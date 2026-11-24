import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { FileLabels } from "./fileLabels.ts";
import {
  type EntityKind,
  isEntityKind,
  makePlaceholder,
  placeholderPattern,
} from "./placeholders.ts";

export interface VaultEntry {
  readonly token: string;
  readonly kind: EntityKind;
  /** The value restored when the model writes the token. The first spelling seen. */
  readonly value: string;
  /** Every spelling that maps to this token. */
  readonly surfaces: ReadonlyArray<string>;
  readonly createdAt: string;
  /**
   * The value comes from a sealed document. It is restored only where the person reads it (the
   * assistant's own text, a file finished for them), never in what a tool is run with: a tool
   * could print it back in another form.
   */
  readonly sealed?: boolean;
  /** sealed: what the value is filed under when that is not its spelling (see `sealedTokenFor`). */
  readonly sealedKey?: string;
  /**
   * When the person stopped masking this value (see `Vault.release`). It is sent as written and
   * never given a stand-in again; the entry stays so that its old stand-in still restores.
   */
  readonly releasedAt?: string;
}

interface StoredVault {
  readonly version: 1;
  readonly entries: ReadonlyArray<VaultEntry>;
}

const ARABIC_MARKS = /[ً-ْٰـ]/g;

/** Two spellings with the same key are the same real-world value. */
export const normalizeForVault = (value: string): string =>
  value
    .normalize("NFKC")
    .replace(ARABIC_MARKS, "")
    .replace(/[أإآ]/g, "ا")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Shorter values match too much ordinary text to be replaced wherever they appear. */
const MIN_SURFACE_LENGTH = 3;

/**
 * An Arabic letter word attached in front of a known value: و ف ب ل ك, or و/ف before ب/ل/ك.
 * The letter stays in the text, outside the stand-in.
 */
const ATTACHED_PREFIX = "(?:[وف]?[بلك]|[وف])(?=\\p{Script=Arabic})";
/** One-word values this short are often the tail of an ordinary word ("فعلي" is not ف + علي). */
const MIN_PREFIXED_WORD_LENGTH = 4;

const takesPrefix = (surface: string): boolean =>
  /\s/u.test(surface) || surface.length >= MIN_PREFIXED_WORD_LENGTH;

/** The values to look for in a text, and the token of each. */
interface Known {
  readonly pattern: RegExp;
  readonly tokens: ReadonlyMap<string, string>;
}

/**
 * The table that turns real values into placeholders and back. It never leaves the machine.
 *
 * Tokens are random, not derived from the value, so a token reveals nothing and cannot be
 * reversed by guessing inputs.
 */
export class Vault {
  /** What a provider is told a sealed file is called, written wherever its name stands. */
  readonly fileLabels = new FileLabels();
  readonly #byToken = new Map<string, VaultEntry>();
  readonly #tokenByKey = new Map<string, string>();
  /** Sealed values are filed apart: looking up an ordinary value never yields a sealed token. */
  readonly #sealedByKey = new Map<string, string>();
  /** Values the person stopped masking, by key, with the token each one had. */
  readonly #releasedByKey = new Map<string, string>();
  readonly #filePath: string | undefined;
  /** Every spelling in the order it became known, for `spellingsSince`. */
  readonly #spellings: Array<{ readonly surface: string; readonly kind: EntityKind }> = [];
  #epoch = 0;
  #known: Known | undefined | null = null;
  #knownWithSealed: Known | undefined | null = null;
  #saveTimer: NodeJS.Timeout | undefined;

  constructor(filePath?: string) {
    this.#filePath = filePath;
    if (filePath !== undefined) this.#load(filePath);
  }

  /**
   * Changes when a value stops being masked or is masked again. With `spellingCount`, it lets a
   * caller that keeps a masked text tell whether the text could come out differently now.
   */
  get epoch(): number {
    return this.#epoch;
  }

  get spellingCount(): number {
    return this.#spellings.length;
  }

  /** The spellings that became known after the first `count`, sealed values included. */
  spellingsSince(
    count: number,
  ): ReadonlyArray<{ readonly surface: string; readonly kind: EntityKind }> {
    return this.#spellings.slice(count);
  }

  /** Values that are replaced now: the ones the person stopped masking are not counted. */
  get size(): number {
    return this.#byToken.size - this.released().length;
  }

  entries(): ReadonlyArray<VaultEntry> {
    return [...this.#byToken.values()].filter((entry) => entry.releasedAt === undefined);
  }

  /** The values the person stopped masking, each with the stand-in it had. */
  released(): ReadonlyArray<VaultEntry> {
    return [...this.#byToken.values()].filter((entry) => entry.releasedAt !== undefined);
  }

  /** True when the person stopped masking this value, in any spelling that normalizes the same. */
  isReleased(surface: string): boolean {
    return this.#releasedByKey.size > 0 && this.#releasedByKey.has(normalizeForVault(surface));
  }

  /**
   * Stops masking a value: for a word that is not personal data, such as a word of code a detector
   * took for a name. From then on it is sent as written, wherever it stands in a conversation,
   * and no detector can bring it back. Its stand-in still restores, since a model that saw it may
   * write it again. A sealed value is never released: undefined.
   */
  release(token: string): VaultEntry | undefined {
    const entry = this.#byToken.get(token);
    if (entry === undefined || entry.sealed === true || entry.releasedAt !== undefined) {
      return undefined;
    }
    const released = { ...entry, releasedAt: new Date().toISOString() };
    this.#byToken.set(token, released);
    for (const key of this.#keysOf(entry)) {
      if (this.#tokenByKey.get(key) === token) this.#tokenByKey.delete(key);
      this.#releasedByKey.set(key, token);
    }
    this.#epoch += 1;
    this.#changed();
    return released;
  }

  /** Masks a released value again, under the stand-in it had. False when it was not released. */
  restore(token: string): boolean {
    const entry = this.#byToken.get(token);
    if (entry?.releasedAt === undefined) return false;
    const { releasedAt: _releasedAt, ...active } = entry;
    this.#byToken.set(token, active);
    for (const key of this.#keysOf(entry)) {
      if (this.#releasedByKey.get(key) === token) this.#releasedByKey.delete(key);
      this.#tokenByKey.set(key, token);
    }
    this.#epoch += 1;
    this.#changed();
    return true;
  }

  #keysOf(entry: VaultEntry): ReadonlySet<string> {
    return new Set([entry.value, ...entry.surfaces].map(normalizeForVault));
  }

  /** The token for a value, minting one the first time the value is seen. */
  tokenFor(kind: EntityKind, surface: string): string {
    const key = normalizeForVault(surface);
    const existing = this.#tokenByKey.get(key);
    if (existing !== undefined) {
      const entry = this.#byToken.get(existing);
      if (entry !== undefined && !entry.surfaces.includes(surface)) {
        this.#byToken.set(existing, { ...entry, surfaces: [...entry.surfaces, surface] });
        this.#spellings.push({ surface, kind: entry.kind });
        this.#changed();
      }
      return existing;
    }
    // A released value keeps its one entry. Callers leave it alone: see `isReleased`.
    const released = this.#releasedByKey.get(key);
    if (released !== undefined) return released;
    return this.#mint(kind, key, surface, [surface], false);
  }

  /**
   * The token for a value of a sealed document, filed apart from ordinary values so that a
   * detector finding a model's guess never hands back a sealed stand-in. Not `findable`: too
   * common to search for ("60"), restored only. `filedAs`: a key other than the spelling.
   */
  sealedTokenFor(kind: EntityKind, surface: string, findable: boolean, filedAs?: string): string {
    const key = filedAs ?? normalizeForVault(surface);
    const existing = this.#sealedByKey.get(key);
    if (existing !== undefined) return existing;
    return this.#mint(kind, key, surface, findable ? [surface] : [], true, filedAs);
  }

  /** True when the token stands for a value of a sealed document. */
  isSealed(token: string): boolean {
    return this.#byToken.get(token)?.sealed === true;
  }

  /** True when `text` holds a token of a sealed value. */
  holdsSealedToken(text: string): boolean {
    if (!text.includes("[")) return false;
    for (const match of text.matchAll(placeholderPattern())) {
      if (this.isSealed(match[0])) return true;
    }
    return false;
  }

  #mint(
    kind: EntityKind,
    key: string,
    value: string,
    surfaces: ReadonlyArray<string>,
    sealed: boolean,
    sealedKey?: string,
  ): string {
    let token = makePlaceholder(kind, NodeCrypto.randomBytes(8));
    while (this.#byToken.has(token)) token = makePlaceholder(kind, NodeCrypto.randomBytes(8));
    this.#byToken.set(token, {
      token,
      kind,
      value,
      surfaces,
      createdAt: new Date().toISOString(),
      ...(sealed ? { sealed: true } : {}),
      ...(sealedKey === undefined ? {} : { sealedKey }),
    });
    (sealed ? this.#sealedByKey : this.#tokenByKey).set(key, token);
    for (const surface of surfaces) this.#spellings.push({ surface, kind });
    this.#changed();
    return token;
  }

  /** True when this value, in any spelling that normalizes the same, has a token. */
  has(surface: string): boolean {
    return this.#tokenByKey.has(normalizeForVault(surface));
  }

  resolve(token: string): string | undefined {
    return this.#byToken.get(token)?.value;
  }

  /**
   * Replaces every known value in `text`, leaving existing placeholders alone. The values of
   * sealed documents are looked for only with `sealed`. That is never set for what a tool
   * returned: a model could write its guesses to a file, read it back, and see which one became
   * a stand-in.
   */
  maskKnown(written: string, sealed = false): string {
    const text = this.fileLabels.write(written);
    const known = this.#knownValues(sealed);
    if (known === undefined) return text;
    const placeholders = placeholderPattern();
    let result = "";
    let cursor = 0;
    for (const match of text.matchAll(placeholders)) {
      result += this.#maskSegment(text.slice(cursor, match.index), known) + match[0];
      cursor = match.index + match[0].length;
    }
    return result + this.#maskSegment(text.slice(cursor), known);
  }

  /**
   * Where known values stand in `text`, with the token of each: what `maskKnown` would replace,
   * for a caller that has to cover the value somewhere other than in the text itself.
   */
  findKnown(
    text: string,
    sealed = false,
  ): ReadonlyArray<{ readonly start: number; readonly end: number; readonly token: string }> {
    const known = this.#knownValues(sealed);
    if (known === undefined) return [];
    const { pattern, tokens } = known;
    const found: Array<{ start: number; end: number; token: string }> = [];
    const scan = (segment: string, offset: number) => {
      if (segment.length < MIN_SURFACE_LENGTH) return;
      pattern.lastIndex = 0;
      for (const match of segment.matchAll(pattern)) {
        const prefix = match[1] ?? "";
        const surface = match[2] ?? "";
        const token = tokens.get(surface);
        if (token === undefined || (prefix !== "" && !takesPrefix(surface))) continue;
        const start = offset + match.index + prefix.length;
        found.push({ start, end: start + surface.length, token });
      }
    };
    let cursor = 0;
    for (const match of text.matchAll(placeholderPattern())) {
      scan(text.slice(cursor, match.index), cursor);
      cursor = match.index + match[0].length;
    }
    scan(text.slice(cursor), cursor);
    return found;
  }

  /**
   * Restores real values. `jsonFragment` escapes them for insertion inside a JSON string. The
   * values of sealed documents are restored only with `sealed`: see `VaultEntry.sealed`.
   */
  unmask(
    text: string,
    jsonFragment = false,
    sealed = false,
    restored?: Set<string>,
    /** How a value is written where it stands, given the text on either side of its stand-in. */
    written?: (token: string, value: string, before: string, after: string) => string,
    /** The end of the text that came before `text`, when it is one piece of a longer one. */
    leading = "",
  ): string {
    if (!text.includes("[")) return text;
    return text.replace(placeholderPattern(), (token, offset: number) => {
      const entry = this.#byToken.get(token);
      if (entry === undefined) return token;
      const before = text.slice(0, offset);
      const after = text.slice(offset + token.length);
      // Inside a file's label the value is written as the file's name writes it. A name is no
      // secret from a tool, which finds the file by it: a sealed value's part of one comes back.
      const inName = this.fileLabels.spelling(token, leading + before, after);
      if (entry.sealed === true && !sealed && inName === undefined) return token;
      restored?.add(token);
      const value =
        inName ??
        (jsonFragment || written === undefined
          ? entry.value
          : written(token, entry.value, before, after));
      return jsonFragment ? JSON.stringify(value).slice(1, -1) : value;
    });
  }

  /**
   * Whether a value may be shown in another spelling, such as without its unit. A client sends
   * the text back, sometimes reworded: a value that is searched for is shown another way only if
   * that spelling is searched for from now on (`searchable`). One never searched for loses nothing.
   */
  writtenAs(token: string, spelling: string, searchable: boolean): boolean {
    const entry = this.#byToken.get(token);
    if (entry === undefined) return false;
    if (entry.surfaces.length === 0 || entry.surfaces.includes(spelling)) return true;
    if (!searchable) return false;
    this.#byToken.set(token, { ...entry, surfaces: [...entry.surfaces, spelling] });
    this.#spellings.push({ surface: spelling, kind: entry.kind });
    this.#changed();
    return true;
  }

  flush(): void {
    if (this.#saveTimer !== undefined) {
      clearTimeout(this.#saveTimer);
      this.#saveTimer = undefined;
    }
    this.#save();
  }

  #maskSegment(segment: string, known: Known): string {
    if (segment.length < MIN_SURFACE_LENGTH) return segment;
    known.pattern.lastIndex = 0;
    return segment.replace(known.pattern, (whole, prefix: string | undefined, surface: string) => {
      const token = known.tokens.get(surface);
      if (token === undefined || (prefix !== undefined && !takesPrefix(surface))) return whole;
      return (prefix ?? "") + token;
    });
  }

  #knownValues(withSealed: boolean): Known | undefined {
    const cached = withSealed ? this.#knownWithSealed : this.#known;
    if (cached !== null) return cached;
    const tokens = new Map<string, string>();
    // Sealed first, so that a value held both ways keeps its ordinary token.
    for (const sealed of withSealed ? [true, false] : [false]) {
      for (const entry of this.#byToken.values()) {
        if ((entry.sealed === true) !== sealed || entry.releasedAt !== undefined) continue;
        for (const surface of entry.surfaces) {
          if (surface.length >= MIN_SURFACE_LENGTH) tokens.set(surface, entry.token);
        }
      }
    }
    // Longest first, so a full name wins over the first name it contains.
    const alternation = [...tokens.keys()]
      .toSorted((left, right) => right.length - left.length)
      .map(escapeRegExp)
      .join("|");
    const known =
      tokens.size === 0
        ? undefined
        : {
            tokens,
            pattern: new RegExp(
              `(?<![\\p{L}\\p{N}])(${ATTACHED_PREFIX})?(${alternation})(?![\\p{L}\\p{N}])`,
              "gu",
            ),
          };
    if (withSealed) this.#knownWithSealed = known;
    else this.#known = known;
    return known;
  }

  #changed(): void {
    this.#known = null;
    this.#knownWithSealed = null;
    if (this.#filePath === undefined || this.#saveTimer !== undefined) return;
    this.#saveTimer = setTimeout(() => {
      this.#saveTimer = undefined;
      this.#save();
    }, 250);
    this.#saveTimer.unref();
  }

  #save(): void {
    if (this.#filePath === undefined) return;
    const stored: StoredVault = { version: 1, entries: [...this.#byToken.values()] };
    NodeFS.mkdirSync(NodePath.dirname(this.#filePath), { recursive: true, mode: 0o700 });
    const temporary = `${this.#filePath}.${process.pid}.tmp`;
    NodeFS.writeFileSync(temporary, JSON.stringify(stored), { mode: 0o600 });
    NodeFS.renameSync(temporary, this.#filePath);
  }

  #load(filePath: string): void {
    let raw: string;
    try {
      raw = NodeFS.readFileSync(filePath, "utf8");
    } catch {
      return;
    }
    const parsed = JSON.parse(raw) as Partial<StoredVault>;
    for (const entry of parsed.entries ?? []) {
      if (typeof entry.token !== "string" || !isEntityKind(entry.kind)) continue;
      if (typeof entry.value !== "string" || !Array.isArray(entry.surfaces)) continue;
      this.#byToken.set(entry.token, entry);
      // A sealed value that is never searched for has no surface, and is still one value.
      if (typeof entry.sealedKey === "string") {
        this.#sealedByKey.set(entry.sealedKey, entry.token);
        continue;
      }
      const byKey =
        entry.releasedAt !== undefined
          ? this.#releasedByKey
          : entry.sealed === true
            ? this.#sealedByKey
            : this.#tokenByKey;
      for (const surface of [entry.value, ...entry.surfaces]) {
        byKey.set(normalizeForVault(surface), entry.token);
      }
    }
  }
}
