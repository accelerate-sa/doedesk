import type { DeidentifyItem, DeidentifyLayer } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  applyChangeLocally,
  boxBetween,
  boxOfPolygon,
  columnLetter,
  columnTargetOf,
  groupItems,
  isLocalItem,
  manualMarksOn,
  markAt,
  matchesFilter,
  moveBox,
  occurrencesOf,
  polygonOfBox,
  resizeBox,
  segmentsOf,
  sheetMarksOf,
  spansIn,
  stretchesAt,
} from "./deidentifyModel";

const item = (
  id: string,
  target: DeidentifyItem["target"],
  over: Partial<DeidentifyItem> = {},
): DeidentifyItem => ({
  id,
  source: "auto",
  action: "mask",
  kind: "IBAN",
  label: "IBAN",
  target,
  ...over,
});

const layerOf = (items: ReadonlyArray<DeidentifyItem>): DeidentifyLayer => ({
  family: "text",
  defaultMode: "mask",
  reviewState: "unreviewed",
  items,
  unchecked: false,
  fileRevision: "f",
  revision: "r",
});

describe("boxes", () => {
  it("keeps a box on the page however it is drawn, moved or resized", () => {
    const box = boxBetween({ x: 0.6, y: 0.5 }, { x: -0.2, y: 0.1 });
    expect(box).toEqual({ x: 0, y: 0.1, width: 0.6, height: 0.4 });
    expect(boxOfPolygon(polygonOfBox(box))).toEqual(box);
    expect(moveBox(box, 0.9, -0.9)).toMatchObject({ x: 0.4, y: 0 });
    // The opposite corner stays put, also when the dragged one crosses it.
    expect(resizeBox(box, "nw", { x: 0.8, y: 0.3 })).toEqual({
      x: 0.6,
      y: 0.3,
      width: expect.closeTo(0.2),
      height: expect.closeTo(0.2),
    });
  });
});

describe("marked text", () => {
  it("lets a person's own mark stand before a found one it overlaps", () => {
    const found = item("found", { type: "text", start: 2, end: 10 });
    const own = item("own", { type: "text", start: 8, end: 12 }, { source: "manual" });
    const after = item("after", { type: "text", start: 14, end: 16 });
    const outside = item("outside", { type: "text", start: 18, end: 40 });
    const spans = spansIn([found, own, after, outside], 20, (entry) =>
      entry.target.type === "text" ? entry.target : undefined,
    );
    expect(spans.map((span) => span.item.id)).toEqual(["own", "after"]);
    expect(segmentsOf(20, spans).map((segment) => [segment.start, segment.end])).toEqual([
      [0, 8],
      [8, 12],
      [12, 14],
      [14, 16],
      [16, 20],
    ]);
    expect(occurrencesOf("Huda met Huda", "Huda")).toEqual([
      { start: 0, end: 4 },
      { start: 9, end: 13 },
    ]);
    expect(occurrencesOf("Huda", " ")).toEqual([]);
  });
});

describe("sheets", () => {
  it("names columns as a spreadsheet does", () => {
    expect([0, 25, 26, 701, 702].map(columnLetter)).toEqual(["A", "Z", "AA", "ZZ", "AAA"]);
  });

  it("decides a cell by its own mark, then its row's, then its column's", () => {
    const column = item("column", columnTargetOf("s", 1), { source: "manual", action: "redact" });
    const row = item(
      "row",
      {
        type: "cells",
        sheet: "s",
        scope: "row",
        startRow: 2,
        endRow: 2,
        startColumn: 0,
        endColumn: null,
      },
      { source: "manual", action: "keep" },
    );
    const cell = item("cell", {
      type: "cells",
      sheet: "s",
      scope: "cell",
      startRow: 3,
      endRow: 3,
      startColumn: 1,
      endColumn: 1,
    });
    const inside = item("inside", {
      type: "cells",
      sheet: "s",
      scope: "cell",
      startRow: 1,
      endRow: 1,
      startColumn: 0,
      endColumn: 0,
      start: 2,
      end: 6,
    });
    const elsewhere = item("elsewhere", columnTargetOf("other", 1));
    const items = [column, row, cell, inside, elsewhere];
    const marks = sheetMarksOf(items, "s", { rows: 5, columns: 3 });

    // A column's mark leaves the header it was made from alone.
    expect(markAt(marks, 0, 1)).toBeUndefined();
    expect(markAt(marks, 1, 1)?.id).toBe("column");
    expect(markAt(marks, 2, 1)?.id).toBe("row");
    expect(markAt(marks, 3, 1)?.id).toBe("cell");
    expect(markAt(marks, 1, 0)).toBeUndefined();
    expect(stretchesAt(marks, 1, 0).map((entry) => entry.id)).toEqual(["inside"]);
    expect(manualMarksOn(items, columnTargetOf("s", 1)).map((entry) => entry.id)).toEqual([
      "column",
    ]);
  });
});

describe("a layer ahead of the server", () => {
  it("shows a change at once, and a new mark under a name of its own", () => {
    const found = item("found", { type: "text", start: 0, end: 4 });
    const own = item("own", { type: "text", start: 5, end: 9 }, { source: "manual" });
    const layer = layerOf([found, own]);

    const kept = applyChangeLocally(layer, { type: "setItemAction", id: "found", action: "keep" });
    expect(kept.items[0]?.action).toBe("keep");
    // What was found is never deleted, only kept.
    expect(applyChangeLocally(layer, { type: "removeItem", id: "found" }).items).toHaveLength(2);
    expect(applyChangeLocally(layer, { type: "removeItem", id: "own" }).items).toEqual([found]);

    const added = applyChangeLocally(layer, {
      type: "addItem",
      action: "redact",
      target: { type: "text", start: 10, end: 12 },
    });
    const made = added.items[2];
    expect(made).toMatchObject({ source: "manual", action: "redact" });
    expect(made !== undefined && isLocalItem(made)).toBe(true);
    expect(isLocalItem(own)).toBe(false);
  });
});

describe("lists", () => {
  it("groups items by page in the document's order and filters files by status", () => {
    const region = (page: number) => ({ type: "region" as const, page, polygon: [] });
    const groups = groupItems(
      [item("b", region(2)), item("a", region(0)), item("c", region(2))],
      3,
    );
    expect(groups.map((group) => [group.key, group.items.map((entry) => entry.id)])).toEqual([
      ["page:0", ["a"]],
      ["page:2", ["b", "c"]],
    ]);
    // A picture is one place: its items need no heading.
    expect(groupItems([item("a", region(0))], 1).map((group) => group.place.type)).toEqual([
      "file",
    ]);

    expect(
      (["notScanned", "unreviewed", "stale", "reviewed", "skipped"] as const).map((status) => [
        matchesFilter(status, "needsReview"),
        matchesFilter(status, "changed"),
        matchesFilter(status, "reviewed"),
      ]),
    ).toEqual([
      [true, false, false],
      [true, false, false],
      [true, true, false],
      [false, false, true],
      [false, false, true],
    ]);
  });
});
