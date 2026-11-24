import { canonicalText } from "./values.ts";

/**
 * A document prepared for checking quotes against it: its text in the canonical spelling with
 * all white space removed, and for each canonical character the offset it came from. Spacing is
 * left out because a quote is still a quote when "Invoice No :" is copied as "Invoice No:".
 */
export interface IndexedDocument {
  readonly text: string;
  readonly canonical: string;
  /** `offsets[i]` is the offset in `text` of the character that produced `canonical[i]`. */
  readonly offsets: Int32Array;
  /** Offsets at which each line of `text` starts. */
  readonly lineStarts: ReadonlyArray<number>;
}

export const indexDocument = (text: string): IndexedDocument => {
  let canonical = "";
  const offsets: Array<number> = [];
  let offset = 0;
  for (const character of text) {
    // One character at a time, so every canonical character has a source.
    if (!/\s/u.test(character)) {
      const piece = canonicalText(`a${character}a`).slice(1, -1).replace(/\s+/gu, "");
      canonical += piece;
      for (let index = 0; index < piece.length; index += 1) offsets.push(offset);
    }
    offset += character.length;
  }
  const lineStarts = [0];
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === "\n") lineStarts.push(index + 1);
  }
  return { text, canonical, offsets: Int32Array.from(offsets), lineStarts };
};

/** The canonical spelling built the way a document's is, so the two compare exactly. */
export const canonicalOf = (text: string): string => indexDocument(text).canonical;

export interface LocatedQuote {
  /** Offsets in the document's own text. */
  readonly start: number;
  readonly end: number;
  /** The line the quote starts on, counted from 1. */
  readonly line: number;
}

const lineOf = (document: IndexedDocument, offset: number): number => {
  let low = 0;
  let high = document.lineStarts.length - 1;
  while (low < high) {
    const middle = (low + high + 1) >> 1;
    if ((document.lineStarts[middle] ?? 0) <= offset) low = middle;
    else high = middle - 1;
  }
  return low + 1;
};

const trimEdges = (segment: string): string =>
  segment.replace(/^["'.,;:()[\]{}<>*_#|-]+|["'.,;:()[\]{}<>*_#|-]+$/gu, "");

/**
 * Where a quote stands in the document. The quote may leave words out with "..." between its
 * parts; each part has to occur, in order. Spelling differences that `canonicalText` removes are
 * ignored, and nothing else: a quote that changes a digit or a word is not found.
 */
export const locateQuote = (document: IndexedDocument, quote: string): LocatedQuote | null => {
  const segments = quote
    .split(/\.{3,}|…|\[\.\.\.\]/u)
    .map((segment) => trimEdges(canonicalOf(segment)))
    .filter((segment) => segment.length > 0);
  if (segments.length === 0) return null;
  let cursor = 0;
  let start = -1;
  let end = -1;
  for (const segment of segments) {
    const at = document.canonical.indexOf(segment, cursor);
    if (at === -1) return null;
    if (start === -1) start = at;
    end = at + segment.length;
    cursor = end;
  }
  const first = document.offsets[start] ?? 0;
  const last = document.offsets[end - 1] ?? first;
  // The last canonical character may come from a surrogate pair or a ligature.
  const lastLength = document.text.codePointAt(last)! > 0xffff ? 2 : 1;
  return { start: first, end: last + lastLength, line: lineOf(document, first) };
};

/** Spelling with spaces kept only where they part two words or numbers: "1 5" is not "15". */
const tight = (text: string): string =>
  canonicalText(text)
    .replace(/(?<=[\p{L}\p{N}]) (?=[\p{L}\p{N}])/gu, "\u0001")
    .replace(/ /g, "");

/** Marks and the tatweel are part of the letter before them, not a character of their own. */
const isMark = (character: string | undefined): boolean =>
  character !== undefined && character.trim() !== "" && canonicalOf(character) === "";

const isWordCharacter = (character: string | undefined): boolean =>
  character !== undefined && !isMark(character) && /[\p{L}\p{N}]/u.test(character);

/**
 * Where a value stands in the document as one piece: not across two separate tokens, and not
 * cut out of the middle of a longer number or word. An occurrence inside `within` (the quote
 * that states the value) is taken first, so that "15" is the 15 the quote is about.
 */
export const locateValue = (
  document: IndexedDocument,
  value: string,
  within?: LocatedQuote | null,
): LocatedQuote | null => {
  const wanted = trimEdges(canonicalOf(value));
  if (wanted.length === 0) return null;
  const wantedTight = tight(value);
  let fallback: LocatedQuote | null = null;
  for (
    let at = document.canonical.indexOf(wanted);
    at !== -1;
    at = document.canonical.indexOf(wanted, at + 1)
  ) {
    const first = document.offsets[at] ?? 0;
    const last = document.offsets[at + wanted.length - 1] ?? first;
    let end = last + ((document.text.codePointAt(last) ?? 0) > 0xffff ? 2 : 1);
    while (isMark(document.text[end])) end += 1;
    const span = document.text.slice(first, end);
    // The same characters with a gap between two tokens are another value.
    if (!tight(span).includes(wantedTight) && !wantedTight.includes(tight(span))) continue;
    const digitBefore = /\p{N}/u.test(document.text[first - 1] ?? "") && /^\p{N}/u.test(span);
    const digitAfter = /\p{N}/u.test(document.text[end] ?? "") && /\p{N}$/u.test(span);
    // An Arabic word may carry one or two letters attached in front (و ف ب ل ك): still one word.
    const attached = /(?<![\p{L}\p{N}])[وف]?[بلكوف]$/u.test(
      document.text.slice(Math.max(0, first - 3), first),
    );
    const letterBefore =
      isWordCharacter(document.text[first - 1]) && /^\p{L}/u.test(span) && !attached;
    const letterAfter = isWordCharacter(document.text[end]) && /\p{L}$/u.test(span);
    if (digitBefore || digitAfter || letterBefore || letterAfter) continue;
    const located = { start: first, end, line: lineOf(document, first) };
    if (within === undefined || within === null) return located;
    if (first >= within.start && end <= within.end) return located;
    fallback ??= located;
  }
  return fallback;
};

/** The document's own spelling of a located quote. */
export const quoteText = (document: IndexedDocument, located: LocatedQuote): string =>
  document.text.slice(located.start, located.end);

const wordsOf = (canonical: string): ReadonlyArray<string> =>
  canonical.split(/[^\p{L}\p{N}]+/u).filter((word) => word.length > 0);

/**
 * The longest run of consecutive words that `text` shares with the document. A summary in the
 * worker's own words shares short runs; text lifted from the source shares a long one.
 */
export const longestCopiedRun = (document: IndexedDocument, text: string): number => {
  const words = wordsOf(canonicalText(text));
  const source = ` ${wordsOf(canonicalText(document.text)).join(" ")} `;
  let longest = 0;
  for (let start = 0; start < words.length; start += 1) {
    let length = longest + 1;
    // Only runs longer than the best so far matter.
    while (
      start + length <= words.length &&
      source.includes(` ${words.slice(start, start + length).join(" ")} `)
    ) {
      longest = length;
      length += 1;
    }
  }
  return longest;
};
