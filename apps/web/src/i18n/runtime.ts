import { localeDirection, prefersArabicLanguage } from "@t3tools/client-runtime/locales";
import { getTranslationsSnapshot } from "gt-react";

import {
  ensureClientSettingsHydrated,
  getClientSettings,
  isClientSettingsHydrated,
  subscribeClientSettings,
  updateClientSettings,
} from "../hooks/useSettings";
import { initializeI18n } from "./initializeI18n";
import { DEFAULT_LOCALE, SUPPORTED_LOCALES, resolveWebLocaleSelection } from "./locales";
import { setActiveLocale } from "./messages";

/** Mirrored for the inline boot script in `index.html`, which runs before IPC hydration. */
const LANGUAGE_BOOT_STORAGE_KEY = "t3code:language";

type LocaleTranslations = Awaited<ReturnType<typeof getTranslationsSnapshot>>;

export interface I18nSnapshot {
  readonly locale: string;
  readonly formattingLocale: string | undefined;
  readonly translations: LocaleTranslations;
}

const loadedTranslations: LocaleTranslations = { [DEFAULT_LOCALE]: {} };
const pendingLoads = new Map<string, Promise<void>>();
const listeners = new Set<() => void>();
let snapshot: I18nSnapshot = {
  locale: DEFAULT_LOCALE,
  formattingLocale: undefined,
  translations: { ...loadedTranslations },
};
let requestedLocale: ReturnType<typeof resolveWebLocaleSelection> = {
  catalogLocale: DEFAULT_LOCALE,
  formattingLocale: undefined,
};

function getPreferredSystemLanguages(): ReadonlyArray<string> {
  if (typeof window !== "undefined") {
    const desktopLanguages = window.desktopBridge?.getPreferredSystemLanguages?.() ?? [];
    if (desktopLanguages.length > 0) return desktopLanguages;
  }
  return typeof navigator !== "undefined" ? navigator.languages : [];
}

function readMirroredBootLanguage(): string | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage.getItem(LANGUAGE_BOOT_STORAGE_KEY)?.trim() || null;
  } catch {
    return null;
  }
}

function mirrorBootLanguage(language: string): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(LANGUAGE_BOOT_STORAGE_KEY, language);
  } catch {
    // Ignore storage quota or privacy-mode failures; client settings remain authoritative.
  }
}

function applyDocumentLocale(locale: string): void {
  if (typeof document === "undefined") return;
  document.documentElement.lang = locale;
  document.documentElement.dir = localeDirection(locale);
}

function resolveActiveLocale(): ReturnType<typeof resolveWebLocaleSelection> {
  const settings = getClientSettings();
  const language = isClientSettingsHydrated()
    ? settings.language
    : (readMirroredBootLanguage() ?? settings.language);
  const systemLanguages = getPreferredSystemLanguages();
  const isFreshSetup =
    settings.onboardingCompletedAt === null && settings.onboardingProgress?.locale == null;
  if (
    isFreshSetup &&
    language === DEFAULT_LOCALE &&
    SUPPORTED_LOCALES.includes("ar") &&
    prefersArabicLanguage(systemLanguages)
  ) {
    // Setup guessed Arabic and no language was chosen, so dates keep the computer's region.
    return { catalogLocale: "ar", formattingLocale: undefined };
  }
  return resolveWebLocaleSelection(language, systemLanguages);
}

function loadLocale(locale: string): Promise<void> {
  if (locale in loadedTranslations) return Promise.resolve();
  let load = pendingLoads.get(locale);
  if (!load) {
    // GT resolves a failed load to an empty catalog. Leave it uncached: English renders now
    // and the next request retries.
    load = getTranslationsSnapshot(locale).then((loaded) => {
      pendingLoads.delete(locale);
      const translations = loaded[locale];
      if (translations && Object.keys(translations).length > 0) {
        loadedTranslations[locale] = translations;
      }
    });
    pendingLoads.set(locale, load);
  }
  return load;
}

function activateLocale(locale: string): void {
  if (requestedLocale.catalogLocale !== locale) return;
  const { formattingLocale } = requestedLocale;
  applyDocumentLocale(locale);
  if (
    snapshot.locale === locale &&
    snapshot.formattingLocale === formattingLocale &&
    snapshot.translations[locale] === loadedTranslations[locale]
  ) {
    return;
  }
  snapshot = { locale, formattingLocale, translations: { ...loadedTranslations } };
  setActiveLocale(locale);
  for (const listener of listeners) listener();
}

function applyLanguageSetting(): void {
  const settings = getClientSettings();
  requestedLocale = resolveActiveLocale();
  if (isClientSettingsHydrated()) {
    const isFreshSetup =
      settings.onboardingCompletedAt === null && settings.onboardingProgress?.locale == null;
    if (!isFreshSetup || settings.language !== DEFAULT_LOCALE) {
      mirrorBootLanguage(settings.language);
    }
  }
  const locale = requestedLocale.catalogLocale;
  void loadLocale(locale).then(() => activateLocale(locale));
}

/** GT's own locale setters write the saved setting, which stays the only source of truth. */
export function persistGTLocale(locale: string): void {
  mirrorBootLanguage(locale);
  void updateClientSettings({ language: locale });
}

export function startI18n(): void {
  initializeI18n(persistGTLocale);
  subscribeClientSettings(applyLanguageSetting);
  applyLanguageSetting();
}

/** Resolves once client settings hydrate and the active locale's translations are ready. */
export function whenLocaleReady(): Promise<void> {
  return ensureClientSettingsHydrated()
    .catch(() => undefined)
    .then(() => {
      applyLanguageSetting();
      const locale = requestedLocale.catalogLocale;
      return loadLocale(locale).then(() => activateLocale(locale));
    });
}

export function subscribeI18n(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getI18nSnapshot(): I18nSnapshot {
  return snapshot;
}

export function getFormattingLocale(): string | undefined {
  return snapshot.formattingLocale;
}
