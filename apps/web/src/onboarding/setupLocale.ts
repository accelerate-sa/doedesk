import { createContext, useContext } from "react";

/**
 * True while rendering inside first-run setup. Shared privacy forms read this to hide their
 * inline consent-language toggle because step 1 of setup already chose the app language.
 */
export const InSetupContext = createContext(false);

export function useInSetup(): boolean {
  return useContext(InSetupContext);
}
