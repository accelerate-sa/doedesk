import { type CheckpointRef } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import * as ServerConfig from "../config.ts";
import type { CheckpointStoreError } from "./Errors.ts";
import type { VcsCheckpointOps } from "../vcs/VcsDriver.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";

export interface CaptureCheckpointInput {
  readonly cwd: string;
  readonly checkpointRef: CheckpointRef;
  /** The checkpoint this one follows, so a turn that switched branches starts where it landed. */
  readonly previousCheckpointRef?: CheckpointRef;
  /** Folders below `cwd` (relative, `/`-separated) that have their own checkpoints. */
  readonly excludePaths?: ReadonlyArray<string>;
}

export interface CaptureHeadCheckpointInput {
  readonly cwd: string;
  readonly checkpointRef: CheckpointRef;
  /** A commit `resolveCleanHead` returned for this folder. */
  readonly head: string;
  /**
   * When the folder was seen clean, in epoch seconds, if that was earlier than now. Commits made
   * after a checkpoint count as the turn's own work, so a late snapshot must not postdate them.
   */
  readonly seenAt?: number;
}

export interface RestoreCheckpointInput {
  readonly cwd: string;
  readonly checkpointRef: CheckpointRef;
  readonly fallbackToHead?: boolean;
  /** Folders below `cwd` the restore leaves as they are, as in a capture. */
  readonly excludePaths?: ReadonlyArray<string>;
}

export interface DiffCheckpointsInput {
  readonly cwd: string;
  readonly fromCheckpointRef: CheckpointRef;
  readonly toCheckpointRef: CheckpointRef;
  readonly fallbackFromToHead?: boolean;
  readonly ignoreWhitespace: boolean;
  readonly format?: "patch" | "numstat";
  /** Maximum bytes collected from the diff command. */
  readonly maxOutputBytes?: number;
  /** Limits the diff to these exact paths. An empty list yields an empty diff. */
  readonly filePaths?: ReadonlyArray<string>;
  /** Folders below `cwd` left out of the diff, as in a capture. */
  readonly excludePaths?: ReadonlyArray<string>;
}

export interface ListAuthoredPathsInput {
  readonly cwd: string;
  readonly fromCheckpointRef: CheckpointRef;
  readonly toCheckpointRef: CheckpointRef;
}

export interface DeleteCheckpointRefsInput {
  readonly cwd: string;
  readonly checkpointRefs: ReadonlyArray<CheckpointRef>;
}

export class CheckpointStore extends Context.Service<
  CheckpointStore,
  {
    readonly isGitRepository: (cwd: string) => Effect.Effect<boolean, CheckpointStoreError>;

    /**
     * Makes a plain folder able to hold checkpoints, so undo and the changes view work for
     * people whose folders are not repositories. The history lives in DoeDesk's own data
     * folder; the user's folder gets one small hidden `.git` file pointing at it. False when
     * the folder is one DoeDesk will not track, such as the home folder.
     */
    readonly ensureRepository: (cwd: string) => Effect.Effect<boolean, CheckpointStoreError>;

    readonly captureCheckpoint: (
      input: CaptureCheckpointInput,
    ) => Effect.Effect<void, CheckpointStoreError>;

    /**
     * HEAD's commit when the folder matches it exactly: nothing staged, modified or untracked.
     * Null otherwise. One status, where a capture stages the whole worktree.
     */
    readonly resolveCleanHead: (cwd: string) => Effect.Effect<string | null, CheckpointStoreError>;

    /** Snapshots a folder that was clean at `head` from that commit, without reading its files. */
    readonly captureHeadCheckpoint: (
      input: CaptureHeadCheckpointInput,
    ) => Effect.Effect<void, CheckpointStoreError>;

    readonly hasCheckpointRef: (
      input: Omit<RestoreCheckpointInput, "fallbackToHead">,
    ) => Effect.Effect<boolean, CheckpointStoreError>;

    readonly restoreCheckpoint: (
      input: RestoreCheckpointInput,
    ) => Effect.Effect<boolean, CheckpointStoreError>;

    readonly diffCheckpoints: (
      input: DiffCheckpointsInput,
    ) => Effect.Effect<string, CheckpointStoreError>;

    /** Null means HEAD is unchanged or unrecorded; all changed paths then belong to the turn. */
    readonly listAuthoredPaths: (
      input: ListAuthoredPathsInput,
    ) => Effect.Effect<ReadonlySet<string> | null, CheckpointStoreError>;

    readonly deleteCheckpointRefs: (
      input: DeleteCheckpointRefsInput,
    ) => Effect.Effect<void, CheckpointStoreError>;
  }
>()("t3/checkpointing/CheckpointStore") {}

/** @public */
export const make = Effect.gen(function* () {
  const vcsRegistry = yield* VcsDriverRegistry.VcsDriverRegistry;

  const resolveCheckpoints = Effect.fn("CheckpointStore.resolveCheckpoints")(function* (
    cwd: string,
  ) {
    const handle = yield* vcsRegistry.resolve({ cwd });
    return handle.driver.checkpoints satisfies VcsCheckpointOps;
  });

  // The registry reads an unreadable repository as none; ask Git again so that fails here.
  const isGitRepository: CheckpointStore["Service"]["isGitRepository"] = Effect.fn(
    "CheckpointStore.isGitRepository",
  )(function* (cwd) {
    if ((yield* vcsRegistry.detect({ cwd, requestedKind: "git" })) !== null) return true;
    const git = yield* vcsRegistry.get("git");
    return (yield* git.detectRepository(cwd)) !== null;
  });

  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  // Optional so the store can be built without a server around it; then plain folders stay untracked.
  const serverConfig = yield* Effect.serviceOption(ServerConfig.ServerConfig);
  const homeDirectory = yield* HostProcess.HomeDirectory;
  const historyRoot = Option.match(serverConfig, {
    onNone: () => null,
    onSome: ({ stateDir }) => path.join(stateDir, "folder-history"),
  });

  /** A short name for a folder's history: its own name, plus a hash that tells same-named folders apart. */
  const historyDirectoryFor = (root: string, cwd: string) => {
    let first = 0x811c9dc5;
    let second = 0x01000193;
    for (let index = 0; index < cwd.length; index += 1) {
      const code = cwd.charCodeAt(index);
      first = Math.imul(first ^ code, 0x01000193) >>> 0;
      second = Math.imul(second + code, 0x85ebca6b) >>> 0;
    }
    const name =
      path
        .basename(cwd)
        .replace(/[^A-Za-z0-9_-]+/g, "-")
        .slice(0, 40) || "folder";
    return path.join(root, `${name}-${first.toString(16)}${second.toString(16)}.git`);
  };

  const ensureRepository: CheckpointStore["Service"]["ensureRepository"] = Effect.fn(
    "CheckpointStore.ensureRepository",
  )(function* (cwd) {
    if (yield* isGitRepository(cwd)) return true;
    if (historyRoot === null) return false;
    const resolved = path.resolve(cwd);
    // Tracking a whole home folder or disk would copy everything in it.
    if (resolved === path.resolve(homeDirectory) || path.dirname(resolved) === resolved) {
      return false;
    }
    const gitDirectory = historyDirectoryFor(historyRoot, resolved);
    const pointer = path.join(resolved, ".git");
    const stalePointer = yield* fileSystem.readFileString(pointer).pipe(
      Effect.map((contents) => contents.startsWith("gitdir:") && contents.includes(historyRoot)),
      Effect.orElseSucceed(() => false),
    );
    // A folder copied from elsewhere can carry a pointer to history that is not on this computer.
    if (stalePointer) yield* fileSystem.remove(pointer).pipe(Effect.ignore);
    yield* fileSystem.makeDirectory(historyRoot, { recursive: true }).pipe(Effect.ignore);
    const git = yield* vcsRegistry.get("git");
    yield* git.execute({
      operation: "CheckpointStore.ensureRepository",
      cwd: resolved,
      args: ["init", "--quiet", "--initial-branch=main", `--separate-git-dir=${gitDirectory}`],
      timeoutMs: 30_000,
    });
    // Files the operating system and office programs scatter around; never the user's work.
    yield* fileSystem
      .writeFileString(
        path.join(gitDirectory, "info", "exclude"),
        [".DS_Store", "Thumbs.db", "desktop.ini", "~$*", ".~lock.*#", ""].join("\n"),
      )
      .pipe(Effect.ignore);
    return yield* isGitRepository(resolved);
  });

  const captureCheckpoint: CheckpointStore["Service"]["captureCheckpoint"] = Effect.fn(
    "captureCheckpoint",
  )(function* (input) {
    const checkpoints = yield* resolveCheckpoints(input.cwd);
    return yield* checkpoints.captureCheckpoint(input);
  });

  const resolveCleanHead: CheckpointStore["Service"]["resolveCleanHead"] = Effect.fn(
    "CheckpointStore.resolveCleanHead",
  )(function* (cwd) {
    const checkpoints = yield* resolveCheckpoints(cwd);
    return yield* checkpoints.resolveCleanHead(cwd);
  });

  const captureHeadCheckpoint: CheckpointStore["Service"]["captureHeadCheckpoint"] = Effect.fn(
    "CheckpointStore.captureHeadCheckpoint",
  )(function* (input) {
    const checkpoints = yield* resolveCheckpoints(input.cwd);
    return yield* checkpoints.captureHeadCheckpoint(input);
  });

  const hasCheckpointRef: CheckpointStore["Service"]["hasCheckpointRef"] = Effect.fn(
    "hasCheckpointRef",
  )(function* (input) {
    const checkpoints = yield* resolveCheckpoints(input.cwd);
    return yield* checkpoints.hasCheckpointRef(input);
  });

  const restoreCheckpoint: CheckpointStore["Service"]["restoreCheckpoint"] = Effect.fn(
    "restoreCheckpoint",
  )(function* (input) {
    const checkpoints = yield* resolveCheckpoints(input.cwd);
    return yield* checkpoints.restoreCheckpoint(input);
  });

  const diffCheckpoints: CheckpointStore["Service"]["diffCheckpoints"] = Effect.fn(
    "diffCheckpoints",
  )(function* (input) {
    const checkpoints = yield* resolveCheckpoints(input.cwd);
    return yield* checkpoints.diffCheckpoints(input);
  });

  const listAuthoredPaths: CheckpointStore["Service"]["listAuthoredPaths"] = Effect.fn(
    "listAuthoredPaths",
  )(function* (input) {
    const checkpoints = yield* resolveCheckpoints(input.cwd);
    return yield* checkpoints.listAuthoredPaths(input);
  });

  const deleteCheckpointRefs: CheckpointStore["Service"]["deleteCheckpointRefs"] = Effect.fn(
    "deleteCheckpointRefs",
  )(function* (input) {
    const checkpoints = yield* resolveCheckpoints(input.cwd);
    return yield* checkpoints.deleteCheckpointRefs(input);
  });

  return CheckpointStore.of({
    isGitRepository,
    ensureRepository,
    captureCheckpoint,
    resolveCleanHead,
    captureHeadCheckpoint,
    hasCheckpointRef,
    restoreCheckpoint,
    diffCheckpoints,
    listAuthoredPaths,
    deleteCheckpointRefs,
  });
});

export const layer = Layer.effect(CheckpointStore, make);
