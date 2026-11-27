import { encodeRasterAs, sniffImageFormat } from "../../redaction/raster.ts";
import type { FormatFamily, ItemTarget, LayerItem } from "../layer.ts";
import {
  openPackage,
  partsMatching,
  readPart,
  readTextPart,
  rewriteTextPart,
  scrubLinks,
  scrubProperties,
  type TextGrammar,
  writePackage,
} from "./ooxml.ts";
import { analysePicture, paintable, paintItems, pictureItem } from "./pictures.ts";
import {
  findInTexts,
  type FormatHandler,
  foundItem,
  nearestOccurrence,
  spanEdits,
} from "./shared.ts";

/**
 * Word and PowerPoint files. Their text is read from the XML it is stored in, which holds it in
 * the order it is read, Arabic included; their pictures are read, searched and painted like any
 * other picture. The copy is the same package with the text and pictures replaced in place.
 */

export interface OfficeFormat {
  readonly family: FormatFamily;
  readonly extension: string;
  readonly mediaType: string;
  /** For a person, in an error: "Word document". */
  readonly name: string;
  /** The parts that hold text a person reads. */
  readonly textParts: RegExp;
  /** The pictures embedded in the file. */
  readonly media: RegExp;
  readonly grammar: TextGrammar;
}

/** Picture formats that can be opened and written back as the same kind of file. */
const WRITABLE = new Set(["png", "jpeg", "webp", "gif", "tiff"] as const);
type Writable = typeof WRITABLE extends ReadonlySet<infer Format> ? Format : never;

const writableFormat = (bytes: Buffer): Writable | undefined => {
  const format = sniffImageFormat(bytes);
  return format !== undefined && (WRITABLE as ReadonlySet<string>).has(format)
    ? (format as Writable)
    : undefined;
};

export const makeOfficeHandler = (format: OfficeFormat): FormatHandler => ({
  family: format.family,
  extensions: [format.extension],
  detect: async (file, context, mode) => {
    const zip = await openPackage(file.bytes, format.name);
    const items: Array<LayerItem> = [];
    const warnings = new Set<string>();
    const parts = await Promise.all(
      partsMatching(zip, format.textParts).map(async (name) =>
        readTextPart(name, (await readPart(zip, name)) ?? "", format.grammar),
      ),
    );
    const found = await findInTexts(
      context,
      parts.map((part) => part.text),
    );
    parts.forEach((part, index) => {
      for (const span of found[index] ?? []) {
        items.push(
          foundItem(
            { type: "xml", part: part.name, start: span.start, end: span.end },
            span.kind,
            part.text.slice(span.start, span.end),
            mode,
          ),
        );
      }
    });
    for (const name of partsMatching(zip, format.media)) {
      const bytes = await zip.file(name)?.async("nodebuffer");
      if (bytes === undefined) continue;
      // A drawing that is not pixels (EMF, WMF, SVG) cannot be read or painted here.
      if (writableFormat(bytes) === undefined) {
        warnings.add(`unscanned-media: ${name}`);
        continue;
      }
      const analysis = await analysePicture(bytes, context);
      for (const finding of analysis.findings) {
        items.push(
          pictureItem(finding, { type: "media", part: name, polygon: finding.polygon }, mode),
        );
      }
      for (const warning of analysis.warnings) warnings.add(warning);
    }
    return { items, warnings: [...warnings] };
  },
  apply: async (file, items, context) => {
    const zip = await openPackage(file.bytes, format.name);
    const replacements = new Map<string, string>();
    for (const name of partsMatching(zip, format.textParts)) {
      const here = items.flatMap((item) =>
        item.target.type === "xml" && item.target.part === name
          ? [{ ...item, span: { start: item.target.start, end: item.target.end } }]
          : [],
      );
      if (here.length === 0) continue;
      const part = readTextPart(name, (await readPart(zip, name)) ?? "", format.grammar);
      zip.file(name, rewriteTextPart(part, spanEdits(part.text, here, context, replacements)));
    }
    for (const name of partsMatching(zip, format.media)) {
      const boxes = items.flatMap((item) =>
        item.target.type === "media" && item.target.part === name && item.action !== "keep"
          ? [{ ...item, polygon: item.target.polygon }]
          : [],
      );
      const bytes = boxes.length === 0 ? undefined : await zip.file(name)?.async("nodebuffer");
      const written = bytes === undefined ? undefined : writableFormat(bytes);
      if (bytes === undefined || written === undefined) continue;
      const painted = paintItems(await paintable(bytes, context), boxes, context, replacements);
      zip.file(name, await encodeRasterAs(painted, written));
    }
    await scrubProperties(zip);
    const previews = (hidden: boolean) =>
      items.flatMap((item) =>
        item.preview !== undefined && (item.action !== "keep") === hidden ? [item.preview] : [],
      );
    await scrubLinks(zip, previews(true), previews(false));
    return { bytes: await writePackage(zip), mediaType: format.mediaType, replacements };
  },
  reanchor: async (file, items) => {
    const zip = await openPackage(file.bytes, format.name);
    const anchors = new Map<string, ItemTarget>();
    for (const item of items) {
      const { target } = item;
      if (target.type === "media" && zip.file(target.part) !== null) anchors.set(item.id, target);
      if (target.type !== "xml") continue;
      const xml = await readPart(zip, target.part);
      if (xml === undefined) continue;
      const { text } = readTextPart(target.part, xml, format.grammar);
      const found = nearestOccurrence(text, item.preview, target.start);
      if (found !== undefined) anchors.set(item.id, { type: "xml", part: target.part, ...found });
    }
    return anchors;
  },
});
