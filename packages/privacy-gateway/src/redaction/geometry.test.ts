import { describe, expect, it } from "vite-plus/test";

import {
  convexHull,
  coveredShare,
  expandQuad,
  fillConvex,
  frameOf,
  insideConvex,
  makeCoverage,
  type Point,
  pointsOf,
} from "./geometry.ts";
import { growToGaps, inkOf } from "./ink.ts";
import { canDraw, drawLabel, fitLabel } from "./label.ts";

/** A rectangle of the given size turned by `degrees` about its centre. */
const turned = (cx: number, cy: number, width: number, height: number, degrees: number) => {
  const angle = (degrees * Math.PI) / 180;
  const corner = (dx: number, dy: number): Point => ({
    x: cx + dx * Math.cos(angle) - dy * Math.sin(angle),
    y: cy + dx * Math.sin(angle) + dy * Math.cos(angle),
  });
  return [
    corner(-width / 2, -height / 2),
    corner(width / 2, -height / 2),
    corner(width / 2, height / 2),
    corner(-width / 2, height / 2),
  ];
};

describe("covering a shape", () => {
  it.each([0, 1, 7, 15, 30, 45, 60, 89, 90, 135, 180, 270, 333])(
    "covers every pixel a box turned %i degrees touches",
    (degrees) => {
      const coverage = makeCoverage(200, 200);
      const quad = turned(100.3, 99.6, 90.4, 21.7, degrees);
      fillConvex(coverage, quad);
      let missed = 0;
      for (let y = 0; y < 200; y += 1) {
        for (let x = 0; x < 200; x += 1) {
          // Any of 25 points of the pixel inside the box means the box touches the pixel.
          let touched = false;
          for (let sy = 0; sy < 5 && !touched; sy += 1) {
            for (let sx = 0; sx < 5 && !touched; sx += 1) {
              touched = insideConvex(quad, { x: x + (sx + 0.5) / 5, y: y + (sy + 0.5) / 5 });
            }
          }
          if (touched && coverage.data[y * 200 + x] !== 1) missed += 1;
        }
      }
      expect(missed).toBe(0);
      // And not much more: within a pixel of the box all round.
      const painted = coverage.data.reduce((total, value) => total + value, 0);
      expect(painted).toBeLessThan((90.4 + 3) * (21.7 + 3) + 60);
    },
  );

  it("clips a box that reaches past the edge of the picture", () => {
    const coverage = makeCoverage(50, 50);
    fillConvex(coverage, turned(48, 2, 40, 12, 20));
    expect(coverage.data.some((value) => value === 1)).toBe(true);
    expect(coveredShare(coverage, turned(-200, -200, 10, 10, 0))).toBe(1);
  });

  it("grows a word's outline along and across its own direction, whatever way it faces", () => {
    for (const degrees of [0, 33, 90, 180, 250]) {
      const quad = turned(100, 100, 80, 20, degrees);
      const grown = expandQuad(quad, frameOf(quad), 5, 3);
      const frame = frameOf(grown);
      expect(frame.width).toBeCloseTo(90, 5);
      expect(frame.height).toBeCloseTo(26, 5);
      for (const corner of quad) expect(insideConvex(convexHull(grown), corner)).toBe(true);
    }
  });

  it("takes a warped outline as it is: four corners, not a rectangle", () => {
    const warped = pointsOf([10, 10, 110, 22, 104, 48, 6, 30]);
    const coverage = makeCoverage(130, 70);
    fillConvex(coverage, convexHull(warped));
    for (const corner of warped) {
      expect(coverage.data[Math.floor(corner.y) * 130 + Math.floor(corner.x)]).toBe(1);
    }
    expect(coverage.data[12 * 130 + 100]).toBe(0);
  });
});

describe("growing a box to the gaps around its text", () => {
  /** Letters as pairs of thin strokes, three clear pixels between letters, on a white strip. */
  const strip = (words: ReadonlyArray<readonly [number, number]>) => {
    const width = 300;
    const height = 60;
    const data = Buffer.alloc(width * height * 3, 255);
    for (const [from, to] of words) {
      for (let letter = from; letter + 5 <= to; letter += 8) {
        for (const stroke of [letter, letter + 3]) {
          for (let y = 20; y < 40; y += 1) {
            data.fill(20, (y * width + stroke) * 3, (y * width + stroke + 2) * 3);
          }
        }
      }
    }
    return inkOf({ width, height, data });
  };
  const box = (from: number, to: number) => [
    { x: from, y: 18 },
    { x: to, y: 18 },
    { x: to, y: 42 },
    { x: from, y: 42 },
  ];
  const extent = (points: ReadonlyArray<Point>) => [
    Math.min(...points.map((point) => point.x)),
    Math.max(...points.map((point) => point.x)),
  ];
  // Letters at 100, 108, …, 164 (each five wide), then a second word from 190.
  const page = strip([
    [100, 170],
    [190, 260],
  ]);

  it("covers to its end a letter the outline cut through, and stops there", () => {
    // The outline ends at 166, inside the last letter (164 to 169).
    const [left, right] = extent(growToGaps(box(100, 166), { x: 1, y: 0 }, page, 30));
    expect(left).toBe(100);
    expect(right).toBeGreaterThanOrEqual(169);
    expect(right).toBeLessThan(175);
  });

  it("leaves a box alone that already ends in a gap", () => {
    expect(extent(growToGaps(box(98, 171), { x: 1, y: 0 }, page, 30))).toEqual([98, 171]);
  });

  it("goes no further than its limit", () => {
    const solid = strip([]);
    solid.data.fill(1);
    const [left, right] = extent(growToGaps(box(100, 160), { x: 1, y: 0 }, solid, 12));
    expect((right as number) - 160).toBe(13);
    expect(100 - (left as number)).toBe(13);
  });
});

describe("labels", () => {
  it("can be drawn only from the stand-in alphabet, so never from what a box hides", () => {
    expect(canDraw("[PERSON_FBJD2]")).toBe(true);
    expect(canDraw("[UNREADABLE]")).toBe(true);
    expect(canDraw("12")).toBe(true);
    for (const real of ["Khalid", "khalid", "0551-234", "k@x.sa", "خالد", "+966"]) {
      expect(canDraw(real), real).toBe(false);
      expect(fitLabel(turned(100, 100, 190, 60, 0), { x: 1, y: 0 }, real, 1, 4)).toBeUndefined();
    }
  });

  it("is as large as fits and is refused where it would be too small to read", () => {
    const wide = fitLabel(turned(200, 100, 380, 60, 0), { x: 1, y: 0 }, "[PERSON_FBJD2]", 1.5, 4);
    expect(wide?.scale).toBe(4);
    const snug = fitLabel(turned(200, 100, 140, 20, 0), { x: 1, y: 0 }, "[PERSON_FBJD2]", 1.5, 4);
    expect(snug?.scale).toBe(1.5);
    expect(
      fitLabel(turned(200, 100, 100, 20, 0), { x: 1, y: 0 }, "[PERSON_FBJD2]", 1.5, 4),
    ).toBeUndefined();
    expect(fitLabel(turned(200, 100, 100, 20, 0), { x: 1, y: 0 }, "7", 1.5, 4)).toBeDefined();
  });

  it("writes only on pixels that are already covered", () => {
    const width = 240;
    const height = 120;
    const coverage = makeCoverage(width, height);
    const hull = turned(120, 60, 200, 34, 12);
    fillConvex(coverage, hull);
    const raster = { width, height, data: Buffer.alloc(width * height * 3, 77) };
    const placement = fitLabel(
      hull,
      { x: Math.cos(0.21), y: Math.sin(0.21) },
      "[IBAN_Q5QPN]",
      1.5,
      4,
    );
    expect(placement).toBeDefined();
    if (placement === undefined) return;
    drawLabel(raster, coverage, placement);
    let written = 0;
    for (let pixel = 0; pixel < width * height; pixel += 1) {
      if (raster.data[pixel * 3] === 77) continue;
      written += 1;
      expect(coverage.data[pixel]).toBe(1);
    }
    expect(written).toBeGreaterThan(200);
  });
});
