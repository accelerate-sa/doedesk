import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import type { Coverage } from "./geometry.ts";

/** Decoded pixels: three bytes a pixel, red, green, blue. No alpha, no metadata, one frame. */
export interface Raster {
  readonly width: number;
  readonly height: number;
  readonly data: Buffer;
}

/** The file could not be turned into pixels. It is withheld. */
export class UnreadableImageError extends Error {
  override readonly name = "UnreadableImageError";
}

export type ImageFormat = "png" | "jpeg" | "gif" | "webp" | "tiff" | "heif" | "avif";

/**
 * What a file is, from its first bytes. The media type a request declares is not trusted: a file
 * whose name or label lies is opened as what it is, and one that is no image at all is refused.
 */
export const sniffImageFormat = (bytes: Buffer): ImageFormat | undefined => {
  if (bytes.length < 12) return undefined;
  if (bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return "png";
  }
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "jpeg";
  const head = bytes.subarray(0, 12).toString("latin1");
  if (head.startsWith("GIF87a") || head.startsWith("GIF89a")) return "gif";
  if (head.startsWith("RIFF") && head.slice(8, 12) === "WEBP") return "webp";
  if (head.startsWith("II*\u0000") || head.startsWith("MM\u0000*")) return "tiff";
  if (head.slice(4, 8) === "ftyp") {
    const brand = head.slice(8, 12);
    if (brand === "avif" || brand === "avis") return "avif";
    if (["heic", "heix", "hevc", "hevx", "heim", "heis", "mif1", "msf1"].includes(brand)) {
      return "heif";
    }
  }
  return undefined;
};

/** Files larger than this in pixels are not opened: decoding them could exhaust memory. */
const MAX_INPUT_PIXELS = 120_000_000;

type SharpModule = typeof import("sharp").default;
let sharpModule: Promise<SharpModule> | undefined;
/** Loaded on first use, so a machine where it cannot load withholds images instead of failing. */
const loadSharp = (): Promise<SharpModule> => {
  sharpModule ??= import("sharp").then((module) => {
    const sharp = module.default;
    // No cache of files or operations: every image is a different person's document.
    sharp.cache(false);
    return sharp;
  });
  return sharpModule;
};

/** The image tool every Mac has. Its absence is how another system is told apart. */
const SIPS = "/usr/bin/sips";

const runSips = (input: string, output: string): Promise<void> =>
  new Promise((resolve, reject) => {
    NodeChildProcess.execFile(
      SIPS,
      ["-s", "format", "png", input, "--out", output],
      { timeout: 30_000 },
      (error) => (error === null ? resolve() : reject(error)),
    );
  });

/**
 * HEIC is opened by macOS itself: the image library's builds carry no HEVC decoder. Elsewhere
 * the file is refused. The converted file lives in a private folder for the length of the call.
 */
const heifToPng = async (bytes: Buffer): Promise<Buffer> => {
  if (!NodeFS.existsSync(SIPS)) {
    throw new UnreadableImageError("HEIC images can only be opened on macOS.");
  }
  const folder = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "doedesk-heif-"));
  try {
    NodeFS.chmodSync(folder, 0o700);
    const input = NodePath.join(folder, "in.heic");
    const output = NodePath.join(folder, "out.png");
    NodeFS.writeFileSync(input, bytes, { mode: 0o600 });
    await runSips(input, output);
    return NodeFS.readFileSync(output);
  } catch (cause) {
    if (cause instanceof UnreadableImageError) throw cause;
    throw new UnreadableImageError("The HEIC image could not be opened.", { cause });
  } finally {
    NodeFS.rmSync(folder, { recursive: true, force: true });
  }
};

export interface DecodedImage {
  readonly raster: Raster;
  readonly format: ImageFormat;
  /** Frames or pages in the file. Only the first is decoded. */
  readonly frames: number;
}

/**
 * Opens an image as plain pixels of its first frame, upright as EXIF asks, flattened onto white.
 * Left behind: EXIF with its position and thumbnail, XMP, colour profiles, PNG text chunks,
 * further frames, and whatever a transparent pixel hid.
 */
export const decodeImage = async (bytes: Buffer): Promise<DecodedImage> => {
  const format = sniffImageFormat(bytes);
  if (format === undefined) {
    throw new UnreadableImageError("The file is not an image DoeDesk can open.");
  }
  let sharp: SharpModule;
  try {
    sharp = await loadSharp();
  } catch (cause) {
    throw new UnreadableImageError("The image library could not be loaded.", { cause });
  }
  const source = format === "heif" ? await heifToPng(bytes) : bytes;
  try {
    const options = { limitInputPixels: MAX_INPUT_PIXELS, failOn: "error" as const, pages: 1 };
    const metadata = await sharp(source, options).metadata();
    const { data, info } = await sharp(source, options)
      .autoOrient()
      .flatten({ background: "#ffffff" })
      .toColourspace("srgb")
      .removeAlpha()
      .raw({ depth: "uchar" })
      .toBuffer({ resolveWithObject: true });
    if (info.channels !== 3 || data.length !== info.width * info.height * 3) {
      throw new UnreadableImageError("The image did not decode to plain colour pixels.");
    }
    return {
      raster: { width: info.width, height: info.height, data },
      format,
      frames: Math.max(1, metadata.pages ?? 1),
    };
  } catch (cause) {
    if (cause instanceof UnreadableImageError) throw cause;
    throw new UnreadableImageError("The image is damaged or could not be opened.", { cause });
  }
};

const rawOptions = (raster: Raster) => ({
  raw: { width: raster.width, height: raster.height, channels: 3 as const },
});

/** The raster at another size. Used to fit the reader's and the model's limits. */
export const resizeRaster = async (
  raster: Raster,
  width: number,
  height: number,
): Promise<Raster> => {
  if (width === raster.width && height === raster.height) return raster;
  const sharp = await loadSharp();
  const { data, info } = await sharp(raster.data, rawOptions(raster))
    .resize(width, height, { fit: "fill", kernel: "lanczos3" })
    .raw()
    .toBuffer({ resolveWithObject: true });
  return { width: info.width, height: info.height, data };
};

/** The raster on a white canvas of at least the given size, the picture at the top left. */
export const padRaster = (raster: Raster, minWidth: number, minHeight: number): Raster => {
  const width = Math.max(raster.width, minWidth);
  const height = Math.max(raster.height, minHeight);
  if (width === raster.width && height === raster.height) return raster;
  const data = Buffer.alloc(width * height * 3, 255);
  for (let row = 0; row < raster.height; row += 1) {
    raster.data.copy(data, row * width * 3, row * raster.width * 3, (row + 1) * raster.width * 3);
  }
  return { width, height, data };
};

export interface EncodedImage {
  readonly bytes: Buffer;
  readonly mediaType: "image/png" | "image/jpeg";
}

/**
 * Pixels as a file, written from the raster alone: no metadata goes in because none exists
 * here. PNG unless that is larger than `maxPngBytes`, then JPEG. The same raster always gives
 * the same bytes, which is what lets a conversation resend an image without it changing.
 */
export const encodeRaster = async (raster: Raster, maxPngBytes: number): Promise<EncodedImage> => {
  const sharp = await loadSharp();
  // A photograph of this size is never under the limit as PNG; do not spend the time finding out.
  if (raster.width * raster.height * 3 <= maxPngBytes * 6) {
    const png = await sharp(raster.data, rawOptions(raster))
      .png({ compressionLevel: 6, palette: false })
      .toBuffer();
    if (png.length <= maxPngBytes) return { bytes: png, mediaType: "image/png" };
  }
  const jpeg = await sharp(raster.data, rawOptions(raster))
    .jpeg({ quality: 92, chromaSubsampling: "4:4:4" })
    .toBuffer();
  return { bytes: jpeg, mediaType: "image/jpeg" };
};

/** Paints every covered pixel black. */
export const paintCoverage = (raster: Raster, coverage: Coverage): void => {
  const { data } = coverage;
  for (let index = 0; index < data.length; index += 1) {
    if (data[index] === 1) {
      raster.data[index * 3] = 0;
      raster.data[index * 3 + 1] = 0;
      raster.data[index * 3 + 2] = 0;
    }
  }
};

export const copyRaster = (raster: Raster): Raster => ({
  width: raster.width,
  height: raster.height,
  data: Buffer.from(raster.data),
});
