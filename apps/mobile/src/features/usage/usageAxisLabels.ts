import { formatDayShort, formatHourShort } from "@t3tools/shared/usageFormat";

import { DEFAULT_LOCALE } from "../../i18n/locales";
import { formatAppDateTime } from "../../lib/dateTimeFormat";

const HOUR_MS = 60 * 60 * 1000;

/** Month name in the UI language; English keeps the shared formatter's output. */
export function usageAxisDayLabel(day: string, locale: string): string {
  if (locale === DEFAULT_LOCALE) return formatDayShort(day);
  const [year, month, dayOfMonth] = day.split("-").map((part) => Number(part));
  if (year === undefined || month === undefined || dayOfMonth === undefined) return day;
  return formatAppDateTime(
    Date.UTC(year, month - 1, dayOfMonth),
    { month: "short", day: "numeric", timeZone: "UTC" },
    locale,
  );
}

/** Hour in the UI language, with the zone name on a repeated fall-back hour like the shared one. */
export function usageAxisHourLabel(hourStart: string, locale: string, timeZone?: string): string {
  if (locale === DEFAULT_LOCALE) return formatHourShort(hourStart, timeZone);
  const instant = new Date(hourStart);
  if (Number.isNaN(instant.getTime())) return hourStart;
  const zone = timeZone === undefined ? {} : { timeZone };
  const wallHourFormat = new Intl.DateTimeFormat("en-CA", {
    ...zone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    hourCycle: "h23",
  });
  const wallHour = wallHourFormat.format(instant);
  const isRepeatedHour = [-HOUR_MS, HOUR_MS].some(
    (offset) => wallHourFormat.format(new Date(instant.getTime() + offset)) === wallHour,
  );
  return formatAppDateTime(
    instant,
    { ...zone, hour: "numeric", ...(isRepeatedHour ? { timeZoneName: "short" as const } : {}) },
    locale,
  );
}
