/** Arabic with Western digits: ص and م for the day's halves, 24/11/2026 for a date. */
const ARABIC = "ar-u-nu-latn";

const isArabic = (language: string | undefined): boolean =>
  language === "ar" || language?.startsWith("ar-") === true;

const formatters = new Map<string, Intl.DateTimeFormat>();
const regionHour12 = new Map<string, boolean>();

/** Whether the region `locale` names counts 12 hours. Arabic alone would always count 12. */
const hour12In = (locale: Intl.LocalesArgument): boolean => {
  const key = JSON.stringify(locale ?? null);
  let hour12 = regionHour12.get(key);
  if (hour12 === undefined) {
    hour12 = new Intl.DateTimeFormat(locale, { hour: "numeric" }).resolvedOptions().hour12 ?? false;
    regionHour12.set(key, hour12);
  }
  return hour12;
};

const showsTime = (options: Intl.DateTimeFormatOptions): boolean =>
  options.hour !== undefined || options.timeStyle !== undefined;

/**
 * A formatter for a date or a time shown by an app whose language is `appLanguage`. In Arabic it
 * writes Arabic words and day halves with Western digits, whatever region `locale` names; the
 * clock keeps that region's 12 or 24 hours unless `options` choose. Otherwise it is `locale`'s.
 */
export function dateTimeFormat(
  appLanguage: string | undefined,
  locale: Intl.LocalesArgument,
  options: Intl.DateTimeFormatOptions,
): Intl.DateTimeFormat {
  const arabic = isArabic(appLanguage);
  // The region is part of the key in Arabic too: it decides the hours.
  const key = `${arabic ? "ar" : ""}|${JSON.stringify(locale ?? null)}|${JSON.stringify(options)}`;
  let formatter = formatters.get(key);
  if (formatter === undefined) {
    formatter = arabic
      ? new Intl.DateTimeFormat(ARABIC, {
          ...options,
          ...(showsTime(options) && options.hour12 === undefined && options.hourCycle === undefined
            ? { hour12: hour12In(locale) }
            : {}),
        })
      : new Intl.DateTimeFormat(locale, options);
    formatters.set(key, formatter);
  }
  return formatter;
}
