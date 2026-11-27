import { describe, expect, it } from "vite-plus/test";

import { imageSize } from "./imageSize.ts";
import { codePointsToUtf16, splitIntoChunks, utf8BytesToUtf16 } from "./offsets.ts";
import { pngOfSize } from "./testkit.ts";

describe("positions counted another way", () => {
  it("turns code points into UTF-16 units", () => {
    const text = "a🙂b😀c";
    const toUnits = codePointsToUtf16(text);
    expect([0, 1, 2, 3, 4, 5].map(toUnits)).toEqual([0, 1, 3, 4, 6, 7]);
    expect([6, -1, 1.5].map(toUnits)).toEqual([undefined, undefined, undefined]);
    const plain = codePointsToUtf16("سارة");
    expect([0, 4, 5, -1].map(plain)).toEqual([0, 4, undefined, undefined]);
  });

  it("turns UTF-8 bytes into UTF-16 units for every width of character", () => {
    // 1, 2, 3 and 4 bytes: a, é, س is 2 bytes, € is 3, 🙂 is 4 bytes and 2 units.
    const text = "aé€🙂س";
    const bytes = utf8BytesToUtf16(text);
    const boundaries = [0, 1, 3, 6, 10, 12];
    expect(boundaries.map(bytes.start)).toEqual([0, 1, 2, 3, 5, 6]);
    expect(boundaries.map(bytes.end)).toEqual([0, 1, 2, 3, 5, 6]);
    // Inside the emoji: a start falls back to its first unit, an end goes on to its last.
    expect([bytes.start(8), bytes.end(8)]).toEqual([3, 5]);
    expect([bytes.start(13), bytes.end(-1)]).toEqual([undefined, undefined]);
    for (const [index, boundary] of boundaries.entries()) {
      expect(Buffer.byteLength(text.slice(0, bytes.start(boundary))), String(index)).toBe(boundary);
    }
  });

  it("splits a long text without cutting a character in two", () => {
    const text = "🙂".repeat(5);
    const chunks = splitIntoChunks(text, 5);
    expect(chunks.map((chunk) => chunk.text)).toEqual(["🙂🙂", "🙂🙂", "🙂"]);
    expect(chunks.map((chunk) => chunk.offset)).toEqual([0, 4, 8]);
    const words = splitIntoChunks("one two three four five", 10);
    expect(words.map((chunk) => chunk.text).join("")).toBe("one two three four five");
    expect(words.every((chunk) => chunk.text.length <= 10)).toBe(true);
  });
});

describe("imageSize", () => {
  /** A JPEG's markers up to its frame header, with an EXIF orientation when one is given. */
  const jpeg = (width: number, height: number, orientation?: number) => {
    const frame = Buffer.from([
      0xff,
      0xc0,
      0x00,
      0x11,
      0x08,
      0,
      0,
      0,
      0,
      0x03,
      ...Array.from({ length: 9 }, () => 0),
    ]);
    frame.writeUInt16BE(height, 5);
    frame.writeUInt16BE(width, 7);
    const exif =
      orientation === undefined
        ? Buffer.alloc(0)
        : Buffer.concat([
            Buffer.from([0xff, 0xe1, 0x00, 0x22]),
            Buffer.from("Exif\0\0MM\0*\0\0\0\x08\0\x01\x01\x12\0\x03\0\0\0\x01", "latin1"),
            Buffer.from([0x00, orientation, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]),
          ]);
    return Buffer.concat([Buffer.from([0xff, 0xd8]), exif, frame]);
  };

  it("reads the size of a PNG and of a JPEG", () => {
    expect(imageSize(pngOfSize(1000, 500))).toEqual({ width: 1000, height: 500 });
    expect(imageSize(jpeg(640, 480))).toEqual({ width: 640, height: 480 });
    expect(imageSize(jpeg(640, 480, 1))).toEqual({ width: 640, height: 480 });
  });

  it("gives no size for a turned JPEG or a file that is not a picture", () => {
    expect(imageSize(jpeg(640, 480, 6))).toBeUndefined();
    expect(imageSize(Buffer.from("%PDF-1.7"))).toBeUndefined();
    expect(imageSize(Buffer.alloc(0))).toBeUndefined();
    expect(imageSize(pngOfSize(0, 500))).toBeUndefined();
  });
});
