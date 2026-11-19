import { isWorkspaceCatalogPending, type WorkspaceState } from "../../state/workspaceModel";

export interface HomeEmptyState {
  readonly title: string;
  readonly detail: string;
  readonly loading: boolean;
  readonly showsAddEnvironment: boolean;
}

export function deriveHomeEmptyState(
  catalogState: WorkspaceState,
  projectCount: number,
): HomeEmptyState {
  const emptyState = deriveEmptyState(catalogState, projectCount);
  return {
    ...emptyState,
    showsAddEnvironment: !emptyState.loading && !catalogState.hasReadyEnvironment,
  };
}

function deriveEmptyState(
  catalogState: WorkspaceState,
  projectCount: number,
): Omit<HomeEmptyState, "showsAddEnvironment"> {
  if (catalogState.isLoadingConnections) {
    return {
      title: "Loading computers",
      detail: "Checking saved computers on this device.",
      loading: true,
    };
  }

  if (!catalogState.hasConnections) {
    return {
      title: "No computers connected",
      detail: "Add your computer to see your work here.",
      loading: false,
    };
  }

  if (
    (catalogState.connectionState === "available" ||
      catalogState.connectionState === "offline" ||
      catalogState.connectionState === "error" ||
      catalogState.connectionState === "unsupported") &&
    !catalogState.hasLoadedShellSnapshot
  ) {
    return {
      title:
        catalogState.connectionState === "unsupported"
          ? "Client not supported"
          : "Computer unavailable",
      detail:
        catalogState.connectionError ??
        "The saved computer is offline. Check the URL or start the computer, then retry.",
      loading: false,
    };
  }

  if (isWorkspaceCatalogPending(catalogState)) {
    return {
      title: catalogState.hasReadyEnvironment ? "Loading chats" : "Connecting to computer",
      detail: "Loading folders and chats from the saved computer.",
      loading: true,
    };
  }

  if (projectCount === 0 && catalogState.hasLoadedShellSnapshot) {
    return {
      title: "No folders found",
      detail: "The connected computer did not report any folders.",
      loading: false,
    };
  }

  return {
    title: "No chats yet",
    detail: "Create a task to start a new coding runtime in one of your connected folders.",
    loading: false,
  };
}
