import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeStreamPromises from "node:stream/promises";

import type { SealedDocumentInfo, SealedStore, SealedUnread } from "./worker/store.ts";

/**
 * Sealing a file where it lies: the readable copy leaves the folder, and unsealing puts the same
 * bytes back. Nothing here is offered to an agent: unsealing by an agent would undo sealing.
 */
export type SealFileResult =
  | { readonly ok: true; readonly document: SealedDocumentInfo }
  | {
      readonly ok: false;
      readonly message: string;
      /** The file was being written while it was read. Nothing of it was touched. */
      readonly changing?: true;
      /** No file that can be read is there: not by DoeDesk, and so not by an agent. */
      readonly unreadable?: true;
    };

export type UnsealFileResult =
  | {
      readonly ok: true;
      readonly name: string;
      /** Where the file is now. Null when it was sealed from a copy and nothing was put back. */
      readonly path: string | null;
      /** True when another file had taken its place, so it was put back under another name. */
      readonly renamed: boolean;
    }
  | { readonly ok: false; readonly message: string };

/** A file's text for the worker, or why it has none yet. */
export type ReadForSealing = (
  name: string,
  bytes: Buffer,
) => Promise<
  | { readonly ok: true; readonly text: string; readonly mediaType: string }
  | { readonly ok: false; readonly kind: SealedUnread["kind"]; readonly message: string }
>;

export interface SealFileOptions {
  /** A file larger than this is never read: it is kept a piece at a time, with no text. */
  readonly maxReadBytes: number;
  /**
   * The file takes the place of the sealed file that was moved out of the same path, and keeps
   * its handle: a document saved again is one sealed file, not two.
   */
  readonly replaceSamePath?: boolean;
}

const TOO_LARGE: SealedUnread = {
  kind: "tooLarge",
  message: "The file is too large for the worker to read, so nothing can be asked about it.",
};
const CHANGING = "The file is still being written, so it was left as it is.";

/**
 * Seals the file at a path: it is kept encrypted and leaves its folder whether or not its text
 * can be read. Reading is for asking, and can happen later; keeping the file from an agent does
 * not wait for it.
 */
export const sealFile = async (
  store: SealedStore,
  read: ReadForSealing,
  project: string,
  filePath: string,
  options: SealFileOptions,
): Promise<SealFileResult> => {
  let before: NodeFS.Stats;
  try {
    before = NodeFS.statSync(filePath);
    if (!NodePath.isAbsolute(filePath) || !before.isFile()) throw new Error("not a file");
  } catch {
    return { ok: false, message: "No readable file is at that path.", unreadable: true };
  }
  // A copy in progress changes the file's size or time. Such a file is never taken: deleting it
  // would lose what the copy has yet to write.
  const unchanged = (): boolean => {
    try {
      const current = NodeFS.statSync(filePath);
      return current.size === before.size && current.mtimeMs === before.mtimeMs;
    } catch {
      return false;
    }
  };
  const handles = new Set(store.list(project).map((document) => document.handle));
  const replaces =
    options.replaceSamePath === true
      ? store.list(project).find((document) => document.origin === filePath)?.handle
      : undefined;
  const undo = (handle: string) => {
    if (!handles.has(handle)) store.remove(project, handle);
  };

  let document: SealedDocumentInfo;
  if (before.size > options.maxReadBytes) {
    const kept = await store
      .keepLarge(project, filePath, TOO_LARGE, unchanged, replaces, before.mtimeMs)
      .catch(() => undefined);
    if (kept === undefined) {
      return unchanged()
        ? { ok: false, message: "The file could not be kept safely, so it was not sealed." }
        : { ok: false, message: CHANGING, changing: true };
    }
    document = kept;
  } else {
    let bytes: Buffer;
    try {
      bytes = NodeFS.readFileSync(filePath);
    } catch {
      return { ok: false, message: "No readable file is at that path.", unreadable: true };
    }
    const text = await read(NodePath.basename(filePath), bytes);
    if (!unchanged()) return { ok: false, message: CHANGING, changing: true };
    try {
      document = store.keep(
        project,
        NodePath.basename(filePath),
        text.ok
          ? { text: text.text, mediaType: text.mediaType }
          : { unread: { kind: text.kind, message: text.message } },
        { bytes, path: filePath, modifiedAt: before.mtimeMs },
        replaces,
      );
    } catch {
      return { ok: false, message: "The file could not be kept safely, so it was not sealed." };
    }
    // The file leaves the folder only once its kept copy reads back the same.
    if (store.original(project, document.handle)?.bytes.equals(bytes) !== true) {
      undo(document.handle);
      return { ok: false, message: "The file could not be kept safely, so it was not sealed." };
    }
  }
  try {
    NodeFS.rmSync(filePath);
  } catch {
    undo(document.handle);
    return {
      ok: false,
      message:
        "The file could not be moved out of the folder, so it was not sealed. Close it in other programs and try again.",
    };
  }
  return { ok: true, document };
};

/** `report.pdf` → `report (unsealed).pdf`, then `report (unsealed 2).pdf`, and so on. */
const besideName = (filePath: string, attempt: number): string => {
  const extension = NodePath.extname(filePath);
  const stem = filePath.slice(0, filePath.length - extension.length);
  return `${stem} (unsealed${attempt === 1 ? "" : ` ${attempt}`})${extension}`;
};

const digestOf = async (filePath: string): Promise<string | undefined> => {
  const digest = NodeCrypto.createHash("sha256");
  try {
    if (!(await NodeFSP.stat(filePath)).isFile()) return undefined;
    await NodeStreamPromises.pipeline(NodeFS.createReadStream(filePath), digest);
  } catch {
    return undefined;
  }
  return digest.digest("hex");
};

export const unsealFile = async (
  store: SealedStore,
  project: string,
  handle: string,
): Promise<UnsealFileResult> => {
  const info = store.list(project).find((document) => document.handle === handle);
  if (info === undefined) return { ok: false, message: "No sealed document has that handle." };
  if (info.origin === undefined) {
    store.remove(project, handle);
    return { ok: true, name: info.name, path: null, renamed: false };
  }
  const kept = await store.decryptOriginal(project, handle);
  if (kept === undefined) {
    return {
      ok: false,
      message: "The kept copy of this file cannot be read, so it stays sealed.",
    };
  }
  let target = info.origin;
  try {
    NodeFS.mkdirSync(NodePath.dirname(target), { recursive: true });
    for (let attempt = 0; ; attempt += 1) {
      target = attempt === 0 ? info.origin : besideName(info.origin, attempt);
      try {
        // Exclusive: a file that appeared meanwhile is never overwritten.
        await NodeStreamPromises.pipeline(
          NodeFS.createReadStream(kept.path),
          NodeFS.createWriteStream(target, { flags: "wx" }),
        );
        // The file comes back as it was, also by its date. A date that cannot be set is left.
        if (info.modifiedAt !== undefined) {
          const changed = new Date(info.modifiedAt);
          await NodeFS.promises.utimes(target, changed, changed).catch(() => undefined);
        }
        break;
      } catch (cause) {
        if ((cause as NodeJS.ErrnoException).code !== "EEXIST") {
          NodeFS.rmSync(target, { force: true });
          throw cause;
        }
        if ((await digestOf(target)) === kept.sha256) break;
      }
    }
  } catch {
    return {
      ok: false,
      message: "The file could not be put back in the folder, so it stays sealed.",
    };
  } finally {
    NodeFS.rmSync(kept.path, { force: true });
  }
  store.remove(project, handle);
  return { ok: true, name: info.name, path: target, renamed: target !== info.origin };
};
