import type { DetectedEntity, Detector } from "./detect.ts";
import { findInitials, type KnownValues, splitAttachedPrefix } from "./names.ts";
import { type EntityKind, isEntityKind, placeholderPattern } from "./placeholders.ts";
import { normalizeForVault, type Vault } from "./vault.ts";

/**
 * How a piece of text is masked.
 *
 * - `detect`: new material from the user or a tool. Checked for personal data, then masked.
 * - `known`: text the model or the app wrote. Only values already in the vault are masked.
 */
export type MaskMode = "detect" | "known";

export interface MaskStats {
  /** Texts sent to the detector. */
  readonly checked: number;
  /** Replacements made across all texts. */
  readonly masked: number;
}

/** Names of the tools themselves. A detector that flags these would confuse the agent. */
const DEFAULT_NEVER_MASK = [
  "Claude",
  "Claude Code",
  "Anthropic",
  "OpenAI",
  "Codex",
  "ChatGPT",
  "GPT",
  "Gemini",
  "Google",
  "Cursor",
  "DoeDesk",
  "DoeDesk",
  "GitHub",
  "Microsoft",
  "Apple",
  "Claude Haiku",
  "Claude Sonnet",
  "Claude Opus",
  "macOS",
  "darwin",
  "Linux",
  "Windows",
  "Shell",
  "Bash",
  "zsh",
  "CLAUDE.md",
  "AGENTS.md",
  "claude.ai",
];

/** A span of personal data and the token that stands in for it. */
export interface LocatedSpan extends DetectedEntity {
  readonly token: string;
  /** Found because the vault already held the value, not by the detector. */
  readonly known: boolean;
}

const kindOfPlaceholder = (token: string): EntityKind => {
  const kind = token.slice(1, token.lastIndexOf("_"));
  return isEntityKind(kind) ? kind : "OTHER";
};

const firstWordOf = (value: string): string => value.split(" ")[0] ?? "";

const countPlaceholders = (text: string): number => text.match(placeholderPattern())?.length ?? 0;

export class Pseudonymizer {
  readonly vault: Vault;
  readonly #detector: Detector;
  readonly #neverMask: ReadonlySet<string>;

  constructor(vault: Vault, detector: Detector, neverMask: ReadonlyArray<string> = []) {
    this.vault = vault;
    this.#detector = detector;
    this.#neverMask = new Set([...DEFAULT_NEVER_MASK, ...neverMask].map(normalizeForVault));
  }

  /** Masks a batch of texts. Rejects, sending nothing, if a text could not be checked. */
  async mask(
    items: ReadonlyArray<{ readonly text: string; readonly mode: MaskMode }>,
    /** Extra words to leave alone for this batch, such as the names of the request's tools. */
    neverMask: ReadonlyArray<string> = [],
  ): Promise<{ readonly texts: ReadonlyArray<string>; readonly stats: MaskStats }> {
    const batchNeverMask = new Set(neverMask.map(normalizeForVault));
    const toDetect = items.flatMap((item, index) =>
      item.mode === "detect" && item.text.trim().length > 0 ? [index] : [],
    );
    const detected =
      toDetect.length === 0
        ? []
        : await this.#detector.detect(toDetect.map((index) => items[index]?.text ?? ""));

    const spansByItem = this.#spansToMask(
      toDetect.map((itemIndex, position) => ({
        index: itemIndex,
        text: items[itemIndex]?.text ?? "",
        detected: detected[position] ?? [],
      })),
      batchNeverMask,
    );

    let masked = 0;
    const texts = items.map((item, index) => {
      const before = countPlaceholders(item.text);
      const spans = spansByItem.get(index) ?? [];
      let text = item.text;
      // Right to left keeps earlier offsets valid.
      for (const entity of spans.toSorted((left, right) => right.start - left.start)) {
        const token = this.vault.tokenFor(entity.kind, text.slice(entity.start, entity.end));
        text = text.slice(0, entity.start) + token + text.slice(entity.end);
      }
      text = this.vault.maskKnown(text);
      masked += Math.max(0, countPlaceholders(text) - before);
      return text;
    });
    return { texts, stats: { checked: toDetect.length, masked } };
  }

  /**
   * Finds what `mask` would replace in each text, and with which token, without rewriting the
   * text. For content that is not text when it is sent, such as the words of an image: the caller
   * covers each span where it stands. Tokens are minted exactly as `mask` mints them, so a value
   * found here and the same value in a message get the same token.
   */
  async locate(
    texts: ReadonlyArray<string>,
    neverMask: ReadonlyArray<string> = [],
  ): Promise<ReadonlyArray<ReadonlyArray<LocatedSpan>>> {
    const batchNeverMask = new Set(neverMask.map(normalizeForVault));
    const toDetect = texts.flatMap((text, index) => (text.trim().length > 0 ? [index] : []));
    const detected =
      toDetect.length === 0
        ? []
        : await this.#detector.detect(toDetect.map((index) => texts[index] ?? ""));
    const found = this.#spansToMask(
      toDetect.map((textIndex, position) => ({
        index: textIndex,
        text: texts[textIndex] ?? "",
        detected: detected[position] ?? [],
      })),
      batchNeverMask,
    );
    const spansByText = new Map<number, ReadonlyArray<LocatedSpan>>();
    for (const [textIndex, spans] of found) {
      const text = texts[textIndex] ?? "";
      spansByText.set(
        textIndex,
        spans.map((entity) => ({
          ...entity,
          token: this.vault.tokenFor(entity.kind, text.slice(entity.start, entity.end)),
          known: false,
        })),
      );
    }
    // Known values second, after every token of the batch exists, as in `mask`.
    return texts.map((text, index) => {
      const spans = spansByText.get(index) ?? [];
      const known = this.vault
        .findKnown(text)
        .filter((span) =>
          spans.every((other) => span.end <= other.start || span.start >= other.end),
        )
        .map((span) => ({ ...span, kind: kindOfPlaceholder(span.token), known: true }));
      return [...spans, ...known].toSorted((left, right) => left.start - right.start);
    });
  }

  unmask(text: string, jsonFragment = false): string {
    return this.vault.unmask(text, jsonFragment);
  }

  /**
   * What to replace in each detected text, with a token minted for every span before any text is
   * rewritten, so a value found in one text is also masked where it appears, undetected, in
   * another. Prefix letters are moved out of the spans, and initials of known people added.
   */
  #spansToMask(
    batch: ReadonlyArray<{
      readonly index: number;
      readonly text: string;
      readonly detected: ReadonlyArray<DetectedEntity>;
    }>,
    batchNeverMask: ReadonlySet<string>,
  ): Map<number, ReadonlyArray<DetectedEntity>> {
    const filtered = batch.map(({ index, text, detected }) => ({
      index,
      text,
      spans: detected.filter((entity) => this.#shouldMask(text, entity, batchNeverMask)),
    }));
    // The values found in this batch, and which names start with each word.
    const batchValues = new Set<string>();
    const batchFirstWords = new Map<string, Set<string>>();
    const isName = (kind: EntityKind) => kind === "PERSON" || kind === "ORG";
    for (const { text, spans } of filtered) {
      for (const entity of spans) {
        const key = normalizeForVault(text.slice(entity.start, entity.end));
        batchValues.add(key);
        if (!isName(entity.kind)) continue;
        const word = firstWordOf(key);
        batchFirstWords.set(word, (batchFirstWords.get(word) ?? new Set()).add(key));
      }
    }
    const vaultFirstWords = new Set(
      this.vault
        .entries()
        .filter((entry) => isName(entry.kind))
        .flatMap((entry) =>
          entry.surfaces.map((surface) => firstWordOf(normalizeForVault(surface))),
        ),
    );

    const spansByIndex = new Map<number, ReadonlyArray<DetectedEntity>>();
    for (const { index, text, spans } of filtered) {
      const split = spans.map((entity) => {
        // What the rest of the batch knows: the span itself does not count.
        const own = normalizeForVault(text.slice(entity.start, entity.end));
        const known: KnownValues = {
          has: (surface) => {
            const key = normalizeForVault(surface);
            return this.vault.has(surface) || (key !== own && batchValues.has(key));
          },
          startsAName: (word) => {
            const key = normalizeForVault(word);
            const names = batchFirstWords.get(key);
            return vaultFirstWords.has(key) || [...(names ?? [])].some((name) => name !== own);
          },
        };
        return splitAttachedPrefix(text, entity, known);
      });
      for (const entity of split) {
        this.vault.tokenFor(entity.kind, text.slice(entity.start, entity.end));
      }
      spansByIndex.set(index, split);
    }

    const people = this.vault
      .entries()
      .filter((entry) => entry.kind === "PERSON")
      .flatMap((entry) => entry.surfaces);
    for (const { index, text } of filtered) {
      const spans = spansByIndex.get(index) ?? [];
      const initials = findInitials(text, people, spans).filter((entity) =>
        this.#shouldMask(text, entity, batchNeverMask),
      );
      for (const entity of initials) {
        this.vault.tokenFor(entity.kind, text.slice(entity.start, entity.end));
      }
      if (initials.length > 0) spansByIndex.set(index, [...spans, ...initials]);
    }
    return spansByIndex;
  }

  #shouldMask(text: string, entity: DetectedEntity, batchNeverMask: ReadonlySet<string>): boolean {
    const surface = text.slice(entity.start, entity.end);
    if (surface.trim().length < 2) return false;
    const key = normalizeForVault(surface);
    if (this.#neverMask.has(key) || batchNeverMask.has(key)) return false;
    // A span that cuts into an existing placeholder would corrupt it.
    for (const match of text.matchAll(placeholderPattern())) {
      const end = match.index + match[0].length;
      if (entity.start < end && entity.end > match.index) return false;
    }
    return true;
  }
}
