import { PLACEHOLDER_SOURCE } from "./placeholders.ts";

/** A sealed file's name or path, or a sealed folder's path, and what a provider is told for it. */
export interface FileLabel {
  readonly name: string;
  /** The name with stand-ins where its values stood, part for part of a path. */
  readonly label: string;
  /** The handle and the file type, which say nothing the name said. It is not turned back. */
  readonly neutral?: boolean;
}

const TYPE = /\.[A-Za-z0-9]{1,8}$/u;

/** The file type a name ends with, lower-cased, or nothing when it has none. */
export const typeOf = (name: string): string => TYPE.exec(name)?.[0].toLowerCase() ?? "";

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** A stem shorter than this is looked for only with its file type: "Li" is also a word. */
const MIN_STEM_LENGTH = 4;

/** How a stand-in is written inside one file name, and the label's text on either side of it. */
interface Spelling {
  readonly before: string;
  readonly after: string;
  readonly written: string;
}

const NO_NAMES: ReadonlySet<string> = new Set();

/** Names met in texts whose spelling is kept for the way back. */
const MAX_LEARNED = 4_000;

/**
 * Where each stand-in of a label stands, and what the name writes there. `type` tells a label
 * that is one stand-in and nothing else from prose; without it such a label is not kept.
 */
const spellingsOf = (
  stem: string,
  labelStem: string,
  type: string,
): ReadonlyArray<readonly [string, Spelling]> => {
  const tokens = [...labelStem.matchAll(new RegExp(PLACEHOLDER_SOURCE, "g"))];
  if (tokens.length === 0) return [];
  const plain: Array<string> = [];
  let cursor = 0;
  for (const token of tokens) {
    plain.push(labelStem.slice(cursor, token.index));
    cursor = token.index + token[0].length;
  }
  plain.push(labelStem.slice(cursor));
  const written = new RegExp(`^${plain.map(escapeRegExp).join("(.+?)")}$`, "su").exec(stem);
  if (written === null) return [];
  return tokens.flatMap((token, index) => {
    const before = labelStem.slice(0, token.index);
    const rest = labelStem.slice(token.index + token[0].length);
    const after = before === "" && rest === "" ? type : rest;
    if (before === "" && after === "") return [];
    return [[token[0], { before, after, written: written[index + 1] ?? "" }] as const];
  });
};

const WORD = /[\p{L}\p{N}]/u;
const NAME = /[\p{L}\p{N}_-]/u;

/** A masked name may be joined to more: `copy_of_<name>`, `<name>.bak`. A letter or digit ends it. */
const standsAlone = (text: string, start: number, end: number): boolean =>
  !WORD.test(text.charAt(start - 1)) && !WORD.test(text.charAt(end));

/** Stricter: "notes.txt" is not looked for in "my-notes.txt" or "notes.txt.bak". */
const standsApart = (text: string, start: number, end: number): boolean => {
  const before = text.charAt(start - 1);
  if (before === "." || NAME.test(before)) return false;
  return (
    !NAME.test(text.charAt(end)) && !(text.charAt(end) === "." && WORD.test(text.charAt(end + 1)))
  );
};

/** Too short to look for wherever it stands, as with a value. */
const MIN_KEY_LENGTH = 3;

/** The three characters at `index` as one number: no text is cut out to look a name up. */
const startOf = (text: string, index: number): number =>
  (text.charCodeAt(index) * 0x10000 + text.charCodeAt(index + 1)) * 0x10000 +
  text.charCodeAt(index + 2);

/**
 * Finds any of many names in a text in one pass over it, whatever their case. A pattern of every
 * name tried at every character costs the text's length times the number of sealed files, on
 * every text of every request.
 */
class Names<Entry> {
  /** Names by their first characters, as one number: looked up at every character of a text. */
  readonly #byStart = new Map<number, Array<string>>();
  /** The first and the second characters some name has: most of a text is passed on these. */
  readonly #firsts = new Uint8Array(0x10000);
  readonly #seconds = new Uint8Array(0x10000);
  readonly #entries = new Map<string, Entry>();

  get size(): number {
    return this.#entries.size;
  }

  set(name: string, entry: Entry): void {
    const key = name.toLowerCase();
    if (key.length < MIN_KEY_LENGTH || key.length !== name.length) return;
    if (!this.#entries.has(key)) {
      const start = startOf(key, 0);
      const keys = this.#byStart.get(start) ?? [];
      keys.push(key);
      // The longest first: a name before its own stem.
      keys.sort((left, right) => right.length - left.length);
      this.#byStart.set(start, keys);
      this.#firsts[key.charCodeAt(0)] = 1;
      this.#seconds[key.charCodeAt(1)] = 1;
    }
    this.#entries.set(key, entry);
  }

  has(name: string): boolean {
    return this.#entries.has(name.toLowerCase());
  }

  delete(name: string): void {
    const key = name.toLowerCase();
    if (!this.#entries.delete(key)) return;
    const start = startOf(key, 0);
    this.#byStart.set(
      start,
      (this.#byStart.get(start) ?? []).filter((other) => other !== key),
    );
  }

  keys(): Iterable<string> {
    return this.#entries.keys();
  }

  /** Each place a name stands, left to right, none inside another. */
  *find(
    text: string,
    stands: (text: string, start: number, end: number) => boolean,
  ): Generator<{ readonly start: number; readonly end: number; readonly entry: Entry }> {
    if (this.#entries.size === 0 || text.length < MIN_KEY_LENGTH) return;
    const lower = text.toLowerCase();
    // A few letters change length in lower case: positions would no longer be the text's.
    if (lower.length !== text.length) return;
    let index = 0;
    while (index <= lower.length - MIN_KEY_LENGTH) {
      if (
        this.#firsts[lower.charCodeAt(index)] === 0 ||
        this.#seconds[lower.charCodeAt(index + 1)] === 0
      ) {
        index += 1;
        continue;
      }
      const keys = this.#byStart.get(startOf(lower, index));
      const key = keys?.find(
        (candidate) =>
          lower.startsWith(candidate, index) && stands(text, index, index + candidate.length),
      );
      const entry = key === undefined ? undefined : this.#entries.get(key);
      if (key === undefined || entry === undefined) {
        index += 1;
        continue;
      }
      yield { start: index, end: index + key.length, entry };
      index += key.length;
    }
  }

  replace(
    text: string,
    stands: (text: string, start: number, end: number) => boolean,
    write: (entry: Entry) => string | undefined,
  ): string {
    let result = "";
    let cursor = 0;
    for (const found of this.find(text, stands)) {
      const written = write(found.entry);
      if (written === undefined) continue;
      result += text.slice(cursor, found.start) + written;
      cursor = found.end;
    }
    return cursor === 0 ? text : result + text.slice(cursor);
  }
}

/**
 * The names of sealed files, with the label kept for each when it was sealed. The label is
 * written wherever a name stands in what is sent, before anything is detected, so no text masks
 * a name a second time; on the way back a label becomes the name as the file spells it.
 */
export class FileLabels {
  #load: () => Iterable<FileLabel> = () => [];
  #stale = false;
  #revision = 0;
  #labelOf = new Names<string>();
  #neutralOf = new Names<{ readonly name: string; readonly label: string }>();
  readonly #spellings = new Map<string, Array<Spelling>>();
  #reach = 0;
  readonly #learned = new Map<
    string,
    { readonly label: string; readonly spellings: ReadonlyArray<readonly [string, Spelling]> }
  >();
  readonly #learnedBy = new Map<string, Set<string>>();
  #learnedReach = 0;

  /** Where the labels are read from, each time they are said to have changed. */
  from(load: () => Iterable<FileLabel>): void {
    this.#load = load;
    this.changed();
  }

  /** A file was sealed or put back, or a label was checked or chosen. */
  changed(): void {
    this.#stale = true;
    this.#revision += 1;
  }

  /** Goes up whenever the labels changed, so a caller can tell its own notes are old. */
  get revision(): number {
    return this.#revision;
  }

  /** The longest text a label needs on one side of a stand-in to be told apart from prose. */
  get reach(): number {
    this.#read();
    return Math.max(this.#reach, this.#learnedReach);
  }

  #read(): void {
    if (!this.#stale) return;
    this.#stale = false;
    this.#labelOf = new Names();
    this.#neutralOf = new Names();
    this.#spellings.clear();
    this.#reach = 0;
    for (const { name, label, neutral } of this.#load()) {
      if (neutral === true) {
        if (name !== label) this.#neutralOf.set(name, { name, label });
        continue;
      }
      const names = name.split(/[\\/]/u);
      const labels = label.split(/[\\/]/u);
      if (names.length !== labels.length) continue;
      names.forEach((part, index) => this.#keep(part, labels[index] ?? part));
    }
    // A name that is also sent masked is not sent as a handle: the masked form comes back.
    for (const key of this.#labelOf.keys()) this.#neutralOf.delete(key);
  }

  #keep(part: string, label: string): void {
    if (part === label || part === "") return;
    const type = typeOf(part);
    const stem = part.slice(0, part.length - type.length);
    const labelStem = label.slice(0, label.length - type.length);
    this.#labelOf.set(part, label);
    if (type !== "" && stem.length >= MIN_STEM_LENGTH) this.#labelOf.set(stem, labelStem);
    for (const [token, spelling] of spellingsOf(stem, labelStem, type)) {
      const spellings = this.#spellings.get(token) ?? [];
      spellings.push(spelling);
      this.#spellings.set(token, spellings);
      this.#reach = Math.max(this.#reach, spelling.before.length, spelling.after.length);
    }
  }

  /**
   * A name or path met in a text that is not a sealed file's, with the stand-ins written into
   * it, for giving it back as it was spelled. Each file and folder of a path is kept by itself
   * too: it may be named again without the folders above it. In memory, the newest names only.
   */
  learn(name: string, label: string): void {
    this.#learn(name, label);
    const parts = name.split(/[\\/]/u);
    const labels = label.split(/[\\/]/u);
    if (parts.length === 1 || parts.length !== labels.length) return;
    parts.forEach((part, index) => {
      const partLabel = labels[index] ?? part;
      if (partLabel !== part) this.#learn(part, partLabel);
    });
  }

  #learn(name: string, label: string): void {
    const known = this.#learned.get(name);
    if (known?.label === label) return;
    const spellings = spellingsOf(name, label, "");
    if (spellings.length === 0) return;
    // More of the name is masked than when it was last met: the earlier label is no longer sent.
    if (known !== undefined) this.#forget(name);
    this.#learned.set(name, { label, spellings });
    for (const [token, spelling] of spellings) {
      this.#learnedBy.set(token, (this.#learnedBy.get(token) ?? new Set()).add(name));
      this.#learnedReach = Math.max(
        this.#learnedReach,
        spelling.before.length,
        spelling.after.length,
      );
    }
    const [oldest] = this.#learned.keys();
    if (this.#learned.size > MAX_LEARNED && oldest !== undefined) this.#forget(oldest);
  }

  #forget(name: string): void {
    for (const [token] of this.#learned.get(name)?.spellings ?? []) {
      this.#learnedBy.get(token)?.delete(name);
    }
    this.#learned.delete(name);
  }

  /** How `token` is written in each name it stands in: a sealed file's first. */
  *#spellingsOf(token: string): Generator<Spelling> {
    yield* this.#spellings.get(token) ?? [];
    for (const name of this.#learnedBy.get(token) ?? []) {
      for (const [other, spelling] of this.#learned.get(name)?.spellings ?? []) {
        if (other === token) yield spelling;
      }
    }
  }

  /** `text` with the label of each sealed file written where its name stands. */
  write(text: string): string {
    this.#read();
    return this.#labelOf.replace(text, standsAlone, (label) => label);
  }

  /** The names sent as a handle and a type that stand in `text`, as their files spell them. */
  neutralNamesIn(text: string): ReadonlyArray<string> {
    this.#read();
    return [...this.#neutralOf.find(text, standsApart)].map((found) => found.entry.name);
  }

  /**
   * `text` with the handle and type written where such a name stands. `elsewhere`: names that
   * another file of the folder also has, which are left: the text may be about that file.
   */
  writeNeutral(text: string, elsewhere: ReadonlySet<string> = NO_NAMES): string {
    this.#read();
    return this.#neutralOf.replace(text, standsApart, (entry) =>
      elsewhere.has(entry.name) ? undefined : entry.label,
    );
  }

  /**
   * What a file's name writes where `token` stands in its label, when the text on either side is
   * the label's: `Khalid_Al_Otaibi` for the stand-in of "Khalid Al Otaibi". Undefined in prose.
   */
  spelling(token: string, before: string, after: string): string | undefined {
    this.#read();
    for (const spelling of this.#spellingsOf(token)) {
      if (before.endsWith(spelling.before) && after.startsWith(spelling.after)) {
        return spelling.written;
      }
    }
    return undefined;
  }

  /** True while the text after `token` is the start of a label's and more of it may still come. */
  awaits(token: string, before: string, after: string): boolean {
    this.#read();
    for (const spelling of this.#spellingsOf(token)) {
      if (
        after.length < spelling.after.length &&
        spelling.after.startsWith(after) &&
        before.endsWith(spelling.before)
      ) {
        return true;
      }
    }
    return false;
  }
}
