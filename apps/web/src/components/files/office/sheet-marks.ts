import { rangeRect, type CellRange, type GridMeta } from "@betteroffice/xlsx/headless";
import type { KnownValueMatcher } from "@t3tools/shared/privacyKnownValues";

import type { Headers } from "./sheet-paint";

// The sheet is a canvas, so a value DoeDesk replaces is marked by its cell: a faint fill and a
// rule along the bottom. The paper is white in every theme, so the colours are fixed.
const colours = { fill: "rgba(60, 60, 67, 0.1)", rule: "rgba(60, 60, 67, 0.45)" };

export const cellKey = (row: number, col: number): string => `${row}:${col}`;

/** The tracks a frame shows along one axis, as runs: the frozen pane, then the cells past it. */
export function visibleRuns(
  start: number,
  indices: ReadonlyArray<number> | undefined,
  offsets: ReadonlyArray<number>,
): ReadonlyArray<readonly [first: number, last: number]> {
  const runs: Array<[number, number]> = [];
  for (let track = 0; track < offsets.length - 1; track += 1) {
    const index = indices?.[track] ?? start + track;
    const last = runs.at(-1);
    if (last && index === last[1] + 1) last[1] = index;
    else runs.push([index, index]);
  }
  return runs;
}

/** The stand-ins of the known values a cell shows, each once. */
export const cellStandIns = (matcher: KnownValueMatcher, text: string): ReadonlyArray<string> => [
  ...new Set(matcher.find(text).map((span) => span.token)),
];

/** Where a cell range sits in the canvas, in CSS pixels from the canvas's corner. */
export function cellRect(grid: GridMeta, headers: Headers, range: CellRange) {
  const rect = rangeRect(grid, range);
  return rect === null
    ? null
    : { x: rect.x + headers.width, y: rect.y + headers.height, w: rect.w, h: rect.h };
}

/** Draws the marks over the cells and under the selection. */
export function paintCellMarks(
  context: CanvasRenderingContext2D,
  input: {
    readonly grid: GridMeta;
    readonly ratio: number;
    readonly headers: Headers;
    readonly width: number;
    readonly height: number;
    readonly ranges: ReadonlyArray<CellRange>;
  },
) {
  if (input.ranges.length === 0) return;
  context.save();
  context.setTransform(
    input.ratio,
    0,
    0,
    input.ratio,
    input.headers.width * input.ratio,
    input.headers.height * input.ratio,
  );
  context.beginPath();
  context.rect(0, 0, input.width, input.height);
  context.clip();
  for (const range of input.ranges) {
    const rect = rangeRect(input.grid, range);
    if (!rect) continue;
    context.fillStyle = colours.fill;
    context.fillRect(rect.x, rect.y, rect.w, rect.h);
    context.fillStyle = colours.rule;
    context.fillRect(rect.x, rect.y + rect.h - 1.5, rect.w, 1);
  }
  context.restore();
}
