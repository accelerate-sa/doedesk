import { describe, expect, it } from "vite-plus/test";

import {
  decideUsageDataBasis,
  FALLBACK_CONSENT_REGIONS,
  regionOfLocale,
} from "./UsageDataRegion.ts";

const decide = (
  input: Partial<Parameters<typeof decideUsageDataBasis>[0]>,
): ReturnType<typeof decideUsageDataBasis> =>
  decideUsageDataBasis({
    network: "notice",
    consentRegions: FALLBACK_CONSENT_REGIONS,
    locales: ["ar-SA"],
    timeZones: ["Asia/Riyadh"],
    ...input,
  });

describe("where usage data needs agreement first", () => {
  it.each([
    // [what the case is, the signals, the answer]
    ["every signal outside the list", {}, { basis: "notice", signal: "network" }],
    ["the connection is in the list", { network: "ask" }, { basis: "ask", signal: "network" }],
    ["the service could not be asked", { network: null }, { basis: "ask", signal: "network" }],
    [
      "a VPN exit outside the list, the system region inside it",
      { locales: ["de-DE"] },
      { basis: "ask", signal: "locale" },
    ],
    [
      "a VPN exit outside the list, the time zone inside it",
      { locales: ["en-US"], timeZones: ["Europe/Paris"] },
      { basis: "ask", signal: "timezone" },
    ],
    [
      "the server's own region is inside the list, the window's is not",
      { locales: ["en-US", "en_GB.UTF-8"] },
      { basis: "ask", signal: "locale" },
    ],
    ["Canada without a province", { locales: ["en-CA"] }, { basis: "ask", signal: "locale" }],
    [
      "a Canadian time zone, which names no province",
      { locales: ["en-US"], timeZones: ["America/Vancouver"] },
      { basis: "ask", signal: "timezone" },
    ],
    [
      "an older name for a time zone in the list",
      { locales: [null], timeZones: ["Asia/Calcutta"] },
      { basis: "ask", signal: "timezone" },
    ],
    [
      "a language with no region, and a time zone that names no place",
      { locales: ["ar", "C"], timeZones: ["UTC", null] },
      { basis: "notice", signal: "network" },
    ],
    [
      "the United States, which is not in the list",
      { locales: ["en-US"], timeZones: ["America/New_York"] },
      { basis: "notice", signal: "network" },
    ],
    [
      "a list from the service that adds a country this build does not know",
      { consentRegions: ["SA"] },
      { basis: "ask", signal: "locale" },
    ],
    [
      "no list from the service, so this build's copy",
      { consentRegions: null, locales: ["tr-TR"] },
      { basis: "ask", signal: "locale" },
    ],
  ] as const)("%s", (_case, signals, answer) => {
    expect(decide(signals)).toEqual(answer);
  });

  it("reads the region from the forms a system writes its locale in", () => {
    expect(regionOfLocale("en-GB")).toBe("GB");
    expect(regionOfLocale("fr_CA.UTF-8")).toBe("CA");
    expect(regionOfLocale("zh-Hant-TW")).toBe("TW");
    expect(regionOfLocale("ar")).toBeNull();
    expect(regionOfLocale("POSIX")).toBeNull();
    expect(regionOfLocale("")).toBeNull();
  });
});
