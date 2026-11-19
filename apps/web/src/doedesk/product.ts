import { getClientSettings, useClientSettings } from "~/hooks/useSettings";

/**
 * DoeDesk is for people who handle confidential files, not for programmers. The tools that only
 * make sense for source code (terminal, git, pull requests, simulators) stay out of the way
 * unless the user turns on Developer mode in Settings.
 */
export function useDeveloperMode(): boolean {
  return useClientSettings((settings) => settings.developerMode);
}

/** For code that runs outside a component. Reads the setting as it is now. */
export function isDeveloperMode(): boolean {
  return getClientSettings().developerMode;
}
