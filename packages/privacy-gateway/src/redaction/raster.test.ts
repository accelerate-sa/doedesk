import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import sharp from "sharp";
import { describe, expect, it } from "vite-plus/test";

import {
  decodeImage,
  encodeRaster,
  type Raster,
  sniffImageFormat,
  UnreadableImageError,
} from "./raster.ts";

const WIDTH = 60;
const HEIGHT = 40;

/** A picture with no symmetry: a red block top left, a blue bar down the right, green below. */
const upright = (): Raster => {
  const data = Buffer.alloc(WIDTH * HEIGHT * 3, 255);
  const paint = (x0: number, y0: number, x1: number, y1: number, rgb: [number, number, number]) => {
    for (let y = y0; y < y1; y += 1) {
      for (let x = x0; x < x1; x += 1) data.set(rgb, (y * WIDTH + x) * 3);
    }
  };
  paint(0, 0, 20, 10, [200, 0, 0]);
  paint(52, 0, 60, 40, [0, 0, 200]);
  paint(0, 32, 30, 40, [0, 160, 0]);
  return { width: WIDTH, height: HEIGHT, data };
};

type Picture = ReturnType<typeof sharp>;

const raw = (raster: Raster) =>
  sharp(raster.data, { raw: { width: raster.width, height: raster.height, channels: 3 } });

/** The stored pixels a camera writes for each EXIF orientation of the upright picture. */
const stored = (orientation: number) => {
  const image = raw(upright());
  switch (orientation) {
    case 2:
      return image.flop();
    case 3:
      return image.rotate(180);
    case 4:
      return image.flip();
    // The library mirrors before it turns, whichever is written first.
    case 5:
      return image.rotate(90).flip();
    case 6:
      return image.rotate(270);
    case 7:
      return image.rotate(90).flop();
    case 8:
      return image.rotate(90);
    default:
      return image;
  }
};

describe("opening an image", () => {
  it.each([1, 2, 3, 4, 5, 6, 7, 8])(
    "applies EXIF orientation %i, so positions are those of the picture as seen",
    async (orientation) => {
      const file = await stored(orientation)
        .withMetadata({ orientation })
        .tiff({ compression: "lzw" })
        .toBuffer();
      const decoded = await decodeImage(file);
      expect([decoded.raster.width, decoded.raster.height]).toEqual([WIDTH, HEIGHT]);
      expect(decoded.raster.data.equals(upright().data)).toBe(true);
    },
  );

  it("flattens transparency onto white: what a transparent pixel hides is gone", async () => {
    const rgba = Buffer.alloc(WIDTH * HEIGHT * 4);
    for (let pixel = 0; pixel < WIDTH * HEIGHT; pixel += 1) {
      // Dark "writing" in the colour channels everywhere; opaque only in the top half.
      rgba.set([10, 10, 10, pixel < (WIDTH * HEIGHT) / 2 ? 255 : 0], pixel * 4);
    }
    const file = await sharp(rgba, { raw: { width: WIDTH, height: HEIGHT, channels: 4 } })
      .png()
      .toBuffer();
    const { raster } = await decodeImage(file);
    expect(raster.data.length).toBe(WIDTH * HEIGHT * 3);
    expect([...raster.data.subarray(0, 3)]).toEqual([10, 10, 10]);
    expect([...raster.data.subarray(raster.data.length - 3)]).toEqual([255, 255, 255]);
  });

  it("blends a half-transparent pixel with white instead of keeping an alpha channel", async () => {
    const rgba = Buffer.alloc(WIDTH * HEIGHT * 4);
    for (let pixel = 0; pixel < WIDTH * HEIGHT; pixel += 1) rgba.set([0, 0, 0, 128], pixel * 4);
    const file = await sharp(rgba, { raw: { width: WIDTH, height: HEIGHT, channels: 4 } })
      .png()
      .toBuffer();
    const { raster } = await decodeImage(file);
    expect(raster.data[0]).toBeGreaterThan(120);
    expect(raster.data[0]).toBeLessThan(135);
  });

  it.each([
    ["CMYK JPEG", (image: Picture) => image.toColourspace("cmyk").jpeg({ quality: 95 })],
    ["progressive JPEG", (image: Picture) => image.jpeg({ quality: 95, progressive: true })],
    ["greyscale JPEG", (image: Picture) => image.greyscale().jpeg({ quality: 95 })],
    ["16-bit PNG", (image: Picture) => image.toColourspace("rgb16").png()],
    ["palette PNG", (image: Picture) => image.png({ palette: true, colours: 8 })],
    ["lossless WebP", (image: Picture) => image.webp({ lossless: true })],
    ["AVIF", (image: Picture) => image.avif({ lossless: true })],
  ])("opens a %s as three bytes a pixel", async (_name, encode) => {
    const { raster } = await decodeImage(await encode(raw(upright())).toBuffer());
    expect([raster.width, raster.height, raster.data.length]).toEqual([
      WIDTH,
      HEIGHT,
      WIDTH * HEIGHT * 3,
    ]);
    // The blue bar is still on the right: darker in red than the white beside the red block.
    expect(raster.data[(5 * WIDTH + 56) * 3]).toBeLessThan(90);
    expect(raster.data[(20 * WIDTH + 30) * 3]).toBeGreaterThan(200);
  });

  it("takes the first frame of an animation and the first page of a TIFF, and counts the rest", async () => {
    const other = Buffer.alloc(WIDTH * HEIGHT * 3, 40);
    const frames = await Promise.all(
      [upright().data, other].map((data) =>
        sharp(data, { raw: { width: WIDTH, height: HEIGHT, channels: 3 } })
          .png()
          .toBuffer(),
      ),
    );
    const gif = await sharp(frames, { join: { animated: true } })
      .gif()
      .toBuffer();
    const tiff = await sharp(frames, { join: { animated: true } })
      .tiff()
      .toBuffer();
    for (const file of [gif, tiff]) {
      const decoded = await decodeImage(file);
      expect(decoded.frames).toBe(2);
      expect([decoded.raster.width, decoded.raster.height]).toEqual([WIDTH, HEIGHT]);
      // White paper from the first frame, not the dark second one.
      expect(decoded.raster.data[(20 * WIDTH + 30) * 3]).toBeGreaterThan(200);
    }
  });

  it("opens HEIC with the system's own decoder, upright", async () => {
    if (!NodeFS.existsSync("/usr/bin/sips")) return;
    const folder = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "doedesk-heic-test-"));
    try {
      const source = NodePath.join(folder, "in.png");
      const target = NodePath.join(folder, "out.heic");
      await raw(upright())
        .resize(WIDTH * 4, HEIGHT * 4, { kernel: "nearest" })
        .png()
        .toFile(source);
      NodeChildProcess.execFileSync("/usr/bin/sips", [
        "-s",
        "format",
        "heic",
        source,
        "--out",
        target,
      ]);
      const file = NodeFS.readFileSync(target);
      expect(sniffImageFormat(file)).toBe("heif");
      const { raster } = await decodeImage(file);
      expect([raster.width, raster.height]).toEqual([WIDTH * 4, HEIGHT * 4]);
      expect(raster.data[(20 * raster.width + 224) * 3]).toBeLessThan(90);
    } finally {
      NodeFS.rmSync(folder, { recursive: true, force: true });
    }
  });

  it("opens a file as what its first bytes say it is, whatever it is called", async () => {
    const png = await raw(upright()).png().toBuffer();
    const jpeg = await raw(upright()).jpeg().toBuffer();
    expect(sniffImageFormat(png)).toBe("png");
    expect(sniffImageFormat(jpeg)).toBe("jpeg");
    expect((await decodeImage(png)).format).toBe("png");
  });

  it.each([
    ["an empty file", Buffer.alloc(0)],
    ["plain text", Buffer.from("Khalid Al-Otaibi 1087654321 ".repeat(10))],
    [
      "an SVG drawing",
      Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"/>'),
    ],
    ["a PDF", Buffer.from("%PDF-1.7\n%âãÏÓ\n1 0 obj\n")],
    ["a web page", Buffer.from("<!doctype html><html><body>Khalid</body></html>")],
    [
      "a bitmap, which the library cannot open",
      Buffer.concat([Buffer.from("BM"), Buffer.alloc(60)]),
    ],
  ])("refuses %s", async (_name, bytes) => {
    await expect(decodeImage(bytes)).rejects.toBeInstanceOf(UnreadableImageError);
  });

  it("refuses a picture that is cut off, and one too large to open safely", async () => {
    const png = await raw(upright()).png().toBuffer();
    await expect(decodeImage(png.subarray(0, 60))).rejects.toBeInstanceOf(UnreadableImageError);
    const jpeg = await raw(upright()).resize(600, 400).jpeg().toBuffer();
    await expect(decodeImage(jpeg.subarray(0, jpeg.length / 2))).rejects.toBeInstanceOf(
      UnreadableImageError,
    );
    const huge = await sharp({
      create: { width: 12_000, height: 11_000, channels: 3, background: "#ffffff" },
    })
      .png({ compressionLevel: 9 })
      .toBuffer();
    await expect(decodeImage(huge)).rejects.toBeInstanceOf(UnreadableImageError);
  });
});

describe("writing an image", () => {
  it("writes the same bytes for the same pixels, and nothing but pixels", async () => {
    const first = await encodeRaster(upright(), 1_000_000);
    const second = await encodeRaster(upright(), 1_000_000);
    expect(first.mediaType).toBe("image/png");
    expect(first.bytes.equals(second.bytes)).toBe(true);
    const metadata = await sharp(first.bytes).metadata();
    expect(metadata).toMatchObject({ channels: 3, hasAlpha: false });
    expect(metadata.exif ?? metadata.icc ?? metadata.xmp).toBeUndefined();
  });

  it("writes a JPEG with no metadata segments when the PNG would be too large", async () => {
    const noisy = Buffer.from(
      Array.from({ length: 300 * 200 * 3 }, (_, index) => (index * 2654435761) >>> 24),
    );
    const encoded = await encodeRaster({ width: 300, height: 200, data: noisy }, 10_000);
    expect(encoded.mediaType).toBe("image/jpeg");
    // Segment markers: application data other than JFIF's own, and comments, are metadata.
    const markers: Array<number> = [];
    for (let offset = 2; offset + 4 < encoded.bytes.length && encoded.bytes[offset] === 0xff;) {
      const marker = encoded.bytes[offset + 1] as number;
      if (marker === 0xda) break;
      markers.push(marker);
      offset += 2 + encoded.bytes.readUInt16BE(offset + 2);
    }
    expect(
      markers.filter((marker) => (marker >= 0xe1 && marker <= 0xef) || marker === 0xfe),
    ).toEqual([]);
  });
});
