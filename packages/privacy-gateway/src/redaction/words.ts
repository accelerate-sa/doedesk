import { frameOf, type Point, pointsOf, type QuadFrame } from "./geometry.ts";
import type { LayoutRead } from "./layout.ts";
import { LayoutUnusableError } from "./layout.ts";

/** One word the reader found, with where it is. */
export interface Word {
  readonly index: number;
  readonly text: string;
  /** Corners in the pixels of the image that was read. */
  readonly quad: ReadonlyArray<Point>;
  readonly frame: QuadFrame;
  readonly confidence: number;
  /** Which line of the page the word is on. */
  readonly line: number;
  readonly handwritten: boolean;
}

export interface PageWords {
  readonly width: number;
  readonly height: number;
  readonly words: ReadonlyArray<Word>;
  /** For each line, its words in reading order. */
  readonly lines: ReadonlyArray<ReadonlyArray<number>>;
}

/**
 * A text made from words, remembering which word each character came from. Detection runs on
 * text; this is how a span of text is turned back into the words to cover.
 */
export interface MappedText {
  readonly text: string;
  readonly spans: ReadonlyArray<{
    readonly start: number;
    readonly end: number;
    readonly word: number;
  }>;
}

/** The single page of an image, as words and lines. */
export const pageWords = (read: LayoutRead): PageWords => {
  const page = read.layout.pages[0];
  if (page === undefined || read.layout.pages.length !== 1) {
    throw new LayoutUnusableError("The reading service did not answer with exactly one page.");
  }
  const handwritten = (offset: number, length: number) =>
    read.layout.handwritten.some(
      (span) => offset < span.offset + span.length && offset + length > span.offset,
    );
  const ordered = page.words.toSorted((left, right) => left.offset - right.offset);
  const lineSpans = page.lines.toSorted((left, right) => left.offset - right.offset);
  const lines: Array<Array<number>> = lineSpans.map(() => []);
  const words = ordered.map((word, index): Word => {
    let line = lineSpans.findIndex(
      (span) => word.offset >= span.offset && word.offset < span.offset + span.length,
    );
    if (line === -1) {
      // A word outside every line is a line of its own.
      line = lines.length;
      lines.push([]);
    }
    lines[line]?.push(index);
    const quad = pointsOf(word.polygon);
    return {
      index,
      text: word.text,
      quad,
      frame: frameOf(quad),
      confidence: word.confidence,
      line,
      handwritten: handwritten(word.offset, word.length),
    };
  });
  return mergeStackedLines({
    width: page.width,
    height: page.height,
    words,
    lines: lines.filter((line) => line.length > 0),
  });
};

const boundsOf = (word: Word) => {
  const xs = word.quad.map((point) => point.x);
  const ys = word.quad.map((point) => point.y);
  const left = Math.min(...xs);
  const right = Math.max(...xs);
  const top = Math.min(...ys);
  const bottom = Math.max(...ys);
  return { left, right, top, bottom, x: (left + right) / 2, y: (top + bottom) / 2 };
};

const isFragment = (text: string, limit: number): boolean => [...text].length <= limit;

/**
 * Upright letters written one under another ("K", "H", "A", …) come back from the reader as one
 * line each, in no dependable order. Lines of a single character that stand in a column are put
 * together as one line, top to bottom, so that the column is treated like any other
 * letter-spaced writing: detected as the word it spells, and covered as one.
 */
const mergeStackedLines = (page: PageWords): PageWords => {
  const single = page.lines.flatMap((line) => {
    const word = page.words[line[0] as number];
    return line.length === 1 && word !== undefined && isFragment(word.text, 2) ? [word] : [];
  });
  if (single.length < 3) return page;
  const bounds = new Map(single.map((word) => [word.index, boundsOf(word)]));
  const below = new Map<number, number>();
  const above = new Map<number, number>();
  for (const word of single) {
    const a = bounds.get(word.index) as ReturnType<typeof boundsOf>;
    let best: Word | undefined;
    let bestGap = Infinity;
    for (const other of single) {
      if (other.index === word.index) continue;
      const b = bounds.get(other.index) as ReturnType<typeof boundsOf>;
      const size = Math.max(a.right - a.left, a.bottom - a.top, b.right - b.left, b.bottom - b.top);
      const gap = b.top - a.bottom;
      if (b.y <= a.y || Math.abs(b.x - a.x) > 0.6 * size || gap > 2.5 * size) continue;
      if (gap < bestGap) {
        best = other;
        bestGap = gap;
      }
    }
    if (best !== undefined) below.set(word.index, best.index);
  }
  // Keep a link only where it is the nearest in both directions.
  for (const [upper, lower] of below) {
    const rival = above.get(lower);
    const gap = (index: number) =>
      (bounds.get(lower) as ReturnType<typeof boundsOf>).top -
      (bounds.get(index) as ReturnType<typeof boundsOf>).bottom;
    if (rival === undefined || gap(upper) < gap(rival)) above.set(lower, upper);
  }
  const chains: Array<Array<number>> = [];
  for (const word of single) {
    if (above.has(word.index)) continue;
    const chain = [word.index];
    let cursor = word.index;
    for (;;) {
      const next = below.get(cursor);
      if (next === undefined || above.get(next) !== cursor) break;
      chain.push(next);
      cursor = next;
    }
    if (chain.length >= 3) chains.push(chain);
  }
  if (chains.length === 0) return page;
  const chained = new Map<number, Array<number>>();
  for (const chain of chains) for (const index of chain) chained.set(index, chain);
  const emitted = new Set<Array<number>>();
  const lines: Array<ReadonlyArray<number>> = [];
  for (const line of page.lines) {
    const chain = line.length === 1 ? chained.get(line[0] as number) : undefined;
    if (chain === undefined) lines.push(line);
    else if (!emitted.has(chain)) {
      emitted.add(chain);
      lines.push(chain);
    }
  }
  return {
    ...page,
    lines,
    words: page.words.map((word) => {
      const line = lines.findIndex((members) => members.includes(word.index));
      return line === -1 || line === word.line ? word : { ...word, line };
    }),
  };
};

/** The clear space between two neighbouring words, along the line from one to the other. */
const gapBetween = (first: Word, second: Word): number => {
  const a = boundsOf(first);
  const b = boundsOf(second);
  const distance = Math.hypot(b.x - a.x, b.y - a.y);
  if (distance < 1e-6) return 0;
  const direction = { x: (b.x - a.x) / distance, y: (b.y - a.y) / distance };
  const along = (point: Point) => point.x * direction.x + point.y * direction.y;
  return Math.min(...second.quad.map(along)) - Math.max(...first.quad.map(along));
};

/** A stretch of a line written as separate letters or small pieces, and where its words part. */
export interface SpacedRun {
  /** Every word of the run, in reading order. */
  readonly words: ReadonlyArray<number>;
  /** The run cut where a gap is clearly wider than the rest: one piece for each written word. */
  readonly pieces: ReadonlyArray<ReadonlyArray<number>>;
}

/** Pieces of at most this many characters can be part of spaced writing. */
const MAX_FRAGMENT = 4;
const MIN_SPACED_RUN = 4;

/**
 * The letter-spaced stretches of a page: rows of short pieces, most of them single characters
 * ("K h a lid"). A run is shown to the detector joined up (`detectionTexts`), and a run with any
 * covered piece is covered whole (`spreadOverRuns`): half a spaced name is still the name.
 */
export const spacedRuns = (
  page: PageWords,
  textOf: (word: Word) => string = (word) => word.text,
): ReadonlyArray<SpacedRun> => {
  const runs: Array<SpacedRun> = [];
  for (const line of page.lines) {
    const words = line.map((index) => page.words[index] as Word);
    let cursor = 0;
    while (cursor < words.length) {
      if (!isFragment(textOf(words[cursor] as Word), MAX_FRAGMENT)) {
        cursor += 1;
        continue;
      }
      let end = cursor;
      while (end < words.length && isFragment(textOf(words[end] as Word), MAX_FRAGMENT)) end += 1;
      // The run begins and ends on a piece of one or two characters.
      let from = cursor;
      let to = end;
      while (from < to && !isFragment(textOf(words[from] as Word), 2)) from += 1;
      while (to > from && !isFragment(textOf(words[to - 1] as Word), 2)) to -= 1;
      const run = words.slice(from, to);
      const singles = run.filter((word) => isFragment(textOf(word), 1)).length;
      if (run.length >= MIN_SPACED_RUN && singles >= 0.6 * run.length) {
        const gaps = run.slice(1).map((word, offset) => gapBetween(run[offset] as Word, word));
        const usual = Math.max(1, median(gaps));
        const pieces: Array<Array<number>> = [[(run[0] as Word).index]];
        run.slice(1).forEach((word, offset) => {
          if ((gaps[offset] ?? 0) > usual * 1.6) pieces.push([]);
          pieces.at(-1)?.push(word.index);
        });
        runs.push({ words: run.map((word) => word.index), pieces });
      }
      cursor = end;
    }
  }
  return runs;
};

/**
 * Extends coverage over letter-spaced runs: if any piece of a run is to be covered, every piece
 * is, with the run's first stand-in if it has one.
 */
export const spreadOverRuns = <Mark>(
  runs: ReadonlyArray<SpacedRun>,
  marks: Map<number, Mark>,
  preferred: (mark: Mark) => boolean,
): void => {
  for (const run of runs) {
    const present = run.words.flatMap((index) => {
      const mark = marks.get(index);
      return mark === undefined ? [] : [mark];
    });
    const mark = present.find(preferred) ?? present[0];
    if (mark === undefined) continue;
    for (const index of run.words) if (!marks.has(index)) marks.set(index, mark);
  }
};

class TextBuilder {
  text = "";
  readonly spans: Array<{ start: number; end: number; word: number }> = [];

  /** Appends a word's text, or part of it, as belonging to that word. */
  word(index: number, text: string): this {
    if (text.length === 0) return this;
    this.spans.push({ start: this.text.length, end: this.text.length + text.length, word: index });
    this.text += text;
    return this;
  }

  gap(): this {
    if (this.text.length > 0 && !this.text.endsWith(" ")) this.text += " ";
    return this;
  }

  done(): MappedText {
    return { text: this.text, spans: this.spans };
  }
}

/** The words a span of a mapped text came from. */
export const wordsIn = (mapped: MappedText, start: number, end: number): ReadonlyArray<number> => {
  const found: Array<number> = [];
  for (const span of mapped.spans) {
    if (span.start < end && span.end > start && !found.includes(span.word)) found.push(span.word);
  }
  return found;
};

/**
 * The whole page as one line of text, words in reading order with one space between them. No
 * line breaks: a value that wraps onto the next line is then found as one value, and each part
 * of it gets the same stand-in.
 */
export const flatText = (
  page: PageWords,
  textOf: (word: Word) => string = (word) => word.text,
): MappedText => {
  const builder = new TextBuilder();
  for (const line of page.lines) {
    for (const index of line) {
      const word = page.words[index];
      if (word !== undefined) builder.gap().word(index, textOf(word));
    }
  }
  return builder.done();
};

const ARABIC_LETTER = /[\p{Script=Arabic}&&\p{L}]/v;
const HAS_LATIN_OR_DIGIT = /[\p{Script=Latin}\p{Nd}]/u;

/** A word written left to right: Latin letters or digits, no Arabic letters. */
const isLeftToRight = (text: string): boolean =>
  !ARABIC_LETTER.test(text) && HAS_LATIN_OR_DIGIT.test(text);

const lineText = (
  page: PageWords,
  order: ReadonlyArray<number>,
  textOf: (word: Word) => string,
): TextBuilder => {
  const builder = new TextBuilder();
  for (const index of order) {
    const word = page.words[index];
    if (word !== undefined) builder.gap().word(index, textOf(word));
  }
  return builder;
};

const HAS_LATIN = /\p{Script=Latin}/u;

/**
 * Lines of an Arabic page with their left-to-right runs put back in order. Measured: the reader
 * returns a spaced number last group first ("23 5191 … 8000 IBAN: SA78"), Latin words in their
 * own order after it, and a plus behind its number ("966+"), so no pattern matches as read.
 */
const reversedRunLines = (
  page: PageWords,
  textOf: (word: Word) => string,
): ReadonlyArray<MappedText> => {
  const variants: Array<MappedText> = [];
  // A cell of an Arabic table that holds only a number has no Arabic letter in it, and its
  // groups are turned round all the same: the page's direction decides, not the line's.
  if (!page.words.some((word) => ARABIC_LETTER.test(textOf(word)))) return [];
  const shown = (word: Word): string => {
    const text = textOf(word);
    return /^[\p{Nd}]+\+$/u.test(text) ? `+${text.slice(0, -1)}` : text;
  };
  for (const line of page.lines) {
    const texts = line.map((index) => textOf(page.words[index] as Word));
    const order: Array<number> = [];
    let changed = false;
    let cursor = 0;
    while (cursor < line.length) {
      let end = cursor;
      while (end < line.length && isLeftToRight(texts[end] ?? "")) end += 1;
      if (end - cursor >= 2) {
        const units: Array<Array<number>> = [];
        for (let index = cursor; index < end; index += 1) {
          const latin = HAS_LATIN.test(texts[index] ?? "");
          const previous = units.at(-1);
          if (
            latin &&
            previous !== undefined &&
            index > cursor &&
            HAS_LATIN.test(texts[index - 1] ?? "")
          ) {
            previous.push(line[index] as number);
          } else {
            units.push([line[index] as number]);
          }
        }
        if (units.length >= 2) changed = true;
        order.push(...units.toReversed().flat());
        cursor = end;
      } else {
        order.push(line[cursor] as number);
        cursor += 1;
      }
    }
    if (changed) variants.push(lineText(page, order, shown).done());
  }
  return variants;
};

const median = (values: ReadonlyArray<number>): number => {
  const sorted = values.toSorted((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
};

/**
 * Lines with letter-spaced writing, with each run joined back into the words it spells and the
 * rest of the line as it was, and each run again on its own.
 */
const letterSpacedLines = (
  page: PageWords,
  textOf: (word: Word) => string,
): ReadonlyArray<MappedText> => {
  const runs = spacedRuns(page, textOf);
  const variants: Array<MappedText> = [];
  for (const line of page.lines) {
    const here = runs.filter((run) => line.includes(run.words[0] as number));
    if (here.length === 0) continue;
    const builder = new TextBuilder();
    const joined = (run: SpacedRun, target: TextBuilder) => {
      for (const piece of run.pieces) {
        target.gap();
        for (const index of piece) target.word(index, textOf(page.words[index] as Word));
      }
    };
    for (const index of line) {
      const run = here.find((candidate) => candidate.words.includes(index));
      if (run === undefined) builder.gap().word(index, textOf(page.words[index] as Word));
      else if (run.words[0] === index) joined(run, builder);
    }
    variants.push(builder.done());
    for (const run of here) {
      const alone = new TextBuilder();
      joined(run, alone);
      variants.push(alone.done());
      // And with no spaces at all, for a number whose groups were told apart by their gaps.
      const solid = new TextBuilder();
      for (const index of run.words) solid.word(index, textOf(page.words[index] as Word));
      variants.push(solid.done());
    }
  }
  return variants;
};

const HYPHEN_END = /[-‐‑­]$/u;

/** Two lines where the first ends in a hyphen, joined without it: "Al-Qah-" + "tani". */
const hyphenatedLines = (
  page: PageWords,
  textOf: (word: Word) => string,
): ReadonlyArray<MappedText> => {
  const variants: Array<MappedText> = [];
  for (let index = 0; index + 1 < page.lines.length; index += 1) {
    const first = page.lines[index] as ReadonlyArray<number>;
    const second = page.lines[index + 1] as ReadonlyArray<number>;
    const last = page.words[first.at(-1) as number] as Word;
    const lastText = textOf(last);
    if (lastText.length < 2 || !HYPHEN_END.test(lastText)) continue;
    const builder = lineText(page, first.slice(0, -1), textOf);
    builder.gap().word(last.index, lastText.replace(HYPHEN_END, ""));
    second.forEach((wordIndex, position) => {
      const word = page.words[wordIndex] as Word;
      if (position > 0) builder.gap();
      builder.word(wordIndex, textOf(word));
    });
    variants.push(builder.done());
  }
  return variants;
};

/** Several mapped texts as one, a line each. Detection never joins a value across lines. */
const asLines = (texts: ReadonlyArray<MappedText>): MappedText => {
  let text = "";
  const spans: Array<{ start: number; end: number; word: number }> = [];
  for (const mapped of texts) {
    if (mapped.text.trim().length === 0) continue;
    if (text.length > 0) text += "\n";
    for (const span of mapped.spans) {
      spans.push({ start: span.start + text.length, end: span.end + text.length, word: span.word });
    }
    text += mapped.text;
  }
  return { text, spans };
};

/**
 * Every text the detector is shown for a page: the page line by line, the page as one line (so
 * that a value that wraps is found whole), and the lines where the reader's order or spacing
 * would hide a value, each rewritten. A word found in any of them is covered.
 */
export const detectionTexts = (
  page: PageWords,
  textOf: (word: Word) => string = (word) => word.text,
): ReadonlyArray<MappedText> =>
  [
    // The page line by line, which is the text the detector is given for any other document:
    // measured, it finds names in it that it misses when the lines are run together.
    asLines(page.lines.map((line) => lineText(page, line, textOf).done())),
    flatText(page, textOf),
    asLines([
      ...reversedRunLines(page, textOf),
      ...letterSpacedLines(page, textOf),
      ...hyphenatedLines(page, textOf),
    ]),
  ].filter((mapped) => mapped.text.trim().length > 0);

const ARABIC_INDIC_ZERO = 0x0660;
const EXTENDED_ARABIC_INDIC_ZERO = 0x06f0;

/** Letters and digits only, digits as ASCII, letters upper case. For comparing identifiers. */
export const compactOf = (text: string): string => {
  let out = "";
  for (const character of text.normalize("NFKC")) {
    const code = character.codePointAt(0) ?? 0;
    if (code >= ARABIC_INDIC_ZERO && code <= ARABIC_INDIC_ZERO + 9) {
      out += String(code - ARABIC_INDIC_ZERO);
    } else if (code >= EXTENDED_ARABIC_INDIC_ZERO && code <= EXTENDED_ARABIC_INDIC_ZERO + 9) {
      out += String(code - EXTENDED_ARABIC_INDIC_ZERO);
    } else if (/[\p{L}\p{N}]/u.test(character)) {
      out += character.toUpperCase();
    }
  }
  return out;
};

/** A mapped text with everything but letters and digits removed, still mapped to its words. */
export const compactText = (mapped: MappedText): MappedText => {
  const builder = new TextBuilder();
  for (const span of mapped.spans) {
    builder.word(span.word, compactOf(mapped.text.slice(span.start, span.end)));
  }
  return builder.done();
};

/** The page as lines of text, for a person or a model to read. */
export const pageLines = (page: PageWords, render: (line: ReadonlyArray<Word>) => string): string =>
  page.lines.map((line) => render(line.map((index) => page.words[index] as Word))).join("\n");
