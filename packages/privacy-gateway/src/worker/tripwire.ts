import { canonicalText } from "./values.ts";

/**
 * Notices sealed text on its way out: the second line, for when a copy is in a request anyway.
 * It counts runs of five words that few sealed documents hold, and flags a block on several
 * distinct runs. It does not see text that was encoded or reworded.
 */
export const SHINGLE_WORDS = 5;

/** Distinct rare runs in one block that flag it: ten consecutive copied words give six. */
export const DEFAULT_TRIPWIRE_HITS = 6;

const wordsOf = (text: string): ReadonlyArray<string> =>
  canonicalText(text)
    .split(/[^\p{L}\p{N}]+/u)
    .filter((word) => word.length > 0);

/** FNV-1a over the run, twice with different seeds, as one number that fits a double. */
const hashRun = (words: ReadonlyArray<string>, start: number): number => {
  let high = 0x811c9dc5;
  let low = 0x01000193;
  for (let index = start; index < start + SHINGLE_WORDS; index += 1) {
    const word = words[index] ?? "";
    for (let position = 0; position < word.length; position += 1) {
      const code = word.charCodeAt(position);
      high = Math.imul(high ^ code, 0x01000193);
      low = Math.imul(low ^ code, 0x85ebca6b);
    }
    high = Math.imul(high ^ 0x20, 0x01000193);
    low = Math.imul(low ^ 0x20, 0x85ebca6b);
  }
  return (high >>> 0) * 0x200000 + ((low >>> 0) & 0x1fffff);
};

const shinglesOf = (text: string): ReadonlySet<number> => {
  const words = wordsOf(text);
  const found = new Set<number>();
  for (let start = 0; start + SHINGLE_WORDS <= words.length; start += 1) {
    found.add(hashRun(words, start));
  }
  return found;
};

export interface TripwireFinding {
  /** Distinct rare runs of the block that occur in sealed documents. */
  readonly hits: number;
  /** The sealed document most of them came from. */
  readonly document: string | null;
}

export class Tripwire {
  readonly #byDocument = new Map<string, ReadonlySet<number>>();
  /** For each run, the sealed documents that hold it. */
  readonly #owners = new Map<number, Set<string>>();

  get size(): number {
    return this.#byDocument.size;
  }

  /**
   * Watches for `text`. With `except`, only the runs that `except` does not hold are watched:
   * for a file the model wrote and sealed values were put into, that is the runs around the
   * values, and the model's own wording stays readable to it.
   */
  add(document: string, text: string, except?: string): void {
    this.remove(document);
    const own = except === undefined ? undefined : shinglesOf(except);
    const shingles =
      own === undefined
        ? shinglesOf(text)
        : new Set([...shinglesOf(text)].filter((shingle) => !own.has(shingle)));
    this.#byDocument.set(document, shingles);
    for (const shingle of shingles) {
      const owners = this.#owners.get(shingle);
      if (owners === undefined) this.#owners.set(shingle, new Set([document]));
      else owners.add(document);
    }
  }

  remove(document: string): void {
    const shingles = this.#byDocument.get(document);
    if (shingles === undefined) return;
    for (const shingle of shingles) {
      const owners = this.#owners.get(shingle);
      owners?.delete(document);
      if (owners?.size === 0) this.#owners.delete(shingle);
    }
    this.#byDocument.delete(document);
  }

  /** How much of `text` is sealed wording. Cheap when nothing is sealed. */
  inspect(text: string): TripwireFinding {
    if (this.#byDocument.size === 0 || text.length < 24) return { hits: 0, document: null };
    // A run shared by many sealed documents is common wording, not one document's content.
    const common = 1 + Math.floor(this.#byDocument.size / 10);
    const perDocument = new Map<string, number>();
    let hits = 0;
    for (const shingle of shinglesOf(text)) {
      const owners = this.#owners.get(shingle);
      if (owners === undefined || owners.size > common) continue;
      hits += 1;
      for (const owner of owners) perDocument.set(owner, (perDocument.get(owner) ?? 0) + 1);
    }
    let document: string | null = null;
    let most = 0;
    for (const [owner, count] of perDocument) {
      if (count > most) {
        most = count;
        document = owner;
      }
    }
    return { hits, document };
  }

  flags(text: string, threshold: number = DEFAULT_TRIPWIRE_HITS): boolean {
    return this.inspect(text).hits >= threshold;
  }

  /**
   * For what the person typed: each passage copied from a sealed document gives way to a note
   * and the rest of the text stays, so a request that quotes a clause still reaches the model.
   * Undefined when no passage is long enough to count (`threshold` runs in a row).
   */
  withoutPassages(text: string, threshold: number = DEFAULT_TRIPWIRE_HITS): string | undefined {
    if (this.#byDocument.size === 0 || text.length < 24) return undefined;
    const words: Array<{ readonly word: string; readonly start: number; readonly end: number }> =
      [];
    for (const match of text.matchAll(/[\p{L}\p{N}]+/gu)) {
      for (const word of wordsOf(match[0])) {
        words.push({ word, start: match.index, end: match.index + match[0].length });
      }
    }
    const spelled = words.map((entry) => entry.word);
    const common = 1 + Math.floor(this.#byDocument.size / 10);
    const passages: Array<{ readonly start: number; readonly end: number }> = [];
    let run = 0;
    const close = (after: number) => {
      // `run` runs in a row ended at the run before `after`: they cover these words.
      if (run >= threshold) {
        const first = words[after - run];
        const last = words[after - 1 + SHINGLE_WORDS - 1];
        if (first !== undefined && last !== undefined)
          passages.push({ start: first.start, end: last.end });
      }
      run = 0;
    };
    for (let start = 0; start + SHINGLE_WORDS <= spelled.length; start += 1) {
      const owners = this.#owners.get(hashRun(spelled, start));
      if (owners !== undefined && owners.size <= common) run += 1;
      else close(start);
    }
    close(Math.max(0, spelled.length - SHINGLE_WORDS + 1));
    if (passages.length === 0) return undefined;
    let result = "";
    let cursor = 0;
    for (const passage of passages) {
      result += text.slice(cursor, passage.start) + WITHHELD_PASSAGE_NOTE;
      cursor = passage.end;
    }
    return result + text.slice(cursor);
  }
}

/** What takes the place of a passage the person copied from a sealed document. */
export const WITHHELD_PASSAGE_NOTE =
  "[DoeDesk withheld a passage here: it is the text of a sealed document]";

/** What takes the place of a block that held sealed text. Written for the model. */
export const WITHHELD_SEALED_NOTE =
  "[DoeDesk withheld this content: it holds text of a sealed document, which may not leave this device. " +
  "Ask about sealed documents with the ask_documents tool instead of reading them.]";
