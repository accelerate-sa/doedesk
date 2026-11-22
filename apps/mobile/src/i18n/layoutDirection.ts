import { localeDirection } from "@t3tools/client-runtime/locales";
import { I18nManager } from "react-native";

/**
 * React Native reads the layout direction once, at launch. A language that reads the other way
 * is saved for the next launch here, and the running app keeps its direction until restarted.
 */
export function saveLayoutDirection(locale: string): void {
  const rtl = localeDirection(locale) === "rtl";
  if (I18nManager.isRTL === rtl) return;
  I18nManager.allowRTL(rtl);
  I18nManager.forceRTL(rtl);
}

/** True when the language reads the other way from the layout this launch started with. */
export function isLayoutRestartNeeded(locale: string): boolean {
  return I18nManager.isRTL !== (localeDirection(locale) === "rtl");
}
