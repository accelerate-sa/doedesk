import Constants from "expo-constants";

import type { NativeMarkdownTextStyle } from "../native/SelectableMarkdownText.types";

type ReadingFontFamilies = Pick<
  NativeMarkdownTextStyle,
  "fontFamily" | "headingFontFamily" | "boldFontFamily"
>;

/** The brand serif for long text and titles. Keep the names aligned with app.config.ts. */
export const READING_FONT_FAMILIES = {
  fontFamily: "DoeDeskSerif-Regular",
  headingFontFamily: "DoeDeskSerif-Bold",
  boldFontFamily: "DoeDeskSerif-Bold",
} as const satisfies ReadingFontFamilies;

// Thmanyah Serif is only in builds made with DOEDESK_BRAND_FONTS_DIR; others carry Noto Naskh.
const ARABIC_READING_FONT_FAMILIES: ReadingFontFamilies =
  Constants.expoConfig?.extra?.brandArabicFonts === true
    ? {
        fontFamily: "thmanyahseriftext-Regular",
        headingFontFamily: "thmanyahserifdisplay-Medium",
        boldFontFamily: "thmanyahseriftext-Bold",
      }
    : {
        fontFamily: "NotoNaskhArabic-Regular",
        headingFontFamily: "NotoNaskhArabic-Bold",
        boldFontFamily: "NotoNaskhArabic-Bold",
      };

/**
 * Native text takes one family, not a stack, so a reply that reads right to left is set whole
 * in the Arabic face (which carries Latin and figures too) with the looser leading Arabic needs.
 */
export function readingTextStyle(
  style: NativeMarkdownTextStyle,
  direction: "ltr" | "rtl" | undefined,
): NativeMarkdownTextStyle {
  if (direction !== "rtl" || style.fontFamily !== READING_FONT_FAMILIES.fontFamily) return style;
  return {
    ...style,
    ...ARABIC_READING_FONT_FAMILIES,
    lineHeight: Math.round(style.fontSize * 1.85),
  };
}
