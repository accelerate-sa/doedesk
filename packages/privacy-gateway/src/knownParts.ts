import { STANDARDS } from "./fixedFormats.ts";
import type { EntityKind } from "./placeholders.ts";
import { normalizeForVault } from "./vault.ts";

/**
 * The part of a known value that a file's name writes on its own: the serial of a record's
 * number (`amendment_mnt_8042.txt` for MNT-2025-8042) and the first words of an organisation's
 * name (`quote_meridian_crest.txt`). The rules are in the README, "Names of files and paths".
 */

/** A record's number read apart: `MNT-2025-8042` is `mnt`, then `2025` and `8042`. */
interface RecordNumber {
  readonly prefix: ReadonlyArray<string>;
  /** Its runs of digits. The last one, the serial, is what tells it from its neighbours. */
  readonly groups: ReadonlyArray<string>;
}

interface KnownRecord extends RecordNumber {
  readonly value: string;
  readonly token: () => string;
}

interface KnownName {
  readonly words: ReadonlyArray<string>;
  /** How many of its first words a name has to write: two when the first is an article. */
  readonly least: number;
  readonly token: string;
}

export interface KnownParts {
  /** Record numbers by their serial. */
  readonly records: ReadonlyMap<string, ReadonlyArray<KnownRecord>>;
  /** Organisations by the first word of their name, in lower case. */
  readonly names: ReadonlyMap<string, ReadonlyArray<KnownName>>;
}

const NO_PARTS: KnownParts = { records: new Map(), names: new Map() };

const RECORD = /^([A-Za-z]{2,10}(?:[-_/. ][A-Za-z]{2,10})?)((?:[-_/. ]?[0-9]+)+)$/u;
const MIN_SERIAL_DIGITS = 3;
const MIN_NAME_WORD_LENGTH = 4;
const YEAR = /^(?:19|20)[0-9]{2}$/u;
const DIGITS = /^[0-9]+$/u;

/** Kinds a record's number is filed under. A phone number, an IBAN or an amount is none. */
const RECORD_KINDS: ReadonlySet<EntityKind> = new Set([
  "ID",
  "ACCOUNT",
  "PARCEL",
  "DEED",
  "CASE",
  "OTHER",
]);

/** Words many organisations start with: one of them alone names none. */
const GENERIC_FIRST_WORDS = new Set(
  [
    "the national international general saudi arab arabian gulf first united royal global",
    "ministry university bank company",
  ].flatMap((line) => line.split(" ")),
);
/** A body named for what it does ("Placement Committee") starts with an ordinary word. */
const BODY_NOUNS = new Set(
  "committee board council department division unit office team section panel".split(" "),
);
const ARTICLES = new Set(["al", "el"]);

const wordsOf = (name: string): ReadonlyArray<string> =>
  normalizeForVault(name)
    .split(/[^\p{L}\p{N}]+/u)
    .filter((word) => word !== "");

/** Whether a word can stand for the name it starts: long enough, and not one many names share. */
const namesAlone = (word: string): boolean =>
  word.length >= MIN_NAME_WORD_LENGTH && !DIGITS.test(word) && !GENERIC_FIRST_WORDS.has(word);

const recordNumberOf = (value: string): RecordNumber | undefined => {
  const match = RECORD.exec(value.trim());
  if (match === null) return undefined;
  const groups = (match[2] ?? "").match(/[0-9]+/gu) ?? [];
  if ((groups.at(-1)?.length ?? 0) < MIN_SERIAL_DIGITS) return undefined;
  return { prefix: (match[1] ?? "").toLowerCase().split(/[-_/. ]/u), groups };
};

const WRITTEN_RECORD =
  /(?<![\p{L}\p{N}_/.-])([A-Z]{2,10})(?:-[A-Z]{2,10})?(?:[-/][0-9]+)+(?![\p{L}\p{N}_])/gu;

/** The record numbers a document's text writes: capitals, then runs of digits joined on. */
export const recordNumbersIn = (text: string): ReadonlyArray<string> => [
  ...new Set(
    [...text.matchAll(WRITTEN_RECORD)].flatMap((match) =>
      STANDARDS.has(match[1] ?? "") || recordNumberOf(match[0]) === undefined ? [] : [match[0]],
    ),
  ),
];

const addRecord = (
  records: Map<string, ReadonlyArray<KnownRecord>>,
  value: string,
  token: () => string,
): void => {
  const record = recordNumberOf(value);
  const serial = record?.groups.at(-1);
  if (record === undefined || serial === undefined) return;
  const held = records.get(serial) ?? [];
  const key = normalizeForVault(value);
  if (held.some((other) => normalizeForVault(other.value) === key)) return;
  records.set(serial, [...held, { ...record, value, token }]);
};

/** What to look for in names: the record numbers and organisations among a vault's `entries`. */
export const knownPartsOf = (
  entries: Iterable<{
    readonly token: string;
    readonly kind: EntityKind;
    readonly sealed?: boolean;
    readonly surfaces: ReadonlyArray<string>;
  }>,
): KnownParts => {
  const records = new Map<string, ReadonlyArray<KnownRecord>>();
  const names = new Map<string, Array<KnownName>>();
  for (const entry of entries) {
    if (entry.sealed === true) continue;
    for (const surface of entry.surfaces) {
      if (RECORD_KINDS.has(entry.kind)) {
        addRecord(records, surface, () => entry.token);
      } else if (entry.kind === "ORG") {
        const words = wordsOf(surface);
        const [first, second, ...rest] = words;
        if (first === undefined || BODY_NOUNS.has(words.at(-1) ?? "")) continue;
        const add = (name: ReadonlyArray<string>, least: number): void => {
          const key = name[0] ?? "";
          names.set(key, [...(names.get(key) ?? []), { words: name, least, token: entry.token }]);
        };
        if (ARTICLES.has(first) && second !== undefined) {
          // "Al Rajhi Bank": `al_rajhi` and `alrajhi`.
          add(words, 2);
          add([first + second, ...rest], 1);
        } else if (namesAlone(first)) {
          add(words, 1);
        }
      }
    }
  }
  return records.size === 0 && names.size === 0 ? NO_PARTS : { records, names };
};

/**
 * `known` and the record numbers of a file's own text. One the vault does not hold is given
 * its stand-in (`token`) only if the file's name writes it.
 */
export const withOwnRecords = (
  known: KnownParts,
  own: ReadonlyArray<string>,
  token: (value: string) => string,
): KnownParts => {
  if (own.length === 0) return known;
  const records = new Map(known.records);
  for (const value of own) addRecord(records, value, () => token(value));
  return { records, names: known.names };
};

export const holdsNoParts = (known: KnownParts): boolean =>
  known.records.size === 0 && known.names.size === 0;

interface PartInName {
  readonly start: number;
  readonly end: number;
  readonly token: string;
}

interface Word {
  readonly start: number;
  readonly end: number;
  readonly lower: string;
  /** Written with no separator before it, or after it: `412` in the folder `346a412e`. */
  readonly joinedBefore: boolean;
  readonly joinedAfter: boolean;
}

/** The record number whose serial is word `at`, and where its part of the name starts. */
const recordAt = (
  words: ReadonlyArray<Word>,
  at: number,
  candidates: ReadonlyArray<KnownRecord>,
): { readonly from: number; readonly record: KnownRecord } | undefined => {
  const read = candidates.map((record) => {
    // How many of its runs of digits the name writes, the serial last.
    let groups = 1;
    while (
      groups < record.groups.length &&
      words[at - groups]?.lower === record.groups.at(-1 - groups)
    ) {
      groups += 1;
    }
    let letters = 0;
    while (
      letters < record.prefix.length &&
      words[at - groups - letters]?.lower === record.prefix.at(-1 - letters)
    ) {
      letters += 1;
    }
    return { record, groups, letters };
  });
  const lettered = read.filter((found) => found.letters > 0);
  // Beside its letters a serial is told from every other; alone it has to be the only one.
  const among = lettered.length > 0 ? lettered : read;
  const most = Math.max(...among.map((found) => found.groups));
  const [found, ...others] = among.filter((each) => each.groups === most);
  if (found === undefined || others.length > 0) return undefined;
  const from = at - found.groups - found.letters + 1;
  if (found.letters === 0) {
    // Without its letters a serial is a number that stands apart, and no year.
    if (words[from]?.joinedBefore === true || words[at]?.joinedAfter === true) return undefined;
    if (found.groups === 1 && YEAR.test(words[at]?.lower ?? "")) return undefined;
  }
  return { from, record: found.record };
};

/**
 * Where a name with its words read apart (`openName`) writes a part of a known value, and the
 * value's stand-in. Positions are those of the opened text. `wordToken`: the stand-in of a
 * word that several organisations' names start with.
 */
export const knownPartsIn = (
  { text: opened, at: stood }: { readonly text: string; readonly at: ReadonlyArray<number> },
  known: KnownParts,
  wordToken: (written: string) => string | undefined,
): ReadonlyArray<PartInName> => {
  if (holdsNoParts(known)) return [];
  const words: Array<Word> = [...opened.matchAll(/\S+/gu)].map((match) => {
    const end = match.index + match[0].length;
    return {
      start: match.index,
      end,
      lower: match[0].toLowerCase(),
      // -1 marks a space that `openName` put in: the name itself joins the two words.
      joinedBefore: stood[match.index - 1] === -1,
      joinedAfter: stood[end] === -1,
    };
  });
  const found: Array<PartInName> = [];
  let taken = 0;
  words.forEach((word, at) => {
    const records = known.records.get(word.lower);
    const record = records === undefined ? undefined : recordAt(words, at, records);
    const first = words[record?.from ?? -1];
    if (record !== undefined && first !== undefined && first.start >= taken) {
      found.push({ start: first.start, end: word.end, token: record.record.token() });
      taken = word.end;
      return;
    }
    const names = known.names.get(word.lower);
    if (names === undefined || word.start < taken) return;
    const lengths = names.map((name) => {
      let length = 1;
      while (length < name.words.length && words[at + length]?.lower === name.words[length]) {
        length += 1;
      }
      return length;
    });
    const longest = Math.max(...lengths);
    const last = words[at + longest - 1] ?? word;
    const matched = names.filter(
      (name, index) => lengths[index] === longest && longest >= name.least,
    );
    if (matched.length === 0) return;
    // A name written whole wins over the names that only start so.
    const whole = matched.filter((name) => name.words.length === longest);
    const tokens = new Set((whole.length > 0 ? whole : matched).map((name) => name.token));
    const [only] = tokens;
    const token = tokens.size === 1 ? only : wordToken(opened.slice(word.start, last.end));
    if (token === undefined) return;
    found.push({ start: word.start, end: last.end, token });
    taken = last.end;
  });
  return found;
};

/**
 * What a name would hold, in lower case, if it wrote a part of one of these newly known values:
 * a serial, or the word that tells an organisation's name. For looking through names again.
 */
export const partsToLookFor = (
  added: ReadonlyArray<{ readonly surface: string; readonly kind: EntityKind }>,
): ReadonlyArray<string> =>
  added.flatMap(({ surface, kind }) => {
    if (RECORD_KINDS.has(kind)) return recordNumberOf(surface)?.groups.at(-1) ?? [];
    if (kind !== "ORG") return [];
    const [first = "", second] = wordsOf(surface);
    if (ARTICLES.has(first)) return second ?? [];
    return namesAlone(first) ? first : [];
  });
