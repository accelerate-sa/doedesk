import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { describe, expect, it } from "vite-plus/test";

import { RedactionStore } from "./store.ts";

const folder = () => NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "doedesk-redactions-"));
const image = { bytes: Buffer.from("not really a png"), mediaType: "image/png" };

describe("what was sent in place of an attachment", () => {
  it("is kept as two files only the user can read, and never the original", () => {
    const directory = NodePath.join(folder(), "redactions");
    const store = new RedactionStore(directory);
    const original = Buffer.from("the original picture, with Khalid Al-Otaibi in it");
    const record = store.save({
      original,
      kind: "image",
      outcome: "redacted",
      image,
      text: "Owner [PERSON_FBJD2]",
      width: 800,
      height: 600,
      valueBoxes: 1,
    });
    expect(NodeFS.statSync(directory).mode & 0o777).toBe(0o700);
    const names = NodeFS.readdirSync(directory).toSorted();
    expect(names).toEqual([`${record.id}.image`, `${record.id}.json`, `${record.id}.txt`]);
    for (const name of names) {
      const path = NodePath.join(directory, name);
      expect(NodeFS.statSync(path).mode & 0o777, name).toBe(0o600);
      expect(NodeFS.readFileSync(path).includes("Khalid"), name).toBe(false);
    }
    expect(store.read(record.id, "image")).toMatchObject({
      mediaType: "image/png",
      fileName: `redacted-${record.id.slice(0, 8)}.png`,
    });
    expect(store.read(record.id, "text")?.bytes.toString()).toBe("Owner [PERSON_FBJD2]");
    expect(store.list()).toMatchObject([
      { id: record.id, hasImage: true, hasText: true, width: 800 },
    ]);
  });

  it("replaces the record of the same file instead of keeping both", () => {
    const store = new RedactionStore(folder());
    const original = Buffer.from("one file");
    store.save({ original, kind: "image", outcome: "redacted", image, text: "first" });
    const second = store.save({ original, kind: "image", outcome: "text", text: "second" });
    expect(store.list()).toHaveLength(1);
    expect(store.read(second.id, "image")).toBeUndefined();
    expect(store.read(second.id, "text")?.bytes.toString()).toBe("second");
  });

  it("answers only for a record's own id", () => {
    const directory = folder();
    const store = new RedactionStore(directory);
    NodeFS.writeFileSync(NodePath.join(directory, "secret.txt"), "not a record");
    store.save({ original: Buffer.from("a"), kind: "file", outcome: "text", text: "masked" });
    for (const id of [
      "../secret",
      "secret",
      "",
      "0".repeat(24),
      "../../etc/passwd",
      "g".repeat(24),
    ]) {
      expect(store.read(id, "text"), id).toBeUndefined();
      expect(store.read(id, "image"), id).toBeUndefined();
    }
  });

  it("deletes records after their time and beyond their number", () => {
    const directory = folder();
    const store = new RedactionStore(directory, { maxRecords: 3, maxAgeMs: 60_000 });
    const ids = ["a", "b", "c", "d", "e"].map(
      (name) =>
        store.save({ original: Buffer.from(name), kind: "image", outcome: "text", text: name }).id,
    );
    expect(store.list().length).toBeLessThanOrEqual(3);
    // One record is made old by hand; opening the store again deletes it.
    const kept = store.list()[0];
    if (kept === undefined) throw new Error("no record");
    const path = NodePath.join(directory, `${kept.id}.json`);
    NodeFS.writeFileSync(path, JSON.stringify({ ...kept, at: "2020-01-01T00:00:00.000Z" }));
    const reopened = new RedactionStore(directory, { maxRecords: 3, maxAgeMs: 60_000 });
    expect(reopened.list().some((record) => record.id === kept.id)).toBe(false);
    expect(NodeFS.existsSync(NodePath.join(directory, `${kept.id}.txt`))).toBe(false);
    expect(ids).toHaveLength(5);
  });

  it("deletes everything when asked", () => {
    const directory = folder();
    const store = new RedactionStore(directory);
    store.save({
      original: Buffer.from("a"),
      kind: "image",
      outcome: "redacted",
      image,
      text: "t",
    });
    store.save({ original: Buffer.from("b"), kind: "file", outcome: "text", text: "t" });
    store.clear();
    expect(store.list()).toEqual([]);
    expect(NodeFS.readdirSync(directory)).toEqual([]);
  });
});
