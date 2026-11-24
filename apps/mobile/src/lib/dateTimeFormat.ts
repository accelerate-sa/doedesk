import { dateTimeFormat } from "@t3tools/shared/dateTimeFormat";

import { getActiveLocale } from "../i18n/messages";

/**
 * A formatter for a date or a time as the app writes them: the device's region decides the form,
 * except that an app in Arabic writes Arabic words, ص and م, with Western digits. `locale` is the
 * region to format in otherwise; without it, the device's.
 */
export const appDateTimeFormat = (
  options: Intl.DateTimeFormatOptions,
  locale?: Intl.LocalesArgument,
): Intl.DateTimeFormat => dateTimeFormat(getActiveLocale(), locale, options);

export const formatAppDateTime = (
  date: Date | number,
  options: Intl.DateTimeFormatOptions,
  locale?: Intl.LocalesArgument,
): string => appDateTimeFormat(options, locale).format(date);
