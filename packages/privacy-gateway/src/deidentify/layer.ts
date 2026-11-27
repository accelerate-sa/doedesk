import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { type EntityKind, isEntityKind } from "../placeholders.ts";
import type { DeidentificationAction, DeidentificationMode } from "../pseudonymizer.ts";

/**
 * The de-identification layer of one file: what was found in it and what a person added, each
 * with what is to be done about it. The file is never changed; a copy is written from the two.
 * A layer holds real values (`preview`), as the vault does: it never leaves this computer.
 */

export type ReviewState = "unreviewed" | "reviewed" | "stale" | "skipped";

export type FormatFamily = "text" | "image" | "pdf" | "csv" | "xlsx" | "docx" | "pptx";

/** A point of a page or picture, as shares of its width and height: 0 to 1 each way. */
export interface NormalizedPoint {
  readonly x: number;
  readonly y: number;
}

/** A stretch of a text file, in UTF-16 code units. */
export interface TextTarget {
  readonly type: "text";
  readonly start: number;
  readonly end: number;
}

/** An outline on a picture (`page` 0) or on one page of a PDF, corners in order. */
export interface RegionTarget {
  readonly type: "region";
  readonly page: number;
  readonly polygon: ReadonlyArray<NormalizedPoint>;
}

/**
 * Cells of a sheet, rows and columns counted from 0. `endRow` or `endColumn` of `null` runs to
 * the sheet's edge: a whole column is one column from `startRow` down. `start` and `end` pick a
 * stretch inside a single cell's text; without them the whole of each cell is meant.
 */
export interface CellsTarget {
  readonly type: "cells";
  readonly sheet: string;
  readonly scope: "cell" | "range" | "row" | "column";
  readonly startRow: number;
  readonly endRow: number | null;
  readonly startColumn: number;
  readonly endColumn: number | null;
  readonly start?: number | undefined;
  readonly end?: number | undefined;
}

/** A stretch of one part of a DOCX or PPTX, in UTF-16 code units of that part's text as read. */
export interface XmlTarget {
  readonly type: "xml";
  readonly part: string;
  readonly start: number;
  readonly end: number;
}

/** An outline on a picture embedded in a DOCX or PPTX. */
export interface MediaTarget {
  readonly type: "media";
  readonly part: string;
  readonly polygon: ReadonlyArray<NormalizedPoint>;
}

export type ItemTarget = TextTarget | RegionTarget | CellsTarget | XmlTarget | MediaTarget;

export interface LayerItem {
  readonly id: string;
  /** `auto`: found by detection. `manual`: added by a person. */
  readonly source: "auto" | "manual";
  readonly action: DeidentificationAction;
  /** True once a person chose this item's action: the document's mode no longer moves it. */
  readonly overridden?: boolean | undefined;
  readonly kind: EntityKind;
  /** What the item is, for a person: "IBAN", "QR code: verification link (…)". */
  readonly label: string;
  /** The value that was found. Absent for a box drawn over something that was not read. */
  readonly preview?: string | undefined;
  /** What was written in its place the last time the layer was applied. */
  readonly replacement?: string | undefined;
  /** How an automatic item of a picture was found. */
  readonly origin?: "value" | "unreadable" | "ink" | "code" | undefined;
  readonly target: ItemTarget;
}

export interface DeidentificationLayer {
  readonly version: 1;
  readonly projectId: string;
  readonly filePath: string;
  readonly family: FormatFamily;
  /** SHA-256 of the file's bytes, in hex, as they were when the items were found. */
  readonly fileHash: string;
  readonly fileMtimeMs: number;
  readonly defaultMode: DeidentificationMode;
  readonly reviewState: ReviewState;
  readonly items: ReadonlyArray<LayerItem>;
  /** What could not be checked, for a person to be told: "no-reader", "unscanned-media:…". */
  readonly warnings: ReadonlyArray<string>;
  readonly updatedAt: string;
}

export const hashOfFile = (bytes: Uint8Array): string =>
  NodeCrypto.createHash("sha256").update(bytes).digest("hex");

const digest = (value: string): string =>
  NodeCrypto.createHash("sha256").update(value).digest("hex");

/**
 * What a layer is kept under. `locator` names the file (project and path) and is where the
 * layer is stored, so the layer of a file that changed is still found; `key` adds the content
 * hash and names exactly one state of the file.
 */
export const layerKey = (
  projectId: string,
  filePath: string,
  fileHash: string,
): { readonly locator: string; readonly key: string } => {
  const locator = digest(`${projectId}\u0000${filePath}`).slice(0, 40);
  return { locator, key: `${locator}:${fileHash}` };
};

/** The same item found again gets the same id, so a person's choice for it carries over. */
export const autoItemId = (target: ItemTarget, kind: EntityKind, preview: string): string =>
  digest(`${JSON.stringify(target)}\u0000${kind}\u0000${preview}`).slice(0, 20);

const clamp = (value: number): number => Math.min(1, Math.max(0, value));

/** A free-form box on a picture or a PDF page, given by its corner and size as shares of the page. */
export const boxRegion = (
  page: number,
  box: { readonly x: number; readonly y: number; readonly width: number; readonly height: number },
): RegionTarget => {
  const left = clamp(Math.min(box.x, box.x + box.width));
  const right = clamp(Math.max(box.x, box.x + box.width));
  const top = clamp(Math.min(box.y, box.y + box.height));
  const bottom = clamp(Math.max(box.y, box.y + box.height));
  return {
    type: "region",
    page,
    polygon: [
      { x: left, y: top },
      { x: right, y: top },
      { x: right, y: bottom },
      { x: left, y: bottom },
    ],
  };
};

/** A whole column, by default from the second row down: the first is the column's header. */
export const columnTarget = (sheet: string, column: number, fromRow = 1): CellsTarget => ({
  type: "cells",
  sheet,
  scope: "column",
  startRow: fromRow,
  endRow: null,
  startColumn: column,
  endColumn: column,
});

export const rowTarget = (sheet: string, row: number): CellsTarget => ({
  type: "cells",
  sheet,
  scope: "row",
  startRow: row,
  endRow: row,
  startColumn: 0,
  endColumn: null,
});

export const rangeTarget = (
  sheet: string,
  range: {
    readonly startRow: number;
    readonly endRow: number;
    readonly startColumn: number;
    readonly endColumn: number;
  },
): CellsTarget => ({
  type: "cells",
  sheet,
  scope:
    range.startRow === range.endRow && range.startColumn === range.endColumn ? "cell" : "range",
  startRow: Math.min(range.startRow, range.endRow),
  endRow: Math.max(range.startRow, range.endRow),
  startColumn: Math.min(range.startColumn, range.endColumn),
  endColumn: Math.max(range.startColumn, range.endColumn),
});

/** An item a person adds. Its action is theirs: the document's mode does not move it. */
export const manualItem = (input: {
  readonly target: ItemTarget;
  readonly action: DeidentificationAction;
  readonly kind?: EntityKind | undefined;
  readonly label?: string | undefined;
  readonly preview?: string | undefined;
}): LayerItem => ({
  id: NodeCrypto.randomUUID(),
  source: "manual",
  action: input.action,
  overridden: true,
  kind: input.kind ?? "OTHER",
  label: input.label ?? "Marked by hand",
  ...(input.preview === undefined ? {} : { preview: input.preview }),
  target: input.target,
});

const touched = (
  layer: DeidentificationLayer,
  change: Partial<DeidentificationLayer>,
): DeidentificationLayer => ({ ...layer, ...change, updatedAt: new Date().toISOString() });

export const addLayerItem = (
  layer: DeidentificationLayer,
  item: LayerItem,
): DeidentificationLayer =>
  touched(layer, { items: [...layer.items.filter((other) => other.id !== item.id), item] });

export const removeLayerItem = (layer: DeidentificationLayer, id: string): DeidentificationLayer =>
  touched(layer, { items: layer.items.filter((item) => item.id !== id) });

/** One item's own action: Mask, Redact or Keep, whatever the document's mode is. */
export const setItemAction = (
  layer: DeidentificationLayer,
  id: string,
  action: DeidentificationAction,
): DeidentificationLayer =>
  touched(layer, {
    items: layer.items.map((item) =>
      item.id === id ? { ...item, action, overridden: true } : item,
    ),
  });

/**
 * The document's mode. Every item a person has not decided takes it, except one that was found
 * and left open on purpose (a code that holds nothing personal).
 */
export const setDefaultMode = (
  layer: DeidentificationLayer,
  mode: DeidentificationMode,
): DeidentificationLayer =>
  touched(layer, {
    defaultMode: mode,
    items: layer.items.map((item) =>
      item.overridden === true || item.action === "keep" ? item : { ...item, action: mode },
    ),
  });

export const setReviewState = (
  layer: DeidentificationLayer,
  reviewState: ReviewState,
): DeidentificationLayer => touched(layer, { reviewState });

/** A file as it is now: its hash, and what detection finds in it. */
export interface FileSnapshot {
  readonly fileHash: string;
  readonly fileMtimeMs: number;
  /** The automatic items of the file as it is now. */
  readonly items: ReadonlyArray<LayerItem>;
  readonly warnings?: ReadonlyArray<string> | undefined;
  /**
   * Where a person's item is in the file as it is now, or nothing when what it marked is gone.
   * Without it, items that mark a place (a box, cells) stay and items that mark words go.
   */
  readonly reanchor?: ((item: LayerItem) => ItemTarget | undefined) | undefined;
}

export interface Reconciled {
  readonly layer: DeidentificationLayer;
  /** True when the file's content is not what the layer was made from. */
  readonly changed: boolean;
  /** A person's items whose words are no longer in the file. */
  readonly dropped: ReadonlyArray<LayerItem>;
}

const choiceKey = (item: LayerItem): string | undefined =>
  item.preview === undefined ? undefined : `${item.kind}\u0000${item.preview}`;

const marksAPlace = (target: ItemTarget): boolean =>
  target.type === "region" || target.type === "media" || target.type === "cells";

/**
 * Brings a layer up to a file that was edited outside DoeDesk. The same hash: nothing to do.
 * Another hash: what detection finds now replaces what it found before, a person's choice for a
 * value is kept where that value is found again, their own items are kept where what they marked
 * is still there, and a layer that was reviewed is `stale` until someone looks again.
 */
export const reconcileLayerOnFileChange = (
  layer: DeidentificationLayer,
  current: FileSnapshot,
): Reconciled => {
  if (current.fileHash === layer.fileHash) {
    const same = current.fileMtimeMs === layer.fileMtimeMs;
    return {
      layer: same ? layer : { ...layer, fileMtimeMs: current.fileMtimeMs },
      changed: false,
      dropped: [],
    };
  }
  const chosen = new Map<string, DeidentificationAction>();
  for (const item of layer.items) {
    const key = choiceKey(item);
    if (item.source === "auto" && item.overridden === true && key !== undefined) {
      chosen.set(key, item.action);
    }
  }
  const found = current.items.map((item): LayerItem => {
    const action = chosen.get(choiceKey(item) ?? "");
    if (action !== undefined) return { ...item, action, overridden: true };
    return item.action === "keep" ? item : { ...item, action: layer.defaultMode };
  });
  const kept: Array<LayerItem> = [];
  const dropped: Array<LayerItem> = [];
  for (const item of layer.items) {
    if (item.source !== "manual") continue;
    const target =
      current.reanchor === undefined
        ? marksAPlace(item.target)
          ? item.target
          : undefined
        : current.reanchor(item);
    if (target === undefined) dropped.push(item);
    else kept.push({ ...item, target, replacement: undefined });
  }
  return {
    layer: touched(layer, {
      fileHash: current.fileHash,
      fileMtimeMs: current.fileMtimeMs,
      reviewState: layer.reviewState === "unreviewed" ? "unreviewed" : "stale",
      items: [...found, ...kept],
      warnings: current.warnings ?? [],
    }),
    changed: true,
    dropped,
  };
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const REVIEW_STATES: ReadonlyArray<string> = ["unreviewed", "reviewed", "stale", "skipped"];
const ACTIONS: ReadonlyArray<string> = ["mask", "redact", "keep"];
const TARGET_TYPES: ReadonlyArray<string> = ["text", "region", "cells", "xml", "media"];

const isItem = (value: unknown): value is LayerItem =>
  isRecord(value) &&
  typeof value.id === "string" &&
  (value.source === "auto" || value.source === "manual") &&
  ACTIONS.includes(value.action as string) &&
  isEntityKind(value.kind) &&
  typeof value.label === "string" &&
  isRecord(value.target) &&
  TARGET_TYPES.includes(value.target.type as string);

/** A layer as it was stored, or nothing when the file holds anything else. */
export const parseLayer = (value: unknown): DeidentificationLayer | undefined =>
  isRecord(value) &&
  value.version === 1 &&
  typeof value.projectId === "string" &&
  typeof value.filePath === "string" &&
  typeof value.family === "string" &&
  typeof value.fileHash === "string" &&
  typeof value.fileMtimeMs === "number" &&
  (value.defaultMode === "mask" || value.defaultMode === "redact") &&
  REVIEW_STATES.includes(value.reviewState as string) &&
  Array.isArray(value.items) &&
  value.items.every(isItem)
    ? (value as unknown as DeidentificationLayer)
    : undefined;

/**
 * Layers on disk, one JSON file for each project and path, readable by this user alone. Kept
 * by the file's name and not its content, so the layer of a file that changed is found and can
 * be reconciled.
 */
export class LayerStore {
  readonly #directory: string;

  constructor(directory: string) {
    this.#directory = directory;
  }

  #pathOf(projectId: string, filePath: string): string {
    return NodePath.join(this.#directory, `${layerKey(projectId, filePath, "").locator}.json`);
  }

  read(projectId: string, filePath: string): DeidentificationLayer | undefined {
    let stored: string;
    try {
      stored = NodeFS.readFileSync(this.#pathOf(projectId, filePath), "utf8");
    } catch {
      return undefined;
    }
    try {
      return parseLayer(JSON.parse(stored));
    } catch {
      return undefined;
    }
  }

  write(layer: DeidentificationLayer): void {
    NodeFS.mkdirSync(this.#directory, { recursive: true, mode: 0o700 });
    const path = this.#pathOf(layer.projectId, layer.filePath);
    const draft = `${path}.${process.pid}.tmp`;
    NodeFS.writeFileSync(draft, JSON.stringify(layer), { mode: 0o600 });
    NodeFS.renameSync(draft, path);
  }

  remove(projectId: string, filePath: string): void {
    NodeFS.rmSync(this.#pathOf(projectId, filePath), { force: true });
  }
}
