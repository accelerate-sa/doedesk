import type { DetectedEntity } from "./detect.ts";
import { normalizeForVault } from "./vault.ts";

/*
 * Arabic attaches some one-letter words to the next word: و (and), ف (so), ب (with), ل (for),
 * ك (like), alone or as و/ف before ب/ل/ك ("ولشركة"). A detector often reports the letter as part
 * of the name, and then "لشركة X" gets a stand-in of its own, apart from "شركة X", and the letter
 * goes to the model inside the stand-in. The letter belongs outside: "ل" + stand-in.
 */

/** What the vault and the current batch already know, for telling a prefix from a name. */
export interface KnownValues {
  /** A value known with exactly this spelling. */
  readonly has: (surface: string) => boolean;
  /** A known person or organisation whose name starts with this word. */
  readonly startsAName: (word: string) => boolean;
}

const PREFIX_LETTER = /^[وفبلك]/u;
const TWO_LETTER_PREFIX = /^[وف][بلك]/u;
const ARABIC_WORD = /^\p{Script=Arabic}+$/u;
const MIN_WORD_LETTERS = 3;
const SPLITTABLE_KINDS = new Set(["PERSON", "ORG", "LOCATION", "ADDRESS"]);

/** Name lists are matched loosely: people write ة as ه and ى as ي. */
const looseName = (value: string): string =>
  normalizeForVault(value).replace(/ة/g, "ه").replace(/ى/g, "ي");

/** Common given names that start with one of the prefix letters, so the letter is the name's. */
const NAMES_STARTING_WITH_A_PREFIX_LETTER = new Set(
  [
    "وليد",
    "وائل",
    "وعد",
    "وفاء",
    "وداد",
    "وجدان",
    "وضحى",
    "وسام",
    "وهيب",
    "وديع",
    "وصال",
    "ولاء",
    "وجيه",
    "وحيد",
    "وئام",
    "وسن",
    "فهد",
    "فيصل",
    "فارس",
    "فراس",
    "فؤاد",
    "فاطمة",
    "فاتن",
    "فرح",
    "فريد",
    "فريدة",
    "فواز",
    "فوزي",
    "فوزية",
    "فايز",
    "فالح",
    "فلاح",
    "فهيد",
    "فرحان",
    "فضل",
    "فادي",
    "فدوى",
    "فجر",
    "فيروز",
    "فتحي",
    "فهدة",
    "فلوة",
    "بندر",
    "بدر",
    "بسام",
    "باسل",
    "باسم",
    "بلال",
    "بشير",
    "بشرى",
    "بشار",
    "بكر",
    "بدرية",
    "بسمة",
    "بتول",
    "بيان",
    "بثينة",
    "بخيت",
    "براء",
    "بلقيس",
    "بهاء",
    "بدور",
    "لمى",
    "ليلى",
    "لينا",
    "لؤي",
    "لطيفة",
    "لبنى",
    "لجين",
    "لولوة",
    "لميس",
    "ليان",
    "لانا",
    "لافي",
    "لطفي",
    "ليث",
    "كريم",
    "كمال",
    "كوثر",
    "كاظم",
    "كنان",
    "كادي",
    "كندة",
    "كامل",
    "كلثوم",
  ].map(looseName),
);

/** First words of organisation names: after a prefix letter they mark where the name starts. */
const ORGANISATION_HEADS = new Set(
  [
    "شركة",
    "مؤسسة",
    "مجموعة",
    "مكتب",
    "مصنع",
    "مركز",
    "جمعية",
    "هيئة",
    "وزارة",
    "بنك",
    "مصرف",
    "مستشفى",
    "جامعة",
    "مدرسة",
    "أمانة",
    "بلدية",
    "مجلس",
    "صندوق",
    "معهد",
    "كلية",
    "مكتبة",
  ].map(normalizeForVault),
);

const firstWord = (value: string): string => value.split(/\s/u)[0] ?? "";

/**
 * Moves an attached prefix letter out of a detected span, so the stand-in covers the name alone
 * and the letter stays in the text. Restoring gives back the text exactly: the letter was never
 * replaced. A span is left as it is when the letter may be the name's own ("فهد", "بندر").
 */
export const splitAttachedPrefix = (
  text: string,
  entity: DetectedEntity,
  known: KnownValues,
): DetectedEntity => {
  if (!SPLITTABLE_KINDS.has(entity.kind)) return entity;
  const surface = text.slice(entity.start, entity.end);
  if (!PREFIX_LETTER.test(surface) || /\p{L}/u.test(text[entity.start - 1] ?? "")) return entity;
  if (known.has(surface)) return entity;
  const lengths = TWO_LETTER_PREFIX.test(surface) ? [2, 1] : [1];
  const candidates = lengths.flatMap((length) => {
    const rest = surface.slice(length);
    const word = firstWord(rest);
    return [...word].length >= MIN_WORD_LETTERS && ARABIC_WORD.test(word)
      ? [{ length, rest, word }]
      : [];
  });
  const split = (length: number): DetectedEntity =>
    length === 0 ? entity : { ...entity, start: entity.start + length };

  // The name without the letter is already known: "كمحمد العتيبي" after "محمد العتيبي".
  for (const { length, rest, word } of candidates) {
    if (known.has(rest) || known.startsAName(word)) return split(length);
  }
  // A common name starts here: "فهد" is a name, "وبندر" is و + بندر.
  const whole = firstWord(surface);
  if (known.startsAName(whole)) return entity;
  for (const length of [0, 1, ...(lengths.includes(2) ? [2] : [])]) {
    if (NAMES_STARTING_WITH_A_PREFIX_LETTER.has(looseName(firstWord(surface.slice(length))))) {
      return split(length);
    }
  }
  for (const { length, rest, word } of candidates) {
    // "لل" is ل before الـ with its alif dropped: the letters cannot be split back apart.
    if (surface.startsWith("لل") && length === 1) continue;
    if (word.startsWith("ال") || ORGANISATION_HEADS.has(normalizeForVault(word))) {
      return split(length);
    }
    if (entity.kind === "PERSON" && rest.includes(" ")) return split(length);
  }
  return entity;
};

/*
 * Initials ("م. ع.", "J. S.") are personal data when they stand for a person: next to an honorific
 * or the word "initials", or matching a person the vault already knows. Ordinary abbreviations
 * are never masked, whatever they match.
 */

const INITIAL_LETTER = /[\p{Script=Arabic}A-Z]/gu;
const INITIALS_RUN = /(?<![\p{L}\p{N}])[\p{Script=Arabic}A-Z]\.(?: ?[\p{Script=Arabic}A-Z]\.)+/gu;
/** Honorifics written as one letter: د. (doctor), م. (engineer), أ. (Mr or Ms). */
const ONE_LETTER_HONORIFICS = new Set(["د", "م", "ا"]);
const PERSON_CUE_BEFORE =
  /(?:(?<![a-z])(?:mr|mrs|ms|miss|dr|prof|eng|sir)\.?|السيد|السيدة|الأستاذ|الأستاذة|الدكتور|الدكتورة|المهندس|المهندسة|الشيخ|الأخ|الأخت|سعادة|معالي|الأحرف الأولى|(?<![a-z])initial(?:s|led|ed)?)[\s(:"'«]*$/iu;
const CUE_REACH = 32;
const ABBREVIATIONS = new Set([
  // Arabic: P.O. box, riyal, commercial registration, limited liability, before Christ.
  "صب",
  "رس",
  "ست",
  "ذمم",
  "قم",
  "مم",
  "US",
  "UK",
  "UN",
  "EU",
  "UAE",
  "USA",
  "AM",
  "PM",
  "AD",
  "BC",
  "EG",
  "IE",
  "NB",
  "PS",
  "VS",
  "OK",
  "TV",
  "ID",
  "CR",
  "PO",
  "CV",
  "HR",
  "IT",
  "PR",
  "QA",
  "LLC",
  "PLC",
  "CO",
  "DC",
  "NY",
  "LA",
]);
const NAME_CONNECTORS = new Set(["بن", "بنت", "ابن", "bin", "bint", "ibn", "ben"]);

const letter = (value: string): string => normalizeForVault(value).toUpperCase();

const initialsOfWord = (word: string): ReadonlySet<string> => {
  const letters = new Set([letter(word[0] ?? "")]);
  const article = /^(?:ال|al-|el-)(.)/iu.exec(word);
  if (article?.[1] !== undefined) letters.add(letter(article[1]));
  return letters;
};

const matchesPerson = (initials: ReadonlyArray<string>, name: string): boolean => {
  const words = name
    .replace(/\b(?:al|el) (?=\p{L})/giu, "al-")
    .split(/\s+/u)
    .filter((word) => word.length > 0 && !NAME_CONNECTORS.has(word.toLowerCase()));
  if (words.length < 2) return false;
  const first = initials[0] ?? "";
  const last = initials[initials.length - 1] ?? "";
  if (!initialsOfWord(words[0] ?? "").has(first)) return false;
  if (!initialsOfWord(words[words.length - 1] ?? "").has(last)) return false;
  if (initials.length === 2) return true;
  const middle = initials[1] ?? "";
  return words.slice(1, -1).some((word) => initialsOfWord(word).has(middle));
};

const INITIALS_ANYWHERE = new RegExp(INITIALS_RUN.source, "u");

/** True when `text` holds something shaped like initials, whoever they stand for. */
export const holdsInitials = (text: string): boolean => INITIALS_ANYWHERE.test(text);

/** Initials in `text` that stand for a person, outside the spans already found. */
export const findInitials = (
  text: string,
  people: ReadonlyArray<string>,
  taken: ReadonlyArray<DetectedEntity>,
): ReadonlyArray<DetectedEntity> => {
  const found: Array<DetectedEntity> = [];
  for (const run of text.matchAll(INITIALS_RUN)) {
    const end = run.index + run[0].length;
    const letters = [...run[0].matchAll(INITIAL_LETTER)].map((match) => ({
      letter: letter(match[0]),
      at: run.index + match.index,
    }));
    const lineStart = text.lastIndexOf("\n", run.index - 1) + 1;
    const cued = PERSON_CUE_BEFORE.test(
      text.slice(Math.max(lineStart, run.index - CUE_REACH), run.index),
    );
    const standsForAPerson = (initials: ReadonlyArray<string>, cue: boolean) =>
      initials.length <= 3 &&
      !ABBREVIATIONS.has(initials.join("")) &&
      (cue || people.some((name) => matchesPerson(initials, name)));
    const all = letters.map((entry) => entry.letter);
    let start: number | undefined;
    if (standsForAPerson(all, cued)) start = run.index;
    // "د. ف. ق.": a one-letter honorific, then the initials.
    else if (all.length > 2 && ONE_LETTER_HONORIFICS.has(all[0] ?? "")) {
      if (standsForAPerson(all.slice(1), true)) start = letters[1]?.at;
    }
    if (start === undefined) continue;
    const span = { start, end, kind: "PERSON" as const };
    if (taken.some((other) => span.start < other.end && span.end > other.start)) continue;
    found.push(span);
  }
  return found;
};
