import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import type { WorkspaceEnvironment, WorkspaceState } from "../../state/workspaceModel";
import { deriveHomeEmptyState } from "./home-empty-state";

function connectingEnvironment(
  connectionState: "connecting" | "reconnecting",
  connectionError: string | null,
): WorkspaceEnvironment {
  return {
    environmentId: EnvironmentId.make("environment-1"),
    environmentLabel: "corex",
    displayUrl: "",
    isRelayManaged: false,
    isEnabled: true,
    connectionState,
    connectionError,
    connectionErrorTraceId: null,
  };
}

function workspaceState(overrides: Partial<WorkspaceState> = {}): WorkspaceState {
  return {
    isLoadingConnections: false,
    hasConnections: true,
    hasLoadedShellSnapshot: true,
    hasPendingShellSnapshot: false,
    hasSyncingConnectedEnvironment: false,
    hasReadyEnvironment: true,
    hasConnectingEnvironment: false,
    connectingEnvironments: [],
    connectionState: "connected",
    connectionError: null,
    shellSnapshotError: null,
    networkStatus: "online",
    ...overrides,
  };
}

const RETAINED_FAILURE = "Computer did not respond before the connection timeout.";
const reconnecting = connectingEnvironment("reconnecting", RETAINED_FAILURE);

describe("home empty state", () => {
  it.each([
    [
      "waits while a saved computer retries after a retained failure",
      workspaceState({
        hasLoadedShellSnapshot: false,
        hasPendingShellSnapshot: true,
        hasReadyEnvironment: false,
        hasConnectingEnvironment: true,
        connectingEnvironments: [reconnecting],
        connectionState: "reconnecting",
        connectionError: RETAINED_FAILURE,
      }),
      1,
      { title: "Connecting to computer", loading: true, showsAddEnvironment: false },
    ],
    [
      "waits for a connected computer's first shell snapshot",
      workspaceState({
        hasLoadedShellSnapshot: false,
        hasPendingShellSnapshot: true,
        hasSyncingConnectedEnvironment: true,
      }),
      0,
      { title: "Loading chats", loading: true, showsAddEnvironment: false },
    ],
    [
      "waits while another computer is still connecting after one loaded empty",
      workspaceState({
        hasPendingShellSnapshot: true,
        hasConnectingEnvironment: true,
        connectingEnvironments: [reconnecting],
        connectionError: RETAINED_FAILURE,
      }),
      0,
      { title: "Loading chats", loading: true, showsAddEnvironment: false },
    ],
    [
      "reports no chats once every computer has resolved",
      workspaceState(),
      1,
      { title: "No chats yet", loading: false, showsAddEnvironment: false },
    ],
    [
      "does not wait on retries while the device is offline",
      workspaceState({
        hasPendingShellSnapshot: true,
        hasReadyEnvironment: false,
        hasConnectingEnvironment: true,
        connectingEnvironments: [reconnecting],
        connectionState: "offline",
        networkStatus: "offline",
      }),
      1,
      { title: "No chats yet", loading: false, showsAddEnvironment: true },
    ],
  ] as const)("%s", (_name, state, projectCount, expected) => {
    const { title, loading, showsAddEnvironment } = deriveHomeEmptyState(state, projectCount);
    expect({ title, loading, showsAddEnvironment }).toEqual(expected);
  });
});
