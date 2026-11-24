import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { describe, expect, it } from "vite-plus/test";

import { type ReadForSealing, sealFile, unsealFile } from "./sealedFiles.ts";
import { SealedStore } from "./worker/store.ts";

/** Reads a `.txt` file as its own text, and nothing else: as the worker's reader would. */
const readText: ReadForSealing = async (name, bytes) =>
  name.endsWith(".txt") && bytes.length > 0
    ? { ok: true, text: bytes.toString("utf8"), mediaType: "text/plain" }
    : { ok: false, kind: "unsupported", message: "This kind of file cannot be read." };

const setup = () => {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "doedesk-sealed-files-"));
  const folder = NodePath.join(root, "folder");
  NodeFS.mkdirSync(NodePath.join(folder, "contracts"), { recursive: true });
  const store = new SealedStore(NodePath.join(root, "sealed"));
  const seal = (
    filePath: string,
    options: { readonly maxReadBytes?: number; readonly replaceSamePath?: boolean } = {},
    read: ReadForSealing = readText,
  ) => sealFile(store, read, "p", filePath, { maxReadBytes: 1024, ...options });
  const write = (name: string, text: string | Buffer) => {
    const filePath = NodePath.join(folder, name);
    NodeFS.writeFileSync(filePath, text);
    return filePath;
  };
  return {
    folder,
    store,
    seal,
    write,
    [Symbol.dispose]: () => NodeFS.rmSync(root, { recursive: true, force: true }),
  };
};

const handleOf = (result: Awaited<ReturnType<typeof sealFile>>): string => {
  if (!result.ok) throw new Error(result.message);
  return result.document.handle;
};

describe("sealing a file where it lies", () => {
  it("moves the file out of the folder and puts the same bytes back", async () => {
    using context = setup();
    const filePath = context.write("contracts/lease.txt", "Rent is SAR 84,000 a year.\r\n");
    const lastChanged = new Date("2026-03-09T08:15:30.000Z");
    NodeFS.utimesSync(filePath, lastChanged, lastChanged);
    const handle = handleOf(await context.seal(filePath));
    expect(NodeFS.existsSync(filePath)).toBe(false);
    expect(context.store.list("p")).toMatchObject([
      { handle, name: "lease.txt", origin: filePath },
    ]);
    expect(context.store.read("p", handle)).toBe("Rent is SAR 84,000 a year.\r\n");

    // The subfolder was deleted meanwhile: it is made again.
    NodeFS.rmSync(NodePath.dirname(filePath), { recursive: true });
    expect(await unsealFile(context.store, "p", handle)).toEqual({
      ok: true,
      name: "lease.txt",
      path: filePath,
      renamed: false,
    });
    expect(NodeFS.readFileSync(filePath, "utf8")).toBe("Rent is SAR 84,000 a year.\r\n");
    // As it was, also by its date: the person sorts a folder by when a file last changed.
    expect(NodeFS.statSync(filePath).mtime).toEqual(lastChanged);
    expect(context.store.list("p")).toEqual([]);
    expect(context.store.original("p", handle)).toBeUndefined();
  });

  it("never overwrites a file that took the sealed one's place", async () => {
    using context = setup();
    const filePath = context.write("lease.txt", "The sealed lease.");
    const handle = handleOf(await context.seal(filePath));
    context.write("lease.txt", "A new lease someone wrote meanwhile.");
    context.write("lease (unsealed).txt", "And a file with the fallback name.");

    const result = await unsealFile(context.store, "p", handle);
    const beside = NodePath.join(context.folder, "lease (unsealed 2).txt");
    expect(result).toEqual({ ok: true, name: "lease.txt", path: beside, renamed: true });
    expect(NodeFS.readFileSync(beside, "utf8")).toBe("The sealed lease.");
    expect(NodeFS.readFileSync(filePath, "utf8")).toBe("A new lease someone wrote meanwhile.");
  });

  it("writes nothing when the same file is already back in place", async () => {
    using context = setup();
    const filePath = context.write("lease.txt", "The sealed lease.");
    const handle = handleOf(await context.seal(filePath));
    context.write("lease.txt", "The sealed lease.");
    expect(await unsealFile(context.store, "p", handle)).toMatchObject({
      path: filePath,
      renamed: false,
    });
    expect(NodeFS.readdirSync(context.folder).toSorted()).toEqual(["contracts", "lease.txt"]);
  });

  it("puts two files with the same text back in their own places", async () => {
    using context = setup();
    const first = context.write("a.txt", "Same words.");
    const second = context.write("contracts/b.txt", "Same words.");
    const handles = [handleOf(await context.seal(first)), handleOf(await context.seal(second))];
    expect(new Set(handles).size).toBe(2);
    for (const handle of handles) await unsealFile(context.store, "p", handle);
    expect(NodeFS.existsSync(first) && NodeFS.existsSync(second)).toBe(true);
  });

  it("takes a file out of the folder whether or not it can be read, and reads it later", async () => {
    using context = setup();
    // Not valid UTF-8: what goes back is the bytes that were there.
    const bytes = Buffer.from([0x00, 0xff, 0xfe, 0x41, 0x0d, 0x0a]);
    const filePath = context.write("scan.bin", bytes);
    const sealed = await context.seal(filePath);
    const handle = handleOf(sealed);
    expect(NodeFS.existsSync(filePath)).toBe(false);
    expect(context.store.list("p")).toMatchObject([
      {
        handle,
        name: "scan.bin",
        origin: filePath,
        unread: { kind: "unsupported", message: "This kind of file cannot be read." },
      },
    ]);
    // Nothing of it can be asked about, and nothing of it is watched for in what is sent.
    expect(context.store.read("p", handle)).toBeUndefined();
    expect(context.store.tripwire.size).toBe(0);

    // Read later, from the kept copy: the same handle can then be asked about.
    expect(context.store.setText("p", handle, "Text read later.", "text/plain")).toBe(true);
    expect(context.store.list("p")[0]?.unread).toBeUndefined();
    expect(context.store.read("p", handle)).toBe("Text read later.");

    expect(await unsealFile(context.store, "p", handle)).toMatchObject({ ok: true });
    expect(NodeFS.readFileSync(filePath).equals(bytes)).toBe(true);
    // A folder is not a file, and nothing there can be read by anyone.
    expect(await context.seal(NodePath.join(context.folder, "contracts"))).toMatchObject({
      ok: false,
      unreadable: true,
    });
  });

  it("keeps a file too large to read a piece at a time, and puts every byte back", async () => {
    using context = setup();
    // Larger than the pieces it is kept in, so more than one is written and read back.
    const bytes = Buffer.alloc(3 * 1024 * 1024 + 17);
    for (let index = 0; index < bytes.length; index += 1) bytes[index] = (index * 31) % 251;
    const filePath = context.write("recording.txt", bytes);
    let read = 0;
    const handle = handleOf(
      await context.seal(filePath, {}, async (name, content) => {
        read += 1;
        return readText(name, content);
      }),
    );
    expect(read).toBe(0);
    expect(NodeFS.existsSync(filePath)).toBe(false);
    expect(context.store.list("p")).toMatchObject([{ handle, unread: { kind: "tooLarge" } }]);
    expect(context.store.originalWithin("p", handle, 1024)).toBeUndefined();

    expect(await unsealFile(context.store, "p", handle)).toMatchObject({ ok: true });
    expect(NodeFS.readFileSync(filePath).equals(bytes)).toBe(true);
  });

  it("never takes a file that changed while it was being read", async () => {
    using context = setup();
    const filePath = context.write("copying.txt", "Half of the");
    const refused = await context.seal(filePath, {}, async (name, bytes) => {
      // The copy that is writing the file goes on while its text is read.
      NodeFS.appendFileSync(filePath, " file");
      return readText(name, bytes);
    });
    expect(refused).toMatchObject({ ok: false, changing: true });
    expect(NodeFS.readFileSync(filePath, "utf8")).toBe("Half of the file");
    expect(context.store.list("p")).toEqual([]);
  });

  it("puts a file saved again at the same path in place of the earlier one, on its handle", async () => {
    using context = setup();
    const filePath = context.write("contracts/report.txt", "Draft of March.");
    const first = handleOf(await context.seal(filePath, { replaceSamePath: true }));
    context.write("contracts/report.txt", "Final of April.");
    const second = handleOf(await context.seal(filePath, { replaceSamePath: true }));
    expect(second).toBe(first);
    expect(context.store.list("p")).toMatchObject([{ handle: first, name: "report.txt" }]);
    expect(context.store.read("p", first)).toBe("Final of April.");
    // The earlier version's wording is no longer watched for in what is sent.
    expect(context.store.tripwire.size).toBe(1);

    // Saved once more as something that cannot be read: still the one entry, now unread.
    context.write("contracts/report.txt", "");
    expect(handleOf(await context.seal(filePath, { replaceSamePath: true }))).toBe(first);
    expect(context.store.list("p")).toMatchObject([
      { handle: first, unread: { kind: "unsupported" } },
    ]);
    expect(context.store.read("p", first)).toBeUndefined();

    // Sealed by hand, a file of the same path is a file of its own.
    context.write("contracts/report.txt", "Another report.");
    expect(handleOf(await context.seal(filePath))).not.toBe(first);
    expect(context.store.list("p")).toHaveLength(2);
  });

  it("gives a file sealed again where it was the handle it had, changed or not, and none of its kept answers", async () => {
    using context = setup();
    const lease = context.write("contracts/lease.txt", "Rent is SAR 84,000 a year.");
    const first = handleOf(await context.seal(lease));
    const annex = context.write("contracts/annex.txt", "Deposit: SAR 7,000.");
    const second = handleOf(await context.seal(annex));
    const answered = [{ key: "rent", raw: { value: "84,000" }, unquotedChoice: false }];
    context.store.keepAnswers("p", first, "worker", "digest of the March text", answered);
    expect(context.store.keptAnswers("p", first, "worker", "digest of the March text")).toEqual(
      answered,
    );

    // Unsealed and sealed again as it was: the chat that knew the handle still has the file.
    expect((await unsealFile(context.store, "p", first)).ok).toBe(true);
    expect(handleOf(await context.seal(lease))).toBe(first);
    expect(context.store.keptAnswers("p", first, "worker", "digest of the March text")).toEqual([]);

    // Unsealed, changed and sealed again: the handle still points to this file, with new text.
    expect((await unsealFile(context.store, "p", first)).ok).toBe(true);
    context.write("contracts/lease.txt", "Rent is SAR 96,000 a year.");
    expect(handleOf(await context.seal(lease))).toBe(first);
    expect(context.store.read("p", first)).toBe("Rent is SAR 96,000 a year.");
    expect(context.store.list("p").map((document) => document.handle)).toEqual([second, first]);

    // A file that was never sealed takes the next handle, never one that is waiting for its file.
    expect((await unsealFile(context.store, "p", second)).ok).toBe(true);
    const third = handleOf(await context.seal(context.write("contracts/new.txt", "A new file.")));
    expect([first, second]).not.toContain(third);
    expect(handleOf(await context.seal(annex))).toBe(second);
  });

  it("keeps the document sealed when the file cannot be put back", async () => {
    using context = setup();
    const filePath = context.write("contracts/lease.txt", "The sealed lease.");
    const handle = handleOf(await context.seal(filePath));
    // A file now stands where the subfolder was.
    NodeFS.rmSync(NodePath.dirname(filePath), { recursive: true });
    NodeFS.writeFileSync(NodePath.dirname(filePath), "in the way");
    expect((await unsealFile(context.store, "p", handle)).ok).toBe(false);
    expect(context.store.original("p", handle)?.bytes.toString()).toBe("The sealed lease.");
  });

  it("only drops the copy of a document that was sealed from a copy", async () => {
    using context = setup();
    const { handle } = context.store.add("p", "upload.txt", "Uploaded words.", "text/plain");
    expect(await unsealFile(context.store, "p", handle)).toEqual({
      ok: true,
      name: "upload.txt",
      path: null,
      renamed: false,
    });
    expect((await unsealFile(context.store, "p", handle)).ok).toBe(false);
  });

  it("tells its listener when what a project's listing shows changed, and only then", async () => {
    const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "doedesk-sealed-listener-"));
    using _cleanup = {
      [Symbol.dispose]: () => NodeFS.rmSync(root, { recursive: true, force: true }),
    };
    let told = 0;
    const store = new SealedStore(root, () => {
      told += 1;
    });
    const changes = (act: () => void): number => {
      const before = told;
      act();
      return told - before;
    };
    let handle = "";
    expect(
      changes(() => {
        handle = store.add("p", "lease.txt", "Rent is SAR 84,000.", "text/plain").handle;
      }),
    ).toBeGreaterThan(0);
    const folders = [{ path: "/folder/contracts", project: "p", sealedAt: "now", left: [] }];
    expect(changes(() => store.saveFolders("p", folders))).toBe(1);
    // A sweep that found nothing new saves the same folders: no one is told.
    expect(changes(() => store.saveFolders("p", folders))).toBe(0);
    const ledger = { ...store.ledger("p"), clearAnswers: { [handle]: 1 } };
    expect(changes(() => store.saveLedger("p", ledger))).toBe(1);
    expect(
      changes(() =>
        store.recordClearAnswers("p", [
          { at: "now", handle, asked: "Is rent stated?", kind: "yes", value: null },
        ]),
      ),
    ).toBe(1);
    expect(changes(() => store.writeOutput("p", "summary.md", "Rent: 84,000", 1, "Rent: []"))).toBe(
      1,
    );
    // What only the worker reads is not what a listing shows.
    expect(changes(() => store.mergeValues("p", {}))).toBe(0);
    expect(changes(() => store.saveTurnActivities({ open: {}, kept: {} }))).toBe(0);
    expect(changes(() => store.remove("p", handle))).toBe(1);
  });
});
