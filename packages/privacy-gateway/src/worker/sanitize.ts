/**
 * Characters no reader of a document sees and a model still reads: the Unicode tag block, which
 * spells invisible ASCII, control characters, soft hyphens, zero-width spaces and byte order
 * marks. ZWNJ and ZWJ shape Arabic and Persian words, and directional marks order bilingual
 * lines, so they are kept.
 */
// Escaped backslashes: the formatter writes invisible characters out literally otherwise.
const INVISIBLE = new RegExp(
  `[\\u{E0000}-\\u{E007F}\\u0000-\\u0008\\u000E-\\u001F\\u007F\\u00AD\\u200B\\uFEFF]`,
  "gu",
);
/** A vertical tab or a form feed separates pages and lines in extracted text. */
const BREAKS = /[\u000B\u000C]/g;

/** A document's text without characters that are there only to be read by a model. */
export const sanitizeIngestedText = (text: string): string =>
  text.replace(BREAKS, "\n").replace(INVISIBLE, "");
