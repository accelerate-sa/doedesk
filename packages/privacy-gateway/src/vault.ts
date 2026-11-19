import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

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

/**
 * The table that turns real values into placeholders and back. It never leaves the machine.
 *
 * Tokens are random, not derived from the value, so a token reveals nothing and cannot be
 * reversed by guessing inputs.
 */
export class Vault {
  readonly #byToken = new Map<string, VaultEntry>();
  readonly #tokenByKey = new Map<string, string>();
  readonly #filePath: string | undefined;
  #surfacePattern: RegExp | undefined | null = null;
  #surfaceTokens = new Map<string, string>();
  #saveTimer: NodeJS.Timeout | undefined;

  constructor(filePath?: string) {
    this.#filePath = filePath;
    if (filePath !== undefined) this.#load(filePath);
  }

  get size(): number {
    return this.#byToken.size;
  }

  entries(): ReadonlyArray<VaultEntry> {
    return [...this.#byToken.values()];
  }

  /** The token for a value, minting one the first time the value is seen. */
  tokenFor(kind: EntityKind, surface: string): string {
    const key = normalizeForVault(surface);
    const existing = this.#tokenByKey.get(key);
    if (existing !== undefined) {
      const entry = this.#byToken.get(existing);
      if (entry !== undefined && !entry.surfaces.includes(surface)) {
        this.#byToken.set(existing, { ...entry, surfaces: [...entry.surfaces, surface] });
        this.#changed();
      }
      return existing;
    }
    let token = makePlaceholder(kind, NodeCrypto.randomBytes(8));
    while (this.#byToken.has(token)) token = makePlaceholder(kind, NodeCrypto.randomBytes(8));
    this.#byToken.set(token, {
      token,
      kind,
      value: surface,
      surfaces: [surface],
      createdAt: new Date().toISOString(),
    });
    this.#tokenByKey.set(key, token);
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

  /** Replaces every known value in `text`, leaving existing placeholders alone. */
  maskKnown(text: string): string {
    const pattern = this.#knownPattern();
    if (pattern === undefined) return text;
    const placeholders = placeholderPattern();
    let result = "";
    let cursor = 0;
    for (const match of text.matchAll(placeholders)) {
      result += this.#maskSegment(text.slice(cursor, match.index), pattern) + match[0];
      cursor = match.index + match[0].length;
    }
    return result + this.#maskSegment(text.slice(cursor), pattern);
  }

  /**
   * Where known values stand in `text`, with the token of each: what `maskKnown` would replace,
   * for a caller that has to cover the value somewhere other than in the text itself.
   */
  findKnown(
    text: string,
  ): ReadonlyArray<{ readonly start: number; readonly end: number; readonly token: string }> {
    const pattern = this.#knownPattern();
    if (pattern === undefined) return [];
    const found: Array<{ start: number; end: number; token: string }> = [];
    const scan = (segment: string, offset: number) => {
      if (segment.length < MIN_SURFACE_LENGTH) return;
      pattern.lastIndex = 0;
      for (const match of segment.matchAll(pattern)) {
        const prefix = match[1] ?? "";
        const surface = match[2] ?? "";
        const token = this.#surfaceTokens.get(surface);
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

  /** Restores real values. `jsonFragment` escapes them for insertion inside a JSON string. */
  unmask(text: string, jsonFragment = false): string {
    if (!text.includes("[")) return text;
    return text.replace(placeholderPattern(), (token) => {
      const value = this.#byToken.get(token)?.value;
      if (value === undefined) return token;
      return jsonFragment ? JSON.stringify(value).slice(1, -1) : value;
    });
  }

  flush(): void {
    if (this.#saveTimer !== undefined) {
      clearTimeout(this.#saveTimer);
      this.#saveTimer = undefined;
    }
    this.#save();
  }

  #maskSegment(segment: string, pattern: RegExp): string {
    if (segment.length < MIN_SURFACE_LENGTH) return segment;
    pattern.lastIndex = 0;
    return segment.replace(pattern, (whole, prefix: string | undefined, surface: string) => {
      const token = this.#surfaceTokens.get(surface);
      if (token === undefined || (prefix !== undefined && !takesPrefix(surface))) return whole;
      return (prefix ?? "") + token;
    });
  }

  #knownPattern(): RegExp | undefined {
    if (this.#surfacePattern !== null) return this.#surfacePattern;
    const surfaceTokens = new Map<string, string>();
    for (const entry of this.#byToken.values()) {
      for (const surface of entry.surfaces) {
        if (surface.length >= MIN_SURFACE_LENGTH) surfaceTokens.set(surface, entry.token);
      }
    }
    this.#surfaceTokens = surfaceTokens;
    if (surfaceTokens.size === 0) {
      this.#surfacePattern = undefined;
      return undefined;
    }
    // Longest first, so a full name wins over the first name it contains.
    const alternation = [...surfaceTokens.keys()]
      .toSorted((left, right) => right.length - left.length)
      .map(escapeRegExp)
      .join("|");
    this.#surfacePattern = new RegExp(
      `(?<![\\p{L}\\p{N}])(${ATTACHED_PREFIX})?(${alternation})(?![\\p{L}\\p{N}])`,
      "gu",
    );
    return this.#surfacePattern;
  }

  #changed(): void {
    this.#surfacePattern = null;
    if (this.#filePath === undefined || this.#saveTimer !== undefined) return;
    this.#saveTimer = setTimeout(() => {
      this.#saveTimer = undefined;
      this.#save();
    }, 250);
    this.#saveTimer.unref();
  }

  #save(): void {
    if (this.#filePath === undefined) return;
    const stored: StoredVault = { version: 1, entries: this.entries() };
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
      for (const surface of entry.surfaces) {
        this.#tokenByKey.set(normalizeForVault(surface), entry.token);
      }
    }
  }
}
