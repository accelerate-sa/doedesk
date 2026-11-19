/**
 * Where the reading service found each word of an image.
 *
 * Contract: `POST {endpoint}/v1/ocr?layout=1` answers `{ text, pages, layout }`, with `layout` in
 * the shape below. A service that answers without `layout` cannot support redaction, and the
 * image is then not sent.
 */
export interface LayoutWord {
  readonly text: string;
  /** Four corners, x then y, clockwise from the word's own top left, in the page's unit. */
  readonly polygon: Polygon;
  /** 0 to 1: how sure the reader is of this word's text. */
  readonly confidence: number;
  /** Position of the word in the read text, in UTF-16 code units. */
  readonly offset: number;
  readonly length: number;
}

export interface LayoutLine {
  readonly polygon: Polygon;
  readonly offset: number;
  readonly length: number;
}

export interface LayoutPage {
  readonly page: number;
  readonly width: number;
  readonly height: number;
  readonly unit: string;
  readonly angle: number;
  readonly words: ReadonlyArray<LayoutWord>;
  readonly lines: ReadonlyArray<LayoutLine>;
}

export interface OcrLayout {
  readonly pages: ReadonlyArray<LayoutPage>;
  /** Stretches of the text the reader takes for handwriting. */
  readonly handwritten: ReadonlyArray<{
    readonly offset: number;
    readonly length: number;
    readonly confidence: number;
  }>;
}

/** x0, y0, x1, y1, x2, y2, x3, y3. */
export type Polygon = readonly [number, number, number, number, number, number, number, number];

export interface LayoutRead {
  readonly text: string;
  readonly pages: number;
  readonly layout: OcrLayout;
}

/** The reader answered, but not with what redaction needs. The image is withheld. */
export class LayoutUnusableError extends Error {
  override readonly name = "LayoutUnusableError";
}

const isFiniteNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const readPolygon = (value: unknown): Polygon | undefined =>
  Array.isArray(value) && value.length === 8 && value.every(isFiniteNumber)
    ? (value as unknown as Polygon)
    : undefined;

const readSpan = (
  value: Record<string, unknown>,
  textLength: number,
): { readonly offset: number; readonly length: number } | undefined => {
  const { offset, length } = value;
  if (!Number.isInteger(offset) || !Number.isInteger(length)) return undefined;
  if ((offset as number) < 0 || (length as number) <= 0) return undefined;
  if ((offset as number) + (length as number) > textLength) return undefined;
  return { offset: offset as number, length: length as number };
};

/**
 * Checks a layout against the text it came with and returns it typed. Anything that does not add
 * up is an error, never a repair: a word that is in the text but has no place, a place outside
 * the text, a word whose text is not what the text says at that position.
 */
export const parseLayout = (text: string, value: unknown): OcrLayout => {
  if (!isRecord(value) || !Array.isArray(value.pages)) {
    throw new LayoutUnusableError("The reading service gave no word positions.");
  }
  const covered = new Uint8Array(text.length);
  const pages = value.pages.map((rawPage, index): LayoutPage => {
    if (!isRecord(rawPage) || !Array.isArray(rawPage.words)) {
      throw new LayoutUnusableError("The reading service gave a page without word positions.");
    }
    if ((rawPage.unit ?? "pixel") !== "pixel") {
      throw new LayoutUnusableError("The reading service did not measure the image in pixels.");
    }
    if (!isFiniteNumber(rawPage.width) || !isFiniteNumber(rawPage.height)) {
      throw new LayoutUnusableError("The reading service did not give the page's size.");
    }
    const words = rawPage.words.map((rawWord): LayoutWord => {
      const polygon = isRecord(rawWord) ? readPolygon(rawWord.polygon) : undefined;
      const span = isRecord(rawWord) ? readSpan(rawWord, text.length) : undefined;
      if (!isRecord(rawWord) || polygon === undefined || span === undefined) {
        throw new LayoutUnusableError("The reading service gave a word without a usable position.");
      }
      if (
        typeof rawWord.text !== "string" ||
        text.substr(span.offset, span.length) !== rawWord.text
      ) {
        throw new LayoutUnusableError("The word positions do not match the text that was read.");
      }
      covered.fill(1, span.offset, span.offset + span.length);
      return {
        text: rawWord.text,
        polygon,
        confidence: isFiniteNumber(rawWord.confidence) ? rawWord.confidence : 0,
        ...span,
      };
    });
    const lines = (Array.isArray(rawPage.lines) ? rawPage.lines : []).flatMap((rawLine) => {
      const polygon = isRecord(rawLine) ? readPolygon(rawLine.polygon) : undefined;
      const span = isRecord(rawLine) ? readSpan(rawLine, text.length) : undefined;
      return polygon === undefined || span === undefined ? [] : [{ polygon, ...span }];
    });
    return {
      page: isFiniteNumber(rawPage.page) ? rawPage.page : index + 1,
      width: rawPage.width,
      height: rawPage.height,
      unit: "pixel",
      angle: isFiniteNumber(rawPage.angle) ? rawPage.angle : 0,
      words,
      lines,
    };
  });
  // Every visible character of the text must belong to a word with a place. One that does not
  // was read from somewhere in the image that cannot be covered.
  for (let index = 0; index < text.length; index += 1) {
    if (covered[index] === 0 && !/\s/u.test(text[index] ?? " ")) {
      throw new LayoutUnusableError("Some of the text that was read has no position in the image.");
    }
  }
  const handwritten = (Array.isArray(value.handwritten) ? value.handwritten : []).flatMap((raw) => {
    const span = isRecord(raw) ? readSpan(raw, text.length) : undefined;
    return span === undefined || !isRecord(raw)
      ? []
      : [{ ...span, confidence: isFiniteNumber(raw.confidence) ? raw.confidence : 0 }];
  });
  return { pages, handwritten };
};
