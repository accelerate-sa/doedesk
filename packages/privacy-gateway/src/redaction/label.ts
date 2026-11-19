import type { Raster } from "./raster.ts";
import { centroid, type Coverage, insideConvex, type Point } from "./geometry.ts";

/**
 * A fixed 5 by 7 dot face, drawn by this file. A label is drawn the same on every machine, with
 * no font to find, and only ever from the characters below: the token alphabet and digits.
 */
const GLYPHS: Readonly<Record<string, ReadonlyArray<string>>> = {
  A: ["01110", "10001", "10001", "11111", "10001", "10001", "10001"],
  B: ["11110", "10001", "10001", "11110", "10001", "10001", "11110"],
  C: ["01110", "10001", "10000", "10000", "10000", "10001", "01110"],
  // Flat back, cut corners: a model read a rounder D as the letter O.
  D: ["11100", "10010", "10001", "10001", "10001", "10010", "11100"],
  E: ["11111", "10000", "10000", "11110", "10000", "10000", "11111"],
  F: ["11111", "10000", "10000", "11110", "10000", "10000", "10000"],
  G: ["01110", "10001", "10000", "10111", "10001", "10001", "01111"],
  H: ["10001", "10001", "10001", "11111", "10001", "10001", "10001"],
  I: ["01110", "00100", "00100", "00100", "00100", "00100", "01110"],
  J: ["00111", "00010", "00010", "00010", "00010", "10010", "01100"],
  K: ["10001", "10010", "10100", "11000", "10100", "10010", "10001"],
  L: ["10000", "10000", "10000", "10000", "10000", "10000", "11111"],
  M: ["10001", "11011", "10101", "10101", "10001", "10001", "10001"],
  N: ["10001", "11001", "10101", "10011", "10001", "10001", "10001"],
  O: ["01110", "10001", "10001", "10001", "10001", "10001", "01110"],
  P: ["11110", "10001", "10001", "11110", "10000", "10000", "10000"],
  Q: ["01110", "10001", "10001", "10001", "10101", "10010", "01101"],
  R: ["11110", "10001", "10001", "11110", "10100", "10010", "10001"],
  S: ["01111", "10000", "10000", "01110", "00001", "00001", "11110"],
  T: ["11111", "00100", "00100", "00100", "00100", "00100", "00100"],
  U: ["10001", "10001", "10001", "10001", "10001", "10001", "01110"],
  V: ["10001", "10001", "10001", "10001", "10001", "01010", "00100"],
  W: ["10001", "10001", "10001", "10101", "10101", "11011", "10001"],
  X: ["10001", "10001", "01010", "00100", "01010", "10001", "10001"],
  Y: ["10001", "10001", "01010", "00100", "00100", "00100", "00100"],
  Z: ["11111", "00001", "00010", "00100", "01000", "10000", "11111"],
  "0": ["01110", "10001", "10011", "10101", "11001", "10001", "01110"],
  "1": ["00100", "01100", "00100", "00100", "00100", "00100", "01110"],
  "2": ["01110", "10001", "00001", "00010", "00100", "01000", "11111"],
  "3": ["11111", "00010", "00100", "00010", "00001", "10001", "01110"],
  "4": ["00010", "00110", "01010", "10010", "11111", "00010", "00010"],
  "5": ["11111", "10000", "11110", "00001", "00001", "10001", "01110"],
  "6": ["00110", "01000", "10000", "11110", "10001", "10001", "01110"],
  "7": ["11111", "00001", "00010", "00100", "01000", "01000", "01000"],
  "8": ["01110", "10001", "10001", "01110", "10001", "10001", "01110"],
  "9": ["01110", "10001", "10001", "01111", "00001", "00010", "01100"],
  "[": ["01110", "01000", "01000", "01000", "01000", "01000", "01110"],
  "]": ["01110", "00010", "00010", "00010", "00010", "00010", "01110"],
  _: ["00000", "00000", "00000", "00000", "00000", "00000", "11111"],
  "?": ["01110", "10001", "00001", "00010", "00100", "00000", "00100"],
  " ": ["00000", "00000", "00000", "00000", "00000", "00000", "00000"],
};

const GLYPH_WIDTH = 5;
const GLYPH_HEIGHT = 7;
const ADVANCE = 6;

/** True when every character of `text` can be drawn. A label that cannot is never drawn in part. */
export const canDraw = (text: string): boolean =>
  [...text].every((character) => character in GLYPHS);

const textWidth = (text: string): number => text.length * ADVANCE - (ADVANCE - GLYPH_WIDTH);

const inked = (text: string, column: number, row: number): boolean => {
  if (row < 0 || row >= GLYPH_HEIGHT || column < 0) return false;
  const glyph = GLYPHS[text[Math.floor(column / ADVANCE)] ?? " "];
  const within = column % ADVANCE;
  return glyph !== undefined && within < GLYPH_WIDTH && glyph[row]?.[within] === "1";
};

export interface LabelPlacement {
  readonly text: string;
  readonly centre: Point;
  /** Unit vector the label reads along. */
  readonly along: Point;
  /** Output pixels per dot of the face. */
  readonly scale: number;
}

/** Dots of clear box kept around a label, in output pixels. */
const MARGIN = 1.5;

/**
 * The largest size, between `minScale` and `maxScale`, at which `text` fits inside the box when
 * drawn along `along` around the box's centre. Undefined when it does not fit at `minScale`: a
 * label that pokes out of its box, or is too small to read, is not drawn.
 */
export const fitLabel = (
  hull: ReadonlyArray<Point>,
  along: Point,
  text: string,
  minScale: number,
  maxScale: number,
): LabelPlacement | undefined => {
  if (!canDraw(text) || text.length === 0) return undefined;
  const across = { x: -along.y, y: along.x };
  // The middle of the box as the label will lie in it, not the average of its corners: a box
  // around several words has more corners at one end than the other.
  let low = Infinity;
  let high = -Infinity;
  let near = Infinity;
  let far = -Infinity;
  for (const point of hull) {
    const a = point.x * along.x + point.y * along.y;
    const c = point.x * across.x + point.y * across.y;
    low = Math.min(low, a);
    high = Math.max(high, a);
    near = Math.min(near, c);
    far = Math.max(far, c);
  }
  const middle = {
    x: ((low + high) / 2) * along.x + ((near + far) / 2) * across.x,
    y: ((low + high) / 2) * along.y + ((near + far) / 2) * across.y,
  };
  const centre = insideConvex(hull, middle) ? middle : centroid(hull);
  for (let scale = maxScale; scale >= minScale - 1e-9; scale -= 0.25) {
    const halfWidth = (textWidth(text) * scale) / 2 + MARGIN;
    const halfHeight = (GLYPH_HEIGHT * scale) / 2 + MARGIN;
    const corners = [
      [-1, -1],
      [1, -1],
      [1, 1],
      [-1, 1],
    ].map(([a, c]) => ({
      x: centre.x + (a as number) * halfWidth * along.x + (c as number) * halfHeight * across.x,
      y: centre.y + (a as number) * halfWidth * along.y + (c as number) * halfHeight * across.y,
    }));
    if (corners.every((corner) => insideConvex(hull, corner))) {
      return { text, centre, along, scale };
    }
  }
  return undefined;
};

const SAMPLES = 3;

/**
 * Draws a label in white. Only pixels that are already covered are written, so a label can
 * never uncover or overwrite anything outside a box.
 */
export const drawLabel = (raster: Raster, coverage: Coverage, label: LabelPlacement): void => {
  const { text, centre, along, scale } = label;
  const across = { x: -along.y, y: along.x };
  const halfWidth = (textWidth(text) * scale) / 2;
  const halfHeight = (GLYPH_HEIGHT * scale) / 2;
  const reach = Math.ceil(Math.hypot(halfWidth, halfHeight)) + 1;
  const fromX = Math.max(0, Math.floor(centre.x - reach));
  const toX = Math.min(raster.width - 1, Math.ceil(centre.x + reach));
  const fromY = Math.max(0, Math.floor(centre.y - reach));
  const toY = Math.min(raster.height - 1, Math.ceil(centre.y + reach));
  for (let y = fromY; y <= toY; y += 1) {
    for (let x = fromX; x <= toX; x += 1) {
      const index = y * raster.width + x;
      if (coverage.data[index] !== 1) continue;
      let hits = 0;
      for (let sy = 0; sy < SAMPLES; sy += 1) {
        for (let sx = 0; sx < SAMPLES; sx += 1) {
          const dx = x + (sx + 0.5) / SAMPLES - centre.x;
          const dy = y + (sy + 0.5) / SAMPLES - centre.y;
          const column = Math.floor((dx * along.x + dy * along.y + halfWidth) / scale);
          const row = Math.floor((dx * across.x + dy * across.y + halfHeight) / scale);
          if (inked(text, column, row)) hits += 1;
        }
      }
      if (hits === 0) continue;
      const value = Math.round((255 * hits) / (SAMPLES * SAMPLES));
      raster.data[index * 3] = value;
      raster.data[index * 3 + 1] = value;
      raster.data[index * 3 + 2] = value;
    }
  }
};
