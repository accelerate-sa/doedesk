import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { describe, expect, it } from "vite-plus/test";

import {
  addLayerItem,
  boxRegion,
  columnTarget,
  type DeidentificationLayer,
  layerKey,
  type LayerItem,
  LayerStore,
  manualItem,
  parseLayer,
  rangeTarget,
  reconcileLayerOnFileChange,
  setDefaultMode,
  setItemAction,
  setReviewState,
} from "./layer.ts";

const found = (id: string, kind: LayerItem["kind"], preview: string, start: number): LayerItem => ({
  id,
  source: "auto",
  action: "mask",
  kind,
  label: kind,
  preview,
  target: { type: "text", start, end: start + preview.length },
});

const layerOf = (items: ReadonlyArray<LayerItem>): DeidentificationLayer => ({
  version: 1,
  projectId: "project-1",
  filePath: "clients/letter.txt",
  family: "text",
  fileHash: "a".repeat(64),
  fileMtimeMs: 1000,
  defaultMode: "mask",
  reviewState: "unreviewed",
  items,
  warnings: [],
  updatedAt: "2026-01-01T00:00:00.000Z",
});

describe("a layer's key", () => {
  it("names the file by project and path, and one state of it by its content", () => {
    const first = layerKey("project-1", "clients/letter.txt", "a".repeat(64));
    const edited = layerKey("project-1", "clients/letter.txt", "b".repeat(64));
    expect(edited.locator).toBe(first.locator);
    expect(edited.key).not.toBe(first.key);
    expect(layerKey("project-2", "clients/letter.txt", "a".repeat(64)).locator).not.toBe(
      first.locator,
    );
    expect(layerKey("project-1", "clients/other.txt", "a".repeat(64)).locator).not.toBe(
      first.locator,
    );
    // Neither says anything of the path it was made from.
    expect(first.key).not.toContain("letter");
  });
});

describe("the document's mode and an item's own action", () => {
  it("moves every item a person has not decided, and leaves the ones they have", () => {
    const layer = setItemAction(
      layerOf([
        found("name", "PERSON", "Sami Alharbi", 0),
        found("iban", "IBAN", "SA4420000001234567891234", 30),
        { ...found("code", "URL", "https://www.example.com/", 80), action: "keep" },
      ]),
      "name",
      "keep",
    );
    const redacted = setDefaultMode(layer, "redact");
    expect(redacted.defaultMode).toBe("redact");
    expect(redacted.items.map((item) => [item.id, item.action])).toEqual([
      ["name", "keep"],
      ["iban", "redact"],
      // Found and left open on purpose: the mode does not close it.
      ["code", "keep"],
    ]);
    const back = setDefaultMode(setItemAction(redacted, "iban", "mask"), "redact");
    expect(back.items.find((item) => item.id === "iban")?.action).toBe("mask");
  });

  it("builds a person's own targets: a clamped box, a column under its header, a range", () => {
    expect(boxRegion(2, { x: 0.9, y: -0.1, width: 0.3, height: 0.2 })).toEqual({
      type: "region",
      page: 2,
      polygon: [
        { x: 0.9, y: 0 },
        { x: 1, y: 0 },
        { x: 1, y: 0.1 },
        { x: 0.9, y: 0.1 },
      ],
    });
    expect(columnTarget("Staff", 3)).toMatchObject({
      scope: "column",
      startRow: 1,
      endRow: null,
      startColumn: 3,
      endColumn: 3,
    });
    expect(
      rangeTarget("Staff", { startRow: 4, endRow: 2, startColumn: 1, endColumn: 1 }),
    ).toMatchObject({
      scope: "range",
      startRow: 2,
      endRow: 4,
    });
    expect(
      manualItem({ target: boxRegion(0, { x: 0, y: 0, width: 1, height: 1 }), action: "redact" }),
    ).toMatchObject({
      source: "manual",
      overridden: true,
      kind: "OTHER",
    });
  });
});

describe("a file edited outside DoeDesk", () => {
  const reviewed = (): DeidentificationLayer => {
    const base = layerOf([
      found("name", "PERSON", "Sami Alharbi", 0),
      found("iban", "IBAN", "SA4420000001234567891234", 30),
      found("gone", "PHONE", "0551234567", 60),
    ]);
    const box = manualItem({
      target: boxRegion(0, { x: 0.1, y: 0.1, width: 0.2, height: 0.2 }),
      action: "redact",
    });
    const words = manualItem({
      target: { type: "text", start: 70, end: 82 },
      action: "redact",
      preview: "Project Falcon",
    });
    const lost = manualItem({
      target: { type: "text", start: 90, end: 99 },
      action: "mask",
      preview: "old words",
    });
    const withItems = [box, words, lost].reduce(addLayerItem, base);
    return setReviewState(setItemAction(withItems, "name", "keep"), "reviewed");
  };

  it("leaves the layer alone while the content is the same, whatever the file's date says", () => {
    const layer = reviewed();
    const same = reconcileLayerOnFileChange(layer, {
      fileHash: layer.fileHash,
      fileMtimeMs: 2000,
      items: [],
    });
    expect(same.changed).toBe(false);
    expect(same.layer).toEqual({ ...layer, fileMtimeMs: 2000 });
    expect(
      reconcileLayerOnFileChange(layer, { fileHash: layer.fileHash, fileMtimeMs: 1000, items: [] })
        .layer,
    ).toBe(layer);
  });

  it("marks the layer stale, keeps a person's choices and marks where they still hold, and drops the rest", () => {
    const layer = reviewed();
    const [box, words, lost] = layer.items.filter((item) => item.source === "manual");
    const result = reconcileLayerOnFileChange(layer, {
      fileHash: "b".repeat(64),
      fileMtimeMs: 3000,
      // The name moved, the account is new, the phone number was deleted.
      items: [
        found("name-2", "PERSON", "Sami Alharbi", 12),
        found("iban-2", "IBAN", "SA0380000000608010167519", 44),
      ],
      reanchor: (item) =>
        item.id === words?.id
          ? { type: "text", start: 95, end: 109 }
          : item.id === box?.id
            ? item.target
            : undefined,
    });
    expect(result.changed).toBe(true);
    expect(result.layer).toMatchObject({
      fileHash: "b".repeat(64),
      fileMtimeMs: 3000,
      reviewState: "stale",
    });
    expect(
      result.layer.items.map((item) => [item.id, item.action, item.overridden === true]),
    ).toEqual([
      // Kept before the edit: kept after it, wherever the name now stands.
      ["name-2", "keep", true],
      ["iban-2", "mask", false],
      [box?.id, "redact", true],
      [words?.id, "redact", true],
    ]);
    expect(result.layer.items.find((item) => item.id === words?.id)?.target).toEqual({
      type: "text",
      start: 95,
      end: 109,
    });
    expect(result.dropped.map((item) => item.id)).toEqual([lost?.id]);
  });

  it("keeps marks that are places and drops marks that are words when nothing can place them again", () => {
    const layer = reviewed();
    const result = reconcileLayerOnFileChange(layer, {
      fileHash: "c".repeat(64),
      fileMtimeMs: 1,
      items: [],
    });
    expect(result.layer.items.map((item) => item.target.type)).toEqual(["region"]);
    expect(result.dropped).toHaveLength(2);
  });

  it("stays unreviewed when nobody had looked yet, and flags a skipped file again", () => {
    const fresh = layerOf([found("name", "PERSON", "Sami Alharbi", 0)]);
    const change = { fileHash: "d".repeat(64), fileMtimeMs: 1, items: [] };
    expect(reconcileLayerOnFileChange(fresh, change).layer.reviewState).toBe("unreviewed");
    expect(
      reconcileLayerOnFileChange(setReviewState(fresh, "skipped"), change).layer.reviewState,
    ).toBe("stale");
  });
});

describe("layers on disk", () => {
  it("keeps one layer for each project and path, private to the user, and reads nothing else as one", () => {
    const folder = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "doedesk-layers-"));
    try {
      const store = new LayerStore(NodePath.join(folder, "layers"));
      const layer = layerOf([found("name", "PERSON", "Sami Alharbi", 0)]);
      expect(store.read(layer.projectId, layer.filePath)).toBeUndefined();
      store.write(layer);
      store.write({ ...layer, filePath: "clients/other.txt" });
      expect(store.read(layer.projectId, layer.filePath)).toEqual(layer);
      // A changed file is found under the same name: that is how its layer is reconciled.
      store.write({ ...layer, fileHash: "e".repeat(64) });
      expect(store.read(layer.projectId, layer.filePath)?.fileHash).toBe("e".repeat(64));

      const files = NodeFS.readdirSync(NodePath.join(folder, "layers"));
      expect(files).toHaveLength(2);
      for (const file of files) {
        expect(file).not.toContain("letter");
        expect(NodeFS.statSync(NodePath.join(folder, "layers", file)).mode & 0o777).toBe(0o600);
      }
      NodeFS.writeFileSync(NodePath.join(folder, "layers", files[0] ?? ""), '{"version":2}');
      NodeFS.writeFileSync(NodePath.join(folder, "layers", files[1] ?? ""), "not json");
      expect(store.read(layer.projectId, layer.filePath)).toBeUndefined();
      expect(store.read(layer.projectId, "clients/other.txt")).toBeUndefined();
      store.remove(layer.projectId, layer.filePath);
      expect(NodeFS.readdirSync(NodePath.join(folder, "layers"))).toHaveLength(1);
    } finally {
      NodeFS.rmSync(folder, { recursive: true, force: true });
    }
  });

  it("refuses a stored layer whose items are not items", () => {
    const layer = layerOf([found("name", "PERSON", "Sami Alharbi", 0)]);
    expect(parseLayer(JSON.parse(JSON.stringify(layer)))).toEqual(layer);
    expect(parseLayer({ ...layer, items: [{ id: "x" }] })).toBeUndefined();
    expect(parseLayer({ ...layer, defaultMode: "keep" })).toBeUndefined();
    expect(parseLayer({ ...layer, reviewState: "done" })).toBeUndefined();
  });
});
