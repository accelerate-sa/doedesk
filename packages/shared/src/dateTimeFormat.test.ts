import { describe, expect, it } from "vite-plus/test";

import { dateTimeFormat } from "./dateTimeFormat.ts";

const MORNING = Date.UTC(2026, 10, 24, 8, 5, 9);
const EVENING = Date.UTC(2026, 10, 24, 20, 5, 9);
const TIME = { hour: "numeric", minute: "2-digit", timeZone: "UTC" } as const;

describe("dateTimeFormat", () => {
  it("writes Arabic day halves with Western digits when the app is in Arabic, whatever the region", () => {
    const arabic = dateTimeFormat("ar", "en-US", TIME);
    expect(arabic.format(MORNING)).toBe("8:05 ص");
    expect(arabic.format(EVENING)).toBe("8:05 م");
    // A date, and a date with a time, in the same digits.
    expect(
      dateTimeFormat("ar", "en-US", { dateStyle: "long", timeZone: "UTC" }).format(MORNING),
    ).toBe("24 نوفمبر 2026");
    expect(
      dateTimeFormat("ar", undefined, { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" })
        .format(EVENING)
        .replace(/[‎‏]/gu, ""),
    ).toMatch(/^24\/11\/2026، 8:05 م$/u);
  });

  it("keeps the 12 or 24 hours of the region, or of the person's own choice", () => {
    // A region that counts 24 hours keeps them in Arabic.
    expect(dateTimeFormat("ar", "en-GB", TIME).format(EVENING)).toBe("20:05");
    expect(dateTimeFormat("ar", "en-GB", { ...TIME, hour12: true }).format(EVENING)).toBe("8:05 م");
    expect(dateTimeFormat("ar", "en-US", { ...TIME, hour12: false }).format(EVENING)).toBe("20:05");
  });

  it("formats as the caller's region does in any other language", () => {
    expect(dateTimeFormat("en", "en-US", TIME).format(EVENING)).toBe("8:05 PM");
    expect(dateTimeFormat("de", "de-DE", TIME).format(EVENING)).toBe("20:05");
    expect(dateTimeFormat(undefined, "en-US", TIME).format(MORNING)).toBe("8:05 AM");
  });
});
