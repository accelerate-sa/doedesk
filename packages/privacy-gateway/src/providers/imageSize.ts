/**
 * The size in pixels of a PNG or JPEG, read from its header. Services that place words as
 * fractions of the page need it to say where a word is in the picture that was sent.
 */

export interface ImageSize {
  readonly width: number;
  readonly height: number;
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const pngSize = (bytes: Buffer): ImageSize | undefined =>
  bytes.length >= 24 && bytes.subarray(12, 16).toString("latin1") === "IHDR"
    ? { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) }
    : undefined;

/** True when EXIF asks a viewer to turn or mirror the picture. */
const exifTurns = (segment: Buffer): boolean => {
  if (segment.subarray(0, 6).toString("latin1") !== "Exif\0\0" || segment.length < 14) return false;
  const tiff = segment.subarray(6);
  const little = tiff.subarray(0, 2).toString("latin1") === "II";
  const u16 = (at: number) => (little ? tiff.readUInt16LE(at) : tiff.readUInt16BE(at));
  const directory = little ? tiff.readUInt32LE(4) : tiff.readUInt32BE(4);
  if (directory + 2 > tiff.length) return false;
  const entries = u16(directory);
  for (let index = 0; index < entries; index += 1) {
    const entry = directory + 2 + index * 12;
    if (entry + 12 > tiff.length) return false;
    if (u16(entry) === 0x0112) return u16(entry + 8) > 1;
  }
  return false;
};

const jpegSize = (bytes: Buffer): ImageSize | undefined => {
  let at = 2;
  while (at + 4 <= bytes.length) {
    if (bytes[at] !== 0xff) return undefined;
    const marker = bytes[at + 1] ?? 0;
    if (marker === 0xff) {
      at += 1;
      continue;
    }
    const length = bytes.readUInt16BE(at + 2);
    const segment = bytes.subarray(at + 4, at + 2 + length);
    // A turned picture has two sizes, and which one a service measured is not ours to guess.
    if (marker === 0xe1 && exifTurns(segment)) return undefined;
    const startOfFrame =
      marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (startOfFrame) {
      return segment.length >= 5
        ? { width: segment.readUInt16BE(3), height: segment.readUInt16BE(1) }
        : undefined;
    }
    at += 2 + length;
  }
  return undefined;
};

/** Undefined for any other format, a damaged header, or a JPEG that EXIF turns. */
export const imageSize = (bytes: Buffer): ImageSize | undefined => {
  const size = bytes.subarray(0, 8).equals(PNG_SIGNATURE)
    ? pngSize(bytes)
    : bytes[0] === 0xff && bytes[1] === 0xd8
      ? jpegSize(bytes)
      : undefined;
  return size !== undefined && size.width > 0 && size.height > 0 ? size : undefined;
};
