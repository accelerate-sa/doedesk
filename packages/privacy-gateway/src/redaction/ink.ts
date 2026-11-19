import type { Coverage, Point } from "./geometry.ts";
import type { Raster } from "./raster.ts";

export interface UnreadInkOptions {
  /** Marks of similar size standing together, at least this many, are taken for writing. */
  readonly minCluster: number;
}

/** How far a pixel must differ from its surroundings to count as a mark. 0 to 255. */
const CONTRAST = 24;
/** Half the side of the square a pixel is compared with. */
const WINDOW = 12;
const MIN_MARK_HEIGHT = 4;
const MAX_MARK_HEIGHT = 160;
const MIN_MARK_PIXELS = 6;
/** A mark counts as read when this share of its bounding box lies in what the reader accounted for. */
const ACCOUNTED_SHARE = 0.5;
const REGION_PADDING = 3;

interface Mark {
  left: number;
  top: number;
  right: number;
  bottom: number;
  pixels: number;
}

const find = (parents: Int32Array, index: number): number => {
  let root = index;
  while (parents[root] !== root) root = parents[root] as number;
  while (parents[index] !== root) {
    const next = parents[index] as number;
    parents[index] = root;
    index = next;
  }
  return root;
};

/** Sums over rectangles in constant time. */
const integral = (width: number, height: number, valueAt: (index: number) => number) => {
  const stride = width + 1;
  const table = new Float64Array(stride * (height + 1));
  for (let y = 0; y < height; y += 1) {
    let row = 0;
    for (let x = 0; x < width; x += 1) {
      row += valueAt(y * width + x);
      table[(y + 1) * stride + x + 1] = (table[y * stride + x + 1] as number) + row;
    }
  }
  return (left: number, top: number, right: number, bottom: number): number =>
    (table[(bottom + 1) * stride + right + 1] as number) -
    (table[top * stride + right + 1] as number) -
    (table[(bottom + 1) * stride + left] as number) +
    (table[top * stride + left] as number);
};

/**
 * Where the picture has marks: 1 for writing or drawing, dark on light or the reverse, 0 for
 * paper. A mark differs from the mean of the square around it by more than that square's
 * spread; paper beside writing differs by less, there being more paper than ink.
 */
export const inkOf = (raster: Raster): Coverage => {
  const { width, height, data } = raster;
  const ink = new Uint8Array(width * height);
  if (width < 2 || height < 2) return { width, height, data: ink };
  const grey = new Uint8Array(width * height);
  for (let index = 0; index < grey.length; index += 1) {
    grey[index] =
      ((data[index * 3] as number) * 77 +
        (data[index * 3 + 1] as number) * 150 +
        (data[index * 3 + 2] as number) * 29) >>
      8;
  }
  const sum = integral(width, height, (index) => grey[index] as number);
  const squares = integral(width, height, (index) => (grey[index] as number) ** 2);
  for (let y = 0; y < height; y += 1) {
    const top = Math.max(0, y - WINDOW);
    const bottom = Math.min(height - 1, y + WINDOW);
    for (let x = 0; x < width; x += 1) {
      const left = Math.max(0, x - WINDOW);
      const right = Math.min(width - 1, x + WINDOW);
      const count = (right - left + 1) * (bottom - top + 1);
      const mean = sum(left, top, right, bottom) / count;
      const spread = Math.sqrt(
        Math.max(0, squares(left, top, right, bottom) / count - mean * mean),
      );
      const difference = Math.abs((grey[y * width + x] as number) - mean);
      if (difference > CONTRAST && difference > spread) ink[y * width + x] = 1;
    }
  }
  return { width, height, data: ink };
};

/**
 * A box grown along its text until each end reaches clear paper, or `limit` pixels. The reader's
 * outline of a word is sometimes a letter short (at a bracket, where two scripts meet), and a
 * box drawn to that outline leaves the letter showing.
 */
export const growToGaps = (
  hull: ReadonlyArray<Point>,
  along: Point,
  marks: Coverage,
  limit: number,
): ReadonlyArray<Point> => {
  const across = { x: -along.y, y: along.x };
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
  // The middle of the box's height: a neighbouring line's tall letters do not count.
  const inset = (far - near) * 0.25;
  const marked = (a: number): boolean => {
    for (let c = near + inset; c <= far - inset; c += 1) {
      const x = Math.round(a * along.x + c * across.x);
      const y = Math.round(a * along.y + c * across.y);
      if (x < 0 || y < 0 || x >= marks.width || y >= marks.height) return false;
      if (marks.data[y * marks.width + x] === 1) return true;
    }
    return false;
  };
  // Two clear columns end the word. Measured: bridging wider gaps to reach a letter standing
  // apart covered 5% more of the neighbouring text and no more of any value.
  const gap = 1;
  const reach = (from: number, step: number): number => {
    let last = 0;
    for (let moved = 1; moved <= limit && moved - last <= gap; moved += 1) {
      if (marked(from + step * moved)) last = moved;
    }
    // One more pixel, into the gap: the edge of a letter is fainter than its body.
    return last === 0 ? 0 : last + 1;
  };
  const forward = reach(high, 1);
  const backward = reach(low, -1);
  if (forward === 0 && backward === 0) return hull;
  const moved = hull.flatMap((point) => [
    point,
    { x: point.x + forward * along.x, y: point.y + forward * along.y },
    { x: point.x - backward * along.x, y: point.y - backward * along.y },
  ]);
  return moved;
};

/**
 * Rectangles over text-like marks the reader returned no word for: letter-sized marks standing
 * together in a row or column, outside every word it did return. A rule about shapes: it also
 * covers rows of icons and barcodes, and does not see one large mark such as a signature or face.
 */
export const unreadInkRegions = (
  raster: Raster,
  inked: Coverage,
  accounted: Coverage,
  options: UnreadInkOptions,
): ReadonlyArray<ReadonlyArray<Point>> => {
  const { width, height } = raster;
  if (width < 8 || height < 8) return [];
  const ink = inked.data;
  const accountedSum = integral(width, height, (index) => accounted.data[index] as number);

  // Connected marks, by two passes and a union of labels.
  const labels = new Int32Array(width * height);
  const parents = new Int32Array(width * height + 1);
  let next = 1;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = y * width + x;
      if (ink[index] !== 1) continue;
      let label = 0;
      const join = (other: number) => {
        if (other === 0) return;
        if (label === 0) label = find(parents, other);
        else {
          const root = find(parents, other);
          if (root !== label) parents[root] = label;
        }
      };
      if (x > 0) join(labels[index - 1] as number);
      if (y > 0) {
        if (x > 0) join(labels[index - width - 1] as number);
        join(labels[index - width] as number);
        if (x + 1 < width) join(labels[index - width + 1] as number);
      }
      if (label === 0) {
        label = next;
        parents[next] = next;
        next += 1;
      }
      labels[index] = label;
    }
  }
  const marks = new Map<number, Mark>();
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const label = labels[y * width + x] as number;
      if (label === 0) continue;
      const root = find(parents, label);
      const mark = marks.get(root);
      if (mark === undefined) marks.set(root, { left: x, top: y, right: x, bottom: y, pixels: 1 });
      else {
        mark.left = Math.min(mark.left, x);
        mark.right = Math.max(mark.right, x);
        mark.bottom = y;
        mark.pixels += 1;
      }
    }
  }

  // Letter-sized marks the reader did not account for.
  const letters: Array<Mark> = [];
  for (const mark of marks.values()) {
    const markHeight = mark.bottom - mark.top + 1;
    const markWidth = mark.right - mark.left + 1;
    const size = Math.max(markHeight, markWidth);
    if (size < MIN_MARK_HEIGHT || markHeight > MAX_MARK_HEIGHT || mark.pixels < MIN_MARK_PIXELS) {
      continue;
    }
    // A ruled line: long and thin.
    if (markWidth > 12 * markHeight + 20 || markHeight > 12 * markWidth + 20) continue;
    const area = markWidth * markHeight;
    if (accountedSum(mark.left, mark.top, mark.right, mark.bottom) / area >= ACCOUNTED_SHARE)
      continue;
    letters.push(mark);
  }
  if (letters.length < options.minCluster) return [];

  // Marks that stand together: side by side in a row, or one above the other in a column.
  const group = new Int32Array(letters.length);
  for (let index = 0; index < group.length; index += 1) group[index] = index;
  const CELL = 64;
  const grid = new Map<number, Array<number>>();
  const columns = Math.ceil(width / CELL) + 1;
  letters.forEach((mark, index) => {
    for (let cy = Math.floor(mark.top / CELL); cy <= Math.floor(mark.bottom / CELL); cy += 1) {
      for (let cx = Math.floor(mark.left / CELL); cx <= Math.floor(mark.right / CELL); cx += 1) {
        const key = cy * columns + cx;
        const cell = grid.get(key);
        if (cell === undefined) grid.set(key, [index]);
        else cell.push(index);
      }
    }
  });
  const together = (a: Mark, b: Mark): boolean => {
    const aHeight = a.bottom - a.top + 1;
    const bHeight = b.bottom - b.top + 1;
    const aWidth = a.right - a.left + 1;
    const bWidth = b.right - b.left + 1;
    const gapX = Math.max(0, Math.max(a.left, b.left) - Math.min(a.right, b.right) - 1);
    const gapY = Math.max(0, Math.max(a.top, b.top) - Math.min(a.bottom, b.bottom) - 1);
    const overlapY = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) + 1;
    const overlapX = Math.min(a.right, b.right) - Math.max(a.left, b.left) + 1;
    const tall = Math.max(aHeight, bHeight);
    const wide = Math.max(aWidth, bWidth);
    const inRow = overlapY >= 0.4 * Math.min(aHeight, bHeight) && gapX <= 1.5 * tall;
    const inColumn = overlapX >= 0.4 * Math.min(aWidth, bWidth) && gapY <= 1.5 * wide;
    const alike =
      tall <= 3.5 * Math.min(aHeight, bHeight) || wide <= 3.5 * Math.min(aWidth, bWidth);
    return alike && (inRow || inColumn);
  };
  letters.forEach((mark, index) => {
    const reach = Math.ceil(1.5 * Math.max(mark.bottom - mark.top + 1, mark.right - mark.left + 1));
    for (
      let cy = Math.floor(Math.max(0, mark.top - reach) / CELL);
      cy <= Math.floor(Math.min(height - 1, mark.bottom + reach) / CELL);
      cy += 1
    ) {
      for (
        let cx = Math.floor(Math.max(0, mark.left - reach) / CELL);
        cx <= Math.floor(Math.min(width - 1, mark.right + reach) / CELL);
        cx += 1
      ) {
        for (const other of grid.get(cy * columns + cx) ?? []) {
          if (other <= index) continue;
          if (together(mark, letters[other] as Mark)) {
            const a = find(group, index);
            const b = find(group, other);
            if (a !== b) group[b] = a;
          }
        }
      }
    }
  });
  const clusters = new Map<number, { box: Mark; count: number }>();
  letters.forEach((mark, index) => {
    const root = find(group, index);
    const cluster = clusters.get(root);
    if (cluster === undefined) clusters.set(root, { box: { ...mark }, count: 1 });
    else {
      cluster.box.left = Math.min(cluster.box.left, mark.left);
      cluster.box.top = Math.min(cluster.box.top, mark.top);
      cluster.box.right = Math.max(cluster.box.right, mark.right);
      cluster.box.bottom = Math.max(cluster.box.bottom, mark.bottom);
      cluster.count += 1;
    }
  });
  const regions: Array<ReadonlyArray<Point>> = [];
  for (const { box, count } of clusters.values()) {
    if (count < options.minCluster) continue;
    const left = Math.max(0, box.left - REGION_PADDING);
    const top = Math.max(0, box.top - REGION_PADDING);
    const right = Math.min(width, box.right + 1 + REGION_PADDING);
    const bottom = Math.min(height, box.bottom + 1 + REGION_PADDING);
    regions.push([
      { x: left, y: top },
      { x: right, y: top },
      { x: right, y: bottom },
      { x: left, y: bottom },
    ]);
  }
  return regions;
};
