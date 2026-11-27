import type { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { createContext, type MouseEvent } from "react";

export interface ComposerContextActions {
  environmentId: EnvironmentId | null;
  cwd?: string | undefined;
  projectId?: ProjectId | undefined;
  expandImage: (imageId: string) => void;
  expandVideo: (fileId: string) => void;
  openFile: (fileId: string) => void;
  openMention: (path: string) => void;
  openPullRequest: (event: MouseEvent<HTMLElement>, url: string) => void;
  /**
   * What an attached file's chip offers beside its name. A chip is the one place a file shows in
   * the composer, so these are absent only where there is nothing to offer.
   */
  sealFile?: ((fileId: string) => void) | undefined;
  /** Opens the file as it will be sent. De-identification review hangs off this. */
  reviewFile?: ((fileId: string) => void) | undefined;
  removeFile?: ((fileId: string) => void) | undefined;
  /** Present when this folder's files can be sealed: a mentioned file's chip offers Seal. */
  sealMention?: ((path: string) => void) | undefined;
}

export const ComposerContextActionsContext = createContext<ComposerContextActions>({
  environmentId: null,
  expandImage: () => {},
  expandVideo: () => {},
  openFile: () => {},
  openMention: () => {},
  openPullRequest: () => {},
});
