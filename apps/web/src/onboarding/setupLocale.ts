import { createContext, useContext } from "react";

import type { SetupLocale } from "./onboardingSteps.logic";

/**
 * The language first-run setup is shown in. The app's own interface has no Arabic yet, so setup
 * carries its two languages itself; screens shared with Settings read this to follow it, and
 * outside setup there is none and they keep their usual words.
 */
export const SetupLocaleContext = createContext<SetupLocale | null>(null);

/** Picks the English or Arabic words for the language setup is in. */
export function useSetupText() {
  const locale = useContext(SetupLocaleContext);
  return (english: string, arabic: string) => (locale === "ar" ? arabic : english);
}

/** True inside setup shown in Arabic. */
export function useSetupArabic(): boolean {
  return useContext(SetupLocaleContext) === "ar";
}
