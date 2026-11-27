import { patternDetector } from "../detect.ts";
import { Pseudonymizer } from "../pseudonymizer.ts";
import { encodeRasterAs, type Raster, sniffImageFormat } from "../redaction/raster.ts";
import { Vault } from "../vault.ts";
import { docxFormat } from "./formats/docx.ts";
import type { OfficeFormat } from "./formats/office.ts";
import { openPackage, partsMatching, readPart, readTextPart } from "./formats/ooxml.ts";
import { paintable, paintItems } from "./formats/pictures.ts";
import { pptxFormat } from "./formats/pptx.ts";
import { type DeidentifyContext, extensionOf, type SourceFile } from "./formats/shared.ts";
import type { LayerItem, NormalizedPoint } from "./layer.ts";
import { openPdf } from "./pdfPages.ts";

/**
 * What a person is shown of a file while they decide what to do with it: its pages and pictures
 * as they are and as the layer would leave them, and the text of an Office file as the engine
 * reads it. Nothing here writes a file, and nothing here makes a stand-in the vault keeps.
 */

/**
 * The same context with a vault of its own, in memory. A preview shows what a masked value
 * would look like without filing the value: a person may still choose to redact it.
 */
export const previewContextOf = (context: DeidentifyContext): DeidentifyContext => ({
  ...context,
  pseudonymizer: new Pseudonymizer(new Vault(), patternDetector),
});

/** A page of a PDF or a picture: the file's own (`page` 0) or one embedded in an Office file. */
export type PreviewPlace =
  | { readonly type: "page"; readonly page: number }
  | { readonly type: "media"; readonly part: string };

export interface PreviewPicture {
  readonly bytes: Buffer;
  readonly mediaType: "image/png" | "image/jpeg";
  readonly width: number;
  readonly height: number;
}

/** The place asked for is not in the file. */
export class PreviewPlaceError extends Error {
  override readonly name = "PreviewPlaceError";
}

const officeFormatOf = (path: string): OfficeFormat | undefined => {
  const extension = extensionOf(path);
  return extension === ".docx" ? docxFormat : extension === ".pptx" ? pptxFormat : undefined;
};

const outlineAt = (
  item: LayerItem,
  place: PreviewPlace,
): ReadonlyArray<NormalizedPoint> | undefined => {
  const { target } = item;
  if (place.type === "page") {
    return target.type === "region" && target.page === place.page ? target.polygon : undefined;
  }
  return target.type === "media" && target.part === place.part ? target.polygon : undefined;
};

const rasterAt = async (
  file: SourceFile,
  place: PreviewPlace,
  context: DeidentifyContext,
): Promise<{ readonly raster: Raster; readonly photo: boolean }> => {
  if (place.type === "media") {
    const format = officeFormatOf(file.path);
    if (format === undefined) throw new PreviewPlaceError("The file holds no embedded pictures.");
    const zip = await openPackage(file.bytes, format.name);
    const bytes = format.media.test(place.part)
      ? await zip.file(place.part)?.async("nodebuffer")
      : undefined;
    if (bytes === undefined) throw new PreviewPlaceError("The file holds no such picture.");
    return {
      raster: await paintable(bytes, context),
      photo: sniffImageFormat(bytes) === "jpeg",
    };
  }
  if (extensionOf(file.path) === ".pdf") {
    const pdf = await openPdf(file.bytes, context.pdf);
    try {
      if (place.page < 0 || place.page >= pdf.pageCount) {
        throw new PreviewPlaceError("The PDF has no such page.");
      }
      return { raster: (await pdf.renderPage(place.page)).raster, photo: false };
    } finally {
      await pdf.close();
    }
  }
  if (place.page !== 0) throw new PreviewPlaceError("A picture has one page.");
  return {
    raster: await paintable(file.bytes, context),
    photo: sniffImageFormat(file.bytes) === "jpeg",
  };
};

/**
 * One page or picture of a file. Without `items` it is shown as it is; with them, as the copy
 * would show it: every item that is not kept under its box. The outlines of a layer are shares
 * of this picture's width and height.
 */
export const previewPicture = async (
  file: SourceFile,
  place: PreviewPlace,
  context: DeidentifyContext,
  items?: ReadonlyArray<LayerItem>,
): Promise<PreviewPicture> => {
  const { raster, photo } = await rasterAt(file, place, context);
  const boxes = (items ?? []).flatMap((item) => {
    const polygon = outlineAt(item, place);
    return polygon === undefined ? [] : [{ ...item, polygon }];
  });
  const shown =
    boxes.length === 0 ? raster : paintItems(raster, boxes, previewContextOf(context), new Map());
  return {
    bytes: await encodeRasterAs(shown, photo ? "jpeg" : "png"),
    mediaType: photo ? "image/jpeg" : "image/png",
    width: shown.width,
    height: shown.height,
  };
};

/** The size of each page of a PDF in points, or of a picture in pixels as it is painted on. */
export const previewPageSizes = async (
  file: SourceFile,
  context: DeidentifyContext,
): Promise<ReadonlyArray<{ readonly width: number; readonly height: number }>> => {
  if (extensionOf(file.path) !== ".pdf") {
    const raster = await paintable(file.bytes, context);
    return [{ width: raster.width, height: raster.height }];
  }
  const pdf = await openPdf(file.bytes, context.pdf);
  try {
    const sizes: Array<{ readonly width: number; readonly height: number }> = [];
    for (let page = 0; page < pdf.pageCount; page += 1) sizes.push(await pdf.pageSize(page));
    return sizes;
  } finally {
    await pdf.close();
  }
};

export interface OfficeDocumentModel {
  /**
   * Every part that holds text, as the engine reads it: an item's `start` and `end` count into
   * this text. A paragraph is a line; a table's row is one line with a tab between its cells.
   */
  readonly parts: ReadonlyArray<{ readonly name: string; readonly text: string }>;
  /** Every embedded picture. `width` and `height` are absent for one that cannot be opened. */
  readonly media: ReadonlyArray<{
    readonly part: string;
    readonly width?: number | undefined;
    readonly height?: number | undefined;
  }>;
}

/** The text and the pictures of a Word or PowerPoint file, for whoever shows them to a person. */
export const readOfficeDocument = async (
  file: SourceFile,
  context: DeidentifyContext,
): Promise<OfficeDocumentModel> => {
  const format = officeFormatOf(file.path);
  if (format === undefined) throw new PreviewPlaceError("The file is not an Office document.");
  const zip = await openPackage(file.bytes, format.name);
  const parts = await Promise.all(
    partsMatching(zip, format.textParts).map(async (name) => {
      const part = readTextPart(name, (await readPart(zip, name)) ?? "", format.grammar);
      return { name: part.name, text: part.text };
    }),
  );
  const media = await Promise.all(
    partsMatching(zip, format.media).map(async (part) => {
      const bytes = await zip.file(part)?.async("nodebuffer");
      try {
        if (bytes === undefined) return { part };
        const raster = await paintable(bytes, context);
        return { part, width: raster.width, height: raster.height };
      } catch {
        return { part };
      }
    }),
  );
  return { parts, media };
};
