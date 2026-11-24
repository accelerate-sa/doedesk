import { fileNameOf, isCodeToken, wordsOfFileName } from "./codeTokens.ts";
import { typeOf } from "./fileLabels.ts";
import { fileNameTokens, type NameToken } from "./fileNameTokens.ts";
import {
  holdsNoParts,
  type KnownParts,
  knownPartsIn,
  knownPartsOf,
  partsToLookFor,
} from "./knownParts.ts";
import { openName, partsBeside, type Replacement, replacementsInName } from "./sealedLabels.ts";
import type { DetectedEntity, Detector } from "./detect.ts";
import { findInitials, holdsInitials, type KnownValues, splitAttachedPrefix } from "./names.ts";
import { type EntityKind, isEntityKind, placeholderPattern } from "./placeholders.ts";
import { type JoinedText, joinSeparated, originalSpan, Printed } from "./separated.ts";
import { normalizeForVault, type Vault } from "./vault.ts";
import type { WorkspaceFiles } from "./workspaceFiles.ts";

/**
 * `typed`: what the person wrote. `detect`: other new material, such as a tool's result; sealed
 * values are not looked for in it (see `Vault.maskKnown`). `known`: text the model wrote or the
 * app composed; only known values are replaced. `toolKnown`: a public source's text (see
 * `webResults.ts`): no new values are looked for, and, as in `detect`, no sealed ones.
 */
export type MaskMode = "typed" | "detect" | "known" | "toolKnown";

/** Modes whose text is sent to the detector. */
const isChecked = (mode: MaskMode): boolean => mode === "typed" || mode === "detect";

export interface MaskStats {
  /** Texts sent to the detector. */
  readonly checked: number;
  /** Replacements made across all texts. */
  readonly masked: number;
  /** The distinct stand-ins those replacements wrote. Read from the count's own pass. */
  readonly replaced: ReadonlyArray<string>;
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

/** Kinds a detector gives to a name. */
const NAME_KINDS: ReadonlySet<EntityKind> = new Set(["PERSON", "ORG", "LOCATION", "ADDRESS"]);

const NO_FILES: ReadonlySet<string> = new Set();

type Detected = ReadonlyArray<{
  readonly index: number;
  readonly text: string;
  readonly detected: ReadonlyArray<DetectedEntity>;
}>;

const kindOfPlaceholder = (token: string): EntityKind => {
  const kind = token.slice(1, token.lastIndexOf("_"));
  return isEntityKind(kind) ? kind : "OTHER";
};

const firstWordOf = (value: string): string => value.split(" ")[0] ?? "";

const NO_TOKENS: ReadonlyArray<string> = [];

const placeholdersIn = (text: string): ReadonlyArray<string> =>
  text.includes("[") ? (text.match(placeholderPattern()) ?? NO_TOKENS) : NO_TOKENS;

/**
 * The stand-ins `after` holds that `before` did not, each as often as it was added: what was
 * written into a text. One the text already held is left out, unless it was written again.
 */
export const standInsWritten = (before: string, after: string): ReadonlyArray<string> => {
  const held = new Map<string, number>();
  for (const token of placeholdersIn(before)) held.set(token, (held.get(token) ?? 0) + 1);
  return placeholdersIn(after).filter((token) => {
    const left = held.get(token) ?? 0;
    if (left > 0) held.set(token, left - 1);
    return left === 0;
  });
};

const NO_SPANS: ReadonlyArray<DetectedEntity> = [];
const NO_NAME_SPANS: ReadonlyMap<number, ReadonlyArray<Replacement>> = new Map();

/** The names of files and paths in one text, and which of them a detector is asked to read. */
interface NamesInText {
  readonly tokens: ReadonlyArray<NameToken>;
  /** Each folder's and file's name, with the words it joins read apart. */
  readonly stems: ReadonlyMap<string, ReturnType<typeof openName>>;
  /** The opened names put to the detector: those of a text that is checked for new values. */
  readonly asked: ReadonlyArray<string>;
  /** Every opened name, one a line: what a value learned later is looked for in. */
  readonly opened: string;
}

const NO_NAMES: NamesInText = { tokens: [], stems: new Map(), asked: [], opened: "" };

/**
 * A detector reads a name where it could hold a name: a capital or a letter outside ASCII, or
 * the name of a document, which people call after whom it is about (`quote_helvetia.txt`).
 * `node_modules` and `user_service.ts` are looked up among known values and not asked about.
 */
const COULD_NAME = /[\p{Lu}]|[^\u0000-\u007f]/u;
const DOCUMENT_TYPES = new Set(
  "txt md rtf pdf doc docx odt pages xls xlsx xlsm ods numbers csv tsv ppt pptx odp eml msg"
    .split(" ")
    .map((type) => `.${type}`),
);

/** One word joins nothing: the text's own reading has it. */
const joinsWords = (opened: ReturnType<typeof openName>): boolean =>
  opened.text.trim().includes(" ");

const namesIn = (text: string, checked: boolean): NamesInText => {
  const tokens = fileNameTokens(text);
  if (tokens.length === 0) return NO_NAMES;
  const stems = new Map<string, ReturnType<typeof openName>>();
  const asked = new Set<string>();
  for (const token of tokens) {
    const document = checked && DOCUMENT_TYPES.has(typeOf(text.slice(token.start, token.end)));
    for (const part of token.parts) {
      const stem = text.slice(part.start, part.end);
      const opened = stems.get(stem) ?? openName(stem);
      stems.set(stem, opened);
      if (checked && joinsWords(opened) && (document || COULD_NAME.test(opened.text))) {
        asked.add(opened.text);
      }
    }
  }
  return {
    tokens,
    stems,
    asked: [...asked],
    opened: [...new Set([...stems.values()].map((name) => name.text))].join("\n"),
  };
};

const sameSpans = (
  left: ReadonlyArray<DetectedEntity>,
  right: ReadonlyArray<DetectedEntity>,
): boolean =>
  left === right ||
  (left.length === right.length &&
    left.every((span, index) => {
      const other = right[index];
      return span.start === other?.start && span.end === other.end && span.kind === other.kind;
    }));

/**
 * A text as it was last sent, and what that depended on. A conversation resends its whole
 * history on every request; a text whose masked form cannot have changed is not masked again.
 */
interface Remembered {
  readonly detected: ReadonlyArray<DetectedEntity>;
  readonly neverMask: string;
  readonly epoch: number;
  /** How many spellings the vault held when this was last known to be current. */
  spellings: number;
  /** Something shaped like initials stands in the text: a new person could be whom they mean. */
  readonly initials: boolean;
  /** A detected name starts with an Arabic letter: a new name could change where it is cut. */
  readonly prefixed: boolean;
  readonly text: string;
  readonly masked: number;
  /** The distinct stand-ins masking wrote into it, for the turn's record. */
  readonly replaced: ReadonlyArray<string>;
  /** The text with what a tool printed apart put back together, when it held any. */
  readonly joined: JoinedText | undefined;
  /** The names of files in the text with their joined words opened: a new value may be in one. */
  readonly names: string;
}

/** The spellings the vault learned since some point, as one question to put to a text. */
interface Learned {
  readonly person: boolean;
  readonly name: boolean;
  readonly occursIn: (text: string) => boolean;
  /** Whether a name of a file may write a part of a new value: a serial, a company's first word. */
  readonly partIn: (names: string) => boolean;
}

/** Characters of remembered texts kept at once, before the oldest are forgotten. */
const MAX_REMEMBERED_CHARACTERS = 16_000_000;
/** More new spellings than this at once, and every text is simply masked again. */
const MAX_LEARNED_AT_ONCE = 400;
/**
 * The shortest known value looked for among single characters printed apart (`5 0 2 1 1`). A list
 * of single digits spells a year or a count by chance; a five-digit record number it does not. A
 * character dump (`od -c`) says exactly which characters a file holds, so there every length counts.
 */
const MIN_APART_VALUE_LENGTH = 5;

/** True when a known value found in a joined text is to be replaced where it was printed apart. */
const knownApart = (joined: JoinedText, start: number, end: number): boolean => {
  let apart = false;
  let joinedAtAll = false;
  for (let index = start; index < end; index += 1) {
    const printed = joined.printed[index];
    if (printed !== Printed.AsIs) joinedAtAll = true;
    if (printed === Printed.Apart) apart = true;
  }
  if (!joinedAtAll) return false;
  return (
    !apart ||
    (joined.text.slice(start, end).match(/[\p{L}\p{N}]/gu)?.length ?? 0) >= MIN_APART_VALUE_LENGTH
  );
};
const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export class Pseudonymizer {
  readonly vault: Vault;
  readonly #detector: Detector;
  readonly #neverMask: ReadonlySet<string>;
  readonly #workspace: WorkspaceFiles | undefined;
  readonly #remembered: Readonly<Record<MaskMode, Map<string, Remembered>>> = {
    typed: new Map(),
    detect: new Map(),
    known: new Map(),
    toolKnown: new Map(),
  };
  #rememberedCharacters = 0;
  #labelsRevision = 0;
  #parts: { readonly spellings: number; readonly epoch: number; readonly known: KnownParts } = {
    spellings: -1,
    epoch: -1,
    known: knownPartsOf([]),
  };

  constructor(
    vault: Vault,
    detector: Detector,
    neverMask: ReadonlyArray<string> = [],
    /** Tells the name of a file agents work with from a name. Without it no file name is left alone. */
    workspace?: WorkspaceFiles,
  ) {
    this.vault = vault;
    this.#detector = detector;
    this.#neverMask = new Set([...DEFAULT_NEVER_MASK, ...neverMask].map(normalizeForVault));
    this.#workspace = workspace;
  }

  /**
   * Which of the detected spans name a file agents work with. A detector takes `summary.md` for a
   * web address; a span it took for anything else is not asked about, and stays masked.
   */
  async #workspaceFilesIn(batch: Detected): Promise<ReadonlySet<string>> {
    if (this.#workspace === undefined) return NO_FILES;
    const names = new Set<string>();
    for (const { text, detected } of batch) {
      for (const entity of detected) {
        if (entity.kind !== "URL") continue;
        const name = fileNameOf(text.slice(entity.start, entity.end));
        if (name !== undefined) names.add(name);
      }
    }
    return names.size === 0 ? NO_FILES : this.#workspace.find([...names]);
  }

  /**
   * Each text with a sealed file's label written where its name stands: the label kept when the
   * file was sealed, never a second masking of the name. A name sent as a handle and a type is
   * left where another file of the folder has it too.
   */
  async #withFileLabels<Item extends { readonly text: string }>(
    items: ReadonlyArray<Item>,
  ): Promise<ReadonlyArray<Item>> {
    const labels = this.vault.fileLabels;
    if (labels.revision !== this.#labelsRevision) {
      // A sealed file has left its folder: what was listed there is old.
      this.#labelsRevision = labels.revision;
      this.#workspace?.forget();
    }
    const labelled = items.map((item) => labels.write(item.text));
    const neutral = labelled.map((text) => labels.neutralNamesIn(text));
    const asked = new Set(neutral.flat());
    const elsewhere =
      asked.size === 0 || this.#workspace === undefined
        ? NO_FILES
        : await this.#workspace.find([...asked]);
    return items.map((item, index) => {
      const written = labelled[index] ?? item.text;
      // Most texts name no such file, and are not gone through a third time.
      const text = neutral[index]?.length === 0 ? written : labels.writeNeutral(written, elsewhere);
      return text === item.text ? item : { ...item, text };
    });
  }

  /** Masks a batch of texts. Rejects, sending nothing, if a text could not be checked. */
  async mask(
    written: ReadonlyArray<{ readonly text: string; readonly mode: MaskMode }>,
    /** Extra words to leave alone for this batch, such as the names of the request's tools. */
    neverMask: ReadonlyArray<string> = [],
  ): Promise<{ readonly texts: ReadonlyArray<string>; readonly stats: MaskStats }> {
    const items = await this.#withFileLabels(written);
    const batchNeverMask = new Set(neverMask.map(normalizeForVault));
    const toDetect = items.flatMap((item, index) =>
      isChecked(item.mode) && item.text.trim().length > 0 ? [index] : [],
    );
    const earlier = items.map((item) => this.#remembered[item.mode].get(item.text));
    // What a tool printed apart is checked put back together. A text met before is not joined again.
    const joined = new Map<number, JoinedText>();
    for (const index of toDetect) {
      const before = earlier[index];
      const found = before === undefined ? joinSeparated(items[index]?.text ?? "") : before.joined;
      if (found !== undefined) joined.set(index, found);
    }
    const readOf = (index: number): string => joined.get(index)?.text ?? items[index]?.text ?? "";
    // The names of files in a text met for the first time are read in the same call as the text.
    const names = new Map<number, NamesInText>();
    items.forEach((item, index) => {
      if (earlier[index] === undefined) names.set(index, namesIn(item.text, isChecked(item.mode)));
    });
    const openedNames = new Map<string, ReadonlyArray<DetectedEntity>>();
    const asked = [...new Set([...names.values()].flatMap((found) => found.asked))];
    const found =
      toDetect.length + asked.length === 0
        ? []
        : await this.#detector.detect([...toDetect.map(readOf), ...asked]);
    const detected = found.slice(0, toDetect.length);
    asked.forEach((opened, position) =>
      openedNames.set(opened, found[toDetect.length + position] ?? NO_SPANS),
    );

    const detectedByItem = new Map(
      toDetect.map((itemIndex, position) => [itemIndex, detected[position] ?? NO_SPANS]),
    );
    const neverMaskKey = [...batchNeverMask].toSorted().join("\n");
    const learned = new Map<number, Learned>();
    const kept = items.map((item, index) =>
      this.#recall(
        earlier[index],
        readOf(index),
        detectedByItem.get(index) ?? NO_SPANS,
        neverMaskKey,
        learned,
      ),
    );

    // Only what is new, or could have changed, is worked out again.
    const batch = toDetect.flatMap((itemIndex) =>
      kept[itemIndex] === undefined
        ? [
            {
              index: itemIndex,
              text: readOf(itemIndex),
              detected: detectedByItem.get(itemIndex) ?? NO_SPANS,
            },
          ]
        : [],
    );
    const workspaceFiles = await this.#workspaceFilesIn(batch);
    const spansByItem = this.#spansToMask(batch, batchNeverMask, workspaceFiles);
    // A text met before that is masked again: its names were read then, and are asked for again.
    const again: Array<string> = [];
    items.forEach((item, index) => {
      if (kept[index] !== undefined || names.has(index)) return;
      const inText = namesIn(item.text, isChecked(item.mode));
      names.set(index, inText);
      again.push(...inText.asked.filter((opened) => !openedNames.has(opened)));
    });
    if (again.length > 0) {
      const distinct = [...new Set(again)];
      const answers = await this.#detector.detect(distinct);
      distinct.forEach((opened, position) =>
        openedNames.set(opened, answers[position] ?? NO_SPANS),
      );
    }
    const nameSpans = this.#spansInNames(items, kept, names, openedNames, batchNeverMask);

    let masked = 0;
    const replaced = new Set<string>();
    // The stand-ins of a label count as replaced values, as they would in prose.
    items.forEach((item, index) => {
      const before = written[index]?.text ?? item.text;
      if (before === item.text) return;
      const wrote = standInsWritten(before, item.text);
      masked += wrote.length;
      for (const token of wrote) replaced.add(token);
    });
    const fresh: Array<Remembered> = [];
    const texts = items.map((item, index) => {
      const remembered = kept[index];
      if (remembered !== undefined) {
        masked += remembered.masked;
        for (const token of remembered.replaced) replaced.add(token);
        return remembered.text;
      }
      const read = readOf(index);
      const joinedText = joined.get(index);
      // Never in what a tool returned: a model could send guesses out and read them back.
      const sealed = item.mode === "typed" || item.mode === "known";
      const inNames = nameSpans.get(index);
      const inProse = this.#replacements(
        read,
        joinedText,
        spansByItem.get(index) ?? NO_SPANS,
        sealed,
      );
      // Where both found something, the longer span is kept: the loop below skips what overlaps.
      const spans =
        inNames === undefined
          ? inProse
          : [...inProse, ...inNames].toSorted(
              (left, right) => left.start - right.start || right.end - left.end,
            );
      // One pass, left to right: a long text with many values is copied once, not once a value.
      let rewritten = "";
      let cursor = 0;
      for (const span of spans) {
        if (span.start < cursor) continue;
        rewritten += item.text.slice(cursor, span.start) + span.token;
        cursor = span.end;
      }
      const text = this.vault.maskKnown(
        cursor === 0 ? item.text : rewritten + item.text.slice(cursor),
        sealed,
      );
      const count = Math.max(0, placeholdersIn(text).length - placeholdersIn(item.text).length);
      masked += count;
      const wrote = new Set(count > 0 ? standInsWritten(item.text, text) : NO_TOKENS);
      for (const token of wrote) replaced.add(token);
      const found = detectedByItem.get(index) ?? NO_SPANS;
      // A span that may name a workspace file depends on what is on disk: asked every time.
      const onDisk =
        this.#workspace !== undefined &&
        found.some(
          (entity) =>
            entity.kind === "URL" && fileNameOf(read.slice(entity.start, entity.end)) !== undefined,
        );
      if (!onDisk) {
        fresh.push(
          this.#remember(item, {
            detected: found,
            neverMask: neverMaskKey,
            epoch: this.vault.epoch,
            spellings: 0,
            initials: holdsInitials(read),
            prefixed: found.some(
              (entity) =>
                NAME_KINDS.has(entity.kind) &&
                /^\p{Script=Arabic}/u.test(read.slice(entity.start, entity.start + 2)),
            ),
            text,
            masked: count,
            replaced: [...wrote],
            joined: joinedText,
            names: names.get(index)?.opened ?? "",
          }),
        );
      }
      return text;
    });
    // Every token of the batch exists by now: the texts above are current as of this count.
    for (const entry of fresh) entry.spellings = this.vault.spellingCount;
    return { texts, stats: { checked: toDetect.length, masked, replaced: [...replaced] } };
  }

  /** The parts of the vault's values that a name may write, read again when the vault changed. */
  #knownParts(): KnownParts {
    const { spellingCount, epoch } = this.vault;
    if (this.#parts.spellings !== spellingCount || this.#parts.epoch !== epoch) {
      this.#parts = { spellings: spellingCount, epoch, known: knownPartsOf(this.vault.entries()) };
    }
    return this.#parts.known;
  }

  /**
   * What to replace inside the names of files and paths of each text that is being masked: the
   * values found in a name read with its joins opened, placed where they stand in the text. The
   * whole name with its stand-ins is remembered, so a reply gives it back as it was spelled.
   */
  #spansInNames(
    items: ReadonlyArray<{ readonly text: string }>,
    kept: ReadonlyArray<Remembered | undefined>,
    names: ReadonlyMap<number, NamesInText>,
    detected: ReadonlyMap<string, ReadonlyArray<DetectedEntity>>,
    batchNeverMask: ReadonlySet<string>,
  ): ReadonlyMap<number, ReadonlyArray<Replacement>> {
    // Each distinct name is worked out once, after every value its detection found has a token.
    const stems = new Map<string, ReturnType<typeof openName>>();
    for (const [index, inText] of names) {
      if (kept[index] !== undefined) continue;
      for (const [stem, opened] of inText.stems) stems.set(stem, opened);
    }
    if (stems.size === 0) return NO_NAME_SPANS;
    const openedTexts = [
      ...new Set([...stems.values()].filter(joinsWords).map((opened) => opened.text)),
    ];
    const toMask = this.#spansToMask(
      openedTexts.map((text, index) => ({ index, text, detected: detected.get(text) ?? NO_SPANS })),
      batchNeverMask,
      NO_FILES,
    );
    const spansOfOpened = new Map<string, ReadonlyArray<Replacement>>();
    openedTexts.forEach((text, index) => {
      const spans = (toMask.get(index) ?? NO_SPANS).map((entity) => ({
        start: entity.start,
        end: entity.end,
        token: this.vault.tokenFor(entity.kind, text.slice(entity.start, entity.end)),
      }));
      const known = this.vault
        .findKnown(text)
        .filter((span) =>
          spans.every((other) => span.end <= other.start || span.start >= other.end),
        );
      spansOfOpened.set(
        text,
        [...spans, ...known].toSorted((left, right) => left.start - right.start),
      );
    });
    // Minted above, the batch's own values are among the known ones here.
    const known = this.#knownParts();
    const wordToken = (written: string): string | undefined =>
      this.vault.isReleased(written) || batchNeverMask.has(normalizeForVault(written))
        ? undefined
        : this.vault.tokenFor("ORG", written);
    const inStem = new Map<string, ReadonlyArray<Replacement>>();
    for (const [stem, opened] of stems) {
      const inOpened = spansOfOpened.get(opened.text) ?? [];
      const whole = replacementsInName(this.vault, stem, opened, inOpened);
      // A part of a value is replaced in the name only: it is no spelling of the value.
      const parts = holdsNoParts(known)
        ? []
        : partsBeside(opened, inOpened, knownPartsIn(opened, known, wordToken));
      if (whole.length + parts.length === 0) continue;
      inStem.set(
        stem,
        parts.length === 0
          ? whole
          : [...whole, ...parts].toSorted((left, right) => left.start - right.start),
      );
    }
    if (inStem.size === 0) return NO_NAME_SPANS;
    const byItem = new Map<number, ReadonlyArray<Replacement>>();
    for (const [index, inText] of names) {
      if (kept[index] !== undefined) continue;
      const text = items[index]?.text ?? "";
      const spans: Array<Replacement> = [];
      for (const token of inText.tokens) {
        const before = spans.length;
        for (const part of token.parts) {
          for (const span of inStem.get(text.slice(part.start, part.end)) ?? []) {
            spans.push({
              start: part.start + span.start,
              end: part.start + span.end,
              token: span.token,
            });
          }
        }
        if (spans.length === before) continue;
        // The name as it is sent, for the way back.
        let label = "";
        let cursor = token.start;
        for (const span of spans.slice(before)) {
          label += text.slice(cursor, span.start) + span.token;
          cursor = span.end;
        }
        this.vault.fileLabels.learn(
          text.slice(token.start, token.end),
          label + text.slice(cursor, token.end),
        );
      }
      if (spans.length > 0) byItem.set(index, spans);
    }
    return byItem;
  }

  /** The masked form of a text from an earlier request, when nothing it depends on has changed. */
  #recall(
    entry: Remembered | undefined,
    /** The text as it is read: with what a tool printed apart put back together. */
    read: string,
    detected: ReadonlyArray<DetectedEntity>,
    neverMask: string,
    learned: Map<number, Learned>,
  ): Remembered | undefined {
    if (entry === undefined) return undefined;
    if (entry.epoch !== this.vault.epoch || entry.neverMask !== neverMask) return undefined;
    if (!sameSpans(entry.detected, detected)) return undefined;
    if (entry.spellings !== this.vault.spellingCount) {
      const since = this.#learnedSince(entry.spellings, learned);
      if ((entry.initials && since.person) || (entry.prefixed && since.name)) return undefined;
      if (since.occursIn(read)) return undefined;
      if (entry.names !== "" && (since.occursIn(entry.names) || since.partIn(entry.names))) {
        return undefined;
      }
      entry.spellings = this.vault.spellingCount;
    }
    return entry;
  }

  /**
   * What the vault learned since it held `count` spellings. A text that holds none of the new
   * spellings, even as part of a longer word, is replaced exactly as before.
   */
  #learnedSince(count: number, learned: Map<number, Learned>): Learned {
    const known = learned.get(count);
    if (known !== undefined) return known;
    const added = this.vault.spellingsSince(count);
    const surfaces = [...new Set(added.map((entry) => entry.surface))];
    let pattern: RegExp | undefined;
    const parts = partsToLookFor(added);
    const since: Learned = {
      person: added.some((entry) => entry.kind === "PERSON"),
      name: added.some((entry) => NAME_KINDS.has(entry.kind)),
      occursIn: (text) => {
        if (surfaces.length > MAX_LEARNED_AT_ONCE) return true;
        if (surfaces.length <= 4) return surfaces.some((surface) => text.includes(surface));
        pattern ??= new RegExp(surfaces.map(escapeRegExp).join("|"), "u");
        return pattern.test(text);
      },
      partIn: (names) => {
        if (parts.length === 0) return false;
        const lower = names.toLowerCase();
        return parts.some((part) => lower.includes(part));
      },
    };
    learned.set(count, since);
    return since;
  }

  #remember(
    item: { readonly text: string; readonly mode: MaskMode },
    entry: Remembered,
  ): Remembered {
    const texts = this.#remembered[item.mode];
    const replacedEntry = texts.get(item.text);
    if (replacedEntry !== undefined) {
      this.#rememberedCharacters -= item.text.length + replacedEntry.text.length;
      texts.delete(item.text);
    }
    texts.set(item.text, entry);
    this.#rememberedCharacters += item.text.length + entry.text.length;
    // The oldest first, from whichever mode holds the most.
    while (this.#rememberedCharacters > MAX_REMEMBERED_CHARACTERS) {
      const fullest = Object.values(this.#remembered).reduce((most, each) =>
        each.size > most.size ? each : most,
      );
      const oldest = fullest.entries().next().value;
      if (oldest === undefined) break;
      fullest.delete(oldest[0]);
      this.#rememberedCharacters -= oldest[0].length + oldest[1].text.length;
    }
    return entry;
  }

  /**
   * The spans of a text to replace, in order, with their tokens. Found in `read`; where something
   * was printed apart, placed where it stands in the original, together with the known values
   * printed apart that the known-value pass, which reads the original, cannot see.
   */
  #replacements(
    read: string,
    joined: JoinedText | undefined,
    detected: ReadonlyArray<DetectedEntity>,
    sealed: boolean,
  ): ReadonlyArray<{ readonly start: number; readonly end: number; readonly token: string }> {
    const spans = detected.map((entity) => ({
      start: entity.start,
      end: entity.end,
      token: this.vault.tokenFor(entity.kind, read.slice(entity.start, entity.end)),
    }));
    if (joined === undefined) return spans.toSorted((left, right) => left.start - right.start);
    for (const known of this.vault.findKnown(read, sealed)) {
      if (!knownApart(joined, known.start, known.end)) continue;
      if (spans.some((span) => known.start < span.end && known.end > span.start)) continue;
      spans.push(known);
    }
    return spans
      .map((span) => ({ ...originalSpan(joined, span.start, span.end), token: span.token }))
      .toSorted((left, right) => left.start - right.start);
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
    const batch = toDetect.map((textIndex, position) => ({
      index: textIndex,
      text: texts[textIndex] ?? "",
      detected: detected[position] ?? [],
    }));
    const found = this.#spansToMask(batch, batchNeverMask, await this.#workspaceFilesIn(batch));
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
    batch: Detected,
    batchNeverMask: ReadonlySet<string>,
    workspaceFiles: ReadonlySet<string>,
  ): Map<number, ReadonlyArray<DetectedEntity>> {
    const checked = batch.map(({ index, text, detected }) => {
      // Found once for the text, not once for each span in it.
      const standIns =
        detected.length > 0 && text.includes("[")
          ? [...text.matchAll(placeholderPattern())].map((match) => ({
              start: match.index,
              end: match.index + match[0].length,
            }))
          : [];
      return {
        index,
        text,
        spans: detected.filter(
          (entity) =>
            this.#shouldMask(text, entity, batchNeverMask, standIns) && !isCodeToken(text, entity),
        ),
      };
    });
    const filtered =
      workspaceFiles.size === 0 ? checked : this.#withoutWorkspaceFiles(checked, workspaceFiles);
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
      const splitSpans = spans.map((entity) => {
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
      // Without its prefix letter a span can be a value the person stopped masking.
      const split = splitSpans.filter(
        (entity) => !this.vault.isReleased(text.slice(entity.start, entity.end)),
      );
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

  #shouldMask(
    text: string,
    entity: DetectedEntity,
    batchNeverMask: ReadonlySet<string>,
    /** Where stand-ins already are in `text`. Without it they are looked for here. */
    standIns?: ReadonlyArray<{ readonly start: number; readonly end: number }>,
  ): boolean {
    const surface = text.slice(entity.start, entity.end);
    if (surface.trim().length < 2) return false;
    const key = normalizeForVault(surface);
    if (this.#neverMask.has(key) || batchNeverMask.has(key)) return false;
    if (this.vault.isReleased(surface)) return false;
    // A span that cuts into an existing placeholder would corrupt it.
    const taken =
      standIns ??
      [...text.matchAll(placeholderPattern())].map((match) => ({
        start: match.index,
        end: match.index + match[0].length,
      }));
    return !taken.some((standIn) => entity.start < standIn.end && entity.end > standIn.start);
  }

  /**
   * Drops the spans that name a file agents work with and that the detector took for a web
   * address. One whose path holds a word of a known name stays: `noura_contract.docx` is masked
   * when Noura is in the vault or in this batch.
   */
  #withoutWorkspaceFiles<Item extends { readonly text: string }>(
    items: ReadonlyArray<Item & { readonly spans: ReadonlyArray<DetectedEntity> }>,
    workspaceFiles: ReadonlySet<string>,
  ): ReadonlyArray<Item & { readonly spans: ReadonlyArray<DetectedEntity> }> {
    const fileOf = (text: string, entity: DetectedEntity): string | undefined => {
      if (entity.kind !== "URL") return undefined;
      const name = fileNameOf(text.slice(entity.start, entity.end));
      return name !== undefined && workspaceFiles.has(name) ? name : undefined;
    };
    const nameWords = new Set<string>();
    const addName = (value: string) => {
      for (const word of normalizeForVault(value).split(/[\s._-]+/u)) {
        if (word.length >= 3) nameWords.add(word);
      }
    };
    for (const entry of this.vault.entries()) {
      if (NAME_KINDS.has(entry.kind)) entry.surfaces.forEach(addName);
    }
    for (const { text, spans } of items) {
      for (const entity of spans) {
        if (NAME_KINDS.has(entity.kind)) addName(text.slice(entity.start, entity.end));
      }
    }
    return items.map((item) => ({
      ...item,
      spans: item.spans.filter((entity) => {
        const name = fileOf(item.text, entity);
        if (name === undefined) return true;
        return wordsOfFileName(name).some((word) => nameWords.has(normalizeForVault(word)));
      }),
    }));
  }
}
