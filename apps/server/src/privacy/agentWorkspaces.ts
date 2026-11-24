import type { SealChange, SealedFolderGate } from "@t3tools/privacy-gateway";
import { buildSealedFilesInstructions } from "@t3tools/provider-core/server/runtimeInstructions";

const MAX_AGENT_WORKSPACES = 32;
const workspaces = new Set<string>();

/**
 * Records a folder an agent's turn runs in, so the privacy gateway can tell the names of its
 * files from personal data. Kept apart from the gateway so the turn start does not load it.
 */
export const noteAgentWorkspace = (cwd: string): void => {
  // Re-inserted, so the set keeps the folders used most recently.
  workspaces.delete(cwd);
  workspaces.add(cwd);
  for (const oldest of workspaces) {
    if (workspaces.size <= MAX_AGENT_WORKSPACES) break;
    workspaces.delete(oldest);
  }
};

export const agentWorkspaceRoots = (): ReadonlyArray<string> => [...workspaces];

/**
 * A project's sealed files as an agent is told them. The gateway gives a file's label here, never
 * its own name: the name with the values in it masked, or the handle and the file type. Paths
 * are written from the agent's working folder where they lie below it.
 */
interface SealedFiles {
  readonly files: ReadonlyArray<{
    readonly handle: string;
    readonly name: string;
    readonly path?: string;
    /** No text to ask about yet. */
    readonly unread: boolean;
  }>;
  readonly folders: ReadonlyArray<string>;
  readonly askOffered: boolean;
}

let sealedFilesOf: (project: string, cwd: string | null) => SealedFiles = () => ({
  files: [],
  folders: [],
  askOffered: false,
});

/** Set by the privacy gateway: what is sealed in a project, and whether a worker can be asked. */
export const setSealedFilesSource = (
  source: (project: string, cwd: string | null) => SealedFiles,
): void => {
  sealedFilesOf = source;
};

/**
 * What an agent is told with each prompt about the files sealed in its project. Empty when none
 * is sealed.
 */
export const sealedFilesNote = (project: string, cwd: string | null): string =>
  buildSealedFilesInstructions(sealedFilesOf(project, cwd));

const MAX_TOLD = 512;
const toldSealedFiles = new Map<string, string>();

/**
 * Whether an agent has yet to be told what is sealed now: its provider thread was last sent
 * another note, or none since the server started. A resumed turn sends no prompt, so one that is
 * owed the note is started with a prompt instead.
 */
export const owesSealedFilesNote = (providerThreadId: string, note: string): boolean =>
  note !== "" && toldSealedFiles.get(providerThreadId) !== note;

/** Records the note sent with a provider thread's prompt. */
export const noteSealedFilesTold = (providerThreadId: string, note: string): void => {
  toldSealedFiles.delete(providerThreadId);
  toldSealedFiles.set(providerThreadId, note);
  for (const oldest of toldSealedFiles.keys()) {
    if (toldSealedFiles.size <= MAX_TOLD) break;
    toldSealedFiles.delete(oldest);
  }
};

let sealedFolderPaths: () => ReadonlyArray<string> = () => [];

/** Set by the privacy gateway: every sealed folder on this computer. */
export const setSealedFolderPaths = (paths: () => ReadonlyArray<string>): void => {
  sealedFolderPaths = paths;
};

/** The sealed folders below `cwd`, as paths from it: what a checkpoint of `cwd` leaves out. */
export const sealedFoldersBelow = (cwd: string): ReadonlyArray<string> => {
  const slashes = (value: string) => value.replaceAll("\\", "/").replace(/\/+$/, "");
  const below = `${slashes(cwd)}/`;
  return sealedFolderPaths()
    .map(slashes)
    .filter((folder) => folder.startsWith(below))
    .map((folder) => folder.slice(below.length));
};

/**
 * Files that were sealed or unsealed in one action. Resolves false while a copy DoeDesk keeps of
 * a sealed file could not be removed; an empty change tries again what was left.
 */
type SealChangeHandler = (change: SealChange) => Promise<boolean>;

let sealChangeHandler: SealChangeHandler = () => Promise.resolve(true);

/** Set once the checkpoint store is up. Until then nothing has been checkpointed either. */
export const setSealChangeHandler = (handler: SealChangeHandler): void => {
  sealChangeHandler = handler;
};

/** Given to the privacy gateway, which awaits it for every seal and unseal, however it happened. */
export const sealChanged = (change: SealChange): Promise<void> =>
  sealChangeHandler(change).then(() => undefined);

interface SealedFolderChecks {
  readonly beforeTurn: (project: string, signal?: AbortSignal) => Promise<SealedFolderGate>;
  readonly sweepSoon: (project: string) => void;
}

let sealedFolders: SealedFolderChecks = {
  beforeTurn: () => Promise.resolve({ ok: true, sealed: 0 }),
  sweepSoon: () => undefined,
};

/** Set by the privacy gateway once it has started. Until then no folder is sealed. */
export const setSealedFolderChecks = (checks: SealedFolderChecks): void => {
  sealedFolders = checks;
};

/** Why an agent's turn was not started, in words for the person. */
export interface SealedFolderRefusal {
  readonly title: string;
  readonly message: string;
}

const MAX_THREAD_PROJECTS = 512;
const threadProjects = new Map<string, string>();

/**
 * Run before an agent's turn starts. A sealed folder must hold nothing readable by then: a file
 * can arrive while the app is closed, when no watcher sees it, and one still being copied is
 * waited for. Resolves to null when the turn may start. It fails closed: when the folders could
 * not be checked, the turn does not start either.
 */
export const sealedFoldersBeforeTurn = async (
  threadId: string,
  project: string,
  signal?: AbortSignal,
): Promise<SealedFolderRefusal | null> => {
  threadProjects.delete(threadId);
  threadProjects.set(threadId, project);
  for (const oldest of threadProjects.keys()) {
    if (threadProjects.size <= MAX_THREAD_PROJECTS) break;
    threadProjects.delete(oldest);
  }
  let gate: SealedFolderGate;
  try {
    gate = await sealedFolders.beforeTurn(project, signal);
  } catch {
    return {
      title: "The sealed folders could not be checked",
      message:
        "DoeDesk could not check this folder's sealed folders, so the turn was not started. Send your message again.",
    };
  }
  if (gate.ok) {
    // A sweep seals a file that an earlier checkpoint may hold. The turn waits for that copy to go.
    return (await sealChangeHandler({ kind: "sealed", paths: [] }).catch(() => false))
      ? null
      : {
          title: "Earlier copies of a sealed file could not be removed",
          message:
            "DoeDesk keeps copies of this folder's files so a turn can be undone, and it could not remove the copies of a file that is now sealed. The turn was not started, so your AI cannot read them. Send your message again.",
        };
  }
  return gate.reason === "receiving"
    ? {
        title: "A sealed folder is still receiving a file",
        message: `"${gate.file}" is still being copied into the sealed folder "${gate.folder}". The turn was not started, so your AI cannot read the file before it is sealed. Send your message again when the copy has finished.`,
      }
    : {
        title: "A file in a sealed folder could not be sealed",
        message: `"${gate.file}" in the sealed folder "${gate.folder}" could not be sealed: ${gate.message ?? "the reason is not known."} The turn was not started, so your AI cannot read it. Close the file in other programs and send your message again, or unseal the folder.`,
      };
};

/**
 * Told when a tool call of a thread's agent that can write has ended: its project's sealed
 * folders are swept at once, in place of waiting for the watcher to notice the file.
 */
export const noteAgentWrite = (threadId: string): void => {
  const project = threadProjects.get(threadId);
  if (project !== undefined) sealedFolders.sweepSoon(project);
};
