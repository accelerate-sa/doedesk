import { describe, expect, it } from "vite-plus/test";

import {
  isRtlLocale,
  localeDirection,
  nativeLanguageName,
  resolveBootLocale,
  resolveLocale,
  SYSTEM_LANGUAGE,
} from "./locales.ts";

const SUPPORTED = ["en", "ar", "de", "es", "fr", "ja", "ko", "pt-BR", "ru", "sv", "zh"];

describe("locales", () => {
  it("maps locales to layout direction", () => {
    expect(isRtlLocale("ar")).toBe(true);
    expect(isRtlLocale("ar-SA")).toBe(true);
    expect(isRtlLocale("ar_EG")).toBe(true);
    expect(isRtlLocale("he")).toBe(true);
    expect(isRtlLocale("en")).toBe(false);
    expect(isRtlLocale("pt-BR")).toBe(false);
    expect(localeDirection("ar")).toBe("rtl");
    expect(localeDirection("ar-SA")).toBe("rtl");
    expect(localeDirection("en")).toBe("ltr");
    expect(localeDirection("zh")).toBe("ltr");
  });

  it("exposes Arabic native language name", () => {
    expect(nativeLanguageName("ar")).toBe("العربية");
    expect(nativeLanguageName("en")).toBe("English");
  });

  it("resolves Arabic system tags to the ar catalog", () => {
    expect(resolveLocale(SYSTEM_LANGUAGE, ["ar-SA", "en-US"], SUPPORTED, "en")).toBe("ar");
    expect(resolveLocale("ar", ["en-US"], SUPPORTED, "en")).toBe("ar");
  });

  it("resolves boot locale from cached language, browser settings, or Arabic first-run system", () => {
    // Explicit cached language wins over system language.
    expect(
      resolveBootLocale({
        storedLanguage: "ar",
        clientSettingsJson: null,
        systemLocales: ["en-US"],
        supported: SUPPORTED,
        fallback: "en",
      }),
    ).toEqual({ locale: "ar", dir: "rtl" });

    expect(
      resolveBootLocale({
        storedLanguage: "en",
        clientSettingsJson: null,
        systemLocales: ["ar-SA"],
        supported: SUPPORTED,
        fallback: "en",
      }),
    ).toEqual({ locale: "en", dir: "ltr" });

    // System setting follows preferred system languages.
    expect(
      resolveBootLocale({
        storedLanguage: SYSTEM_LANGUAGE,
        clientSettingsJson: null,
        systemLocales: ["ar-SA", "en-US"],
        supported: SUPPORTED,
        fallback: "en",
      }),
    ).toEqual({ locale: "ar", dir: "rtl" });

    // Fresh install on an Arabic system starts in Arabic RTL.
    expect(
      resolveBootLocale({
        storedLanguage: null,
        clientSettingsJson: null,
        systemLocales: ["ar-SA"],
        supported: SUPPORTED,
        fallback: "en",
      }),
    ).toEqual({ locale: "ar", dir: "rtl" });

    // Fresh install on a non-Arabic system starts in English LTR.
    expect(
      resolveBootLocale({
        storedLanguage: null,
        clientSettingsJson: null,
        systemLocales: ["fr-FR"],
        supported: SUPPORTED,
        fallback: "en",
      }),
    ).toEqual({ locale: "en", dir: "ltr" });

    // Existing browser install with stored settings respects stored English even on Arabic OS.
    expect(
      resolveBootLocale({
        storedLanguage: null,
        clientSettingsJson: JSON.stringify({
          language: "en",
          onboardingCompletedAt: "2026-11-20T00:00:00Z",
        }),
        systemLocales: ["ar-SA"],
        supported: SUPPORTED,
        fallback: "en",
      }),
    ).toEqual({ locale: "en", dir: "ltr" });

    // Existing browser install with stored Arabic boots straight into Arabic RTL.
    expect(
      resolveBootLocale({
        storedLanguage: null,
        clientSettingsJson: JSON.stringify({
          language: "ar",
          onboardingCompletedAt: "2026-11-20T00:00:00Z",
        }),
        systemLocales: ["en-US"],
        supported: SUPPORTED,
        fallback: "en",
      }),
    ).toEqual({ locale: "ar", dir: "rtl" });

    // Malformed client settings JSON falls back safely.
    expect(
      resolveBootLocale({
        storedLanguage: null,
        clientSettingsJson: "{bad json",
        systemLocales: ["en-US"],
        supported: SUPPORTED,
        fallback: "en",
      }),
    ).toEqual({ locale: "en", dir: "ltr" });
  });
});
