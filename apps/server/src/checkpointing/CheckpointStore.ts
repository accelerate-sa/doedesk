import { type CheckpointRef } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import * as ServerConfig from "../config.ts";
import { sealedFoldersBelow } from "../privacy/agentWorkspaces.ts";
import { removePaths } from "./historyRewrite.ts";
import type { CheckpointStoreError } from "./Errors.ts";
import type { VcsCheckpointOps, VcsCheckpointRange } from "../vcs/VcsDriver.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";

export interface CaptureCheckpointInput {
  readonly cwd: string;
  readonly checkpointRef: CheckpointRef;
  /** The checkpoint this one follows, so a turn that switched branches starts where it landed. */
  readonly previousCheckpointRef?: CheckpointRef;
  /** Folders below `cwd` (relative, `/`-separated) that have their own checkpoints. */
  readonly excludePaths?: ReadonlyArray<string>;
}

export type CheckpointRange = VcsCheckpointRange;

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
  /** The refs' range as their capture returned it; the refs are then not read. */
  readonly range?: VcsCheckpointRange;
}

export interface ListAuthoredPathsInput {
  readonly cwd: string;
  readonly fromCheckpointRef: CheckpointRef;
  readonly toCheckpointRef: CheckpointRef;
  /** The refs' range as their capture returned it; the refs are then not read. */
  readonly range?: VcsCheckpointRange;
}

export interface DeleteCheckpointRefsInput {
  readonly cwd: string;
  readonly checkpointRefs: ReadonlyArray<CheckpointRef>;
}

/** What history holds of a file the person is about to seal. */
export interface FileHistory {
  /** The person's own repository holds the file, in its commits or in checkpoints kept there. */
  readonly keptByGit: boolean;
  /** A checkpoint holds the file, so chats ran in the folder while it could be read. */
  readonly seenByTurns: boolean;
}

const SealChangeNotes = Schema.fromJsonString(
  Schema.Array(Schema.Struct({ path: Schema.String, at: Schema.Number })),
);
const KeptOut = Schema.fromJsonString(Schema.Array(Schema.String));
const decodeKeptOut = Schema.decodeUnknownEffect(KeptOut);
const encodeKeptOut = Schema.encodeEffect(KeptOut);
const decodeSealChangeNotes = Schema.decodeUnknownEffect(SealChangeNotes);
const encodeSealChangeNotes = Schema.encodeEffect(SealChangeNotes);

/** Every ref DoeDesk makes in a repository: checkpoints, and the bases of review guides. */
const DOEDESK_REVISIONS = "--glob=refs/t3";
/** How the message of every commit DoeDesk writes for a checkpoint begins. */
const CHECKPOINT_MESSAGE = "t3 checkpoint";
/** Every other ref, with HEAD: the person's own branches, tags, remotes and stash. */
const PERSONS_REVISIONS = ["--exclude=refs/t3/*", "--all"];

/** Files that left a folder by being sealed, or came back by being unsealed, in one action. */
export interface SealChange {
  readonly kind: "sealed" | "unsealed";
  readonly paths: ReadonlyArray<string>;
  /** The sealed folder they belong to, when they changed as part of one. */
  readonly folder?: string | undefined;
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

    /** The range from `previousCheckpointRef`, or null when there is none to compare with. */
    readonly captureCheckpoint: (
      input: CaptureCheckpointInput,
    ) => Effect.Effect<VcsCheckpointRange | null, CheckpointStoreError>;

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

    readonly fileHistory: (filePath: string) => Effect.Effect<FileHistory, CheckpointStoreError>;

    /**
     * Told once for each seal or unseal. A diff across it leaves those files out, and sealed
     * files leave the history DoeDesk keeps for a plain folder, in one rewrite, for good. The
     * person's own repository is left as it is.
     */
    readonly sealChanged: (change: SealChange) => Effect.Effect<void, CheckpointStoreError>;
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

  // Forgetting a file rewrites and prunes a history, which no capture or restore may overlap.
  const HISTORY_USERS = 64;
  const historyGate = yield* Semaphore.make(HISTORY_USERS);
  const usingHistory = historyGate.withPermits(1);

  // What was sealed in the person's own repository, a folder standing for its files, kept in a
  // file beside the histories. It stays out of checkpoints after unsealing too, as in a plain
  // folder: restoring an older checkpoint would otherwise put back the version Git committed.
  const KEPT_OUT = 500;
  const keptOutFile = historyRoot === null ? null : path.join(historyRoot, "kept-out.json");
  const keptOut: Array<string> =
    keptOutFile === null
      ? []
      : yield* fileSystem.readFileString(keptOutFile).pipe(
          Effect.flatMap(decodeKeptOut),
          Effect.map((paths) => [...paths]),
          Effect.orElseSucceed(() => []),
        );
  const keepOut = Effect.fn("CheckpointStore.keepOut")(function* (paths: ReadonlyArray<string>) {
    const added = paths.filter((keptOutPath) => !keptOut.includes(keptOutPath));
    if (added.length === 0) return;
    keptOut.push(...added);
    keptOut.splice(0, Math.max(0, keptOut.length - KEPT_OUT));
    if (keptOutFile === null || historyRoot === null) return;
    yield* fileSystem.makeDirectory(historyRoot, { recursive: true }).pipe(Effect.ignore);
    yield* encodeKeptOut(keptOut).pipe(
      Effect.flatMap((list) => fileSystem.writeFileString(keptOutFile, list)),
      Effect.ignore,
    );
  });

  // A file can lie in a sealed folder for a moment before it is sealed. Nothing in one is
  // captured, restored or shown as a change, whatever the caller leaves out itself.
  const withoutSealedFolders = <
    Input extends { readonly cwd: string; readonly excludePaths?: ReadonlyArray<string> },
  >(
    input: Input,
  ): Input => {
    const below = `${path.resolve(input.cwd)}${path.sep}`;
    const sealed = [
      ...sealedFoldersBelow(input.cwd),
      ...keptOut
        .filter((keptOutPath) => keptOutPath.startsWith(below))
        .map((keptOutPath) => keptOutPath.slice(below.length).replaceAll(path.sep, "/")),
    ];
    return sealed.length === 0
      ? input
      : { ...input, excludePaths: [...(input.excludePaths ?? []), ...sealed] };
  };

  const captureCheckpoint: CheckpointStore["Service"]["captureCheckpoint"] = Effect.fn(
    "captureCheckpoint",
  )(function* (input) {
    const checkpoints = yield* resolveCheckpoints(input.cwd);
    return yield* usingHistory(checkpoints.captureCheckpoint(withoutSealedFolders(input)));
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
    return yield* usingHistory(checkpoints.captureHeadCheckpoint(input));
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
    return yield* usingHistory(checkpoints.restoreCheckpoint(withoutSealedFolders(input)));
  });

  // Kept in a file beside the histories, so a diff opened after a restart still leaves them out.
  const SEAL_CHANGES_KEPT = 256;
  const sealChangesFile = historyRoot === null ? null : path.join(historyRoot, "seal-changes.json");
  const sealChanges: Array<{ readonly path: string; readonly at: number }> =
    sealChangesFile === null
      ? []
      : yield* fileSystem.readFileString(sealChangesFile).pipe(
          Effect.flatMap(decodeSealChangeNotes),
          Effect.map((notes) => [...notes]),
          Effect.orElseSucceed(() => []),
        );
  /** `changed`: files, or a folder standing for every file in it. */
  const noteSealChanges = Effect.fn("CheckpointStore.noteSealChanges")(function* (
    changed: ReadonlyArray<string>,
  ) {
    const at = Math.floor((yield* Clock.currentTimeMillis) / 1000);
    sealChanges.push(...changed.map((changedPath) => ({ path: changedPath, at })));
    sealChanges.splice(0, Math.max(0, sealChanges.length - SEAL_CHANGES_KEPT));
    if (sealChangesFile === null || historyRoot === null) return;
    yield* fileSystem.makeDirectory(historyRoot, { recursive: true }).pipe(Effect.ignore);
    yield* encodeSealChangeNotes(sealChanges).pipe(
      Effect.flatMap((notes) => fileSystem.writeFileString(sealChangesFile, notes)),
      Effect.ignore,
    );
  });

  /** The files below `cwd` that the person sealed or unsealed between two checkpoints. */
  const sealChangedBetween = Effect.fn("CheckpointStore.sealChangedBetween")(function* (
    input: DiffCheckpointsInput,
  ) {
    const folder = `${path.resolve(input.cwd)}${path.sep}`;
    const below = sealChanges.filter((change) => change.path.startsWith(folder));
    if (below.length === 0) return [];
    const git = yield* vcsRegistry.get("git");
    const taken = yield* git
      .execute({
        operation: "CheckpointStore.sealChangedBetween",
        cwd: input.cwd,
        args: [
          "log",
          "--no-walk=unsorted",
          "--format=%ct",
          input.fromCheckpointRef,
          input.toCheckpointRef,
        ],
      })
      .pipe(
        Effect.map((result) => result.stdout.trim().split("\n").map(Number)),
        Effect.orElseSucceed(() => []),
      );
    const [from, to] = taken;
    if (from === undefined || to === undefined) return [];
    return [
      ...new Set(
        below
          .filter((change) => change.at >= from && change.at <= to)
          .map((change) => change.path.slice(folder.length).replaceAll(path.sep, "/")),
      ),
    ];
  });

  const diffCheckpoints: CheckpointStore["Service"]["diffCheckpoints"] = Effect.fn(
    "diffCheckpoints",
  )(function* (input) {
    const checkpoints = yield* resolveCheckpoints(input.cwd);
    const changed = yield* sealChangedBetween(input);
    return yield* checkpoints.diffCheckpoints(
      withoutSealedFolders(
        changed.length === 0
          ? input
          : { ...input, excludePaths: [...(input.excludePaths ?? []), ...changed] },
      ),
    );
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
    return yield* usingHistory(checkpoints.deleteCheckpointRefs(input));
  });

  /** The repository a folder lies in, and whether its history is one DoeDesk made for a plain folder. */
  const locateDirectory = Effect.fn("CheckpointStore.locateDirectory")(function* (cwd: string) {
    const git = yield* vcsRegistry.get("git");
    const probe = yield* git.execute({
      operation: "CheckpointStore.locateDirectory",
      cwd,
      args: ["rev-parse", "--absolute-git-dir", "--show-prefix"],
      allowNonZeroExit: true,
    });
    if (probe.exitCode !== 0) return null;
    const [gitDirectory = "", prefix = ""] = probe.stdout.split("\n");
    const roots =
      historyRoot === null
        ? []
        : [
            historyRoot,
            yield* fileSystem.realPath(historyRoot).pipe(Effect.orElseSucceed(() => historyRoot)),
          ];
    return {
      git,
      cwd,
      gitDirectory,
      /** This folder's path below the repository's top, with a trailing slash, or empty. */
      prefix,
      own: roots.some((root) => gitDirectory.startsWith(`${root}${path.sep}`)),
    };
  });
  type LocatedDirectory = NonNullable<Effect.Success<ReturnType<typeof locateDirectory>>>;
  const locateFile = Effect.fn("CheckpointStore.locateFile")(function* (filePath: string) {
    const directory = yield* locateDirectory(path.dirname(filePath));
    return directory === null
      ? null
      : {
          ...directory,
          // A name is matched as written: `report[1].pdf` is not a pattern.
          pathspec: `:(literal)${path.basename(filePath)}`,
        };
  });

  const fileHistory: CheckpointStore["Service"]["fileHistory"] = Effect.fn(
    "CheckpointStore.fileHistory",
  )(function* (filePath) {
    const file = yield* locateFile(filePath);
    if (file === null) return { keptByGit: false, seenByTurns: false };
    const operation = "CheckpointStore.fileHistory";
    // A history too large to walk in time is taken to hold the file: the person is then warned.
    const heldBy = (...revisions: ReadonlyArray<string>) =>
      file.git
        .execute({
          operation,
          cwd: file.cwd,
          args: ["rev-list", "-1", ...revisions, "--", file.pathspec],
          timeoutMs: 5_000,
        })
        .pipe(
          Effect.map((found) => found.stdout.trim() !== ""),
          Effect.orElseSucceed(() => true),
        );
    const tracked = yield* file.git.execute({
      operation,
      cwd: file.cwd,
      args: ["ls-files", "--error-unmatch", "--", file.pathspec],
      allowNonZeroExit: true,
    });
    return {
      // The person's own commits. What DoeDesk's checkpoints hold of it is removed on sealing.
      keptByGit: !file.own && (tracked.exitCode === 0 || (yield* heldBy(...PERSONS_REVISIONS))),
      seenByTurns: yield* heldBy(DOEDESK_REVISIONS),
    };
  });

  /** Takes files out of one history DoeDesk made, all in one rewrite, and keeps them out. */
  const forgetIn = Effect.fn("CheckpointStore.forgetIn")(function* (
    history: LocatedDirectory,
    /** Each file's path below the folder at `history.cwd`, and below the repository's top. */
    files: ReadonlyArray<{ readonly below: string; readonly relativePath: string }>,
  ) {
    const operation = "CheckpointStore.forgetFiles";
    const run = (
      args: ReadonlyArray<string>,
      options?: { readonly stdin?: string; readonly maxOutputBytes?: number },
    ) =>
      history.git.execute({
        operation,
        cwd: history.cwd,
        args,
        timeoutMs: 300_000,
        outputMode: "error",
        ...options,
      });
    const relativePaths = files.map((file) => file.relativePath);
    // First, so a capture that starts after this never stores a file again, unsealed or not:
    // a restore would otherwise delete a file that an older checkpoint no longer knows.
    const exclude = path.join(history.gitDirectory, "info", "exclude");
    const excluded = yield* fileSystem.readFileString(exclude).pipe(Effect.orElseSucceed(() => ""));
    const known = new Set(excluded.split("\n"));
    const added = relativePaths
      .map((relativePath) => `/${relativePath.replace(/[\\*?[\]]/g, "\\$&").replace(/ $/, "\\ ")}`)
      .filter((pattern) => !known.has(pattern));
    if (added.length > 0) {
      yield* fileSystem
        .writeFileString(
          exclude,
          `${excluded}${excluded === "" || excluded.endsWith("\n") ? "" : "\n"}${added.join("\n")}\n`,
        )
        .pipe(Effect.orDie);
    }
    // Packed copies need the repack; a file no checkpoint held can only be a loose staged one.
    const prune = Effect.fn("CheckpointStore.pruneHistory")(function* (packed: boolean) {
      yield* run(["reflog", "expire", "--expire=now", "--all"]);
      yield* run(packed ? ["gc", "--quiet", "--prune=now"] : ["prune", "--expire=now"]);
    });
    /** The history as a stream without the files, and how many entries of them it held. */
    const stripped = Effect.gen(function* () {
      // Names and messages only, no file contents; a history too long for this is given up.
      const exported = yield* run(
        [
          "-c",
          "core.quotePath=false",
          "fast-export",
          "--all",
          "--no-data",
          "--reencode=no",
          "--signed-tags=strip",
          "--tag-of-filtered-object=drop",
        ],
        { maxOutputBytes: 128_000_000 },
      );
      // Processes exchange text here, so a history with a name that is not UTF-8 cannot pass.
      if (exported.stdoutInvalidUtf8 === true) return yield* Effect.die("History is not UTF-8.");
      return removePaths(exported.stdout, relativePaths);
    });
    yield* historyGate.withPermits(HISTORY_USERS)(
      Effect.gen(function* () {
        yield* run(["update-index", "--force-remove", "-z", "--stdin"], {
          stdin: files.map((file) => `${file.below}\u0000`).join(""),
        }).pipe(Effect.ignore);
        const first = yield* stripped.pipe(Effect.option);
        if (Option.isSome(first) && first.value.removed === 0) return yield* prune(false);
        const rewritten = Option.isNone(first)
          ? false
          : yield* run(["fast-import", "--force", "--quiet"], { stdin: first.value.stream }).pipe(
              Effect.andThen(stripped),
              Effect.map((second) => second.removed === 0),
              Effect.orElseSucceed(() => false),
            );
        // A history that could not be rewritten is given up: sealing comes before undo.
        if (!rewritten) {
          const refs = yield* run(["for-each-ref", "--format=delete %(refname)"]);
          yield* run(["update-ref", "--stdin"], { stdin: refs.stdout });
        }
        yield* prune(true);
      }),
    );
  });

  /**
   * Takes files out of DoeDesk's checkpoints in the person's own repository: only `refs/t3`
   * moves, only commits DoeDesk wrote change. Nothing is pruned; the objects the old checkpoints
   * alone kept are removed by name, so no other unreachable object of the person's goes.
   */
  const forgetInRepository = Effect.fn("CheckpointStore.forgetInRepository")(function* (
    history: LocatedDirectory,
    files: ReadonlyArray<{ readonly relativePath: string }>,
  ) {
    const operation = "CheckpointStore.forgetInRepository";
    const run = (
      args: ReadonlyArray<string>,
      options?: {
        readonly stdin?: string;
        readonly maxOutputBytes?: number;
        readonly timeoutMs?: number;
      },
    ) =>
      history.git.execute({
        operation,
        cwd: history.cwd,
        args,
        timeoutMs: 300_000,
        outputMode: "error",
        ...options,
      });
    const lines = (text: string) => text.split("\n").filter((line) => line !== "");
    const relativePaths = files.map((file) => file.relativePath);
    const stripped = Effect.gen(function* () {
      const exported = yield* run(
        [
          "-c",
          "core.quotePath=false",
          "fast-export",
          "--no-data",
          "--reencode=no",
          "--signed-tags=strip",
          "--tag-of-filtered-object=drop",
          // The person's commits are named, not copied: a checkpoint keeps its parents.
          "--reference-excluded-parents",
          DOEDESK_REVISIONS,
          "--not",
          ...PERSONS_REVISIONS,
          "--reflog",
        ],
        { maxOutputBytes: 128_000_000 },
      );
      if (exported.stdoutInvalidUtf8 === true) return yield* Effect.die("History is not UTF-8.");
      return removePaths(exported.stdout, relativePaths, (message) =>
        message.startsWith(CHECKPOINT_MESSAGE),
      );
    });
    yield* historyGate.withPermits(HISTORY_USERS)(
      Effect.gen(function* () {
        const tips = [
          ...new Set(
            lines((yield* run(["for-each-ref", "--format=%(objectname)", "refs/t3"])).stdout),
          ),
        ];
        if (tips.length === 0) return;
        const first = yield* stripped.pipe(Effect.option);
        // No checkpoint holds a version of its own: what they have is the person's commits'.
        if (Option.isSome(first) && first.value.removed === 0) return;
        const rewritten = Option.isNone(first)
          ? false
          : yield* run(["fast-import", "--force", "--quiet"], { stdin: first.value.stream }).pipe(
              Effect.andThen(stripped),
              Effect.map((second) => second.removed === 0),
              Effect.orElseSucceed(() => false),
            );
        // Checkpoints that could not be rewritten are given up: sealing comes before undo.
        if (!rewritten) {
          const refs = yield* run(["for-each-ref", "--format=delete %(refname)", "refs/t3"]);
          yield* run(["update-ref", "--stdin"], { stdin: refs.stdout });
        }
        // The refs no longer lead to the file. Taking its objects out of the store as well can
        // fail or run out of time in a very large repository; the seal stands either way.
        yield* Effect.gen(function* () {
          // What the old checkpoints reached and nothing reaches now. Git's own check says what is
          // unreachable, from every ref, reflog and index of every working tree; a walk from the
          // old checkpoints alone would also name objects the new ones still use.
          const orphaned = Effect.gen(function* () {
            const reached = yield* run(
              [
                "rev-list",
                "--objects",
                "--no-object-names",
                "--stdin",
                "--not",
                ...PERSONS_REVISIONS,
                "--reflog",
              ],
              { stdin: `${tips.join("\n")}\n`, maxOutputBytes: 128_000_000 },
            );
            const unreachable = yield* history.git.execute({
              operation,
              cwd: history.cwd,
              args: [
                "fsck",
                "--unreachable",
                "--connectivity-only",
                "--no-dangling",
                "--no-progress",
              ],
              timeoutMs: 600_000,
              maxOutputBytes: 128_000_000,
              outputMode: "error",
              allowNonZeroExit: true,
            });
            const lost = new Set(
              [...unreachable.stdout.matchAll(/^unreachable \w+ ([0-9a-f]+)$/gm)].map(
                (match) => match[1] ?? "",
              ),
            );
            return lines(reached.stdout).filter((oid) => lost.has(oid));
          });
          const objects = (yield* run([
            "rev-parse",
            "--path-format=absolute",
            "--git-path",
            "objects",
          ])).stdout.trim();
          const looseFile = (oid: string) => path.join(objects, oid.slice(0, 2), oid.slice(2));
          const removeLoose = Effect.fn("CheckpointStore.removeOrphans")(function* (
            oids: ReadonlyArray<string>,
          ) {
            const packed: Array<string> = [];
            for (const oid of oids) {
              const file = looseFile(oid);
              if (yield* fileSystem.exists(file).pipe(Effect.orElseSucceed(() => false))) {
                yield* fileSystem.remove(file).pipe(Effect.ignore);
              } else packed.push(oid);
            }
            return packed;
          });
          // Git's commit graph lists the old checkpoint commits, and its own check fails on one
          // that is gone. Git writes the graph again after it prunes; so does this.
          const refreshCommitGraph = Effect.gen(function* () {
            const info = path.join(objects, "info");
            const chain = yield* fileSystem
              .exists(path.join(info, "commit-graphs", "commit-graph-chain"))
              .pipe(Effect.orElseSucceed(() => false));
            const single = yield* fileSystem
              .exists(path.join(info, "commit-graph"))
              .pipe(Effect.orElseSucceed(() => false));
            if (!chain && !single) return;
            yield* run([
              "commit-graph",
              "write",
              "--reachable",
              ...(chain ? ["--split=replace"] : []),
            ]).pipe(Effect.ignore);
          });
          const packed = yield* removeLoose(yield* orphaned);
          if (packed.length === 0) return yield* refreshCommitGraph;
          // Git's own repack keeps every unreachable object of a pack as a loose one, so the
          // person loses nothing; ours are then removed as above.
          yield* run(["repack", "-A", "-d", "-q"], { timeoutMs: 600_000 }).pipe(Effect.ignore);
          // Asked again: the repack is the person's Git at work, and may have found a use for one.
          const left = yield* removeLoose(yield* orphaned);
          yield* refreshCommitGraph;
          if (left.length > 0) {
            yield* Effect.logWarning("Sealed copies stay in a pack of the person's repository", {
              objects: left.length,
            });
          }
        }).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("Could not remove a sealed file's objects from the repository", {
              cause,
            }),
          ),
        );
      }),
    );
  });

  const forgetFiles = Effect.fn("CheckpointStore.forgetFiles")(function* (
    filePaths: ReadonlyArray<string>,
    folder: string | undefined,
  ) {
    // Files of one folder share its repository, so each folder is asked once.
    const directories = new Map<string, LocatedDirectory | null>();
    const histories = new Map<
      string,
      {
        readonly located: LocatedDirectory;
        readonly files: Array<{ below: string; relativePath: string }>;
      }
    >();
    for (const filePath of filePaths) {
      const directory = path.dirname(filePath);
      if (!directories.has(directory)) {
        directories.set(directory, yield* locateDirectory(directory));
      }
      const located = directories.get(directory) ?? null;
      if (located === null) continue;
      const history = histories.get(located.gitDirectory) ?? { located, files: [] };
      histories.set(located.gitDirectory, history);
      const relativePath = `${located.prefix}${path.basename(filePath)}`;
      // Commands run in the first file's folder, so a path is given from there, by way of the top.
      const up = "../".repeat(history.located.prefix.split("/").filter(Boolean).length);
      history.files.push({ relativePath, below: `${up}${relativePath}` });
    }
    const persons = [...histories.values()].filter(({ located }) => !located.own);
    if (persons.length > 0) {
      const inPersons = new Set(
        persons.flatMap(({ located, files }) =>
          files.map((file) => `${located.gitDirectory}\n${file.relativePath}`),
        ),
      );
      // Kept out before anything is rewritten, so no capture stores the file again meanwhile.
      yield* keepOut(
        folder !== undefined
          ? [path.resolve(folder)]
          : filePaths
              .filter((filePath) => {
                const located = directories.get(path.dirname(filePath)) ?? null;
                return (
                  located !== null &&
                  inPersons.has(
                    `${located.gitDirectory}\n${located.prefix}${path.basename(filePath)}`,
                  )
                );
              })
              .map((filePath) => path.resolve(filePath)),
      );
    }
    yield* Effect.forEach(
      histories.values(),
      ({ located, files }) =>
        located.own ? forgetIn(located, files) : forgetInRepository(located, files),
      { discard: true },
    );
  });

  const sealChanged: CheckpointStore["Service"]["sealChanged"] = Effect.fn(
    "CheckpointStore.sealChanged",
  )(function* (change) {
    if (change.paths.length === 0) return;
    yield* noteSealChanges(change.folder === undefined ? change.paths : [change.folder]);
    if (change.kind === "sealed") yield* forgetFiles(change.paths, change.folder);
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
    fileHistory,
    sealChanged,
  });
});

export const layer = Layer.effect(CheckpointStore, make);
