import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { describe, expect, it } from "vite-plus/test";

import { type ReadForSealing, sealFile, unsealFile } from "./sealedFiles.ts";
import { makeSealedFolders, type SealChange } from "./sealedFolders.ts";
import { SealedStore } from "./worker/store.ts";

const NOW = Date.parse("2026-11-24T09:00:00.000Z");

const canRead = (name: string): boolean => /\.(?:txt|md|csv)$/.test(name);

/** Reads text files that have text, and nothing else: as the worker's reader would. */
const readText: ReadForSealing = async (name, bytes) =>
  !canRead(name)
    ? { ok: false, kind: "unsupported", message: "This kind of file cannot be read." }
    : bytes.length === 0
      ? { ok: false, kind: "noText", message: "No text was found in the file." }
      : { ok: true, text: bytes.toString("utf8"), mediaType: "text/plain" };

const setup = () => {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "doedesk-sealed-folders-"));
  const project = NodePath.join(root, "project");
  const contracts = NodePath.join(project, "contracts");
  NodeFS.mkdirSync(contracts, { recursive: true });
  const store = new SealedStore(NodePath.join(root, "sealed"));
  const clock = { now: NOW };
  const slept: Array<number> = [];
  /** What a test does while a turn waits for a file to settle. */
  const whileWaiting: { run: () => void } = { run: () => undefined };
  /** Files that cannot be moved out of the folder, as one open in another program on Windows. */
  const locked = new Set<string>();
  /** What the host was told, in order: it removes its own copies of what was sealed. */
  const changes: Array<SealChange> = [];
  const open = () =>
    makeSealedFolders({
      store,
      sealFile: async (projectId, filePath) =>
        locked.has(filePath)
          ? { ok: false, message: "The file could not be moved out of the folder." }
          : sealFile(store, readText, projectId, filePath, {
              maxReadBytes: 1024 * 1024,
              replaceSamePath: true,
            }),
      unsealFile: (projectId, handle) => unsealFile(store, projectId, handle),
      canRead,
      readFirst: () => false,
      now: () => clock.now,
      sleep: async (ms) => {
        slept.push(ms);
        clock.now += ms;
        whileWaiting.run();
      },
      watch: false,
      holdForMs: 10_000,
      onSealChange: async (change) => {
        changes.push(change);
      },
    });
  /** Writes a file last changed `ageMs` before the test's clock. */
  const write = (name: string, content: string | Buffer, ageMs = 60_000) => {
    const filePath = NodePath.join(project, name);
    NodeFS.mkdirSync(NodePath.dirname(filePath), { recursive: true });
    NodeFS.writeFileSync(filePath, content);
    const changed = new Date(clock.now - ageMs);
    NodeFS.utimesSync(filePath, changed, changed);
    return filePath;
  };
  return {
    project,
    contracts,
    store,
    clock,
    slept,
    whileWaiting,
    locked,
    changes,
    open,
    write,
    [Symbol.dispose]: () => NodeFS.rmSync(root, { recursive: true, force: true }),
  };
};

describe("sealing a subfolder", () => {
  it("leaves nothing readable in it: files that cannot be read are sealed too", async () => {
    using context = setup();
    const lease = context.write("contracts/lease.txt", "Rent is SAR 84,000 a year.");
    const annex = context.write("contracts/2024/a/b/c/d/e/f/g/h/i/annex.md", "Annex A");
    const video = context.write("contracts/signing.mp4", "not text");
    const blank = context.write("contracts/blank.txt", "");
    const hidden = context.write("contracts/.draft.txt", "A hidden draft.");
    const finder = context.write("contracts/.DS_Store", "finder");
    const outside = context.write("notes.txt", "Not in the folder.");
    const folders = context.open();

    expect(await folders.inspectFolder(context.contracts)).toMatchObject({
      files: 4,
      unsupported: 1,
      readFirst: 0,
    });
    expect(await folders.seal("p", context.project, context.contracts)).toEqual({
      ok: true,
      sealed: 5,
      left: [],
    });
    expect([lease, annex, video, blank, hidden].filter((path) => NodeFS.existsSync(path))).toEqual(
      [],
    );
    // What the operating system writes about the folder holds none of a document, and stays.
    expect([finder, outside].map((path) => NodeFS.existsSync(path))).toEqual([true, true]);
    const unread = context.store
      .list("p")
      .flatMap((document) =>
        document.unread === undefined ? [] : [[document.name, document.unread.kind]],
      );
    expect(unread.toSorted()).toEqual([
      ["blank.txt", "noText"],
      ["signing.mp4", "unsupported"],
    ]);
    expect(folders.list("p")).toMatchObject([{ project: "p", path: context.contracts, left: [] }]);
  });

  it("refuses the project's own folder, a folder outside it, one inside a sealed folder, and a repository", async () => {
    using context = setup();
    context.write("contracts/2024/annex.md", "Annex A");
    context.write("code/.git/HEAD", "ref: refs/heads/main");
    const folders = context.open();
    expect(await folders.seal("p", context.project, context.project)).toMatchObject({ ok: false });
    expect(
      await folders.seal("p", context.project, NodePath.dirname(context.project)),
    ).toMatchObject({ ok: false });
    expect(
      await folders.seal("p", context.project, NodePath.join(context.project, "code")),
    ).toMatchObject({ ok: false, message: expect.stringContaining("Git repository") });
    expect(await folders.seal("p", context.project, context.contracts)).toMatchObject({ ok: true });
    expect(
      await folders.seal("p", context.project, NodePath.join(context.contracts, "2024")),
    ).toMatchObject({ ok: false, message: expect.stringContaining("already sealed") });
    expect(folders.list("p")).toHaveLength(1);
  });

  it("seals a file that appears later, also one that arrived while the app was closed", async () => {
    using context = setup();
    const first = context.open();
    const there = context.write("contracts/lease.md", "Rent: 480,000 SAR a year.\n");
    const beside = context.write("contracts/annex.md", "Deposit: 40,000 SAR.\n");
    await first.seal("p", context.project, context.contracts);
    const arrived = context.write("contracts/new-hire.csv", "name,iqama\nSara,2456789012\n");
    expect(await first.beforeTurn("p")).toEqual({ ok: true, sealed: 1 });
    expect(NodeFS.existsSync(arrived)).toBe(false);
    expect(context.slept).toEqual([]);
    // The host hears of each action once, with every file of it, before the turn may start.
    expect(
      context.changes.map((change) => ({ ...change, paths: change.paths.toSorted() })),
    ).toEqual([
      { kind: "sealed", folder: context.contracts, paths: [beside, there] },
      { kind: "sealed", folder: context.contracts, paths: [arrived] },
    ]);
    first.close();

    // The folder is remembered across a restart, and the sweep before a turn finds the file.
    const later = context.write("contracts/payroll.csv", "name,salary\nSara,18000\n");
    const second = context.open();
    expect(await second.beforeTurn("p")).toEqual({ ok: true, sealed: 1 });
    expect(NodeFS.existsSync(later)).toBe(false);
    expect(await second.beforeTurn("other-project")).toEqual({ ok: true, sealed: 0 });

    await second.unseal("p", context.contracts);
    expect(context.changes.at(-1)).toEqual({
      kind: "unsealed",
      folder: context.contracts,
      paths: expect.arrayContaining([there, beside, arrived, later]),
    });
  });

  it("keeps one sealed file, on its handle, for a document saved again at the same path", async () => {
    using context = setup();
    const folders = context.open();
    context.write("contracts/report.txt", "Draft of March.");
    await folders.seal("p", context.project, context.contracts);
    const [first] = context.store.list("p");

    context.write("contracts/report.txt", "Final of April.");
    expect(await folders.beforeTurn("p")).toEqual({ ok: true, sealed: 1 });
    expect(context.store.list("p")).toMatchObject([{ handle: first?.handle, name: "report.txt" }]);
    expect(context.store.read("p", first?.handle ?? "")).toBe("Final of April.");
  });

  it("tells which sealed folder holds a path, so a write there can be refused", async () => {
    using context = setup();
    const folders = context.open();
    await folders.seal("p", context.project, context.contracts);
    expect(folders.containing(NodePath.join(context.contracts, "2024", "summary.md"))).toBe(
      context.contracts,
    );
    expect(folders.containing(context.contracts)).toBeUndefined();
    expect(folders.containing(NodePath.join(context.project, "contracts-old", "a.md"))).toBe(
      undefined,
    );
    expect(folders.containing(NodePath.join(context.project, "summary.md"))).toBeUndefined();
  });
});

describe("a turn about to start in a project with a sealed folder", () => {
  it("waits for a file written a moment ago, and starts once it is sealed", async () => {
    using context = setup();
    const folders = context.open();
    await folders.seal("p", context.project, context.contracts);
    const fresh = context.write("contracts/fresh.txt", "Saved a moment ago.", 400);
    let held: ReturnType<typeof folders.holds> = [];
    context.whileWaiting.run = () => {
      held = folders.holds();
    };

    expect(await folders.beforeTurn("p")).toEqual({ ok: true, sealed: 1 });
    expect(context.slept).toEqual([1_100]);
    expect(NodeFS.existsSync(fresh)).toBe(false);
    // While it waited, the wait could be shown; afterwards nothing is held.
    expect(held).toEqual([{ project: "p", folder: "contracts", files: 1 }]);
    expect(folders.holds()).toEqual([]);
  });

  it("does not start while a file is still being copied, and never deletes that file", async () => {
    using context = setup();
    const folders = context.open();
    await folders.seal("p", context.project, context.contracts);
    const copying = context.write("contracts/copying.txt", "Half of the", 0);
    // The copy goes on for longer than a turn waits.
    context.whileWaiting.run = () => context.write("contracts/copying.txt", "Half of the file", 0);

    expect(await folders.beforeTurn("p")).toEqual({
      ok: false,
      reason: "receiving",
      folder: "contracts",
      file: "copying.txt",
      message: null,
    });
    expect(context.slept.reduce((total, ms) => total + ms, 0)).toBeGreaterThanOrEqual(10_000);
    expect(NodeFS.readFileSync(copying, "utf8")).toBe("Half of the file");
    expect(context.store.list("p")).toEqual([]);

    // The copy has finished: the next turn seals the whole file and starts.
    context.whileWaiting.run = () => undefined;
    expect(await folders.beforeTurn("p")).toEqual({ ok: true, sealed: 1 });
    expect(context.store.read("p", "DOC_1")).toBe("Half of the file");
    folders.close();
  });

  it("does not start while a file that could not be taken out is still readable", async () => {
    using context = setup();
    const folders = context.open();
    await folders.seal("p", context.project, context.contracts);
    const open = context.write("contracts/open.txt", "Open in another program.");
    context.locked.add(open);

    expect(await folders.beforeTurn("p")).toEqual({
      ok: false,
      reason: "notSealed",
      folder: "contracts",
      file: "open.txt",
      message: "The file could not be moved out of the folder.",
    });
    expect(folders.list("p")[0]?.left).toMatchObject([{ path: open }]);

    context.locked.clear();
    expect(await folders.beforeTurn("p")).toEqual({ ok: true, sealed: 1 });
    expect(folders.list("p")[0]?.left).toEqual([]);
  });
});

describe("unsealing a folder", () => {
  it("puts every file back byte for byte, read or not, and stops sealing what arrives", async () => {
    using context = setup();
    // Not valid UTF-8 and with a carriage return: what goes back is the bytes, not the text.
    const bytes = Buffer.from([0xff, 0xfe, 0x52, 0x65, 0x6e, 0x74, 0x0d, 0x0a, 0x00, 0x41]);
    const lease = context.write("contracts/lease.txt", bytes);
    const annex = context.write("contracts/2024/annex.md", "Annex A\r\n");
    const video = context.write("contracts/signing.mp4", bytes);
    const loose = context.write("notes.txt", "Sealed on its own.");
    const folders = context.open();
    await sealFile(context.store, readText, "p", loose, { maxReadBytes: 1024 });
    await folders.seal("p", context.project, context.contracts);
    // The year's folder was deleted meanwhile: it is made again.
    NodeFS.rmSync(NodePath.join(context.contracts, "2024"), { recursive: true });

    expect(await folders.unseal("p", context.contracts)).toEqual({
      ok: true,
      restored: 3,
      renamed: 0,
      failed: [],
    });
    expect(NodeFS.readFileSync(lease).equals(bytes)).toBe(true);
    expect(NodeFS.readFileSync(video).equals(bytes)).toBe(true);
    expect(NodeFS.readFileSync(annex, "utf8")).toBe("Annex A\r\n");
    // A file sealed on its own, outside the folder, stays sealed.
    expect(context.store.list("p")).toMatchObject([{ name: "notes.txt" }]);
    expect(NodeFS.existsSync(loose)).toBe(false);

    expect(folders.list("p")).toEqual([]);
    expect(await folders.beforeTurn("p")).toEqual({ ok: true, sealed: 0 });
    expect(NodeFS.existsSync(lease)).toBe(true);
    expect(await folders.unseal("p", context.contracts)).toMatchObject({ ok: false });
  });
});
