/**
 * Whether usage data may be on by default where this installation is, or must wait for the
 * person's agreement. The rule is consent-spec section 11.3: three signals, and the stricter wins.
 */
import type { UsageDataBasis } from "@t3tools/contracts";

import { countriesOfTimeZone } from "./timeZoneCountries.ts";

/**
 * The places where usage data needs agreement first: ISO 3166-1 codes, and `CA-QC` for Quebec.
 * DoeDesk Cloud sends the list in force with its sign-in options; this copy of consent-spec 11.2
 * is used when it could not be asked.
 */
export const FALLBACK_CONSENT_REGIONS: ReadonlyArray<string> = [
  // European Union
  ..."AT BE BG HR CY CZ DK EE FI FR DE GR HU IE IT LV LT LU MT NL PL PT RO SK SI ES SE".split(" "),
  // Rest of the European Economic Area
  ..."IS LI NO".split(" "),
  // Territories with their own codes where EU law applies
  ..."AX GF GP MQ YT RE MF".split(" "),
  // United Kingdom and its related territories
  ..."GB GI JE GG IM".split(" "),
  // Consent-first laws, or regulator guidance that analytics need consent
  ..."TR RS CN KR AE OM IN VN".split(" "),
  "CA-QC",
];

/** Which signal decided: the country of the connection, the device's region, or its time zone. */
export type UsageDataSignal = "network" | "locale" | "timezone";

export interface UsageDataDecision {
  readonly basis: UsageDataBasis;
  readonly signal: UsageDataSignal;
}

/**
 * The region part of a locale: `en-GB` and `en_GB.UTF-8` give `GB`. Null when the locale names no
 * region (`ar`, `C`): a language alone says nothing about where the person is.
 */
export const regionOfLocale = (locale: string): string | null => {
  const tag = locale.split(/[.@]/)[0]?.replaceAll("_", "-") ?? "";
  try {
    const region = new Intl.Locale(tag).region;
    return region !== undefined && /^[A-Z]{2}$/.test(region) ? region : null;
  } catch {
    return null;
  }
};

/**
 * True when the country is listed, or when one of its regions is: a device reports its country
 * but not its province, and "Canada without a region" counts as Quebec.
 */
const needsAgreement = (country: string, regions: ReadonlyArray<string>): boolean =>
  regions.some((region) => region === country || region.startsWith(`${country}-`));

/**
 * `network` is DoeDesk Cloud's answer for the country of the connection: null when it could not
 * be asked or its answer was not understood, which counts as "ask". Any signal that says "ask"
 * makes the answer "ask"; only when every signal allows it is the answer "notice".
 */
export const decideUsageDataBasis = (input: {
  readonly network: UsageDataBasis | null;
  readonly consentRegions: ReadonlyArray<string> | null;
  readonly locales: ReadonlyArray<string | null | undefined>;
  readonly timeZones: ReadonlyArray<string | null | undefined>;
}): UsageDataDecision => {
  if (input.network !== "notice") return { basis: "ask", signal: "network" };
  const regions = input.consentRegions ?? FALLBACK_CONSENT_REGIONS;
  const localeRegions = input.locales.flatMap((locale) => {
    const region = typeof locale === "string" ? regionOfLocale(locale) : null;
    return region === null ? [] : [region];
  });
  if (localeRegions.some((region) => needsAgreement(region, regions))) {
    return { basis: "ask", signal: "locale" };
  }
  const zoneCountries = input.timeZones.flatMap((zone) =>
    typeof zone === "string" ? countriesOfTimeZone(zone) : [],
  );
  if (zoneCountries.some((country) => needsAgreement(country, regions))) {
    return { basis: "ask", signal: "timezone" };
  }
  return { basis: "notice", signal: "network" };
};
