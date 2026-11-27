import type {
  DeidentifyAction,
  DeidentifyCellsTarget,
  DeidentifyFileStatus,
  DeidentifyItem,
  DeidentifyLayer,
  DeidentifyLayerChange,
  DeidentifyPoint,
} from "@t3tools/contracts";

/** What the views of the studio share: where items are, and how a layer looks after a change. */

/** A rectangle on a page or picture, as shares of its width and height. */
export interface Box {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

const share = (value: number): number => Math.min(1, Math.max(0, value));

/** The upright rectangle around an outline: a box is shown and dragged as one. */
export const boxOfPolygon = (polygon: ReadonlyArray<DeidentifyPoint>): Box => {
  const xs = polygon.map((point) => point.x);
  const ys = polygon.map((point) => point.y);
  const left = share(Math.min(...xs));
  const top = share(Math.min(...ys));
  return {
    x: left,
    y: top,
    width: share(Math.max(...xs)) - left,
    height: share(Math.max(...ys)) - top,
  };
};

/** A rectangle from two corners in any order, kept on the page. */
export const boxBetween = (from: DeidentifyPoint, to: DeidentifyPoint): Box => {
  const left = share(Math.min(from.x, to.x));
  const top = share(Math.min(from.y, to.y));
  return {
    x: left,
    y: top,
    width: share(Math.max(from.x, to.x)) - left,
    height: share(Math.max(from.y, to.y)) - top,
  };
};

export const polygonOfBox = (box: Box): ReadonlyArray<DeidentifyPoint> => [
  { x: box.x, y: box.y },
  { x: box.x + box.width, y: box.y },
  { x: box.x + box.width, y: box.y + box.height },
  { x: box.x, y: box.y + box.height },
];

/** The box moved by a distance, never off the page. */
export const moveBox = (box: Box, dx: number, dy: number): Box => ({
  ...box,
  x: Math.min(1 - box.width, Math.max(0, box.x + dx)),
  y: Math.min(1 - box.height, Math.max(0, box.y + dy)),
});

export type BoxCorner = "nw" | "ne" | "sw" | "se";

/** The box with one corner dragged to a point; the opposite corner stays where it is. */
export const resizeBox = (box: Box, corner: BoxCorner, to: DeidentifyPoint): Box => {
  const anchor = {
    x: corner === "nw" || corner === "sw" ? box.x + box.width : box.x,
    y: corner === "nw" || corner === "ne" ? box.y + box.height : box.y,
  };
  return boxBetween(anchor, to);
};

/** Smaller than this either way and a drag was a click: no box is made. */
const MIN_BOX_SHARE = 0.008;

export const isBoxLargeEnough = (box: Box): boolean =>
  box.width >= MIN_BOX_SHARE && box.height >= MIN_BOX_SHARE;

/** An item shown before the server has answered: it cannot be changed until it has. */
export const LOCAL_ITEM_PREFIX = "local:";

export const isLocalItem = (item: DeidentifyItem): boolean => item.id.startsWith(LOCAL_ITEM_PREFIX);

/**
 * The layer as it will be once the server has made a change, for the changes whose outcome is
 * known here. The server's answer replaces it.
 */
export const applyChangeLocally = (
  layer: DeidentifyLayer,
  change: DeidentifyLayerChange,
): DeidentifyLayer => {
  switch (change.type) {
    case "setItemAction":
      return {
        ...layer,
        items: layer.items.map((item) =>
          item.id === change.id ? { ...item, action: change.action } : item,
        ),
      };
    case "moveItem":
      return {
        ...layer,
        items: layer.items.map((item) =>
          item.id === change.id && item.source === "manual"
            ? { ...item, target: change.target }
            : item,
        ),
      };
    case "removeItem":
      return {
        ...layer,
        items: layer.items.filter((item) => item.id !== change.id || item.source !== "manual"),
      };
    case "setReviewState":
      return { ...layer, reviewState: change.state };
    case "setDefaultMode":
      return { ...layer, defaultMode: change.mode };
    case "addItem":
      // Shown at once under a name of its own; the server's answer brings the item it kept.
      return {
        ...layer,
        items: [
          ...layer.items,
          {
            id: `${LOCAL_ITEM_PREFIX}${layer.items.length}:${JSON.stringify(change.target)}`,
            source: "manual",
            action: change.action,
            kind: "OTHER",
            label: "",
            target: change.target,
          },
        ],
      };
  }
};

export interface TextSpan {
  readonly item: DeidentifyItem;
  readonly start: number;
  readonly end: number;
}

/**
 * The stretches of one text that items mark, in order and apart. Where two overlap, a person's
 * own item stands before a found one and a longer before a shorter, as in the copy.
 */
export const spansIn = (
  items: ReadonlyArray<DeidentifyItem>,
  length: number,
  stretchOf: (item: DeidentifyItem) => { readonly start: number; readonly end: number } | undefined,
): ReadonlyArray<TextSpan> => {
  const candidates = items.flatMap((item): ReadonlyArray<TextSpan> => {
    const stretch = stretchOf(item);
    return stretch !== undefined &&
      stretch.start >= 0 &&
      stretch.end <= length &&
      stretch.start < stretch.end
      ? [{ item, start: stretch.start, end: stretch.end }]
      : [];
  });
  const ranked = candidates.toSorted(
    (left, right) =>
      Number(right.item.source === "manual") - Number(left.item.source === "manual") ||
      right.end - right.start - (left.end - left.start),
  );
  const taken: Array<TextSpan> = [];
  for (const span of ranked) {
    if (taken.every((other) => span.end <= other.start || span.start >= other.end)) {
      taken.push(span);
    }
  }
  return taken.toSorted((left, right) => left.start - right.start);
};

export interface TextSegment {
  readonly start: number;
  readonly end: number;
  readonly item?: DeidentifyItem;
}

/** A text cut into the stretches items mark and the stretches between them. */
export const segmentsOf = (
  length: number,
  spans: ReadonlyArray<TextSpan>,
): ReadonlyArray<TextSegment> => {
  const segments: Array<TextSegment> = [];
  let cursor = 0;
  for (const span of spans) {
    if (span.start > cursor) segments.push({ start: cursor, end: span.start });
    segments.push({ start: span.start, end: span.end, item: span.item });
    cursor = span.end;
  }
  if (cursor < length) segments.push({ start: cursor, end: length });
  return segments;
};

/** Every place a stretch of words stands in a text. */
export const occurrencesOf = (
  text: string,
  words: string,
): ReadonlyArray<{ readonly start: number; readonly end: number }> => {
  if (words.trim() === "") return [];
  const found: Array<{ readonly start: number; readonly end: number }> = [];
  let from = text.indexOf(words);
  while (from !== -1) {
    found.push({ start: from, end: from + words.length });
    from = text.indexOf(words, from + words.length);
  }
  return found;
};

/** The stand-in the last copy wrote for a masked value, when there has been one. */
export const standInOf = (item: DeidentifyItem): string | undefined =>
  item.action === "mask" ? item.replacement : undefined;

/** A, B, …, Z, AA, AB: a column as a spreadsheet names it. */
export const columnLetter = (index: number): string => {
  let letters = "";
  for (let rest = index; rest >= 0; rest = Math.floor(rest / 26) - 1) {
    letters = String.fromCharCode(65 + (rest % 26)) + letters;
  }
  return letters;
};

export interface SheetMarks {
  readonly columns: ReadonlyMap<number, DeidentifyItem>;
  readonly rows: ReadonlyMap<number, DeidentifyItem>;
  /** Cells and ranges, each cell under `row:column`. */
  readonly cells: ReadonlyMap<string, DeidentifyItem>;
  /** Values found inside a cell's text, where the rest of the cell is left alone. */
  readonly stretches: ReadonlyMap<string, ReadonlyArray<DeidentifyItem>>;
}

const cellKey = (row: number, column: number): string => `${row}:${column}`;

const stronger = (current: DeidentifyItem | undefined, next: DeidentifyItem): DeidentifyItem =>
  current !== undefined && current.source === "manual" && next.source !== "manual" ? current : next;

/** What marks the cells of one sheet, within the rows and columns that are shown. */
export const sheetMarksOf = (
  items: ReadonlyArray<DeidentifyItem>,
  sheet: string,
  shown: { readonly rows: number; readonly columns: number },
): SheetMarks => {
  const columns = new Map<number, DeidentifyItem>();
  const rows = new Map<number, DeidentifyItem>();
  const cells = new Map<string, DeidentifyItem>();
  const stretches = new Map<string, Array<DeidentifyItem>>();
  for (const item of items) {
    const { target } = item;
    if (target.type !== "cells" || target.sheet !== sheet) continue;
    if (target.start !== undefined && target.end !== undefined) {
      const key = cellKey(target.startRow, target.startColumn);
      stretches.set(key, [...(stretches.get(key) ?? []), item]);
      continue;
    }
    if (target.scope === "column") {
      columns.set(target.startColumn, stronger(columns.get(target.startColumn), item));
      continue;
    }
    if (target.scope === "row") {
      rows.set(target.startRow, stronger(rows.get(target.startRow), item));
      continue;
    }
    const lastRow = Math.min(target.endRow ?? shown.rows - 1, shown.rows - 1);
    const lastColumn = Math.min(target.endColumn ?? shown.columns - 1, shown.columns - 1);
    for (let row = target.startRow; row <= lastRow; row += 1) {
      for (let column = target.startColumn; column <= lastColumn; column += 1) {
        const key = cellKey(row, column);
        cells.set(key, stronger(cells.get(key), item));
      }
    }
  }
  return { columns, rows, cells, stretches };
};

export const stretchesAt = (
  marks: SheetMarks,
  row: number,
  column: number,
): ReadonlyArray<DeidentifyItem> => marks.stretches.get(cellKey(row, column)) ?? [];

/**
 * The item that decides one cell. A cell's own mark comes first, then its row's, then its
 * column's; a column's mark starts under the header it was made from.
 */
export const markAt = (
  marks: SheetMarks,
  row: number,
  column: number,
): DeidentifyItem | undefined => {
  const own = marks.cells.get(cellKey(row, column));
  if (own !== undefined) return own;
  const ofRow = marks.rows.get(row);
  if (ofRow !== undefined) return ofRow;
  const ofColumn = marks.columns.get(column);
  return ofColumn !== undefined &&
    ofColumn.target.type === "cells" &&
    row >= ofColumn.target.startRow
    ? ofColumn
    : undefined;
};

export const columnTargetOf = (sheet: string, column: number): DeidentifyCellsTarget => ({
  type: "cells",
  sheet,
  scope: "column",
  startRow: 1,
  endRow: null,
  startColumn: column,
  endColumn: column,
});

export const rowTargetOf = (sheet: string, row: number): DeidentifyCellsTarget => ({
  type: "cells",
  sheet,
  scope: "row",
  startRow: row,
  endRow: row,
  startColumn: 0,
  endColumn: null,
});

export interface CellRange {
  readonly startRow: number;
  readonly endRow: number;
  readonly startColumn: number;
  readonly endColumn: number;
}

export const rangeBetween = (
  from: { readonly row: number; readonly column: number },
  to: { readonly row: number; readonly column: number },
): CellRange => ({
  startRow: Math.min(from.row, to.row),
  endRow: Math.max(from.row, to.row),
  startColumn: Math.min(from.column, to.column),
  endColumn: Math.max(from.column, to.column),
});

export const rangeTargetOf = (sheet: string, range: CellRange): DeidentifyCellsTarget => ({
  type: "cells",
  sheet,
  scope:
    range.startRow === range.endRow && range.startColumn === range.endColumn ? "cell" : "range",
  ...range,
});

export const isInRange = (range: CellRange | null, row: number, column: number): boolean =>
  range !== null &&
  row >= range.startRow &&
  row <= range.endRow &&
  column >= range.startColumn &&
  column <= range.endColumn;

/** A person's own marks that cover exactly these cells: what "clear" takes away. */
export const manualMarksOn = (
  items: ReadonlyArray<DeidentifyItem>,
  target: DeidentifyCellsTarget,
): ReadonlyArray<DeidentifyItem> =>
  items.filter(
    (item) =>
      item.source === "manual" &&
      item.target.type === "cells" &&
      item.target.sheet === target.sheet &&
      item.target.scope === target.scope &&
      item.target.startRow === target.startRow &&
      item.target.endRow === target.endRow &&
      item.target.startColumn === target.startColumn &&
      item.target.endColumn === target.endColumn,
  );

/** Where an item is, for grouping a list of them. */
export type ItemPlace =
  | { readonly type: "page"; readonly page: number }
  | { readonly type: "sheet"; readonly name: string }
  | { readonly type: "part"; readonly name: string }
  | { readonly type: "file" };

const placeOf = (item: DeidentifyItem, pageCount: number): ItemPlace => {
  const { target } = item;
  switch (target.type) {
    case "region":
      return pageCount > 1 ? { type: "page", page: target.page } : { type: "file" };
    case "cells":
      return { type: "sheet", name: target.sheet };
    case "xml":
    case "media":
      return { type: "part", name: target.part };
    case "text":
      return { type: "file" };
  }
};

const placeKey = (place: ItemPlace): string =>
  place.type === "page"
    ? `page:${place.page}`
    : place.type === "file"
      ? "file"
      : `${place.type}:${place.name}`;

export interface ItemGroup {
  readonly key: string;
  readonly place: ItemPlace;
  readonly items: ReadonlyArray<DeidentifyItem>;
}

/** Items by where they are, in the order the file has them. */
export const groupItems = (
  items: ReadonlyArray<DeidentifyItem>,
  pageCount: number,
): ReadonlyArray<ItemGroup> => {
  const groups = new Map<string, { place: ItemPlace; items: Array<DeidentifyItem> }>();
  for (const item of items) {
    const place = placeOf(item, pageCount);
    const key = placeKey(place);
    const group = groups.get(key);
    if (group === undefined) groups.set(key, { place, items: [item] });
    else group.items.push(item);
  }
  return [...groups.entries()]
    .map(([key, group]) => ({ key, ...group }))
    .toSorted((left, right) =>
      left.place.type === "page" && right.place.type === "page"
        ? left.place.page - right.place.page
        : 0,
    );
};

/** How many items the copy will hide. */
export const hiddenCount = (items: ReadonlyArray<DeidentifyItem>): number =>
  items.filter((item) => item.action !== "keep").length;

export type QueueFilter = "needsReview" | "changed" | "reviewed" | "all";

export const matchesFilter = (status: DeidentifyFileStatus, filter: QueueFilter): boolean => {
  switch (filter) {
    case "all":
      return true;
    case "needsReview":
      return status === "notScanned" || status === "unreviewed" || status === "stale";
    case "changed":
      return status === "stale";
    case "reviewed":
      return status === "reviewed" || status === "skipped";
  }
};

const SUPPORTED_ENDINGS: ReadonlyArray<string> = [
  ".txt",
  ".md",
  ".png",
  ".jpg",
  ".jpeg",
  ".webp",
  ".pdf",
  ".csv",
  ".xlsx",
  ".docx",
  ".pptx",
];

/** Whether a file of this name can be de-identified at all. */
export const canDeidentify = (name: string): boolean => {
  const lower = name.toLowerCase();
  return SUPPORTED_ENDINGS.some((ending) => lower.endsWith(ending));
};

export const ACTIONS: ReadonlyArray<DeidentifyAction> = ["mask", "redact", "keep"];
