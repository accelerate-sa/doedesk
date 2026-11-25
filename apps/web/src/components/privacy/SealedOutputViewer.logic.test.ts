import type { PrivacySealedProvenanceSpan } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { highlightValueInQuote, segmentOutputWithProvenance } from "./SealedOutputViewer.logic";

const TEXT = "Fee SAR 84,000 due 2026-03-01, total SAR 96,600.";

const span = (start: number, end: number, written = TEXT.slice(start, end)) =>
  ({
    start,
    end,
    written,
    kind: "document",
    handle: "DOC_1",
    documentName: "contract.pdf",
    field: "fee",
  }) satisfies PrivacySealedProvenanceSpan;

describe("segmentOutputWithProvenance", () => {
  it("cuts the text at each value, in order, numbering the values it keeps", () => {
    const fee = span(4, 14);
    const total = span(37, 47);
    const segments = segmentOutputWithProvenance(TEXT, [total, fee]);
    expect(segments).toEqual([
      { kind: "text", start: 0, text: "Fee " },
      { kind: "span", index: 0, text: "SAR 84,000", span: fee },
      { kind: "text", start: 14, text: " due 2026-03-01, total " },
      { kind: "span", index: 1, text: "SAR 96,600", span: total },
      { kind: "text", start: 47, text: "." },
    ]);
    expect(segments.map((segment) => segment.text).join("")).toBe(TEXT);
  });

  it("drops spans out of bounds, empty, fractional, overlapping, or not matching the text", () => {
    const kept = span(4, 14);
    const segments = segmentOutputWithProvenance(TEXT, [
      span(-1, 3, "Fee"),
      span(40, 99, "x"),
      span(5, 5, ""),
      span(4.5, 14, "SAR 84,000"),
      span(8, 18),
      span(19, 29, "2099-01-01"),
      kept,
    ]);
    expect(segments.filter((segment) => segment.kind === "span")).toEqual([
      { kind: "span", index: 0, text: "SAR 84,000", span: kept },
    ]);
    expect(segments.map((segment) => segment.text).join("")).toBe(TEXT);
  });

  it("returns the whole text when there are no spans", () => {
    expect(segmentOutputWithProvenance(TEXT, [])).toEqual([{ kind: "text", start: 0, text: TEXT }]);
    expect(segmentOutputWithProvenance("", [])).toEqual([]);
  });
});

describe("highlightValueInQuote", () => {
  it.each([
    ["exact", "The fee is SAR 84,000 in total.", "SAR 84,000", "The fee is ", "SAR 84,000"],
    ["ignoring case", "Paid by ACME LLC on time.", "Acme LLC", "Paid by ", "ACME LLC"],
    ["Arabic", "الأتعاب 84,000 ريال", "84,000 ريال", "الأتعاب ", "84,000 ريال"],
  ])("finds the value %s", (_, quote, written, before, match) => {
    expect(highlightValueInQuote(quote, written)).toEqual({
      before,
      match,
      after: quote.slice(before.length + match.length),
    });
  });

  it("returns null when the value is not in the quote or is empty", () => {
    expect(highlightValueInQuote("The fee is SAR 84,000.", "SAR 90,000")).toBeNull();
    expect(highlightValueInQuote("The fee is SAR 84,000.", "")).toBeNull();
  });
});
