import { encodeRasterAs } from "../../redaction/raster.ts";
import type { ItemTarget, LayerItem } from "../layer.ts";
import { openPdf, PagePdfBuilder } from "../pdfPages.ts";
import { regionOf } from "./image.ts";
import { analysePicture, paintItems, pictureItem } from "./pictures.ts";
import type { FormatHandler } from "./shared.ts";

/**
 * PDFs, page by page as pictures (see `pdfPages.ts` for why). Each page is drawn, read and
 * searched like a picture, a person may draw boxes on any page, and the copy is a new PDF of
 * the painted pages and nothing else.
 */
export const pdfHandler: FormatHandler = {
  family: "pdf",
  extensions: [".pdf"],
  detect: async (file, context, mode) => {
    const pdf = await openPdf(file.bytes, context.pdf);
    try {
      const items: Array<LayerItem> = [];
      const warnings = new Set<string>();
      // One page at a time: a long document is never held in memory as pictures all at once.
      for (let page = 0; page < pdf.pageCount; page += 1) {
        const { raster } = await pdf.renderPage(page);
        const analysis = await analysePicture(await encodeRasterAs(raster, "png"), context);
        for (const finding of analysis.findings) {
          items.push(
            pictureItem(finding, { type: "region", page, polygon: finding.polygon }, mode),
          );
        }
        for (const warning of analysis.warnings) warnings.add(warning);
      }
      return { items, warnings: [...warnings] };
    } finally {
      await pdf.close();
    }
  },
  apply: async (file, items, context) => {
    const pdf = await openPdf(file.bytes, context.pdf);
    try {
      const replacements = new Map<string, string>();
      const builder = new PagePdfBuilder();
      for (let page = 0; page < pdf.pageCount; page += 1) {
        const rendered = await pdf.renderPage(page);
        const boxes = items.flatMap((item) => {
          const polygon = regionOf(item, page);
          return polygon === undefined ? [] : [{ ...item, polygon }];
        });
        await builder.addPage(
          paintItems(rendered.raster, boxes, context, replacements),
          rendered.widthPoints,
          rendered.heightPoints,
        );
      }
      return { bytes: builder.finish(), mediaType: "application/pdf", replacements };
    } finally {
      await pdf.close();
    }
  },
  // A box stays on its page for as long as the document has that page.
  reanchor: async (file, items) => {
    const pdf = await openPdf(file.bytes);
    try {
      const anchors = new Map<string, ItemTarget>();
      for (const item of items) {
        if (item.target.type === "region" && item.target.page < pdf.pageCount) {
          anchors.set(item.id, item.target);
        }
      }
      return anchors;
    } finally {
      await pdf.close();
    }
  },
};
