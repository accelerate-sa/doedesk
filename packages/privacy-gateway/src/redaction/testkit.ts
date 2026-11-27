import sharp from "sharp";

import type { DetectedEntity, Detector } from "../detect.ts";
import { combineDetectors, patternDetector } from "../detect.ts";
import type { EntityKind } from "../placeholders.ts";
import { Pseudonymizer } from "../pseudonymizer.ts";
import { Vault } from "../vault.ts";
import type { LayoutReader } from "./redactImage.ts";

/**
 * A word painted on a test page, with what a reader would say it reads. It is painted as thin
 * upright strokes, as much ink to paper as print has, unless `solid`.
 */
export interface Planted {
  /** Painted as one solid block: for pages that are scaled, where strokes would blur away. */
  readonly solid?: boolean;
  readonly text: string;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly confidence?: number;
  /** Not on the page at the first reading: the reader finds it only on a re-read. */
  readonly late?: boolean;
}

/** The grey a planted word is painted in. A box is black and a label white, so it is neither. */
export const WORD_GREY = 128;

/** Whether the pixel `dx` columns into a word carries its ink. */
const inked = (word: Pick<Planted, "solid">, dx: number): boolean =>
  word.solid === true || dx % 4 === 0;

/** A white page with grey strokes where each word stands. */
export const paintPage = (
  width: number,
  height: number,
  words: ReadonlyArray<Planted>,
): { readonly width: number; readonly height: number; readonly data: Buffer } => {
  const data = Buffer.alloc(width * height * 3, 255);
  for (const word of words) {
    for (let y = Math.max(0, word.y); y < Math.min(height, word.y + word.height); y += 1) {
      for (let dx = 0; dx < word.width; dx += 1) {
        if (inked(word, dx))
          data.fill(WORD_GREY, (y * width + word.x + dx) * 3, (y * width + word.x + dx + 1) * 3);
      }
    }
  }
  return { width, height, data };
};

export const pngOf = (page: { width: number; height: number; data: Buffer }): Promise<Buffer> =>
  sharp(page.data, { raw: { width: page.width, height: page.height, channels: 3 } })
    .png()
    .toBuffer();

/** A line a word is on: words whose tops are within half a height of each other. */
const linesOf = (words: ReadonlyArray<Planted>): ReadonlyArray<ReadonlyArray<Planted>> => {
  const lines: Array<Array<Planted>> = [];
  for (const word of words.toSorted((a, b) => a.y - b.y || a.x - b.x)) {
    const line = lines.find(
      (members) => Math.abs((members[0] as Planted).y - word.y) < word.height / 2,
    );
    if (line === undefined) lines.push([word]);
    else line.push(word);
  }
  return lines.map((line) => line.toSorted((a, b) => a.x - b.x));
};

/** The reader's answer for words standing at given places of a picture of the given size. */
export const layoutAnswer = (
  width: number,
  height: number,
  words: ReadonlyArray<Planted>,
  scale = 1,
) => {
  let text = "";
  const layoutWords: Array<Record<string, unknown>> = [];
  const layoutLines: Array<Record<string, unknown>> = [];
  for (const line of linesOf(words)) {
    if (text.length > 0) text += "\n";
    const lineStart = text.length;
    line.forEach((word, position) => {
      if (position > 0) text += " ";
      const left = word.x * scale;
      const top = word.y * scale;
      const right = (word.x + word.width) * scale;
      const bottom = (word.y + word.height) * scale;
      layoutWords.push({
        text: word.text,
        polygon: [left, top, right, top, right, bottom, left, bottom],
        confidence: word.confidence ?? 0.99,
        offset: text.length,
        length: word.text.length,
      });
      text += word.text;
    });
    const first = line[0] as Planted;
    const last = line.at(-1) as Planted;
    layoutLines.push({
      polygon: [
        first.x * scale,
        first.y * scale,
        (last.x + last.width) * scale,
        first.y * scale,
        (last.x + last.width) * scale,
        (first.y + first.height) * scale,
        first.x * scale,
        (first.y + first.height) * scale,
      ],
      offset: lineStart,
      length: text.length - lineStart,
    });
  }
  return {
    text,
    pages: 1,
    layout: {
      pages: [
        { page: 1, width, height, unit: "pixel", angle: 0, words: layoutWords, lines: layoutLines },
      ],
      handwritten: [],
    },
  };
};

export interface PlantedReader extends LayoutReader {
  /** How many times the reader was asked. */
  readonly calls: () => number;
  /** The pictures it was given, newest last. */
  readonly seen: ReadonlyArray<Buffer>;
}

/**
 * A reader that knows where the words of a painted page are. It looks at the picture it is
 * given: a word whose block is still grey is read, one that has been covered is not. So it
 * reads a redacted picture the way a real reader would.
 */
export const plantedReader = (
  pageWidth: number,
  words: ReadonlyArray<Planted>,
  options: {
    readonly alter?: (answer: ReturnType<typeof layoutAnswer>, call: number) => unknown;
  } = {},
): PlantedReader => {
  let calls = 0;
  const seen: Array<Buffer> = [];
  return {
    calls: () => calls,
    seen,
    readLayout: async (bytes) => {
      calls += 1;
      seen.push(bytes);
      const { data, info } = await sharp(bytes)
        .removeAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true });
      const scale = info.width / pageWidth;
      const visible = words.filter(
        (word) =>
          !(word.late === true && calls === 1) &&
          inkLeft(data, info.width, info.height, info.channels, scale, word) > 0.5,
      );
      const answer = layoutAnswer(info.width, info.height, visible, scale);
      return (options.alter?.(answer, calls) ?? answer) as ReturnType<typeof layoutAnswer>;
    },
  };
};

/** Finds a fixed list of values, standing in for a detection service. */
export const listDetector = (
  values: ReadonlyArray<string>,
  kind: EntityKind = "PERSON",
): Detector => ({
  detect: (texts) =>
    Promise.resolve(
      texts.map((text) => {
        const spans: Array<DetectedEntity> = [];
        for (const value of values) {
          let from = text.indexOf(value);
          while (from !== -1) {
            spans.push({ start: from, end: from + value.length, kind });
            from = text.indexOf(value, from + value.length);
          }
        }
        return spans;
      }),
    ),
});

/** A vault and detectors as the gateway builds them: fixed patterns and a list of names. */
export const makePseudonymizer = (names: ReadonlyArray<string> = []): Pseudonymizer =>
  new Pseudonymizer(new Vault(), combineDetectors([patternDetector, listDetector(names)]));

/** Of the pixels a word's ink was painted on, the share that still shows it. */
const inkLeft = (
  data: Buffer,
  width: number,
  height: number,
  channels: number,
  scale: number,
  word: Pick<Planted, "x" | "y" | "width" | "height" | "solid">,
): number => {
  let grey = 0;
  let total = 0;
  const solid = word.solid === true || scale !== 1;
  for (let y = Math.floor(word.y * scale); y < Math.floor((word.y + word.height) * scale); y += 1) {
    for (
      let x = Math.floor(word.x * scale);
      x < Math.floor((word.x + word.width) * scale);
      x += 1
    ) {
      if (x < 0 || y < 0 || x >= width || y >= height) continue;
      if (!solid && !inked(word, x - word.x)) continue;
      total += 1;
      const value = data[(y * width + x) * channels] as number;
      if (value > 100 && value < 160) grey += 1;
    }
  }
  return total === 0 ? 0 : grey / total;
};

/**
 * How much of a word still shows in the sent picture: "hidden", "shown", or the share where it
 * is neither. A label's soft edges are grey too, so a hidden word may show a few stray pixels.
 */
export const shows = async (
  image: Buffer,
  pageWidth: number,
  word: Pick<Planted, "x" | "y" | "width" | "height" | "solid">,
): Promise<"hidden" | "shown" | number> => {
  const { data, info } = await sharp(image)
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const share = inkLeft(data, info.width, info.height, info.channels, info.width / pageWidth, word);
  return share < 0.15 ? "hidden" : share > 0.95 ? "shown" : share;
};

interface Pixels {
  readonly width: number;
  readonly height: number;
  readonly data: Buffer;
}

/** A QR code or barcode holding `text`, as black and white pixels with its quiet zone. */
export const codePixels = async (
  text: string,
  format: "QRCode" | "Code128" | "DataMatrix" = "QRCode",
  scale = 5,
): Promise<Pixels> => {
  const { writeBarcode } = await import("zxing-wasm/writer");
  const written = await writeBarcode(text, { format, scale, addQuietZones: true });
  if (written.image === null) throw new Error(`The code could not be drawn: ${written.error}`);
  const { data, info } = await sharp(Buffer.from(await written.image.arrayBuffer()))
    .flatten({ background: "#ffffff" })
    .removeAlpha()
    .toColourspace("srgb")
    .raw()
    .toBuffer({ resolveWithObject: true });
  return { width: info.width, height: info.height, data };
};

/** Paints `stamp` onto `page` with its top left corner at `x`, `y`. */
export const stampOn = (page: Pixels, stamp: Pixels, x: number, y: number): void => {
  for (let row = 0; row < stamp.height; row += 1) {
    stamp.data.copy(
      page.data,
      ((y + row) * page.width + x) * 3,
      row * stamp.width * 3,
      (row + 1) * stamp.width * 3,
    );
  }
};

/** The share of dark pixels in a rectangle of an encoded picture. 1 for a solid black box. */
export const darkShare = async (
  image: Buffer,
  box: { readonly x: number; readonly y: number; readonly width: number; readonly height: number },
): Promise<number> => {
  const { data, info } = await sharp(image)
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  let dark = 0;
  let total = 0;
  for (let y = box.y; y < box.y + box.height; y += 1) {
    for (let x = box.x; x < box.x + box.width; x += 1) {
      if (x < 0 || y < 0 || x >= info.width || y >= info.height) continue;
      total += 1;
      if ((data[(y * info.width + x) * info.channels] as number) < 64) dark += 1;
    }
  }
  return total === 0 ? 0 : dark / total;
};
