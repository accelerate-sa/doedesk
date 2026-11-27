import { encodeRasterAs, sniffImageFormat } from "../../redaction/raster.ts";
import type { ItemTarget, LayerItem, NormalizedPoint } from "../layer.ts";
import { analysePicture, paintable, paintItems, pictureItem } from "./pictures.ts";
import type { FormatHandler } from "./shared.ts";

/**
 * Pictures: what is written in them is read and searched, their QR codes and barcodes are
 * decoded, and a person may draw boxes of their own. The copy that is written is the same kind
 * of file, made from pixels alone: no EXIF, no position, no thumbnail of the original.
 */

const MEDIA_TYPES = { png: "image/png", jpeg: "image/jpeg", webp: "image/webp" } as const;

/** The format the copy is written in: the picture's own where it is one of ours, else PNG. */
const writtenAs = (bytes: Buffer): keyof typeof MEDIA_TYPES => {
  const format = sniffImageFormat(bytes);
  return format === "jpeg" || format === "webp" ? format : "png";
};

export const regionOf = (
  item: LayerItem,
  page: number,
): ReadonlyArray<NormalizedPoint> | undefined =>
  item.target.type === "region" && item.target.page === page ? item.target.polygon : undefined;

export const imageHandler: FormatHandler = {
  family: "image",
  extensions: [".png", ".jpg", ".jpeg", ".webp"],
  detect: async (file, context, mode) => {
    const { findings, warnings } = await analysePicture(file.bytes, context);
    return {
      items: findings.map((finding) =>
        pictureItem(finding, { type: "region", page: 0, polygon: finding.polygon }, mode),
      ),
      warnings,
    };
  },
  apply: async (file, items, context) => {
    const replacements = new Map<string, string>();
    const boxes = items.flatMap((item) => {
      const polygon = regionOf(item, 0);
      return polygon === undefined ? [] : [{ ...item, polygon }];
    });
    const format = writtenAs(file.bytes);
    const painted = paintItems(await paintable(file.bytes, context), boxes, context, replacements);
    return {
      bytes: await encodeRasterAs(painted, format),
      mediaType: MEDIA_TYPES[format],
      replacements,
    };
  },
  // A box marks a place on the picture, and the place is still there.
  reanchor: async (_file, items) =>
    new Map<string, ItemTarget>(
      items.flatMap((item) =>
        item.target.type === "region" && item.target.page === 0 ? [[item.id, item.target]] : [],
      ),
    ),
};
