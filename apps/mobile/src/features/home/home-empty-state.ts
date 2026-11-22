import { msg } from "gt-react-native";

import { m, type MessageResolver } from "../../i18n/messages";
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
  resolve: MessageResolver = m,
): HomeEmptyState {
  const emptyState = deriveEmptyState(catalogState, projectCount, resolve);
  return {
    ...emptyState,
    showsAddEnvironment: !emptyState.loading && !catalogState.hasReadyEnvironment,
  };
}

function deriveEmptyState(
  catalogState: WorkspaceState,
  projectCount: number,
  resolve: MessageResolver,
): Omit<HomeEmptyState, "showsAddEnvironment"> {
  if (catalogState.isLoadingConnections) {
    return {
      title: resolve(msg("Loading computers")),
      detail: resolve(msg("Checking saved computers on this device.")),
      loading: true,
    };
  }

  if (!catalogState.hasConnections) {
    return {
      title: resolve(msg("No computers connected")),
      detail: resolve(msg("Add your computer to see your work here.")),
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
          ? resolve(msg("Client not supported"))
          : resolve(msg("Computer unavailable")),
      detail:
        catalogState.connectionError ??
        resolve(
          msg("The saved computer is offline. Check the URL or start the computer, then retry."),
        ),
      loading: false,
    };
  }

  if (isWorkspaceCatalogPending(catalogState)) {
    return {
      title: catalogState.hasReadyEnvironment
        ? resolve(msg("Loading chats"))
        : resolve(msg("Connecting to computer")),
      detail: resolve(msg("Loading folders and chats from the saved computer.")),
      loading: true,
    };
  }

  if (projectCount === 0 && catalogState.hasLoadedShellSnapshot) {
    return {
      title: resolve(msg("No folders found")),
      detail: resolve(msg("The connected computer did not report any folders.")),
      loading: false,
    };
  }

  return {
    title: resolve(msg("No chats yet")),
    detail: resolve(
      msg("Create a task to start a new coding runtime in one of your connected folders."),
    ),
    loading: false,
  };
}
