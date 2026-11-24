import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import type { SealFileResult, UnsealFileResult } from "./sealedFiles.ts";
import type { SealedFolderInfo, SealedFolderLeftFile, SealedStore } from "./worker/store.ts";

/**
 * Sealed subfolders: what is in one does not stay readable. Every file in it is sealed, when the
 * person seals the folder and whenever a file turns up in it later, whether or not its text can
 * be read. The file stays the unit: each gets its own handle and is put back on its own bytes.
 * Nothing here is offered to an agent.
 */
export interface SealTargetsInspection {
  /** Files the worker will be able to read, and so be asked about. */
  readonly files: number;
  /** Files of a kind that cannot be read. They are sealed too, and cannot be asked about. */
  readonly unsupported: number;
  /** Of `files`: PDFs and images, which the reading service reads before the worker does. */
  readonly readFirst: number;
  /** Tracked by Git, which keeps their earlier versions readable. */
  readonly inGit: number;
  /** The names of the first few files, for showing what a provider will be told they are called. */
  readonly names: ReadonlyArray<string>;
}

/** As many names as a confirmation shows labels for. */
const NAMES_SHOWN = 5;

export type SealFolderResult =
  | {
      readonly ok: true;
      readonly sealed: number;
      /** Files still readable in the folder, each with the reason. */
      readonly left: ReadonlyArray<SealedFolderLeftFile>;
    }
  | { readonly ok: false; readonly message: string };

export type UnsealFolderResult =
  | {
      readonly ok: true;
      readonly restored: number;
      /** Of `restored`: put back under another name, because a file had taken their place. */
      readonly renamed: number;
      /** Files that could not be put back. They stay sealed, each on its own. */
      readonly failed: ReadonlyArray<{ readonly name: string; readonly message: string }>;
    }
  | { readonly ok: false; readonly message: string };

/**
 * Whether an agent's turn may start: only once the project's sealed folders hold nothing
 * readable. `receiving`: a file was still being written when the wait ran out. `notSealed`: a
 * file could not be taken out of the folder.
 */
export type SealedFolderGate =
  | { readonly ok: true; readonly sealed: number }
  | {
      readonly ok: false;
      readonly reason: "receiving" | "notSealed";
      /** The folder's name and the file's, for telling the person. */
      readonly folder: string;
      readonly file: string;
      /** Why the file was not sealed, when it was not for being written. */
      readonly message: string | null;
    };

/** A turn that is waiting for files still arriving in a sealed folder. */
export interface SealedFolderHold {
  readonly project: string;
  readonly folder: string;
  readonly files: number;
}

export interface SealedFolders {
  readonly list: (project: string) => ReadonlyArray<SealedFolderInfo>;
  readonly inspectFolder: (folder: string) => Promise<SealTargetsInspection>;
  readonly inspectFiles: (paths: ReadonlyArray<string>) => Promise<SealTargetsInspection>;
  /**
   * Seals a subfolder of `root`: its files now, and every file that appears in it later. With
   * `neutralLabels`, a provider is told only the handle and type of each, now and later.
   */
  readonly seal: (
    project: string,
    root: string,
    folder: string,
    options?: { readonly neutralLabels?: boolean },
  ) => Promise<SealFolderResult>;
  /** Records a folder's path as a provider is told it. Waits its turn behind a running sweep. */
  readonly setPathLabel: (project: string, folder: string, pathLabel: string) => Promise<void>;
  /** Stops sealing a folder and puts its files back as they were. */
  readonly unseal: (project: string, folder: string) => Promise<UnsealFolderResult>;
  /**
   * Before an agent's turn: seals what has appeared in the project's sealed folders, and waits,
   * for a bounded time, for a file that is still being written. The turn may start only when
   * this resolves `ok`.
   */
  readonly beforeTurn: (project: string, signal?: AbortSignal) => Promise<SealedFolderGate>;
  /** Sweeps soon without waiting for it: after an agent's tool call that can write. */
  readonly sweepSoon: (project: string) => void;
  /** The turns held now, for showing the person why a turn has not started. */
  readonly holds: () => ReadonlyArray<SealedFolderHold>;
  /** The sealed folder, of any project, that holds this path. */
  readonly containing: (path: string) => string | undefined;
  /** Every sealed folder, of any project. */
  readonly paths: () => ReadonlyArray<string>;
  readonly close: () => void;
}

/**
 * Files that left a folder by being sealed, or came back by being unsealed, in one action.
 * `folder`: the sealed folder they belong to, when they were sealed or unsealed as part of one.
 */
export interface SealChange {
  readonly kind: "sealed" | "unsealed";
  readonly paths: ReadonlyArray<string>;
  readonly folder?: string;
}

export interface SealedFoldersOptions {
  readonly store: SealedStore;
  /** Seals one file of a sealed folder, in place of the sealed file of the same path if any. */
  readonly sealFile: (project: string, filePath: string) => Promise<SealFileResult>;
  readonly unsealFile: (project: string, handle: string) => Promise<UnsealFileResult>;
  /** Whether the worker will be able to read a file of this name, judged by its name alone. */
  readonly canRead: (name: string) => boolean;
  /** Whether a file of this name is read by the reading service first. */
  readonly readFirst: (name: string) => boolean;
  readonly now?: (() => number) | undefined;
  readonly sleep?: ((ms: number) => Promise<void>) | undefined;
  /** False where sweeps are driven by hand and no folder is watched. */
  readonly watch?: boolean | undefined;
  /** The host's `process.platform`, which decides whether paths compare without regard to case. */
  readonly platform?: string | undefined;
  /** How long a turn waits for a file that is still being written. */
  readonly holdForMs?: number | undefined;
  /**
   * Told once for each sweep or unseal that changed a folder, and awaited: a turn held for a
   * sweep starts only after the copies kept elsewhere of what it sealed are gone.
   */
  readonly onSealChange?: ((change: SealChange) => Promise<void>) | undefined;
}

/** A folder with more files than this is not sealed: it is not a folder of documents. */
const MAX_FILES = 5_000;
const SEAL_AT_ONCE = 4;
/** A copy in progress keeps changing a file. One untouched this long is taken as whole. */
const SETTLE_MS = 1_500;
const WATCH_DEBOUNCE_MS = 300;
const HOLD_FOR_MS = 120_000;
/** What the operating system writes about a folder. It holds none of a document's content. */
const SYSTEM_FILES = new Set([".DS_Store", "Thumbs.db", "desktop.ini"]);

/** Paths as they compare on this computer: macOS and Windows take `Contracts` for `contracts`. */
export const comparablePath = (platform: string | undefined) => (path: string) => {
  const resolved = NodePath.resolve(path);
  return platform === "darwin" || platform === "win32" ? resolved.toLowerCase() : resolved;
};

interface ListedFile {
  readonly path: string;
  readonly size: number;
  readonly mtimeMs: number;
}

interface FolderListing {
  readonly files: ReadonlyArray<ListedFile>;
  /** More files than `MAX_FILES`: the rest are not listed. */
  readonly truncated: boolean;
  /** A `.git` folder lies inside: a repository of its own, which holds every version of its files. */
  readonly repository: boolean;
}

/**
 * Every file under a folder, hidden ones too: a file an agent could read is a file to seal.
 * Links are not followed; what they point to lies elsewhere.
 */
const filesUnder = async (folder: string): Promise<FolderListing> => {
  const files: Array<ListedFile> = [];
  let repository = false;
  let level = [folder];
  while (level.length > 0) {
    const next: Array<string> = [];
    for (const directory of level) {
      const entries = await NodeFSP.readdir(directory, { withFileTypes: true }).catch(() => []);
      for (const entry of entries) {
        const path = NodePath.join(directory, entry.name);
        if (entry.isDirectory()) {
          if (entry.name === ".git") repository = true;
          next.push(path);
        } else if (entry.isFile() && !SYSTEM_FILES.has(entry.name)) {
          if (files.length >= MAX_FILES) return { files, truncated: true, repository };
          const stats = await NodeFSP.stat(path).catch(() => undefined);
          if (stats !== undefined) files.push({ path, size: stats.size, mtimeMs: stats.mtimeMs });
        }
      }
    }
    level = next;
  }
  return { files, truncated: false, repository };
};

/** The files Git tracks in a directory: all under it, or those of the given names. */
const trackedIn = (
  directory: string,
  comparable: (path: string) => string,
  names?: ReadonlyArray<string>,
): Promise<ReadonlySet<string>> =>
  new Promise((resolve) => {
    NodeChildProcess.execFile(
      "git",
      ["ls-files", "-z", "--", ...(names ?? ["."])],
      { cwd: directory, timeout: 5_000, windowsHide: true, maxBuffer: 16 * 1024 * 1024 },
      (error, stdout) =>
        resolve(
          new Set(
            error === null
              ? stdout
                  .split("\u0000")
                  .filter((line) => line !== "")
                  .map((line) => comparable(NodePath.join(directory, line)))
              : [],
          ),
        ),
    );
  });

const inBatches = async <T>(
  items: ReadonlyArray<T>,
  size: number,
  run: (item: T) => Promise<void>,
): Promise<void> => {
  for (let start = 0; start < items.length; start += size) {
    await Promise.all(items.slice(start, start + size).map(run));
  }
};

interface Sweep {
  readonly sealed: number;
  /** Files still being written, each with the folder it is in. */
  readonly unsettled: ReadonlyArray<{ readonly folder: string; readonly path: string }>;
  readonly retryInMs: number;
  /** Files that are readable in a sealed folder and could not be taken out. */
  readonly left: ReadonlyArray<SealedFolderLeftFile & { readonly folder: string }>;
}

export const makeSealedFolders = (options: SealedFoldersOptions): SealedFolders => {
  const now = options.now ?? Date.now;
  const sleep =
    options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const holdForMs = options.holdForMs ?? HOLD_FOR_MS;
  const comparable = comparablePath(options.platform);
  /** Whether `path` lies under `folder`, at any depth. A folder is not inside itself. */
  const isInsideFolder = (folder: string, path: string): boolean => {
    const relative = NodePath.relative(comparable(folder), comparable(path));
    return (
      relative !== "" &&
      relative !== ".." &&
      !relative.startsWith(`..${NodePath.sep}`) &&
      !NodePath.isAbsolute(relative)
    );
  };
  const byProject = new Map<string, ReadonlyArray<SealedFolderInfo>>();
  for (const folder of options.store.allFolders()) {
    byProject.set(folder.project, [...(byProject.get(folder.project) ?? []), folder]);
  }
  const watchers = new Map<string, NodeFS.FSWatcher>();
  const timers = new Map<string, NodeJS.Timeout>();
  const held = new Map<string, SealedFolderHold>();
  let closed = false;

  // One at a time: a watch event and a turn starting must not seal the same file twice.
  let tail: Promise<unknown> = Promise.resolve();
  const inTurn = <T>(job: () => Promise<T>): Promise<T> => {
    const run = tail.then(job, job);
    tail = run.catch(() => undefined);
    return run;
  };

  const save = (project: string, folders: ReadonlyArray<SealedFolderInfo>) => {
    if (folders.length === 0) byProject.delete(project);
    else byProject.set(project, folders);
    options.store.saveFolders(project, folders);
  };

  const inspect = (
    files: ReadonlyArray<string>,
    tracked: ReadonlySet<string>,
  ): SealTargetsInspection => {
    const readable = files.filter((path) => options.canRead(NodePath.basename(path)));
    return {
      files: readable.length,
      unsupported: files.length - readable.length,
      readFirst: readable.filter((path) => options.readFirst(NodePath.basename(path))).length,
      inGit: files.filter((path) => tracked.has(comparable(path))).length,
      names: files.slice(0, NAMES_SHOWN).map((path) => NodePath.basename(path)),
    };
  };

  const sealChanged = (change: SealChange): Promise<void> =>
    options.onSealChange?.(change).catch(() => undefined) ?? Promise.resolve();

  /** `asked`: the person sealed the folder just now, so a file saved a moment ago is not waited for. */
  const sweepFolder = async (
    info: SealedFolderInfo,
    asked: boolean,
  ): Promise<Sweep & { readonly info: SealedFolderInfo }> => {
    const sealedPaths: Array<string> = [];
    let unsettled: Array<{ folder: string; path: string }> = [];
    let retryInMs = 0;
    let left: Array<SealedFolderLeftFile> = [];
    // Sealed files leave the folder, so a listing cut short is read again for the rest.
    for (let more = true; more;) {
      const listing = await filesUnder(info.path);
      const toSeal: Array<ListedFile> = [];
      unsettled = [];
      retryInMs = 0;
      left = [];
      const wait = (file: ListedFile) => {
        unsettled.push({ folder: info.path, path: file.path });
        retryInMs = Math.max(retryInMs, Math.ceil(SETTLE_MS - (now() - file.mtimeMs)), 1);
      };
      for (const file of listing.files) {
        if (!asked && now() - file.mtimeMs < SETTLE_MS) wait(file);
        else toSeal.push(file);
      }
      let sealedNow = 0;
      await inBatches(toSeal, SEAL_AT_ONCE, async (file) => {
        const result = await options
          .sealFile(info.project, file.path)
          .catch((): SealFileResult => ({ ok: false, message: "The file could not be sealed." }));
        if (result.ok) {
          sealedNow += 1;
          sealedPaths.push(file.path);
        } else if (result.changing === true) wait(file);
        // A file DoeDesk cannot read, an agent started by it cannot read either.
        else if (result.unreadable !== true) left.push({ ...file, message: result.message });
      });
      more = listing.truncated && sealedNow > 0;
    }
    left = left.toSorted((first, second) => first.path.localeCompare(second.path));
    if (sealedPaths.length > 0) {
      await sealChanged({ kind: "sealed", paths: sealedPaths, folder: info.path });
    }
    return {
      info: { ...info, left },
      sealed: sealedPaths.length,
      unsettled,
      retryInMs,
      left: left.map((file) => ({ ...file, folder: info.path })),
    };
  };

  const sweepProject = async (project: string): Promise<Sweep> => {
    const swept: Array<Sweep> = [];
    const next: Array<SealedFolderInfo> = [];
    for (const info of byProject.get(project) ?? []) {
      const folder = await sweepFolder(info, false);
      next.push(folder.info);
      swept.push(folder);
    }
    if (JSON.stringify(next) !== JSON.stringify(byProject.get(project) ?? [])) save(project, next);
    return {
      sealed: swept.reduce((total, folder) => total + folder.sealed, 0),
      unsettled: swept.flatMap((folder) => folder.unsettled),
      retryInMs: Math.max(0, ...swept.map((folder) => folder.retryInMs)),
      left: swept.flatMap((folder) => folder.left),
    };
  };

  const schedule = (project: string, delayMs: number) => {
    if (closed || timers.has(project)) return;
    const timer = setTimeout(() => {
      timers.delete(project);
      void inTurn(() => sweepProject(project)).then(
        (swept) => {
          if (swept.unsettled.length > 0) schedule(project, swept.retryInMs);
        },
        () => undefined,
      );
    }, delayMs);
    timer.unref();
    timers.set(project, timer);
  };

  const syncWatchers = () => {
    if (options.watch === false || closed) return;
    const wanted = new Map(
      [...byProject.values()].flat().map((folder) => [folder.path, folder.project]),
    );
    for (const [path, watcher] of watchers) {
      if (wanted.has(path)) continue;
      watcher.close();
      watchers.delete(path);
    }
    for (const [path, project] of wanted) {
      if (watchers.has(path)) continue;
      try {
        const watcher = NodeFS.watch(path, { recursive: true }, () =>
          schedule(project, WATCH_DEBOUNCE_MS),
        );
        // A folder that was deleted is watched again once a sweep finds it back.
        watcher.on("error", () => {
          watcher.close();
          watchers.delete(path);
        });
        watcher.unref();
        watchers.set(path, watcher);
      } catch {
        // No folder there now. Every turn still sweeps before it starts.
      }
    }
  };

  syncWatchers();
  // Files can have arrived while the app was closed.
  for (const project of byProject.keys()) schedule(project, 0);

  return {
    list: (project) => byProject.get(project) ?? [],
    inspectFolder: async (folder) => {
      const [listing, tracked] = await Promise.all([
        filesUnder(folder),
        trackedIn(folder, comparable),
      ]);
      return inspect(
        listing.files.map((file) => file.path),
        tracked,
      );
    },
    inspectFiles: async (paths) => {
      const names = new Map<string, Array<string>>();
      for (const path of paths) {
        const directory = NodePath.dirname(path);
        names.set(directory, [...(names.get(directory) ?? []), NodePath.basename(path)]);
      }
      const tracked = await Promise.all(
        [...names].map(([directory, inDirectory]) => trackedIn(directory, comparable, inDirectory)),
      );
      return inspect(paths, new Set(tracked.flatMap((set) => [...set])));
    },
    setPathLabel: (project, folder, pathLabel) =>
      inTurn(async () =>
        save(
          project,
          (byProject.get(project) ?? []).map((info) =>
            comparable(info.path) === comparable(folder) ? { ...info, pathLabel } : info,
          ),
        ),
      ),
    seal: (project, root, folder, sealOptions) =>
      inTurn(async (): Promise<SealFolderResult> => {
        const path = NodePath.resolve(folder);
        if (comparable(path) === comparable(root)) {
          return {
            ok: false,
            message: "The folder itself cannot be sealed, only a subfolder of it.",
          };
        }
        if (!NodePath.isAbsolute(folder) || !isInsideFolder(root, path)) {
          return {
            ok: false,
            message:
              "Only a subfolder of this project's own folder can be sealed. This one lies outside it, as a separate working copy does.",
          };
        }
        const isDirectory = await NodeFSP.stat(path).then(
          (stats) => stats.isDirectory(),
          () => false,
        );
        if (!isDirectory) return { ok: false, message: "No folder is at that path." };
        const current = byProject.get(project) ?? [];
        const around = current.find((other) => isInsideFolder(other.path, path));
        if (around !== undefined) {
          return {
            ok: false,
            message: `This folder is inside ${NodePath.basename(around.path)}, which is already sealed.`,
          };
        }
        // Everything in a sealed folder is sealed, so one that is not a folder of documents is
        // refused whole rather than sealed in part.
        const listing = await filesUnder(path);
        if (listing.repository) {
          return {
            ok: false,
            message:
              "This folder holds a Git repository of its own, which keeps every version of its files. It cannot be sealed.",
          };
        }
        if (listing.truncated) {
          return {
            ok: false,
            message: `This folder holds more than ${MAX_FILES.toLocaleString("en-US")} files. Seal a smaller folder.`,
          };
        }
        const existing = current.find((other) => comparable(other.path) === comparable(path));
        const info: SealedFolderInfo = existing ?? {
          project,
          path,
          sealedAt: new Date(now()).toISOString(),
          left: [],
          ...(sealOptions?.neutralLabels === true ? { neutralLabels: true as const } : {}),
        };
        // Recorded before its files are sealed, so one that arrives meanwhile is sealed too. A
        // sealed folder inside this one is now part of it.
        save(project, [
          ...current.filter((other) => other !== existing && !isInsideFolder(path, other.path)),
          info,
        ]);
        syncWatchers();
        const swept = await sweepFolder(info, true);
        save(
          project,
          (byProject.get(project) ?? []).map((other) => (other === info ? swept.info : other)),
        );
        if (swept.unsettled.length > 0) schedule(project, swept.retryInMs);
        return { ok: true, sealed: swept.sealed, left: swept.info.left };
      }),
    unseal: (project, folder) =>
      inTurn(async (): Promise<UnsealFolderResult> => {
        const current = byProject.get(project) ?? [];
        const info = current.find((other) => comparable(other.path) === comparable(folder));
        if (info === undefined) return { ok: false, message: "That folder is not sealed." };
        // Forgotten first: a file put back must not be sealed again by the next sweep.
        save(
          project,
          current.filter((other) => other !== info),
        );
        syncWatchers();
        let restored = 0;
        let renamed = 0;
        const back: Array<string> = [];
        const failed: Array<{ name: string; message: string }> = [];
        for (const document of options.store.list(project)) {
          if (document.origin === undefined || !isInsideFolder(info.path, document.origin)) {
            continue;
          }
          const result = await options.unsealFile(project, document.handle);
          if (!result.ok) failed.push({ name: document.name, message: result.message });
          else {
            restored += 1;
            if (result.renamed) renamed += 1;
            if (result.path !== null) back.push(result.path);
          }
        }
        if (back.length > 0)
          await sealChanged({ kind: "unsealed", paths: back, folder: info.path });
        return { ok: true, restored, renamed, failed };
      }),
    beforeTurn: async (project, signal) => {
      if (!byProject.has(project)) return { ok: true, sealed: 0 };
      const deadline = now() + holdForMs;
      let sealed = 0;
      try {
        for (;;) {
          const swept = await inTurn(() => sweepProject(project));
          syncWatchers();
          sealed += swept.sealed;
          const [waiting] = swept.unsettled;
          if (waiting === undefined) {
            const [stuck] = swept.left;
            return stuck === undefined
              ? { ok: true, sealed }
              : {
                  ok: false,
                  reason: "notSealed",
                  folder: NodePath.basename(stuck.folder),
                  file: NodePath.basename(stuck.path),
                  message: stuck.message,
                };
          }
          // The turn does not start with a half-written file readable. It is not deleted
          // either: the copy that is writing it would lose the rest.
          if (now() >= deadline || signal?.aborted === true) {
            schedule(project, swept.retryInMs);
            return {
              ok: false,
              reason: "receiving",
              folder: NodePath.basename(waiting.folder),
              file: NodePath.basename(waiting.path),
              message: null,
            };
          }
          held.set(project, {
            project,
            folder: NodePath.basename(waiting.folder),
            files: swept.unsettled.length,
          });
          await sleep(Math.min(swept.retryInMs, Math.max(1, deadline - now())));
        }
      } finally {
        held.delete(project);
      }
    },
    sweepSoon: (project) => {
      if (byProject.has(project)) schedule(project, 0);
    },
    holds: () => [...held.values()],
    containing: (path) => {
      for (const folders of byProject.values()) {
        const found = folders.find((folder) => isInsideFolder(folder.path, path));
        if (found !== undefined) return found.path;
      }
      return undefined;
    },
    paths: () => [...byProject.values()].flatMap((folders) => folders.map((folder) => folder.path)),
    close: () => {
      closed = true;
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
      for (const watcher of watchers.values()) watcher.close();
      watchers.clear();
    },
  };
};
