import { describe, expect, it } from "vite-plus/test";

import { DOEDESK_THEME, type ThemeColorRole, type ThemeColors } from "./themePalettes.ts";

type Pair = readonly [foreground: ThemeColorRole, background: ThemeColorRole];

/** Text on the surface it is drawn on. WCAG 2.2 AA, success criterion 1.4.3: at least 4.5:1. */
const TEXT_PAIRS: ReadonlyArray<Pair> = [
  ["text", "canvas"],
  ["text", "surface"],
  ["text", "surfaceRaised"],
  ["text", "surfaceOverlay"],
  ["textMuted", "canvas"],
  ["textMuted", "surface"],
  ["toolbarForeground", "toolbar"],
  ["toolbarControlForeground", "toolbarControl"],
  ["toolbarControlForeground", "toolbarControlHover"],
  ["accentForeground", "accent"],
  ["secondaryForeground", "secondary"],
  ["mutedForeground", "muted"],
  ["mutedForeground", "canvas"],
  ["mutedForeground", "surface"],
  ["placeholder", "surface"],
  ["placeholder", "canvas"],
  ["secondaryLabel", "surface"],
  ["secondaryLabel", "canvas"],
  ["errorForeground", "errorSurface"],
  ["errorForeground", "surface"],
  ["warningForeground", "warningSurface"],
  ["warningForeground", "surface"],
  ["updateForeground", "updateSurface"],
  ["updateForeground", "surface"],
  ["accentSurfaceForeground", "accentSurface"],
  ["messageForeground", "messageSurface"],
  ["messageActionForeground", "messageAction"],
  ["messageActionForeground", "messageActionHover"],
  ["codeForeground", "codeBackground"],
  ["searchMatchForeground", "searchMatchBackground"],
  ["searchMatchActiveForeground", "searchMatchActiveBackground"],
  ["sidebarForeground", "sidebar"],
  ["sidebarForeground", "sidebarRowHover"],
  ["sidebarForeground", "sidebarRowActive"],
  ["sidebarForeground", "sidebarRowSelected"],
  ["sidebarForeground", "sidebarControlSurface"],
  ["sidebarMutedForeground", "sidebar"],
  ["sidebarMutedForeground", "sidebarRowHover"],
  ["sidebarMutedForeground", "sidebarRowSelected"],
  ["terminalForeground", "terminalBackground"],
];

/** Control boundaries, focus rings and icons. Success criterion 1.4.11: at least 3:1. */
const CONTROL_PAIRS: ReadonlyArray<Pair> = [
  ["input", "surface"],
  ["input", "canvas"],
  ["focus", "canvas"],
  ["focus", "surface"],
  ["focus", "sidebar"],
  ["accent", "canvas"],
  ["accent", "surface"],
  ["iconMuted", "canvas"],
  ["iconMuted", "surface"],
  ["error", "surface"],
  ["warning", "surface"],
  ["update", "surface"],
  ["terminalCursor", "terminalBackground"],
];

const channel = (value: number): number => {
  const unit = value / 255;
  return unit <= 0.04045 ? unit / 12.92 : ((unit + 0.055) / 1.055) ** 2.4;
};

const luminance = (hex: string): number => {
  const [red, green, blue] = [1, 3, 5].map((start) =>
    Number.parseInt(hex.slice(start, start + 2), 16),
  );
  return 0.2126 * channel(red ?? 0) + 0.7152 * channel(green ?? 0) + 0.0722 * channel(blue ?? 0);
};

const contrast = (left: string, right: string): number => {
  const [lighter, darker] = [luminance(left), luminance(right)].toSorted((a, b) => b - a);
  return ((lighter ?? 0) + 0.05) / ((darker ?? 0) + 0.05);
};

const failing = (colors: ThemeColors, pairs: ReadonlyArray<Pair>, minimum: number) =>
  pairs
    .map(([foreground, background]) => ({
      pair: `${foreground} on ${background}`,
      ratio: Math.round(contrast(colors[foreground], colors[background]) * 100) / 100,
    }))
    .filter(({ ratio }) => ratio < minimum);

describe("DoeDesk theme contrast", () => {
  const appearances = {
    light: DOEDESK_THEME.colors,
    dark: DOEDESK_THEME.variants?.dark,
  };

  const cases = Object.entries(appearances);

  it.each(cases)("%s: text meets 4.5:1 on every surface it sits on", (_appearance, colors) => {
    expect(colors).toBeDefined();
    expect(failing(colors!, TEXT_PAIRS, 4.5)).toEqual([]);
  });

  it.each(cases)(
    "%s: control boundaries, focus rings and icons meet 3:1",
    (_appearance, colors) => {
      expect(failing(colors!, CONTROL_PAIRS, 3)).toEqual([]);
    },
  );

  it("uses plain six-digit hex, which the contrast check reads", () => {
    for (const colors of Object.values(appearances)) {
      for (const value of Object.values(colors!)) expect(value).toMatch(/^#[0-9a-f]{6}$/);
    }
  });
});
