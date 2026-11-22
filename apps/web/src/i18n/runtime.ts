import {
  localeDirection,
  prefersArabicLanguage,
  resolveLocale,
} from "@t3tools/client-runtime/locales";
import { getTranslationsSnapshot } from "gt-react";

import {
  ensureClientSettingsHydrated,
  getClientSettings,
  isClientSettingsHydrated,
  subscribeClientSettings,
  updateClientSettings,
} from "../hooks/useSettings";
import { initializeI18n } from "./initializeI18n";
import { DEFAULT_LOCALE, SUPPORTED_LOCALES } from "./locales";
import { setActiveLocale } from "./messages";

/** Mirrored for the inline boot script in `index.html`, which runs before IPC hydration. */
const LANGUAGE_BOOT_STORAGE_KEY = "t3code:language";

type LocaleTranslations = Awaited<ReturnType<typeof getTranslationsSnapshot>>;

export interface I18nSnapshot {
  readonly locale: string;
  readonly translations: LocaleTranslations;
}

const loadedTranslations: LocaleTranslations = { [DEFAULT_LOCALE]: {} };
const pendingLoads = new Map<string, Promise<void>>();
const listeners = new Set<() => void>();
let snapshot: I18nSnapshot = { locale: DEFAULT_LOCALE, translations: { ...loadedTranslations } };
let requestedLocale = DEFAULT_LOCALE;

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

function resolveActiveLocale(): string {
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
    return "ar";
  }
  return resolveLocale(language, systemLanguages, SUPPORTED_LOCALES, DEFAULT_LOCALE);
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
  if (requestedLocale !== locale) return;
  applyDocumentLocale(locale);
  if (snapshot.locale === locale && snapshot.translations[locale] === loadedTranslations[locale]) {
    return;
  }
  snapshot = { locale, translations: { ...loadedTranslations } };
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
  void loadLocale(requestedLocale).then(() => activateLocale(requestedLocale));
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
      const locale = requestedLocale;
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
