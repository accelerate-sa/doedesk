import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import type { DeidentificationAction, DeidentificationMode } from "../pseudonymizer.ts";
import { docxHandler } from "./formats/docx.ts";
import { imageHandler } from "./formats/image.ts";
import { pdfHandler } from "./formats/pdf.ts";
import { pptxHandler } from "./formats/pptx.ts";
import {
  type DeidentifyContext,
  extensionOf,
  type FormatHandler,
  type SourceFile,
} from "./formats/shared.ts";
import { csvHandler, xlsxHandler } from "./formats/spreadsheet.ts";
import { textHandler } from "./formats/text.ts";
import {
  type DeidentificationLayer,
  hashOfFile,
  type LayerItem,
  reconcileLayerOnFileChange,
} from "./layer.ts";

/**
 * De-identification of files, in two steps a person stands between: `deidentifyFile` returns a
 * layer of what was found, `applyLayer` and `exportDeidentified` write a copy with it carried
 * out. Only applying makes a stand-in, and only for a masked item: redaction leaves no trace.
 */

/** Every format that can be de-identified. Legacy .doc is not one: it has to be saved as .docx. */
const HANDLERS: ReadonlyArray<FormatHandler> = [
  textHandler,
  imageHandler,
  pdfHandler,
  csvHandler,
  xlsxHandler,
  docxHandler,
  pptxHandler,
];

export const SUPPORTED_EXTENSIONS: ReadonlyArray<string> = HANDLERS.flatMap(
  (handler) => handler.extensions,
);

/** The file's format is not one that can be de-identified. */
export class UnsupportedFormatError extends Error {
  override readonly name = "UnsupportedFormatError";
}

/** The file is not the one the layer was made from: it was edited since. */
export class StaleLayerError extends Error {
  override readonly name = "StaleLayerError";
}

/** The handler for a file, by its name. Undefined for a format that is not supported. */
export const formatOf = (path: string): FormatHandler | undefined => {
  const extension = extensionOf(path);
  return HANDLERS.find((handler) => handler.extensions.includes(extension));
};

const handlerFor = (path: string): FormatHandler => {
  const handler = formatOf(path);
  if (handler !== undefined) return handler;
  const extension = extensionOf(path);
  throw new UnsupportedFormatError(
    extension === ".doc"
      ? "Word 97-2003 files (.doc) cannot be de-identified. Save the file as .docx first."
      : `Files of type ${extension === "" ? "this kind" : extension} cannot be de-identified.`,
  );
};

export interface DeidentifyFileOptions {
  /** The project the file belongs to: with its path, what the layer is kept under. */
  readonly projectId: string;
  /** What is done with what is found, unless an item says otherwise. `mask` unless said. */
  readonly defaultMode?: DeidentificationMode | undefined;
  /** The layer the file already has. It is brought up to the file as it is now. */
  readonly existing?: DeidentificationLayer | undefined;
}

/**
 * Finds what is in a file and returns its layer. With a layer from before: the same content
 * gives the same layer back without looking again; changed content is searched again and the
 * layer reconciled (see `reconcileLayerOnFileChange`). Nothing is written to the vault.
 */
export const deidentifyFile = async (
  file: SourceFile,
  context: DeidentifyContext,
  options: DeidentifyFileOptions,
): Promise<DeidentificationLayer> => {
  const handler = handlerFor(file.path);
  const fileHash = hashOfFile(file.bytes);
  const fileMtimeMs = file.mtimeMs ?? 0;
  const { existing } = options;
  if (existing !== undefined && existing.fileHash === fileHash) {
    return reconcileLayerOnFileChange(existing, { fileHash, fileMtimeMs, items: [] }).layer;
  }
  const defaultMode = options.defaultMode ?? existing?.defaultMode ?? "mask";
  const detection = await handler.detect(file, context, defaultMode);
  if (existing === undefined) {
    return {
      version: 1,
      projectId: options.projectId,
      filePath: file.path,
      family: handler.family,
      fileHash,
      fileMtimeMs,
      defaultMode,
      reviewState: "unreviewed",
      items: detection.items,
      warnings: detection.warnings,
      updatedAt: new Date().toISOString(),
    };
  }
  const anchors = await handler.reanchor(
    file,
    existing.items.filter((item) => item.source === "manual"),
  );
  return reconcileLayerOnFileChange(existing, {
    fileHash,
    fileMtimeMs,
    items: detection.items,
    warnings: detection.warnings,
    reanchor: (item) => anchors.get(item.id),
  }).layer;
};

export interface AppliedLayer {
  /** The de-identified copy, in the format the file has. */
  readonly bytes: Buffer;
  readonly mediaType: string;
  /** The layer with what was written for each item. */
  readonly layer: DeidentificationLayer;
  /** How many items were masked, redacted and kept. */
  readonly counts: Readonly<Record<DeidentificationAction, number>>;
}

/**
 * Carries a layer out on its file and returns the copy. Refuses a file that is not the one the
 * layer was made from. A masked item's value goes to the vault here; a redacted item's goes
 * nowhere.
 */
export const applyLayer = async (
  file: SourceFile,
  layer: DeidentificationLayer,
  context: DeidentifyContext,
): Promise<AppliedLayer> => {
  const handler = handlerFor(file.path);
  if (hashOfFile(file.bytes) !== layer.fileHash) {
    throw new StaleLayerError(
      "The file was changed after it was checked. Check it again before making a copy.",
    );
  }
  const applied = await handler.apply(file, layer.items, context);
  const counts = { mask: 0, redact: 0, keep: 0 };
  const items = layer.items.map((item): LayerItem => {
    counts[item.action] += 1;
    const replacement = applied.replacements.get(item.id);
    return replacement === undefined
      ? { ...item, replacement: undefined }
      : { ...item, replacement };
  });
  return {
    bytes: applied.bytes,
    mediaType: applied.mediaType,
    layer: { ...layer, items, updatedAt: new Date().toISOString() },
    counts,
  };
};

export interface ExportedFile extends AppliedLayer {
  /** A name for the copy: the file's own with `.deidentified` before its type. */
  readonly fileName: string;
  /** Where the copy was written, when a place was given. */
  readonly path?: string | undefined;
}

/**
 * Applies a layer and names the copy. Given `outputPath`, the copy is written there, readable
 * by this user alone; it never replaces the file it was made from.
 */
export const exportDeidentified = async (
  file: SourceFile,
  layer: DeidentificationLayer,
  context: DeidentifyContext,
  options: { readonly outputPath?: string | undefined } = {},
): Promise<ExportedFile> => {
  const applied = await applyLayer(file, layer, context);
  const extension = NodePath.extname(file.path);
  const fileName = `${NodePath.basename(file.path, extension)}.deidentified${extension}`;
  const { outputPath } = options;
  if (outputPath === undefined) return { ...applied, fileName };
  if (NodePath.resolve(outputPath) === NodePath.resolve(file.path)) {
    throw new RangeError("A de-identified copy cannot be written over the file it was made from.");
  }
  NodeFS.mkdirSync(NodePath.dirname(outputPath), { recursive: true });
  NodeFS.writeFileSync(outputPath, applied.bytes, { mode: 0o600 });
  return { ...applied, fileName, path: outputPath };
};

export {
  addLayerItem,
  boxRegion,
  columnTarget,
  hashOfFile,
  layerKey,
  LayerStore,
  manualItem,
  rangeTarget,
  reconcileLayerOnFileChange,
  removeLayerItem,
  rowTarget,
  setDefaultMode,
  setItemAction,
  setReviewState,
} from "./layer.ts";
export type {
  CellsTarget,
  DeidentificationLayer,
  FileSnapshot,
  FormatFamily,
  ItemTarget,
  LayerItem,
  MediaTarget,
  NormalizedPoint,
  Reconciled,
  RegionTarget,
  ReviewState,
  TextTarget,
  XmlTarget,
} from "./layer.ts";
export type { DeidentifyContext, FormatHandler, SourceFile } from "./formats/shared.ts";
export { UnreadableDocumentError } from "./formats/shared.ts";
export { CSV_SHEET, readSpreadsheet } from "./formats/spreadsheet.ts";
export type { SheetModel } from "./formats/spreadsheet.ts";
export { openPdf, PagePdfBuilder, UnreadablePdfError } from "./pdfPages.ts";
export {
  previewContextOf,
  previewPageSizes,
  previewPicture,
  PreviewPlaceError,
  readOfficeDocument,
} from "./preview.ts";
export type { OfficeDocumentModel, PreviewPicture, PreviewPlace } from "./preview.ts";
export type { OpenedPdf, PdfRenderOptions, RenderedPage } from "./pdfPages.ts";
