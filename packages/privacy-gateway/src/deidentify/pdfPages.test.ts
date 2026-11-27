import { describe, expect, it } from "vite-plus/test";

import { paintPage } from "../redaction/testkit.ts";
import { openPdf, PagePdfBuilder, UnreadablePdfError } from "./pdfPages.ts";
import { rawPdf, streamObject } from "./testkit.ts";

/** A page of real text in a standard font, with a filled-in annotation beside it. */
const PAGE_WITH_ANNOTATION = rawPdf([
  "<< /Type /Catalog /Pages 2 0 R >>",
  "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
  "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Contents 4 0 R " +
    "/Resources << /Font << /F1 5 0 R >> >> /Annots [6 0 R] >>",
  streamObject("", "BT /F1 24 Tf 20 150 Td (Hello) Tj ET"),
  "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  "<< /Type /Annot /Subtype /Stamp /Rect [150 20 250 80] /F 4 /AP << /N 7 0 R >> >>",
  streamObject("/Type /XObject /Subtype /Form /BBox [0 0 100 60]", "0.5 g 0 0 100 60 re f"),
]);

const pixel = (raster: { width: number; data: Buffer }, x: number, y: number): number =>
  raster.data[(y * raster.width + x) * 3] as number;

describe("a PDF drawn as pictures", () => {
  it("draws a page's text and its annotations, at the page's own size", async () => {
    const pdf = await openPdf(PAGE_WITH_ANNOTATION, { scale: 2 });
    try {
      expect(pdf.pageCount).toBe(1);
      const page = await pdf.renderPage(0);
      expect([page.widthPoints, page.heightPoints]).toEqual([300, 200]);
      expect([page.raster.width, page.raster.height]).toEqual([600, 400]);
      // The word, in a font the file does not carry: dark strokes where it is written.
      let ink = 0;
      for (let y = 60; y < 104; y += 1) {
        for (let x = 40; x < 200; x += 1) if (pixel(page.raster, x, y) < 100) ink += 1;
      }
      expect(ink).toBeGreaterThan(200);
      // The annotation: what a form's answer is stored as, and no text extraction returns.
      expect(pixel(page.raster, 400, 300)).toBeGreaterThan(100);
      expect(pixel(page.raster, 400, 300)).toBeLessThan(160);
      // Paper everywhere else.
      expect(pixel(page.raster, 560, 40)).toBe(255);
    } finally {
      await pdf.close();
    }
  });

  it("refuses what is not a PDF, and a file with more pages than it is given leave for", async () => {
    await expect(openPdf(Buffer.from("not a pdf at all"))).rejects.toBeInstanceOf(
      UnreadablePdfError,
    );
    await expect(openPdf(PAGE_WITH_ANNOTATION, { maxPages: 0 })).rejects.toThrow(/1 pages/);
  });
});

describe("a PDF written from pictures", () => {
  it("holds each page's pixels as they were given, at the page's size, and nothing else", async () => {
    const first = paintPage(300, 200, [
      { text: "x", x: 40, y: 50, width: 120, height: 30, solid: true },
    ]);
    const second = paintPage(200, 400, [
      { text: "y", x: 20, y: 300, width: 100, height: 40, solid: true },
    ]);
    const builder = new PagePdfBuilder();
    await builder.addPage(first, 300, 200);
    // Drawn at two pixels a point: the page is half as many points as it has pixels.
    await builder.addPage(second, 100, 200);
    const bytes = builder.finish();

    const pdf = await openPdf(bytes, { scale: 1 });
    try {
      expect(pdf.pageCount).toBe(2);
      const drawn = await pdf.renderPage(0);
      expect([drawn.widthPoints, drawn.heightPoints]).toEqual([300, 200]);
      expect(pixel(drawn.raster, 100, 65)).toBe(128);
      expect(pixel(drawn.raster, 100, 150)).toBe(255);
      const other = await pdf.renderPage(1);
      expect([other.widthPoints, other.heightPoints]).toEqual([100, 200]);
      expect(pixel(other.raster, 35, 160)).toBe(128);
    } finally {
      await pdf.close();
    }
    const source = bytes.toString("latin1");
    for (const absent of ["/Info", "/Annots", "/Font", "/Metadata", "/URI", "/AcroForm"]) {
      expect(source, absent).not.toContain(absent);
    }
  });

  it("stores a photograph as JPEG and print without loss", async () => {
    const noise = Buffer.alloc(200 * 200 * 3);
    let seed = 7;
    for (let index = 0; index < noise.length; index += 1) {
      seed = (seed * 16807) % 2147483647;
      noise[index] = seed % 256;
    }
    const builder = new PagePdfBuilder();
    await builder.addPage({ width: 200, height: 200, data: noise }, 200, 200);
    await builder.addPage(paintPage(200, 200, []), 200, 200);
    const source = builder.finish().toString("latin1");
    expect(source.match(/\/DCTDecode/g)).toHaveLength(1);
    expect(source.match(/\/FlateDecode/g)).toHaveLength(1);
  });
});
