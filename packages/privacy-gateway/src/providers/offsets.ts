/**
 * Services count positions in a text in their own unit. DoeDesk counts UTF-16 code units, as a
 * JS string does, and a position that is one off masks the wrong characters.
 */

const HAS_SURROGATE = /[\uD800-\uDFFF]/;
const ALL_ASCII = /^[\u0000-\u007F]*$/;

/**
 * Turns a position counted in Unicode code points, as Python and AWS count, into UTF-16 units.
 * Undefined for a position outside the text.
 */
export const codePointsToUtf16 = (text: string): ((offset: number) => number | undefined) => {
  if (!HAS_SURROGATE.test(text)) {
    return (offset) =>
      Number.isInteger(offset) && offset >= 0 && offset <= text.length ? offset : undefined;
  }
  const units: Array<number> = [];
  let unit = 0;
  for (const character of text) {
    units.push(unit);
    unit += character.length;
  }
  units.push(unit);
  return (offset) => units[offset];
};

const utf8Length = (character: string): number => {
  const codePoint = character.codePointAt(0) ?? 0;
  if (codePoint < 0x80) return 1;
  if (codePoint < 0x800) return 2;
  // A surrogate on its own is sent as U+FFFD, which is three bytes like the rest of this range.
  return codePoint < 0x10000 ? 3 : 4;
};

/**
 * Turns positions counted in UTF-8 bytes, as Google Cloud DLP counts, into UTF-16 units. A
 * position inside a character widens the span to the whole character: more is masked, never less.
 */
export const utf8BytesToUtf16 = (
  text: string,
): {
  readonly start: (byte: number) => number | undefined;
  readonly end: (byte: number) => number | undefined;
} => {
  if (ALL_ASCII.test(text)) {
    const same = (byte: number) =>
      Number.isInteger(byte) && byte >= 0 && byte <= text.length ? byte : undefined;
    return { start: same, end: same };
  }
  const starts: Array<number> = [];
  const ends: Array<number> = [];
  let unit = 0;
  for (const character of text) {
    const size = utf8Length(character);
    for (let index = 0; index < size; index += 1) {
      starts.push(unit);
      ends.push(index === 0 ? unit : unit + character.length);
    }
    unit += character.length;
  }
  starts.push(unit);
  ends.push(unit);
  return { start: (byte) => starts[byte], end: (byte) => ends[byte] };
};

/** Longest text sent in one piece, as for DoeDesk's own detection service. */
export const MAX_CHUNK_LENGTH = 4000;

/** Splits a long text at a line or a word, and never between the two halves of one character. */
export const splitIntoChunks = (
  text: string,
  maxLength = MAX_CHUNK_LENGTH,
): ReadonlyArray<{ readonly offset: number; readonly text: string }> => {
  if (text.length <= maxLength) return [{ offset: 0, text }];
  const chunks: Array<{ offset: number; text: string }> = [];
  let offset = 0;
  while (offset < text.length) {
    let end = Math.min(offset + maxLength, text.length);
    if (end < text.length) {
      const window = text.slice(offset, end);
      const lineBreak = window.lastIndexOf("\n");
      const space = window.lastIndexOf(" ");
      const cut = lineBreak > maxLength / 2 ? lineBreak : space > maxLength / 2 ? space : -1;
      if (cut !== -1) end = offset + cut + 1;
      else if (/[\uD800-\uDBFF]/.test(text[end - 1] ?? "")) end -= 1;
    }
    chunks.push({ offset, text: text.slice(offset, end) });
    offset = end;
  }
  return chunks;
};
