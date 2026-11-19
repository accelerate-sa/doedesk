import { useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";
import { Platform } from "react-native";
import {
  NAVIGATION_TAB_LABELS,
  navigationCustomizationAvailable,
  resolveHiddenNavigationTabs,
  enabledNavigationTabs,
  type NavigationTab,
} from "./navigation-tab-order";
import type { AppSymbolName } from "../../../components/ui/AppSymbol";
import { mobilePreferencesAtom } from "../../../state/preferences";
import { PullRequestGlyph } from "../../pull-requests/pullRequestGlyphs";
import { resolveWorkspaceTabOrder } from "./workspace-tabs-state";

export const WORKSPACE_TAB_LABELS = {
  ...NAVIGATION_TAB_LABELS,
  ...(Platform.OS === "ios" ? { threads: "Chats", pullRequests: "PRs" } : {}),
};

export const NAVIGATION_TAB_ICONS = {
  threads: "text.bubble",
  pullRequests: PullRequestGlyph.pullRequest,
  usage: "chart.bar.xaxis",
} as const satisfies Readonly<Record<NavigationTab, AppSymbolName>>;

/** Sections that are only for source code. They show in Developer mode. */
const DEVELOPER_TABS: readonly NavigationTab[] = ["pullRequests"];

export function useNavigationTabOrder() {
  const preferences = useAtomValue(mobilePreferencesAtom);
  const saved = AsyncResult.isSuccess(preferences)
    ? preferences.value.navigationTabOrder
    : undefined;
  return resolveWorkspaceTabOrder(saved);
}

export function useHiddenNavigationTabs() {
  const preferences = useAtomValue(mobilePreferencesAtom);
  const saved = AsyncResult.isSuccess(preferences)
    ? preferences.value.hiddenNavigationTabs
    : undefined;
  const chosen = navigationCustomizationAvailable() ? resolveHiddenNavigationTabs(saved) : [];
  const developerMode =
    AsyncResult.isSuccess(preferences) && preferences.value.developerMode === true;
  return developerMode ? chosen : [...new Set([...chosen, ...DEVELOPER_TABS])];
}

export function useEnabledNavigationTabs() {
  const order = useNavigationTabOrder();
  const hidden = useHiddenNavigationTabs();
  return enabledNavigationTabs(order, hidden);
}
