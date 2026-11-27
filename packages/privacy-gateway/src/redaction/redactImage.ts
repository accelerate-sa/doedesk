import * as NodeCrypto from "node:crypto";

import { patternDetector } from "../detect.ts";
import { type EntityKind, placeholderPattern } from "../placeholders.ts";
import { type DeidentificationMode, type Pseudonymizer, REDACTED_LABEL } from "../pseudonymizer.ts";
import { normalizeForVault } from "../vault.ts";
import { type CodeInspection, type DetectedCode, detectCodes } from "./barcodes.ts";
import {
  convexHull,
  type Coverage,
  coveredShare,
  expandQuad,
  fillConvex,
  frameOf,
  insideConvex,
  makeCoverage,
  type Point,
  shareOutsideBoxes,
} from "./geometry.ts";
import { growToGaps, inkOf, type UnreadInkOptions, unreadInkRegions } from "./ink.ts";
import { drawLabel, fitLabel, type LabelPlacement } from "./label.ts";
import { LayoutUnusableError, parseLayout } from "./layout.ts";
import {
  copyRaster,
  decodeImage,
  type EncodedImage,
  encodeRaster,
  padRaster,
  paintCoverage,
  type Raster,
  resizeRaster,
  UnreadableImageError,
} from "./raster.ts";
import {
  compactOf,
  compactText,
  detectionTexts,
  type MappedText,
  pageLines,
  type PageWords,
  pageWords,
  spacedRuns,
  spreadOverRuns,
  tableRows,
  type Word,
  wordsIn,
} from "./words.ts";

/** Reads an image and says where each word is. See `layout.ts` for the contract. */
export interface LayoutReader {
  readonly readLayout: (
    bytes: Buffer,
    mediaType: string,
  ) => Promise<{ readonly text: string; readonly pages: number; readonly layout: unknown }>;
}

/**
 * The rules of redaction. Every number here was set from the measured corpus; see
 * docs/operations/image-redaction.md for the measurements behind each.
 */
export interface RedactionPolicy {
  /** The longest edge of the image the reader is given. Larger images are scaled down first. */
  readonly maxReadEdge: number;
  /** The reader refuses images smaller than this on either side; smaller ones are padded. */
  readonly minReadEdge: number;
  /** The longest edge and the pixel count of the image that is sent. */
  readonly maxOutputEdge: number;
  readonly maxOutputPixels: number;
  /**
   * A word the reader is less sure of than this is covered whatever it says. The reader's text
   * for it cannot be trusted, so neither can the detector's verdict on that text.
   */
  readonly minConfidence: number;
  /** The same, for words the reader takes for handwriting. */
  readonly minHandwritingConfidence: number;
  /**
   * Writing lower than this many pixels in the picture the reader saw is covered whatever it
   * says: the reader's own documentation puts its limit near here, and below it the reader
   * returns confident misreadings ("Falsal Al-Harbl") that no detector knows for a name.
   */
  readonly minWordHeight: number;
  /**
   * How many times a small picture may be enlarged for the reader. 1: not at all. Measured at 2,
   * the reader read 8 px print no better and 10 px print with less confidence, and took twice
   * as long.
   */
  readonly maxReadEnlargement: number;
  readonly maxReadPixels: number;
  /**
   * Padding of a box beyond the reader's own outline of the word: a share of the line's height
   * plus a fixed number of pixels, along the text and across it. Across is the larger: marks
   * above and below the letters are what a reader's outline cuts. Along the text a wide pad
   * covers the neighbouring word's first letter, which helps nobody.
   */
  readonly padAlong: number;
  readonly padAcross: number;
  readonly padAlongPixels: number;
  readonly padAcrossPixels: number;
  /** How far a box may grow along its text to reach clear paper, as a share of the line's height. */
  readonly maxGrowth: number;
  /** The smallest and largest label size, in output pixels per dot of the 5 by 7 face. */
  readonly minLabelScale: number;
  readonly maxLabelScale: number;
  /** A box turned further than this from level gets an upright number instead of its token. */
  readonly maxLabelAngle: number;
  /** Times the image may be redacted before it is given up on. Each is followed by a re-read. */
  readonly maxRounds: number;
  /** Above this size as PNG the image is sent as JPEG. */
  readonly maxPngBytes: number;
  /** Covers text-like marks the reader returned no word for. */
  readonly coverUnreadInk: boolean;
  readonly ink: UnreadInkOptions;
  /**
   * Which QR codes and barcodes are covered. `identifying`: those whose payload names someone
   * or leads to a record of them (see `barcodes.ts`). `all`: every code that decodes. `off`:
   * codes are not looked for.
   */
  readonly codes: "identifying" | "all" | "off";
  /**
   * Reads the redacted picture again and covers what is still legible. Always on for a picture
   * that is sent without a person seeing it. Off, the reader is asked once a picture: for a
   * caller whose result a person reviews before it goes anywhere.
   */
  readonly verify: boolean;
}

export const DEFAULT_REDACTION_POLICY: RedactionPolicy = {
  maxReadEdge: 4000,
  minReadEdge: 50,
  maxOutputEdge: 1568,
  maxOutputPixels: 1_150_000,
  minConfidence: 0.6,
  minHandwritingConfidence: 0.6,
  minWordHeight: 14,
  maxReadEnlargement: 1,
  maxReadPixels: 12_000_000,
  padAlong: 0.06,
  padAcross: 0.25,
  padAlongPixels: 1,
  padAcrossPixels: 2,
  maxGrowth: 0.8,
  minLabelScale: 2,
  maxLabelScale: 4,
  maxLabelAngle: 30,
  maxRounds: 2,
  maxPngBytes: 3_500_000,
  coverUnreadInk: true,
  ink: { minCluster: 4 },
  codes: "identifying",
  verify: true,
};

/** The label of a box over text that could not be read. Never derived from the text. */
export const UNREADABLE_LABEL = "[UNREADABLE]";
const UNREADABLE_MARK = "?";

export interface RedactionStats {
  /** Words the reader found in the image. */
  readonly words: number;
  /** Boxes over detected or known values. */
  readonly valueBoxes: number;
  /** Boxes over words the reader was unsure of. */
  readonly unreadableBoxes: number;
  /** Boxes over text-like marks the reader returned no word for. */
  readonly unreadInkBoxes: number;
  /** Boxes over QR codes and barcodes. */
  readonly codeBoxes: number;
  /** Distinct stand-ins on the image. */
  readonly tokens: number;
  /** Times the image was redacted: 1 when the first re-read was clean. */
  readonly rounds: number;
  /** Calls to the reading service, cached ones included. */
  readonly reads: number;
  /** Share of the image that is covered. */
  readonly coveredShare: number;
  readonly milliseconds: number;
}

/**
 * One thing found in an image: a value, a stretch that could not be read, a QR code. Where it
 * is and what it is, for a caller that lets a person choose what happens to each.
 */
export interface RedactedRegion {
  readonly source: "value" | "unreadable" | "ink" | "code";
  /** Its outline in the pixels of the image that was returned. */
  readonly polygon: ReadonlyArray<Point>;
  readonly kind: EntityKind;
  /** False only for a code that decoded and was left open: it holds nothing personal. */
  readonly covered: boolean;
  /** The stand-in on the box, when the value was masked. */
  readonly token?: string | undefined;
  /** The value as it was read. A real value: for this computer only, never for a request. */
  readonly surface?: string | undefined;
  readonly code?: { readonly format: string; readonly inspection: CodeInspection } | undefined;
}

export type RedactionResult =
  | {
      readonly kind: "redacted";
      readonly image: EncodedImage;
      readonly width: number;
      readonly height: number;
      /** What the model is told about the boxes. Empty when there is nothing to say. */
      readonly legend: string;
      /** The image's text with every covered word replaced by what its box says. */
      readonly maskedText: string;
      readonly stats: RedactionStats;
      /** The pixels that were painted, for measurement. */
      readonly coverage: Coverage;
      /** Everything that was found, covered or not, in the returned image's pixels. */
      readonly regions: ReadonlyArray<RedactedRegion>;
    }
  | {
      readonly kind: "withheld";
      /** Written for the user and safe to send: it never quotes the image. */
      readonly reason: string;
      /**
       * The image's text as the reader gave it, when it was read before redaction failed. It is
       * unmasked: the caller masks it as it masks any text, and must never send it as it is.
       */
      readonly readText?: string | undefined;
    };

export interface ImageRedactor {
  /**
   * `mode` is `mask` unless said otherwise. In `redact` every box says `[REDACTED]`, no
   * stand-in is made, and nothing is written to the vault.
   */
  readonly redact: (
    bytes: Buffer,
    neverMask?: ReadonlyArray<string>,
    mode?: DeidentificationMode,
  ) => Promise<RedactionResult>;
}

export interface ImageRedactorOptions {
  readonly reader: LayoutReader;
  readonly pseudonymizer: Pseudonymizer;
  readonly policy?: Partial<RedactionPolicy> | undefined;
  /** Told about every image that was redacted or withheld, with the bytes it came from. */
  readonly onResult?: ((original: Buffer, result: RedactionResult) => void) | undefined;
  /**
   * Measurement only: told what each re-read found still legible. The words are real values, so
   * nothing in the app passes this.
   */
  readonly onRound?: ((round: RedactionRound) => void) | undefined;
}

export interface RedactionRound {
  readonly round: number;
  readonly image: EncodedImage;
  readonly found: ReadonlyArray<{
    readonly text: string;
    readonly confidence: number;
    readonly covered: number;
    readonly mark: string;
  }>;
}

/** A value that is hidden: what it is and how it was read. */
interface ValueMark {
  readonly kind: EntityKind;
  readonly surface: string;
}

/**
 * What a box hides: a value with its token, a value that is redacted for good (told from
 * another by `redacted`, which is never shown), or text that could not be read.
 */
type Mark =
  | (ValueMark & { readonly token: string })
  | (ValueMark & { readonly redacted: string })
  | { readonly unreadable: true };

interface Box {
  readonly mark: Mark;
  readonly hull: ReadonlyArray<Point>;
  /** The direction the covered text runs in. */
  readonly along: Point;
  readonly source: RedactedRegion["source"];
  readonly code?: DetectedCode | undefined;
}

const sameMark = (left: Mark | undefined, right: Mark | undefined): boolean => {
  if (left === undefined || right === undefined) return false;
  if ("token" in left) return "token" in right && left.token === right.token;
  if ("redacted" in left) return "redacted" in right && left.redacted === right.redacted;
  return "unreadable" in right;
};

const isValue = (mark: Mark): mark is Exclude<Mark, { readonly unreadable: true }> =>
  !("unreadable" in mark);

/** What tells one mark from another: its stand-in, or the value it redacts. Never shown. */
const identityOf = (mark: Mark): string =>
  "token" in mark ? mark.token : "redacted" in mark ? `!${mark.redacted}` : "?";

/** What a box says to whoever reads the image. */
const shownAs = (mark: Mark): string =>
  "token" in mark ? mark.token : "redacted" in mark ? REDACTED_LABEL : UNREADABLE_LABEL;

const MIN_COMPACT_LENGTH = 8;
/** A re-read word this much inside words already judged tells nothing new. */
const JUDGED_SHARE = 0.7;

/** Why an image was not sent. The words are the user's; no cause is ever quoted from the file. */
const reasonOf = (cause: unknown): string => {
  if (cause instanceof UnreadableImageError || cause instanceof LayoutUnusableError) {
    return cause.message;
  }
  if (cause instanceof Error && cause.name === "DetectorUnavailableError") return cause.message;
  if (cause instanceof Error && cause.name === "TimeoutError") {
    return "The reading service took too long.";
  }
  return cause instanceof Error && cause.message.length > 0 && cause.message.length < 200
    ? cause.message
    : "The image could not be read.";
};

class Redaction {
  readonly #options: ImageRedactorOptions;
  readonly #policy: RedactionPolicy;
  readonly #neverMask: ReadonlyArray<string>;
  readonly #mode: DeidentificationMode;
  reads = 0;
  /** The text of the first reading: the image's own text, before any box. */
  firstText: string | undefined;

  constructor(
    options: ImageRedactorOptions,
    policy: RedactionPolicy,
    neverMask: ReadonlyArray<string>,
    mode: DeidentificationMode,
  ) {
    this.#options = options;
    this.#policy = policy;
    this.#neverMask = neverMask;
    this.#mode = mode;
  }

  /**
   * The mark for a value. Masked, it carries the value's stand-in, made here if the vault has
   * none. Redacted, no stand-in is made or looked up: the vault is not written to.
   */
  valueMark(kind: EntityKind, surface: string, token?: string): Mark {
    if (this.#mode === "redact") {
      return { redacted: `${kind}:${normalizeForVault(surface)}`, kind, surface };
    }
    return {
      token: token ?? this.#options.pseudonymizer.vault.tokenFor(kind, surface),
      kind,
      surface,
    };
  }

  /** Reads a picture, given as the bytes it would be sent as and its size in pixels. */
  async read(image: EncodedImage, width: number, height: number): Promise<PageWords> {
    this.reads += 1;
    const answer = await this.#options.reader.readLayout(image.bytes, image.mediaType);
    if (typeof answer.text !== "string") {
      throw new LayoutUnusableError("The reading service gave no text.");
    }
    this.firstText ??= answer.text;
    const page = pageWords({
      text: answer.text,
      pages: answer.pages,
      layout: parseLayout(answer.text, answer.layout),
    });
    // Positions are only meaningful in the picture that was sent for reading.
    if (Math.abs(page.width - width) > 1 || Math.abs(page.height - height) > 1) {
      throw new LayoutUnusableError("The reading service measured a different picture.");
    }
    return page;
  }

  /**
   * The words of a page that must be covered, each with what its box will say. `textOf` gives
   * the text a word counts as: on a re-read, the part of a word that is not one of our labels.
   */
  async marks(
    page: PageWords,
    visible: (word: Word) => boolean,
    textOf: (word: Word) => string,
    /** False on a re-read: with the values boxed, what is left of a row is not label and value. */
    asForm = true,
  ): Promise<Map<number, Mark>> {
    const policy = this.#policy;
    const { pseudonymizer } = this.#options;
    const seen: PageWords = {
      ...page,
      lines: page.lines
        .map((line) => line.filter((index) => visible(page.words[index] as Word)))
        .filter((line) => line.length > 0),
    };
    const marks = new Map<number, Mark>();
    const texts = detectionTexts(seen, textOf);
    const read = texts.map((mapped) => mapped.text);
    const located: ReadonlyArray<
      ReadonlyArray<{
        readonly start: number;
        readonly end: number;
        readonly kind: EntityKind;
        readonly token?: string;
      }>
    > =
      this.#mode === "redact"
        ? await pseudonymizer.find(read, this.#neverMask)
        : await pseudonymizer.locate(read, this.#neverMask);
    // The same words are often found more than once: whole in a rewritten line and in pieces in
    // the page as read, or the other way round. A word shows the stand-in of the value written
    // in a known format (a whole IBAN, a phone number in order), then of the longest, then of
    // the rewritten line, which exists because the page as read has that line wrong.
    const candidates: Array<{
      words: ReadonlyArray<number>;
      kind: EntityKind;
      token: string | undefined;
      surface: string;
      rewritten: boolean;
    }> = [];
    const consider = (mapped: MappedText, spans: (typeof located)[number], rewritten: boolean) => {
      for (const span of spans) {
        candidates.push({
          words: wordsIn(mapped, span.start, span.end),
          kind: span.kind,
          token: span.token,
          surface: mapped.text.slice(span.start, span.end),
          rewritten,
        });
      }
    };
    texts.forEach((mapped, index) => consider(mapped, located[index] ?? [], index > 1));
    // The page as rows of a form, for the local rules alone: a label names the value in the
    // cell beside it. Found without a stand-in; one is made only for a value that is covered.
    const rows = asForm ? tableRows(seen, textOf) : undefined;
    if (rows !== undefined && rows.text.trim().length > 0) {
      const [inRows = []] = await pseudonymizer.find([rows.text], this.#neverMask, patternDetector);
      consider(rows, inRows, true);
    }
    const formats = await patternDetector.detect(candidates.map((candidate) => candidate.surface));
    const wellFormed = candidates.map((candidate, index) =>
      (formats[index] ?? []).some(
        (found) => found.start === 0 && found.end === candidate.surface.length,
      ),
    );
    const order = candidates
      .map((_, index) => index)
      .toSorted(
        (left, right) =>
          Number(wellFormed[right]) - Number(wellFormed[left]) ||
          (candidates[right]?.words.length ?? 0) - (candidates[left]?.words.length ?? 0) ||
          Number(candidates[right]?.rewritten) - Number(candidates[left]?.rewritten) ||
          left - right,
      );
    for (const index of order) {
      const candidate = candidates[index];
      if (candidate === undefined) continue;
      const open = candidate.words.filter((word) => !marks.has(word));
      if (open.length === 0) continue;
      const mark = this.valueMark(candidate.kind, candidate.surface, candidate.token);
      for (const word of open) marks.set(word, mark);
    }
    // Identifiers the vault knows, however the image spaces or groups them.
    this.#knownCompact(texts, marks);
    for (const line of seen.lines) {
      for (const index of line) {
        const word = page.words[index] as Word;
        const floor = word.handwritten ? policy.minHandwritingConfidence : policy.minConfidence;
        const tooSmall = word.frame.height < policy.minWordHeight;
        if (!marks.has(index) && (word.confidence < floor || tooSmall)) {
          marks.set(index, { unreadable: true });
        }
      }
    }
    spreadOverRuns(spacedRuns(seen, textOf), marks, isValue);
    // A piece with digits in it right beside a covered number is the rest of that number: the
    // "SA78" a detector left off an account it otherwise found, the last group of a card.
    const hasDigit = (index: number | undefined): boolean =>
      index !== undefined && /\p{Nd}/u.test(textOf(page.words[index] as Word));
    for (const line of seen.lines) {
      for (let changed = true; changed;) {
        changed = false;
        line.forEach((index, position) => {
          if (marks.has(index) || !hasDigit(index)) return;
          for (const beside of [line[position - 1], line[position + 1]]) {
            const mark = beside === undefined ? undefined : marks.get(beside);
            if (mark !== undefined && hasDigit(beside)) {
              marks.set(index, mark);
              changed = true;
              return;
            }
          }
        });
      }
    }
    // A sign standing alone beside a covered value belongs to it: the plus the reader set apart
    // from a phone number, a bracket, a dash between two covered parts.
    for (const line of seen.lines) {
      line.forEach((index, position) => {
        if (marks.has(index) || /[\p{L}\p{N}]/u.test(textOf(page.words[index] as Word))) return;
        const neighbour =
          marks.get(line[position + 1] ?? -1) ?? marks.get(line[position - 1] ?? -1);
        if (neighbour !== undefined) marks.set(index, neighbour);
      });
    }
    return marks;
  }

  #knownCompact(texts: ReadonlyArray<MappedText>, marks: Map<number, Mark>): void {
    const entries = this.#options.pseudonymizer.vault
      .entries()
      .flatMap((entry) =>
        entry.surfaces.map((surface) => ({
          mark: this.valueMark(entry.kind, entry.value, entry.token),
          compact: compactOf(surface),
        })),
      )
      .filter((entry) => entry.compact.length >= MIN_COMPACT_LENGTH && /\d{4}/.test(entry.compact));
    if (entries.length === 0) return;
    for (const mapped of texts) {
      const compact = compactText(mapped);
      for (const entry of entries) {
        let from = compact.text.indexOf(entry.compact);
        while (from !== -1) {
          for (const word of wordsIn(compact, from, from + entry.compact.length)) {
            if (!marks.has(word)) marks.set(word, entry.mark);
          }
          from = compact.text.indexOf(entry.compact, from + 1);
        }
      }
    }
  }

  /** One box for each run of marked words that stand together on a line with the same mark. */
  boxes(
    page: PageWords,
    marks: ReadonlyMap<number, Mark>,
    scaleX: number,
    scaleY: number,
    widen: number,
    /** The picture's marks, to grow each box to the gaps around its text. */
    ink?: Coverage,
  ): ReadonlyArray<Box> {
    const policy = this.#policy;
    const boxes: Array<Box> = [];
    const scaled = (word: Word) =>
      word.quad.map((point) => ({ x: point.x * scaleX, y: point.y * scaleY }));
    for (const line of page.lines) {
      const tallest = Math.max(
        ...line.map((index) => frameOf(scaled(page.words[index] as Word)).height),
      );
      let run: Array<Word> = [];
      const flush = () => {
        const first = run[0];
        if (first === undefined) return;
        const points = run.flatMap((word) => {
          const quad = scaled(word);
          const frame = frameOf(quad);
          // The reader boxes a word by its own letters. Its neighbours on the line may reach
          // higher or lower (a diacritic, a descender), and so may it where the reader cut
          // close, so the box is at least as tall as the line's tallest word.
          const reference = Math.max(frame.height, tallest);
          return expandQuad(
            quad,
            frame,
            (policy.padAlong * reference + policy.padAlongPixels) * widen,
            (reference - frame.height) / 2 +
              (policy.padAcross * reference + policy.padAcrossPixels) * widen,
          );
        });
        const along = frameOf(scaled(first)).along;
        const hull = convexHull(points);
        const mark = marks.get(first.index) as Mark;
        boxes.push({
          mark,
          hull:
            ink === undefined
              ? hull
              : convexHull(growToGaps(hull, along, ink, policy.maxGrowth * tallest)),
          along,
          source: isValue(mark) ? "value" : "unreadable",
        });
        run = [];
      };
      for (const index of line) {
        const mark = marks.get(index);
        const previous = run.at(-1);
        if (mark === undefined) {
          flush();
          continue;
        }
        if (previous !== undefined && !sameMark(marks.get(previous.index), mark)) flush();
        run.push(page.words[index] as Word);
      }
      flush();
    }
    return boxes;
  }
}

/** Numbers for the tokens that could not be written out in their box, in order of appearance. */
class Legend {
  readonly #numbers = new Map<string, number>();
  readonly #unlabelled = new Set<string>();
  readonly #written = new Set<string>();
  unreadable = 0;
  redacted = 0;
  codes = 0;
  boxes = 0;

  /** A stand-in that was written out in full on a box. */
  written(token: string): void {
    this.#written.add(token);
  }

  has(token: string): boolean {
    return this.#numbers.has(token);
  }

  numberFor(token: string): number {
    const existing = this.#numbers.get(token);
    if (existing !== undefined) return existing;
    const next = this.#numbers.size + 1;
    this.#numbers.set(token, next);
    return next;
  }

  /** Forgets the newest number, reserved for a box it then did not fit in. */
  drop(token: string): void {
    this.#numbers.delete(token);
  }

  unlabelled(token: string): void {
    this.#unlabelled.add(token);
  }

  text(frames: number): string {
    const lines: Array<string> = [];
    if (this.boxes > 0) {
      lines.push(
        "Image redacted by DoeDesk before it was sent. Each black box hides personal data and " +
          "shows the stand-in for it; a value that wraps onto another line shows the same " +
          "stand-in on each part. Refer to a hidden value by its stand-in, exactly as written.",
      );
    }
    // Every label is also given here as text: letters drawn in dots are sometimes misread.
    if (this.#written.size > 0) {
      lines.push(`Stand-ins written on boxes: ${[...this.#written].join(", ")}.`);
    }
    const numbered = [...this.#numbers].map(([token, number]) => `${number} = ${token}`);
    if (numbered.length > 0) lines.push(`Numbered boxes: ${numbered.join("; ")}.`);
    if (this.#unlabelled.size > 0) {
      lines.push(`Boxes too small to label hide: ${[...this.#unlabelled].join(", ")}.`);
    }
    if (this.redacted > 0) {
      lines.push(
        `Boxes marked ${REDACTED_LABEL}, and plain black boxes, hide personal data that was ` +
          "removed for good. It has no stand-in and cannot be given back.",
      );
    }
    if (this.codes > 0) {
      lines.push(
        "A box over a QR code or barcode hides what the code held: personal data, or a link " +
          "that opens the document.",
      );
    }
    if (this.unreadable > 0) {
      lines.push(
        `Boxes marked ${UNREADABLE_MARK} or ${UNREADABLE_LABEL} hide text or marks DoeDesk ` +
          "could not read reliably. They are hidden as a precaution and have no stand-in.",
      );
    }
    if (frames > 1) lines.push(`Only the first of ${frames} frames or pages was sent.`);
    return lines.length === 0 ? "" : `[${lines.join("\n")}]`;
  }
}

const upright = (along: Point): Point => (along.x < 0 ? { x: -along.x, y: -along.y } : along);

const angleOf = (along: Point): number => Math.abs((Math.atan2(along.y, along.x) * 180) / Math.PI);

const boundsOf = (points: ReadonlyArray<Point>) => ({
  left: Math.min(...points.map((point) => point.x)),
  right: Math.max(...points.map((point) => point.x)),
  top: Math.min(...points.map((point) => point.y)),
  bottom: Math.max(...points.map((point) => point.y)),
});

/** True when two words, each given by its corners, lie over each other. */
const overlapping = (a: ReadonlyArray<Point>, b: ReadonlyArray<Point>): boolean => {
  const left = boundsOf(a);
  const right = boundsOf(b);
  const width = Math.min(left.right, right.right) - Math.max(left.left, right.left);
  const height = Math.min(left.bottom, right.bottom) - Math.max(left.top, right.top);
  if (width <= 0 || height <= 0) return false;
  const smaller = Math.min(
    (left.right - left.left) * (left.bottom - left.top),
    (right.right - right.left) * (right.bottom - right.top),
  );
  return width * height >= 0.2 * Math.max(1, smaller);
};

/** What the vault and the detector say of a page, as one string: equal strings, equal boxes. */
const signatureOf = (marks: ReadonlyMap<number, Mark>): string =>
  [...marks]
    .toSorted(([left], [right]) => left - right)
    .map(([word, mark]) => `${word}:${identityOf(mark)}`)
    .join(",");

const centreOf = (quad: ReadonlyArray<Point>): Point => ({
  x: quad.reduce((sum, point) => sum + point.x, 0) / Math.max(1, quad.length),
  y: quad.reduce((sum, point) => sum + point.y, 0) / Math.max(1, quad.length),
});

/**
 * Drops the marks of "words" that lie in a decoded code. A reader takes a code's modules for
 * small unsure writing; the code's own box, or its being left open, is what decides there.
 */
const unmarkCodes = (
  page: PageWords,
  marks: Map<number, Mark>,
  codes: ReadonlyArray<ReadonlyArray<Point>>,
): void => {
  if (codes.length === 0) return;
  for (const index of Array.from(marks.keys())) {
    const centre = centreOf((page.words[index] as Word).quad);
    if (codes.some((hull) => insideConvex(hull, centre))) marks.delete(index);
  }
};

const scaledPoints = (
  points: ReadonlyArray<Point>,
  scaleX: number,
  scaleY: number,
): ReadonlyArray<Point> => points.map((point) => ({ x: point.x * scaleX, y: point.y * scaleY }));

/** A box to paint on a picture, its corners given as shares of the picture's width and height. */
export interface PaintRegion {
  readonly polygon: ReadonlyArray<Point>;
  /** What the box says: a stand-in, or `[REDACTED]`. Left out, or too long to fit: plain black. */
  readonly label?: string | undefined;
}

/**
 * Paints solid black boxes on a copy of a picture, each with its label where it fits. For a
 * caller that has decided, region by region, what is hidden: nothing is read and nothing is
 * looked for here.
 */
export const paintRegions = (
  raster: Raster,
  regions: ReadonlyArray<PaintRegion>,
  policy: Pick<RedactionPolicy, "minLabelScale" | "maxLabelScale"> = DEFAULT_REDACTION_POLICY,
): { readonly raster: Raster; readonly coverage: Coverage } => {
  const painted = copyRaster(raster);
  const coverage = makeCoverage(raster.width, raster.height);
  const hulls = regions.map((region) =>
    convexHull(scaledPoints(region.polygon, raster.width, raster.height)),
  );
  for (const hull of hulls) fillConvex(coverage, hull);
  paintCoverage(painted, coverage);
  regions.forEach((region, index) => {
    if (region.label === undefined) return;
    // A page is larger than a picture sent to a model: the label may grow with its box.
    const placement = fitLabel(
      hulls[index] ?? [],
      { x: 1, y: 0 },
      region.label,
      policy.minLabelScale,
      Math.max(policy.maxLabelScale, raster.height / 500),
    );
    if (placement !== undefined) drawLabel(painted, coverage, placement);
  });
  return { raster: painted, coverage };
};

interface Kept {
  readonly page: PageWords;
  /** Where the page's decoded codes are, in the pixels the reader saw. */
  readonly codes: ReadonlyArray<ReadonlyArray<Point>>;
  readonly signature: string;
  readonly result: RedactionResult;
}

export const makeImageRedactor = (options: ImageRedactorOptions): ImageRedactor => {
  const policy: RedactionPolicy = { ...DEFAULT_REDACTION_POLICY, ...options.policy };

  const fit = (box: Box, direction: Point, text: string) =>
    fitLabel(box.hull, direction, text, policy.minLabelScale, policy.maxLabelScale);

  const label = (box: Box, legend: Legend): LabelPlacement | undefined => {
    legend.boxes += 1;
    const along = upright(box.along);
    const level = angleOf(along) <= policy.maxLabelAngle;
    const direction = level ? along : { x: 1, y: 0 };
    if (box.source === "code") legend.codes += 1;
    if ("unreadable" in box.mark) {
      legend.unreadable += 1;
      return (
        (level ? fit(box, direction, UNREADABLE_LABEL) : undefined) ??
        fit(box, direction, UNREADABLE_MARK)
      );
    }
    if ("redacted" in box.mark) {
      legend.redacted += 1;
      // Too small for the word, it is a plain black box: the legend says what those are.
      return level ? fit(box, direction, REDACTED_LABEL) : undefined;
    }
    const { token } = box.mark;
    const whole = level ? fit(box, direction, token) : undefined;
    if (whole !== undefined) {
      legend.written(token);
      return whole;
    }
    const known = legend.has(token);
    const numbered = fit(box, direction, String(legend.numberFor(token)));
    if (numbered === undefined) {
      if (!known) legend.drop(token);
      legend.unlabelled(token);
    }
    return numbered;
  };

  const run = async (
    bytes: Buffer,
    neverMask: ReadonlyArray<string>,
    mode: DeidentificationMode,
  ): Promise<{ readonly kept?: Kept; readonly result: RedactionResult }> => {
    const work = new Redaction(options, policy, neverMask, mode);
    try {
      return await attempt(bytes, work);
    } catch (cause) {
      // Whatever went wrong, the image is not sent. If it was read first, its text is passed on.
      return { result: { kind: "withheld", reason: reasonOf(cause), readText: work.firstText } };
    }
  };

  const attempt = async (
    bytes: Buffer,
    work: Redaction,
  ): Promise<{ readonly kept?: Kept; readonly result: RedactionResult }> => {
    const started = performance.now();
    const decoded = await decodeImage(bytes);
    // The reader refuses very small pictures, so a small one sits on a white canvas throughout.
    const original = padRaster(decoded.raster, policy.minReadEdge, policy.minReadEdge);

    // The picture the reader sees: the whole image, enlarged when it is small enough to be, and
    // scaled down only when it is very large.
    const readScale = Math.min(
      policy.maxReadEnlargement,
      policy.maxReadEdge / Math.max(original.width, original.height),
      Math.sqrt(policy.maxReadPixels / (original.width * original.height)),
    );
    const readRaster = await resizeRaster(
      original,
      Math.max(policy.minReadEdge, Math.round(original.width * readScale)),
      Math.max(policy.minReadEdge, Math.round(original.height * readScale)),
    );
    const page = await work.read(
      await encodeRaster(readRaster, 8_000_000),
      readRaster.width,
      readRaster.height,
    );

    // The picture the model gets. Positions found in the first are scaled into the second.
    const outScale = Math.min(
      1,
      policy.maxOutputEdge / Math.max(original.width, original.height),
      Math.sqrt(policy.maxOutputPixels / (original.width * original.height)),
    );
    const clean = await resizeRaster(
      original,
      Math.max(policy.minReadEdge, Math.floor(original.width * outScale)),
      Math.max(policy.minReadEdge, Math.floor(original.height * outScale)),
    );
    const scaleX = clean.width / readRaster.width;
    const scaleY = clean.height / readRaster.height;

    // Codes are decoded from the picture as it came: a code scaled down may no longer decode.
    const codes = policy.codes === "off" ? [] : await detectCodes(original);
    const toClean = (code: DetectedCode): ReadonlyArray<Point> =>
      convexHull(
        scaledPoints(code.polygon, clean.width / original.width, clean.height / original.height),
      );
    const codeHulls = codes.map(toClean);
    const isCovered = (code: DetectedCode): boolean =>
      policy.codes === "all" || code.inspection.identifying;
    const codeBoxes = codes.flatMap((code, index): ReadonlyArray<Box> =>
      isCovered(code)
        ? [
            {
              mark: work.valueMark(code.inspection.kind, code.text),
              hull: codeHulls[index] ?? [],
              along: { x: 1, y: 0 },
              source: "code",
              code,
            },
          ]
        : [],
    );

    const marks = await work.marks(
      page,
      () => true,
      (word) => word.text,
    );
    const codesAsRead = codes.map((code) =>
      convexHull(
        scaledPoints(
          code.polygon,
          readRaster.width / original.width,
          readRaster.height / original.height,
        ),
      ),
    );
    unmarkCodes(page, marks, codesAsRead);
    const signature = signatureOf(marks);

    const ink = inkOf(clean);
    let inkBoxes: ReadonlyArray<Box> = [];
    if (policy.coverUnreadInk) {
      const accounted = makeCoverage(clean.width, clean.height);
      const everyWord = new Map(
        page.words.map((word) => [word.index, { unreadable: true } as Mark]),
      );
      for (const box of work.boxes(page, everyWord, scaleX, scaleY, 1)) {
        fillConvex(accounted, box.hull);
      }
      // A code that decoded is accounted for: covered by its own box, or known to be harmless.
      for (const hull of codeHulls) fillConvex(accounted, hull);
      inkBoxes = unreadInkRegions(clean, ink, accounted, policy.ink).map((hull): Box => ({
        mark: { unreadable: true },
        hull,
        along: { x: 1, y: 0 },
        source: "ink",
      }));
    }

    /** Boxes found by a re-read, in the picture that is sent. */
    const lateBoxes: Array<Box> = [];
    let widen = 1;
    /** The picture about to be drawn is one already read, with boxes added: it needs no reading. */
    let settled = !policy.verify;
    for (let round = 1; ; round += 1) {
      const wordBoxes = work.boxes(page, marks, scaleX, scaleY, widen, ink);
      const boxes = [...wordBoxes, ...codeBoxes, ...inkBoxes, ...lateBoxes];
      const coverage = makeCoverage(clean.width, clean.height);
      for (const box of boxes) fillConvex(coverage, box.hull);
      const raster = copyRaster(clean);
      paintCoverage(raster, coverage);
      const legend = new Legend();
      for (const box of boxes) {
        const placement = label(box, legend);
        if (placement !== undefined) drawLabel(raster, coverage, placement);
      }
      const image = await encodeRaster(raster, policy.maxPngBytes);

      // Read exactly what would be sent. Nothing that should be hidden may be legible in it.
      let found = new Map<number, Mark>();
      let check: PageWords | undefined;
      let fresh = 0;
      if (!settled) {
        const reread = await work.read(image, raster.width, raster.height);
        check = reread;
        const shares = new Map<number, number>();
        const shareOf = (word: Word) => {
          let share = shares.get(word.index);
          if (share === undefined) {
            share = coveredShare(coverage, convexHull(word.quad));
            shares.set(word.index, share);
          }
          return share;
        };
        // A word that lies in a box is one of our labels. A word partly in a box is a label run
        // together with something beside it: the label is taken off and the rest is judged.
        const withoutLabels = (text: string): string =>
          text
            .replace(placeholderPattern(), " ")
            .replaceAll(UNREADABLE_LABEL, " ")
            .replace(/[[\]_?]/g, " ")
            .trim();
        const textOf = (word: Word): string =>
          shareOf(word) > 0.1 ? withoutLabels(word.text) : word.text;
        const visible = (word: Word): boolean =>
          shareOf(word) < 0.9 && /[\p{L}\p{N}]/u.test(textOf(word));
        found = await work.marks(reread, visible, textOf, false);
        unmarkCodes(reread, found, codeHulls);
        // Words the first reading read with confidence and the detector passed were judged then.
        // Beside a box and at the sent size they come back unsure or misspelt: that is not
        // news, and is dropped. A value the detector now finds in one of them is a second
        // opinion: it is covered, but it shows nothing the first reading did not account for.
        const judged = makeCoverage(clean.width, clean.height);
        for (const earlier of page.words) {
          if (marks.has(earlier.index)) continue;
          const quad = earlier.quad.map((point) => ({ x: point.x * scaleX, y: point.y * scaleY }));
          fillConvex(judged, convexHull(expandQuad(quad, frameOf(quad), 2, 2)));
        }
        for (const [index, mark] of Array.from(found)) {
          const word = reread.words[index] as Word;
          if (shareOutsideBoxes(convexHull(word.quad), coverage, judged) < JUDGED_SHARE) {
            fresh += 1;
          } else if ("unreadable" in mark) {
            found.delete(index);
          }
        }
        options.onRound?.({
          round,
          image,
          found: [...found].map(([index, mark]) => {
            const word = reread.words[index] as Word;
            return {
              text: word.text,
              confidence: word.confidence,
              covered: shareOf(word),
              mark: "unreadable" in mark ? "unreadable" : shownAs(mark),
            };
          }),
        });
      }

      if (found.size === 0) {
        const maskedText = options.pseudonymizer.vault.maskKnown(
          pageLines(page, (line) => {
            const parts: Array<string> = [];
            let previous: Mark | undefined;
            for (const word of line) {
              const mark = marks.get(word.index);
              if (mark === undefined) parts.push(word.text);
              else if (!sameMark(previous, mark)) parts.push(shownAs(mark));
              previous = mark;
            }
            return parts.join(" ");
          }),
        );
        let covered = 0;
        for (const value of coverage.data) covered += value;
        const tokens = new Set(
          boxes.flatMap((box) => ("token" in box.mark ? [box.mark.token] : [])),
        );
        const result: RedactionResult = {
          kind: "redacted",
          image,
          width: raster.width,
          height: raster.height,
          legend: legend.text(decoded.frames),
          maskedText,
          coverage,
          regions: [
            ...boxes.map((box): RedactedRegion => ({
              source: box.source,
              polygon: box.hull,
              kind: isValue(box.mark) ? box.mark.kind : "OTHER",
              covered: true,
              ...("token" in box.mark ? { token: box.mark.token } : {}),
              ...(isValue(box.mark) ? { surface: box.mark.surface } : {}),
              ...(box.code === undefined
                ? {}
                : { code: { format: box.code.format, inspection: box.code.inspection } }),
            })),
            ...codes.flatMap((code, index): ReadonlyArray<RedactedRegion> =>
              isCovered(code)
                ? []
                : [
                    {
                      source: "code",
                      polygon: codeHulls[index] ?? [],
                      kind: code.inspection.kind,
                      covered: false,
                      surface: code.text,
                      code: { format: code.format, inspection: code.inspection },
                    },
                  ],
            ),
          ],
          stats: {
            words: page.words.length,
            valueBoxes: boxes.filter((box) => box.source === "value").length,
            unreadableBoxes: boxes.filter((box) => box.source === "unreadable").length,
            unreadInkBoxes: inkBoxes.length,
            codeBoxes: codeBoxes.length,
            tokens: tokens.size,
            rounds: round,
            reads: work.reads,
            coveredShare: covered / Math.max(1, coverage.data.length),
            milliseconds: Math.round(performance.now() - started),
          },
        };
        return { kept: { page, codes: codesAsRead, signature, result }, result };
      }
      if (fresh > 0 && round >= policy.maxRounds) {
        return {
          result: {
            kind: "withheld",
            reason:
              "After redaction, personal data could still be read in the image, so it was not sent.",
            readText: work.firstText,
          },
        };
      }
      // Cover what the re-read found where it found it, and mark the first reading's words that
      // lie there so the text says the same as the picture.
      const reread = check as PageWords;
      for (const [index, mark] of found) {
        const late = reread.words[index] as Word;
        for (const word of page.words) {
          const quad = word.quad.map((point) => ({ x: point.x * scaleX, y: point.y * scaleY }));
          if (!marks.has(word.index) && overlapping(quad, late.quad)) marks.set(word.index, mark);
        }
      }
      lateBoxes.push(...work.boxes(reread, found, 1, 1, fresh > 0 ? 1.6 : 1, ink));
      if (fresh > 0) {
        // Something showed that the first reading did not account for: a value cut too close
        // or missed. Every box is widened and the result is read again.
        widen = 1.6;
      } else {
        // Only second opinions: the next picture is this one, already read, with boxes added.
        // Black added to a picture cannot make anything in it legible, so it is not read again.
        settled = true;
      }
    }
  };

  // The same picture is in every turn of a conversation. Its result is kept, with the words the
  // reader found in it, and returned for as long as the detector and the vault mark the same
  // words: each turn then sends the same bytes, and nothing is read or drawn again.
  const kept = new Map<string, Kept>();
  const pending = new Map<string, Promise<RedactionResult>>();
  const MAX_KEPT = 100;

  return {
    redact: async (bytes, neverMask = [], mode = "mask") => {
      const key = `${NodeCrypto.createHash("sha256").update(bytes).digest("base64")}:${mode}:${neverMask.join("\u0000")}`;
      const running = pending.get(key);
      if (running !== undefined) return running;
      const promise = (async (): Promise<RedactionResult> => {
        try {
          const before = kept.get(key);
          if (before !== undefined) {
            // A value learned since the last turn may be in this picture, unrecognised then.
            const work = new Redaction(options, policy, neverMask, mode);
            const marks = await work.marks(
              before.page,
              () => true,
              (word) => word.text,
            );
            unmarkCodes(before.page, marks, before.codes);
            if (signatureOf(marks) === before.signature) return before.result;
          }
          const fresh = await run(bytes, neverMask, mode);
          // A picture that was withheld is tried again next time: the cause may have passed.
          kept.delete(key);
          if (fresh.kept !== undefined) kept.set(key, fresh.kept);
          while (kept.size > MAX_KEPT) {
            const oldest = kept.keys().next().value;
            if (oldest === undefined) break;
            kept.delete(oldest);
          }
          options.onResult?.(bytes, fresh.result);
          return fresh.result;
        } catch (cause) {
          const result: RedactionResult = { kind: "withheld", reason: reasonOf(cause) };
          options.onResult?.(bytes, result);
          return result;
        }
      })();
      pending.set(key, promise);
      try {
        return await promise;
      } finally {
        pending.delete(key);
      }
    },
  };
};
