import { sha256 } from "@noble/hashes/sha2";
import { MAX_SEALED_AT_ONCE, type PrivacySealedResult } from "@t3tools/contracts";
import { msg } from "gt-react";
import { create } from "zustand";

import { fileHasUnsavedEdits } from "~/components/files/fileSaveSessions";
import { toastManager } from "~/components/ui/toast";
import { m } from "~/i18n/messages";
import { changeSealedDocuments, reloadPrivacyStatus } from "./privacyClient";

/** A file the person asked to seal: one in the folder, by its path, or one attached to a message. */
export interface SealRequest {
  readonly projectId: string;
  readonly name: string;
  /** Absolute path on the machine that holds the folder. The file is moved out when sealed. */
  readonly path?: string;
  /**
   * An attached file, which is a copy. Where the project's folder holds the file itself, the
   * server seals that; otherwise the copy is sealed and the person is told what stays readable.
   */
  readonly file?: File;
  /** Called once sealed, with the handle the AI knows the document by. */
  readonly onSealed?: (handle: string) => void;
}

export interface UnsealRequest {
  readonly projectId: string;
  readonly handle: string;
  readonly name: string;
  /** False when it was sealed from a copy, so nothing goes back into a folder. */
  readonly movedOut: boolean;
}

/** Several files of the folder, picked in the file list and sealed under one confirmation. */
export interface SealFilesRequest {
  readonly projectId: string;
  /** Absolute paths on the machine that holds the folder. */
  readonly paths: ReadonlyArray<string>;
}

/** A subfolder of the project: its files are sealed now, and each new one as it arrives. */
export interface SealFolderRequest {
  readonly projectId: string;
  readonly name: string;
  /** Absolute path on the machine that holds the folder. */
  readonly path: string;
}

export interface UnsealFolderRequest {
  readonly projectId: string;
  readonly name: string;
  readonly path: string;
  /** Sealed files that go back into the folder. */
  readonly files: number;
}

/** What the server found before a confirmation. Null until it answers. */
export type SealInspection = NonNullable<PrivacySealedResult["inspected"]> | null;

/**
 * What the AI company would be told the first few files are called: each name with the values
 * found in it masked, or null for one that cannot be checked now. Null until the server answers.
 */
export type SealLabels = NonNullable<PrivacySealedResult["labels"]> | null;

/**
 * For a file that is attached to a message and so came as a copy: what the project's folder
 * holds of it. `pending` until the server has looked; `unknown` when it could not say.
 */
export type SealCopy = NonNullable<PrivacySealedResult["copy"]> | "pending" | "unknown";

export type SealPrompt =
  | {
      readonly kind: "seal";
      readonly request: SealRequest;
      /** The person's own repository keeps earlier versions of the file. */
      readonly inGit: boolean;
      /** Chats ran in the folder while the file could be read there. */
      readonly seenByChats: boolean;
      /** The file is of a kind DoeDesk cannot read: sealed, it cannot be asked about. */
      readonly unreadable: boolean;
      readonly labels: SealLabels;
      /** Set for an attached file. Undefined for one sealed where it lies. */
      readonly copy?: SealCopy;
    }
  | {
      readonly kind: "sealFiles";
      readonly request: SealFilesRequest;
      readonly inspected: SealInspection;
      readonly seenByChats: boolean;
      readonly labels: SealLabels;
    }
  | {
      readonly kind: "sealFolder";
      readonly request: SealFolderRequest;
      readonly inspected: SealInspection;
      readonly seenByChats: boolean;
      readonly labels: SealLabels;
    }
  | { readonly kind: "unseal"; readonly request: UnsealRequest }
  | { readonly kind: "unsealFolder"; readonly request: UnsealFolderRequest };

/** `prompt` outlives `open` so the dialog keeps its words while it closes. */
export const useSealPrompt = create<{ prompt: SealPrompt | null; open: boolean }>(() => ({
  prompt: null,
  open: false,
}));

export const closeSealPrompt = (): void => useSealPrompt.setState({ open: false });

export const requestSeal = (request: SealRequest): void => {
  // Whichever screen asked: a save still on its way would write the file back into the folder.
  if (request.path !== undefined && fileHasUnsavedEdits(request.path)) {
    toastManager.add({
      type: "warning",
      title: m(msg("{name} has edits that are not saved yet", { name: request.name })),
      description: m(msg("Seal it once they are saved, which takes a moment.")),
    });
    return;
  }
  useSealPrompt.setState({
    prompt: {
      kind: "seal",
      request,
      inGit: false,
      seenByChats: false,
      unreadable: false,
      labels: null,
      ...(request.path === undefined ? { copy: "pending" as const } : {}),
    },
    open: true,
  });
  // A worker connected from another window or device since this one last read the status.
  void reloadPrivacyStatus().catch(() => undefined);
  if (request.path === undefined) {
    // An attached file is a copy with no path: the server looks for the file itself in the
    // folder by its digest, so the person is told what sealing will and will not cover.
    const settle = (found: Partial<Extract<SealPrompt, { kind: "seal" }>>) => {
      const { prompt } = useSealPrompt.getState();
      if (prompt?.kind === "seal" && prompt.request === request) {
        useSealPrompt.setState({ prompt: { ...prompt, ...found } });
      }
    };
    void (async () => {
      if (request.file === undefined) return settle({ copy: "unknown", labels: [] });
      const bytes = new Uint8Array(await request.file.arrayBuffer());
      const result = await changeSealedDocuments({
        action: "inspectCopy",
        projectId: request.projectId,
        name: request.name,
        sha256: [...sha256(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join(""),
        size: bytes.length,
      });
      settle({
        copy: result.copy ?? "unknown",
        labels: result.labels ?? [],
        inGit: result.inGit === true,
        seenByChats: result.seenByChats === true,
        unreadable: (result.inspected?.unsupported ?? 0) > 0,
      });
    })().catch(() => settle({ copy: "unknown", labels: [] }));
    return;
  }
  // Asked before the person confirms: what sealing cannot take back.
  void changeSealedDocuments({
    action: "inspect",
    projectId: request.projectId,
    path: request.path,
  }).then(
    (result) => {
      const { prompt } = useSealPrompt.getState();
      if (prompt?.kind === "seal" && prompt.request === request) {
        useSealPrompt.setState({
          prompt: {
            ...prompt,
            inGit: result.inGit === true,
            seenByChats: result.seenByChats === true,
            unreadable: (result.inspected?.unsupported ?? 0) > 0,
            labels: result.labels ?? [],
          },
        });
      }
    },
    () => undefined,
  );
};

const lastPart = (filePath: string): string => filePath.split(/[\\/]/).at(-1) ?? filePath;

/** Fills in what the server found, unless the person has moved on to another prompt. */
const inspectFor = (
  request: SealFilesRequest | SealFolderRequest,
  payload: Parameters<typeof changeSealedDocuments>[0],
): void => {
  const current = () => {
    const { prompt } = useSealPrompt.getState();
    return (prompt?.kind === "sealFiles" || prompt?.kind === "sealFolder") &&
      prompt.request === request
      ? prompt
      : null;
  };
  // The confirmation states the count: with no count there is nothing to confirm.
  const failed = () => {
    if (current() === null) return;
    closeSealPrompt();
    toastManager.add({
      type: "error",
      title: m(msg("The files could not be counted, so nothing was sealed")),
    });
  };
  void changeSealedDocuments(payload).then((result) => {
    const prompt = current();
    if (result.inspected === undefined) failed();
    else if (prompt !== null) {
      useSealPrompt.setState({
        prompt: {
          ...prompt,
          inspected: result.inspected,
          seenByChats: result.seenByChats === true,
          labels: result.labels ?? [],
        },
      });
    }
  }, failed);
};

/** Several files from the file list, under one confirmation. One file takes the usual prompt. */
export const requestSealFiles = (request: SealFilesRequest): void => {
  const [only] = request.paths;
  if (only === undefined) return;
  if (request.paths.length === 1) {
    requestSeal({ projectId: request.projectId, name: lastPart(only), path: only });
    return;
  }
  const unsaved = request.paths.find(fileHasUnsavedEdits);
  if (unsaved !== undefined) {
    toastManager.add({
      type: "warning",
      title: m(msg("{name} has edits that are not saved yet", { name: lastPart(unsaved) })),
      description: m(msg("Seal the files once they are saved, which takes a moment.")),
    });
    return;
  }
  if (request.paths.length > MAX_SEALED_AT_ONCE) {
    toastManager.add({
      type: "warning",
      title: m(
        msg("Seal up to {limit} files at a time", { limit: MAX_SEALED_AT_ONCE.toLocaleString() }),
      ),
      description: m(msg("To seal everything in a folder, seal the folder.")),
    });
    return;
  }
  useSealPrompt.setState({
    prompt: { kind: "sealFiles", request, inspected: null, seenByChats: false, labels: null },
    open: true,
  });
  void reloadPrivacyStatus().catch(() => undefined);
  inspectFor(request, {
    action: "inspectPaths",
    projectId: request.projectId,
    paths: request.paths,
  });
};

export const requestSealFolder = (request: SealFolderRequest): void => {
  useSealPrompt.setState({
    prompt: { kind: "sealFolder", request, inspected: null, seenByChats: false, labels: null },
    open: true,
  });
  void reloadPrivacyStatus().catch(() => undefined);
  inspectFor(request, {
    action: "inspectFolder",
    projectId: request.projectId,
    path: request.path,
  });
};

export const requestUnseal = (request: UnsealRequest): void =>
  useSealPrompt.setState({ prompt: { kind: "unseal", request }, open: true });

export const requestUnsealFolder = (request: UnsealFolderRequest): void =>
  useSealPrompt.setState({ prompt: { kind: "unsealFolder", request }, open: true });

/**
 * Where an attached file lies on this computer, when the desktop app can say and it is inside
 * `folder`: such a file is sealed in place, or its readable copy would stay in the folder.
 */
export const attachedFilePathInFolder = (file: File, folder: string | null): string | undefined => {
  if (folder === null) return undefined;
  let filePath: string | undefined;
  try {
    filePath = window.desktopBridge?.getPathForFile?.(file) || undefined;
  } catch {
    return undefined;
  }
  if (filePath === undefined) return undefined;
  const root = folder.replace(/[\\/]+$/, "");
  return filePath.startsWith(`${root}/`) || filePath.startsWith(`${root}\\`) ? filePath : undefined;
};

export const fileToBase64 = async (file: File): Promise<string> => {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
};
