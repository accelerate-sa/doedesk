import { useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";

import { mobilePreferencesAtom } from "../state/preferences";

/**
 * DoeDesk is for people who handle confidential files, not for programmers. The tools that only
 * make sense for source code (terminal, git, pull requests) stay out of the way unless the user
 * turns on Developer mode in Settings.
 */
export function useDeveloperMode(): boolean {
  const preferences = useAtomValue(mobilePreferencesAtom);
  return AsyncResult.isSuccess(preferences) && preferences.value.developerMode === true;
}
