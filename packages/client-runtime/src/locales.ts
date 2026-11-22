export const SYSTEM_LANGUAGE = "system";

export type LayoutDirection = "ltr" | "rtl";

// Shown in their own language so a user can find theirs from any UI language.
const NATIVE_LANGUAGE_NAMES: Readonly<Record<string, string>> = {
  en: "English",
  ar: "العربية",
  de: "Deutsch",
  es: "Español",
  fr: "Français",
  ja: "日本語",
  ko: "한국어",
  "pt-BR": "Português (Brasil)",
  ru: "Русский",
  sv: "Svenska",
  zh: "中文（简体）",
};

const RTL_LANGUAGE_SUBTAGS: ReadonlySet<string> = new Set([
  "ar",
  "ckb",
  "dv",
  "fa",
  "he",
  "iw",
  "ps",
  "sd",
  "ug",
  "ur",
  "yi",
]);

export function nativeLanguageName(locale: string): string {
  return NATIVE_LANGUAGE_NAMES[locale] ?? locale;
}

export function isRtlLocale(locale: string): boolean {
  const subtag = locale.trim().toLowerCase().split(/[-_]/)[0];
  return subtag !== undefined && RTL_LANGUAGE_SUBTAGS.has(subtag);
}

export function localeDirection(locale: string): LayoutDirection {
  return isRtlLocale(locale) ? "rtl" : "ltr";
}

/** True when the host's first preferred language is Arabic. */
export function prefersArabicLanguage(languages: ReadonlyArray<string>): boolean {
  return languages[0]?.trim().toLowerCase().split(/[-_]/)[0] === "ar";
}

// Our `zh` is Simplified, so Traditional tags only match an exact locale.
const TRADITIONAL_CHINESE = /^zh[-_](hant|tw|hk|mo)\b/;

function matchSupportedLocale(tag: string, supported: ReadonlyArray<string>): string | undefined {
  const normalized = tag.trim().toLowerCase();
  const language = normalized.split(/[-_]/)[0];
  const exact = supported.find((locale) => locale.toLowerCase() === normalized);
  if (exact || TRADITIONAL_CHINESE.test(normalized)) return exact;
  return supported.find((locale) => locale.toLowerCase() === language);
}

/** Saved setting to active locale; "system" and unknown values follow the host's languages. */
export function resolveLocale(
  language: string,
  systemLocales: ReadonlyArray<string>,
  supported: ReadonlyArray<string>,
  fallback: string,
): string {
  return resolveLocaleSelection(language, systemLocales, supported, fallback).catalogLocale;
}

/** Keep the matching system tag for regional formats while loading a supported catalog. */
export function resolveLocaleSelection(
  language: string,
  systemLocales: ReadonlyArray<string>,
  supported: ReadonlyArray<string>,
  fallback: string,
): { readonly catalogLocale: string; readonly formattingLocale: string } {
  if (supported.includes(language)) return { catalogLocale: language, formattingLocale: language };
  for (const tag of systemLocales) {
    const match = matchSupportedLocale(tag, supported);
    if (match) return { catalogLocale: match, formattingLocale: tag.trim().replaceAll("_", "-") };
  }
  return { catalogLocale: fallback, formattingLocale: fallback };
}

/**
 * Resolves the initial UI language and layout direction before client settings hydrate.
 * Mirrors the inline boot script in `apps/web/index.html` so both make the exact same choice.
 */
export function resolveBootLocale(input: {
  readonly storedLanguage: string | null;
  readonly clientSettingsJson: string | null;
  readonly systemLocales: ReadonlyArray<string>;
  readonly supported: ReadonlyArray<string>;
  readonly fallback: string;
}): { readonly locale: string; readonly dir: LayoutDirection } {
  let language = input.storedLanguage?.trim() || null;
  let freshSetup = false;

  if (language === null && input.clientSettingsJson) {
    try {
      const parsed: unknown = JSON.parse(input.clientSettingsJson);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        const record = parsed as Record<string, unknown>;
        if (typeof record.language === "string" && record.language.trim().length > 0) {
          language = record.language.trim();
        }
        const progress =
          record.onboardingProgress &&
          typeof record.onboardingProgress === "object" &&
          !Array.isArray(record.onboardingProgress)
            ? (record.onboardingProgress as Record<string, unknown>)
            : null;
        if (record.onboardingCompletedAt == null && progress?.locale == null) {
          freshSetup = true;
        }
      }
    } catch {
      // Ignore malformed JSON and fall through to system language check.
    }
  } else if (language === null) {
    freshSetup = true;
  }

  const locale =
    freshSetup &&
    (language === null || language === input.fallback) &&
    input.supported.includes("ar") &&
    prefersArabicLanguage(input.systemLocales)
      ? "ar"
      : language !== null
        ? resolveLocale(language, input.systemLocales, input.supported, input.fallback)
        : input.fallback;

  return { locale, dir: localeDirection(locale) };
}
