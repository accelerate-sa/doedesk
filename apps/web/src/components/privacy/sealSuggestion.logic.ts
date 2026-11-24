import { findFixedFormats } from "@t3tools/privacy-gateway/fixedFormats";

/**
 * Why an attached file looks like one to seal. Decided here, in the client, from the file's own
 * text and the fixed-format rules alone: nothing is sent anywhere to decide.
 */
export type SealSuggestion =
  /** It is dense with identity numbers, IBANs or phone numbers: this many different ones. */
  | { readonly reason: "identifiers"; readonly count: number }
  /** Its header row names payroll or identity columns. */
  | { readonly reason: "columns" };

/** As much of a file as is read to decide. A register shows what it is in its first rows. */
export const SUGGESTION_SAMPLE_BYTES = 256 * 1024;

const READABLE_HERE = /\.(?:csv|tsv|txt|text|md|markdown|json|jsonl|xml|html?|log)$/i;

/** Whether the browser can read this file's text itself. A PDF or an image needs a service. */
export const readableForSuggestion = (name: string): boolean => READABLE_HERE.test(name);

const COUNTED_KINDS: ReadonlySet<string> = new Set(["ID", "IBAN", "PHONE"]);
const MIN_IDENTIFIERS = 5;
/** Fewer than one identifier in this many lines is a document that mentions a few, not a register. */
const LINES_PER_IDENTIFIER = 20;

const PAYROLL_HEADER =
  /salar(?:y|ies)|payroll|wages?|net pay|gross pay|basic pay|allowance|gosi|راتب|رواتب|الأجر|أجور|بدل السكن|التأمينات/iu;
/**
 * A column that holds a person's own document or contact, as a header writes it once its joins
 * are opened (`national_id`, `passportNo`, `ID #`). One such column among ordinary ones is
 * enough. A word that merely holds "id" (`order_id`, `paid`) is not one, nor is `mobile_app`.
 */
const IDENTITY_HEADER = new RegExp(
  `(?<![\\p{L}\\p{N}])(?:${[
    "national id(?:entity)?",
    "nationalid",
    "nin",
    "iqama",
    "resident id",
    "residen(?:ce|cy) (?:id|no|number|permit)",
    "id (?:no|num|number)",
    "idnumber",
    "identity (?:no|num|number|card)",
    "passport",
    "iban",
    "civil (?:id|registry)",
    "date of birth",
    "dob",
    "birth ?date",
    // A person's mobile, not a mobile app: the word ends the header, or a number's name follows.
    "(?:mobile|cell ?phone)(?: (?:no|num|number|phone))?$",
    "(?:ال)?هوي[ةه]",
    "(?:ال)?[إا]قام[ةه]",
    "(?:ال)?جواز",
    "(?:ال)?[آا]يبان",
    "السجل المدني",
    "(?:ال)?ميلاد",
    "(?:ال)?مواليد",
    "(?:ال)?جوال",
    "(?:ال)?موبايل",
    "(?:ال)?محمول",
  ].join("|")})(?![\\p{L}\\p{N}])`,
  "u",
);

/** A header as its words: lower case, with `_`, `-`, `.`, `#` and a capital's join opened. */
const headerWords = (cell: string): string =>
  cell
    .replace(/(\p{Ll})(\p{Lu})/gu, "$1 $2")
    .replace(/#/gu, " no ")
    .replace(/[_\-./\\"'()[\]:]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim()
    .toLowerCase();

/** The cells of a file's first row, when it is a table: split by tab, comma or semicolon. */
const headerCells = (text: string): ReadonlyArray<string> => {
  const lines = text.split(/\r?\n/).filter((line) => line.trim() !== "");
  const [first] = lines;
  if (first === undefined || lines.length < 2) return [];
  const cells = first.split(/[\t,;]/);
  return cells.length < 2 ? [] : cells.map((cell) => cell.trim());
};

/**
 * Whether to offer sealing for an attached file, from the start of its text. Null for a file that
 * gives no reason: most files, and every file whose text is not given.
 */
export const sealSuggestionFor = (name: string, text: string): SealSuggestion | null => {
  if (!readableForSuggestion(name) || text.trim() === "") return null;
  const header = headerCells(text);
  if (header.some((cell) => PAYROLL_HEADER.test(cell) || IDENTITY_HEADER.test(headerWords(cell)))) {
    return { reason: "columns" };
  }
  // The rules read a table by its tabs, so a comma-separated one is given them.
  const read = /\.csv$/i.test(name) ? text.replace(/[,;]/g, "\t") : text;
  const found = new Set(
    findFixedFormats(read)
      .filter((entity) => COUNTED_KINDS.has(entity.kind))
      .map((entity) => read.slice(entity.start, entity.end).replace(/[\s.-]/g, "")),
  );
  const lines = text.split("\n").length;
  return found.size >= MIN_IDENTIFIERS && found.size * LINES_PER_IDENTIFIER >= lines
    ? { reason: "identifiers", count: found.size }
    : null;
};
