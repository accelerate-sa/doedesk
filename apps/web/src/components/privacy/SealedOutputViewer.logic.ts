import type { PrivacySealedProvenanceSpan } from "@t3tools/contracts";

export type OutputSegment =
  | { readonly kind: "text"; readonly start: number; readonly text: string }
  | {
      readonly kind: "span";
      readonly index: number;
      readonly text: string;
      readonly span: PrivacySealedProvenanceSpan;
    };

/**
 * Cuts a finished file's text at its verified values. A span is shown only where the text at its
 * offsets is the value it claims, so a stale or overlapping span is dropped rather than
 * highlighting the wrong words.
 */
export function segmentOutputWithProvenance(
  text: string,
  spans: ReadonlyArray<PrivacySealedProvenanceSpan>,
): OutputSegment[] {
  const sorted = spans
    .filter(
      (span) =>
        Number.isInteger(span.start) &&
        Number.isInteger(span.end) &&
        span.start >= 0 &&
        span.end > span.start &&
        span.end <= text.length &&
        text.slice(span.start, span.end) === span.written,
    )
    .toSorted((a, b) => a.start - b.start || b.end - a.end);
  const segments: OutputSegment[] = [];
  let cursor = 0;
  let index = 0;
  for (const span of sorted) {
    if (span.start < cursor) continue;
    if (span.start > cursor)
      segments.push({ kind: "text", start: cursor, text: text.slice(cursor, span.start) });
    segments.push({ kind: "span", index, text: span.written, span });
    index += 1;
    cursor = span.end;
  }
  if (cursor < text.length)
    segments.push({ kind: "text", start: cursor, text: text.slice(cursor) });
  return segments;
}

/** Where `written` stands in its source quote: exactly, or failing that ignoring case. */
export function highlightValueInQuote(
  quote: string,
  written: string,
): { before: string; match: string; after: string } | null {
  if (written.length === 0) return null;
  let at = quote.indexOf(written);
  if (at === -1) {
    const lowerQuote = quote.toLowerCase();
    const lowerWritten = written.toLowerCase();
    // Lowercasing can change a string's length (such as "İ"); offsets then no longer line up.
    if (lowerQuote.length !== quote.length || lowerWritten.length !== written.length) return null;
    at = lowerQuote.indexOf(lowerWritten);
  }
  if (at === -1) return null;
  return {
    before: quote.slice(0, at),
    match: quote.slice(at, at + written.length),
    after: quote.slice(at + written.length),
  };
}
