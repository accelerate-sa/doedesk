import type { Polygon } from "./layout.ts";

export interface Point {
  readonly x: number;
  readonly y: number;
}

/** One byte per pixel: 1 where the image is covered. */
export interface Coverage {
  readonly width: number;
  readonly height: number;
  readonly data: Uint8Array;
}

export const makeCoverage = (width: number, height: number): Coverage => ({
  width,
  height,
  data: new Uint8Array(width * height),
});

export const pointsOf = (polygon: Polygon, scaleX = 1, scaleY = 1): ReadonlyArray<Point> => [
  { x: polygon[0] * scaleX, y: polygon[1] * scaleY },
  { x: polygon[2] * scaleX, y: polygon[3] * scaleY },
  { x: polygon[4] * scaleX, y: polygon[5] * scaleY },
  { x: polygon[6] * scaleX, y: polygon[7] * scaleY },
];

const subtract = (left: Point, right: Point): Point => ({
  x: left.x - right.x,
  y: left.y - right.y,
});
const add = (left: Point, right: Point): Point => ({ x: left.x + right.x, y: left.y + right.y });
const scale = (point: Point, factor: number): Point => ({
  x: point.x * factor,
  y: point.y * factor,
});
export const length = (point: Point): number => Math.hypot(point.x, point.y);
const unit = (point: Point, fallback: Point): Point => {
  const size = length(point);
  return size < 1e-6 ? fallback : { x: point.x / size, y: point.y / size };
};

export interface QuadFrame {
  /** Along the text, from the word's first corner to its second. */
  readonly along: Point;
  /** Across the text, from the word's top edge to its bottom edge. */
  readonly across: Point;
  readonly width: number;
  readonly height: number;
}

/** The directions a word runs in, taken from its four corners. */
export const frameOf = (quad: ReadonlyArray<Point>): QuadFrame => {
  const [p0, p1, p2, p3] = quad as [Point, Point, Point, Point];
  const top = subtract(p1, p0);
  const bottom = subtract(p2, p3);
  const left = subtract(p3, p0);
  const right = subtract(p2, p1);
  const along = unit(add(top, bottom), { x: 1, y: 0 });
  // A word read as a line with no height still has a direction across it.
  const across = unit(add(left, right), { x: -along.y, y: along.x });
  return {
    along,
    across,
    width: (length(top) + length(bottom)) / 2,
    height: (length(left) + length(right)) / 2,
  };
};

/** The quad grown outward by `padAlong` at each end and `padAcross` above and below. */
export const expandQuad = (
  quad: ReadonlyArray<Point>,
  frame: QuadFrame,
  padAlong: number,
  padAcross: number,
): ReadonlyArray<Point> => {
  const [p0, p1, p2, p3] = quad as [Point, Point, Point, Point];
  const a = scale(frame.along, padAlong);
  const c = scale(frame.across, padAcross);
  return [
    subtract(subtract(p0, a), c),
    subtract(add(p1, a), c),
    add(add(p2, a), c),
    add(subtract(p3, a), c),
  ];
};

const cross = (origin: Point, a: Point, b: Point): number =>
  (a.x - origin.x) * (b.y - origin.y) - (a.y - origin.y) * (b.x - origin.x);

/** The smallest convex shape around the points, corners in order. */
export const convexHull = (points: ReadonlyArray<Point>): ReadonlyArray<Point> => {
  const sorted = points.toSorted((left, right) => left.x - right.x || left.y - right.y);
  if (sorted.length <= 2) return sorted;
  const lower: Array<Point> = [];
  for (const point of sorted) {
    while (lower.length >= 2 && cross(lower.at(-2) as Point, lower.at(-1) as Point, point) <= 0) {
      lower.pop();
    }
    lower.push(point);
  }
  const upper: Array<Point> = [];
  for (const point of sorted.toReversed()) {
    while (upper.length >= 2 && cross(upper.at(-2) as Point, upper.at(-1) as Point, point) <= 0) {
      upper.pop();
    }
    upper.push(point);
  }
  lower.pop();
  upper.pop();
  return [...lower, ...upper];
};

/** True when `point` is inside the convex shape or on its edge. */
export const insideConvex = (hull: ReadonlyArray<Point>, point: Point): boolean => {
  if (hull.length < 3) return false;
  let sign = 0;
  for (let index = 0; index < hull.length; index += 1) {
    const value = cross(hull[index] as Point, hull[(index + 1) % hull.length] as Point, point);
    if (Math.abs(value) < 1e-9) continue;
    if (sign === 0) sign = Math.sign(value);
    else if (Math.sign(value) !== sign) return false;
  }
  return true;
};

/**
 * Visits each pixel row of a convex shape with the first and last column it touches. Every pixel
 * the shape touches is included, not only those whose centre is inside it: a box that is a
 * fraction of a pixel short leaves a line of the text showing.
 */
const scanConvex = (
  width: number,
  height: number,
  hull: ReadonlyArray<Point>,
  visit: (row: number, from: number, to: number) => void,
): void => {
  if (hull.length === 0) return;
  let top = Infinity;
  let bottom = -Infinity;
  for (const point of hull) {
    top = Math.min(top, point.y);
    bottom = Math.max(bottom, point.y);
  }
  const firstRow = Math.max(0, Math.floor(top));
  const lastRow = Math.min(height - 1, Math.ceil(bottom));
  for (let row = firstRow; row <= lastRow; row += 1) {
    // The part of the shape between this pixel row's top and bottom edges.
    let left = Infinity;
    let right = -Infinity;
    for (let index = 0; index < hull.length; index += 1) {
      const a = hull[index] as Point;
      const b = hull[(index + 1) % hull.length] as Point;
      const low = Math.min(a.y, b.y);
      const high = Math.max(a.y, b.y);
      if (high < row || low > row + 1) continue;
      if (Math.abs(b.y - a.y) < 1e-9) {
        left = Math.min(left, a.x, b.x);
        right = Math.max(right, a.x, b.x);
        continue;
      }
      for (const y of [Math.max(low, row), Math.min(high, row + 1)]) {
        const x = a.x + ((y - a.y) / (b.y - a.y)) * (b.x - a.x);
        left = Math.min(left, x);
        right = Math.max(right, x);
      }
    }
    if (left > right) continue;
    const from = Math.max(0, Math.floor(left));
    const to = Math.min(width - 1, Math.ceil(right));
    if (from <= to) visit(row, from, to);
  }
};

/** Covers a convex shape, edge pixels included. */
export const fillConvex = (coverage: Coverage, hull: ReadonlyArray<Point>): void => {
  const { width, height, data } = coverage;
  scanConvex(width, height, hull, (row, from, to) => {
    data.fill(1, row * width + from, row * width + to + 1);
  });
};

/** The share of a convex shape's pixels that are already covered. 1 for a shape off the image. */
export const coveredShare = (coverage: Coverage, hull: ReadonlyArray<Point>): number => {
  const { width, height, data } = coverage;
  let total = 0;
  let covered = 0;
  scanConvex(width, height, hull, (row, from, to) => {
    for (let index = row * width + from; index <= row * width + to; index += 1) {
      total += 1;
      if (data[index] === 1) covered += 1;
    }
  });
  return total === 0 ? 1 : covered / total;
};

/**
 * Of the pixels of a convex shape that are outside `boxes`, the share that lies in `within`.
 * 0 for a shape that is wholly boxed or off the image.
 */
export const shareOutsideBoxes = (
  hull: ReadonlyArray<Point>,
  boxes: Coverage,
  within: Coverage,
): number => {
  const { width, height } = boxes;
  let open = 0;
  let inside = 0;
  scanConvex(width, height, hull, (row, from, to) => {
    for (let index = row * width + from; index <= row * width + to; index += 1) {
      if (boxes.data[index] === 1) continue;
      open += 1;
      if (within.data[index] === 1) inside += 1;
    }
  });
  return open === 0 ? 0 : inside / open;
};

export const centroid = (points: ReadonlyArray<Point>): Point => {
  let x = 0;
  let y = 0;
  for (const point of points) {
    x += point.x;
    y += point.y;
  }
  return { x: x / Math.max(1, points.length), y: y / Math.max(1, points.length) };
};
