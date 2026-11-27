import type { EntityKind } from "../../placeholders.ts";
import {
  type DeidentificationMode,
  type FoundSpan,
  otherOccurrences,
  type Pseudonymizer,
  REDACTED_LABEL,
} from "../../pseudonymizer.ts";
import type { LayoutReader, RedactionPolicy } from "../../redaction/redactImage.ts";
import { autoItemId, type FormatFamily, type ItemTarget, type LayerItem } from "../layer.ts";
import type { PdfRenderOptions } from "../pdfPages.ts";

/** A file to de-identify: its bytes as they are on disk, and the path it is known by. */
export interface SourceFile {
  readonly path: string;
  readonly bytes: Buffer;
  readonly mtimeMs?: number | undefined;
}

/** What de-identification works with. Everything here runs on this computer but the reader. */
export interface DeidentifyContext {
  /** The gateway's own: its detector finds values, its vault keeps the masked ones. */
  readonly pseudonymizer: Pseudonymizer;
  /**
   * Reads the words of a picture and says where each is. Without one, pictures and PDF pages
   * are checked for QR codes and barcodes only, and are hidden whole until a person decides.
   */
  readonly reader?: LayoutReader | undefined;
  readonly neverMask?: ReadonlyArray<string> | undefined;
  readonly policy?: Partial<RedactionPolicy> | undefined;
  readonly pdf?: PdfRenderOptions | undefined;
}

export interface Detection {
  readonly items: ReadonlyArray<LayerItem>;
  readonly warnings: ReadonlyArray<string>;
}

export interface AppliedFile {
  readonly bytes: Buffer;
  readonly mediaType: string;
  /** What was written for each item that was acted on, by the item's id. */
  readonly replacements: ReadonlyMap<string, string>;
}

/** One kind of file: how it is searched, how a layer is applied to it, how it is written out. */
export interface FormatHandler {
  readonly family: FormatFamily;
  readonly extensions: ReadonlyArray<string>;
  /** Finds what is in the file. Makes no stand-in and writes nothing to the vault. */
  readonly detect: (
    file: SourceFile,
    context: DeidentifyContext,
    mode: DeidentificationMode,
  ) => Promise<Detection>;
  /** Writes the file again with every item's action carried out. The file itself is not touched. */
  readonly apply: (
    file: SourceFile,
    items: ReadonlyArray<LayerItem>,
    context: DeidentifyContext,
  ) => Promise<AppliedFile>;
  /** Where each of a person's items is in the file as it is now; left out when it is gone. */
  readonly reanchor: (
    file: SourceFile,
    items: ReadonlyArray<LayerItem>,
  ) => Promise<ReadonlyMap<string, ItemTarget>>;
}

/** The file is not one this handler can open. */
export class UnreadableDocumentError extends Error {
  override readonly name = "UnreadableDocumentError";
}

const KIND_LABELS: Readonly<Record<EntityKind, string>> = {
  PERSON: "Name",
  ORG: "Organisation",
  LOCATION: "Place",
  ADDRESS: "Address",
  PHONE: "Phone number",
  EMAIL: "Email address",
  ID: "ID number",
  IBAN: "IBAN",
  ACCOUNT: "Account number",
  DATE: "Date",
  URL: "Link",
  AMOUNT: "Amount",
  PARCEL: "Parcel",
  DEED: "Deed",
  CASE: "Case",
  OTHER: "Other",
};

export const labelOfKind = (kind: EntityKind): string => KIND_LABELS[kind];

/**
 * What detection finds in the texts of one file, without a stand-in being made. A value found
 * in one text is found in all of them: the name a detector saw on page one is hidden on page
 * three, where it missed it.
 */
export const findInTexts = async (
  context: DeidentifyContext,
  texts: ReadonlyArray<string>,
): Promise<ReadonlyArray<ReadonlyArray<FoundSpan>>> => {
  const found = await context.pseudonymizer.find(texts, context.neverMask ?? []);
  const values = texts.flatMap((text, index) =>
    (found[index] ?? []).map((span) => ({
      surface: text.slice(span.start, span.end),
      kind: span.kind,
    })),
  );
  return texts.map((text, index) => {
    const spans = found[index] ?? [];
    const repeated = otherOccurrences(text, values, spans).map((span): FoundSpan => ({
      ...span,
      known: false,
    }));
    return [...spans, ...repeated].toSorted((left, right) => left.start - right.start);
  });
};

/** The automatic item for a value found at a place. */
export const foundItem = (
  target: ItemTarget,
  kind: EntityKind,
  preview: string,
  mode: DeidentificationMode,
): LayerItem => ({
  id: autoItemId(target, kind, preview),
  source: "auto",
  action: mode,
  kind,
  label: labelOfKind(kind),
  preview,
  target,
});

/**
 * What an item's action writes where `surface` stands, or nothing for an item that is kept.
 * Only here is a stand-in made, and only for a value that is masked.
 */
export const replacementFor = (
  item: LayerItem,
  surface: string,
  context: DeidentifyContext,
): string | undefined => {
  if (item.action === "keep") return undefined;
  if (item.action === "redact" || surface.trim() === "") return REDACTED_LABEL;
  return context.pseudonymizer.vault.tokenFor(item.kind, surface);
};

export interface SpanEdit {
  readonly start: number;
  readonly end: number;
  readonly replacement: string;
}

/**
 * The stretches of one text that items act on, in order and apart: where two overlap, a
 * person's own item stands before a found one, and a longer before a shorter.
 */
export const spanEdits = (
  text: string,
  items: ReadonlyArray<
    LayerItem & { readonly span: { readonly start: number; readonly end: number } }
  >,
  context: DeidentifyContext,
  replacements: Map<string, string>,
): ReadonlyArray<SpanEdit> => {
  const ranked = items
    .filter(
      (item) =>
        item.span.start >= 0 && item.span.end <= text.length && item.span.start < item.span.end,
    )
    .toSorted(
      (left, right) =>
        Number(right.source === "manual") - Number(left.source === "manual") ||
        right.span.end - right.span.start - (left.span.end - left.span.start),
    );
  const taken: Array<{ readonly start: number; readonly end: number; readonly item: LayerItem }> =
    [];
  for (const item of ranked) {
    if (taken.every((other) => item.span.end <= other.start || item.span.start >= other.end)) {
      taken.push({ ...item.span, item });
    }
  }
  const edits: Array<SpanEdit> = [];
  for (const { start, end, item } of taken.toSorted((left, right) => left.start - right.start)) {
    // A kept item still holds its place: nothing found under it is hidden against its word.
    const replacement = replacementFor(item, text.slice(start, end), context);
    if (replacement === undefined) continue;
    replacements.set(item.id, replacement);
    edits.push({ start, end, replacement });
  }
  return edits;
};

export const rewriteSpans = (text: string, edits: ReadonlyArray<SpanEdit>): string => {
  let rewritten = "";
  let cursor = 0;
  for (const edit of edits) {
    rewritten += text.slice(cursor, edit.start) + edit.replacement;
    cursor = edit.end;
  }
  return rewritten + text.slice(cursor);
};

/** Where `preview` stands in `text`, the place nearest to where it was. */
export const nearestOccurrence = (
  text: string,
  preview: string | undefined,
  near: number,
): { readonly start: number; readonly end: number } | undefined => {
  if (preview === undefined || preview === "") return undefined;
  let best: number | undefined;
  let from = text.indexOf(preview);
  while (from !== -1) {
    if (best === undefined || Math.abs(from - near) < Math.abs(best - near)) best = from;
    from = text.indexOf(preview, from + 1);
  }
  return best === undefined ? undefined : { start: best, end: best + preview.length };
};

export const extensionOf = (path: string): string => {
  const name = path.slice(Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\")) + 1);
  const dot = name.lastIndexOf(".");
  return dot <= 0 ? "" : name.slice(dot).toLowerCase();
};
