/*
 * An agent that sees stand-ins can print a file with its characters apart (`od -c`, `hexdump -c`,
 * `sed 's/./& /g'`), and neither a detector nor the vault finds a value in that. This puts such
 * output back together, so the text is checked as a reader would read it.
 */

/** How a character of a joined text was printed. */
export const Printed = {
  /** As it is in the original text. */
  AsIs: 0,
  /** A cell of a character dump: the dump says exactly which character it is. */
  Dumped: 1,
  /** One of a run of single characters with the same separator between them. */
  Apart: 2,
} as const;
type Printed = (typeof Printed)[keyof typeof Printed];

/** A text with what was printed apart put back together, and where each character came from. */
export interface JoinedText {
  readonly text: string;
  /** Where each character of `text` starts and ends in the original. */
  readonly starts: Int32Array;
  readonly ends: Int32Array;
  readonly printed: Uint8Array;
}

/** A dump line: an offset (`od`, `hexdump`) or the indent `od -An` uses, then 4-wide cells. */
const DUMP_LINE = /^(?:[0-9a-fA-F]{7,8}| {7,8})(?= )/u;
const CELL = /^(?: {3}\S| {2}(?:\\\S|\*\*|\S{2})| [0-3][0-7]{2}| {4})$/u;
const ESCAPES: Readonly<Record<string, string>> = {
  "\\0": "\0",
  "\\a": "\u0007",
  "\\b": "\b",
  "\\f": "\f",
  "\\n": "\n",
  "\\r": "\r",
  "\\t": "\t",
  "\\v": "\v",
  "\\\\": "\\",
};

/**
 * Five or more single characters with one separator between each and the next: `1 1 5 8 4`,
 * `1_1_5_8_4_`, `1, 1, 5, 8, 4`. A space between words is one of the characters (`d   I` is
 * `d I`). It starts and ends on a letter or digit, so code (`d > 0 ? {`) is left as written. A
 * dash or a dot is not a separator: values are written with them.
 */
const APART =
  /([\p{L}\p{N}])( +|\t+|, *|; *|_|\|)(?:[\p{L}\p{N}\-./:@+ ]\2){3,}[\p{L}\p{N}](?:\2|(?![\p{L}\p{N}]))/gu;
const MAYBE_APART = new RegExp(APART.source, "u");
const MAYBE_DUMP = /^[0-9a-fA-F]{7,8} {3,4}\S|^ {7,8} {3,4}\S {3}\S/mu;

/** A joined text is never longer than the original: one character a cell or a run's unit. */
interface Builder {
  readonly pieces: Array<string>;
  length: number;
  readonly starts: Int32Array;
  readonly ends: Int32Array;
  readonly printed: Uint8Array;
}

const push = (into: Builder, character: string, start: number, end: number, printed: Printed) => {
  into.pieces.push(character);
  for (let unit = 0; unit < character.length; unit += 1) {
    into.starts[into.length] = start;
    into.ends[into.length] = end;
    into.printed[into.length] = printed;
    into.length += 1;
  }
};

/** Copies a stretch of the original as it is. */
const pushAsIs = (into: Builder, text: string, from: number, to: number) => {
  if (to <= from) return;
  into.pieces.push(text.slice(from, to));
  for (let index = from; index < to; index += 1) {
    into.starts[into.length] = index;
    into.ends[into.length] = index + 1;
    into.length += 1;
  }
};

/** The cells of one dump line, each with where it stands, or undefined when it is not one. */
const cellsOf = (
  line: string,
  lineStart: number,
): ReadonlyArray<{ readonly cell: string; readonly start: number }> | undefined => {
  const offset = DUMP_LINE.exec(line);
  if (offset === null) return undefined;
  // `od` puts one more space after the offset than `hexdump` does.
  for (const skip of [offset[0].length + 1, offset[0].length]) {
    const cells: Array<{ cell: string; start: number }> = [];
    let at = skip;
    while (at + 4 <= line.length) {
      const cell = line.slice(at, at + 4);
      if (!CELL.test(cell)) break;
      cells.push({ cell, start: lineStart + at });
      at += 4;
    }
    if (cells.length > 0 && line.slice(at).trim() === "") return cells;
  }
  return undefined;
};

/** Adds the characters of a run of dump lines: escapes read, UTF-8 bytes in octal decoded. */
const addDump = (
  into: Builder,
  cells: ReadonlyArray<{ readonly cell: string; readonly start: number }>,
) => {
  let bytes: Array<{ readonly value: number; readonly start: number }> = [];
  const flush = () => {
    for (let index = 0; index < bytes.length;) {
      const lead = bytes[index]?.value ?? 0;
      const length = lead >= 0xf0 ? 4 : lead >= 0xe0 ? 3 : lead >= 0xc0 ? 2 : 1;
      const group = bytes.slice(index, index + length);
      const character = new TextDecoder().decode(Uint8Array.from(group.map((byte) => byte.value)));
      const first = group[0]?.start ?? 0;
      const last = (group.at(-1)?.start ?? first) + 4;
      if (!character.includes("�")) push(into, character, first, last, Printed.Dumped);
      index += Math.max(1, group.length);
    }
    bytes = [];
  };
  for (const { cell, start } of cells) {
    const content = cell.trimStart();
    if (/^[0-3][0-7]{2}$/u.test(content)) {
      bytes.push({ value: Number.parseInt(content, 8), start });
      continue;
    }
    flush();
    // `**`: a further byte of the character in the cell before it.
    if (content === "**") continue;
    const character = content === "" ? " " : (ESCAPES[content] ?? content);
    if (content.startsWith("\\") && ESCAPES[content] === undefined) continue;
    push(into, character, start, start + 4, Printed.Dumped);
  }
  flush();
};

/** Adds a stretch of the text that is not a dump, joining what is printed apart in it. */
const addPlain = (into: Builder, text: string, from: number, to: number, apart: boolean) => {
  let cursor = from;
  if (apart) {
    const segment = text.slice(from, to);
    for (const match of segment.matchAll(APART)) {
      const start = from + match.index;
      pushAsIs(into, text, cursor, start);
      const separator = match[2] ?? "";
      const end = start + match[0].length;
      for (let index = start; index < end;) {
        push(into, text[index] ?? "", index, index + 1, Printed.Apart);
        index += 1;
        if (text.startsWith(separator, index)) index += separator.length;
      }
      cursor = end;
    }
  }
  pushAsIs(into, text, cursor, to);
};

/** The text as a reader would read it, or undefined when nothing in it is printed apart. */
export const joinSeparated = (text: string): JoinedText | undefined => {
  const dump = MAYBE_DUMP.test(text);
  const apart = MAYBE_APART.test(text);
  if (!dump && !apart) return undefined;
  const into: Builder = {
    pieces: [],
    length: 0,
    starts: new Int32Array(text.length),
    ends: new Int32Array(text.length),
    printed: new Uint8Array(text.length),
  };
  let plainFrom = 0;
  if (dump) {
    let lineStart = 0;
    let region: Array<{ readonly cell: string; readonly start: number }> = [];
    let regionEnd = 0;
    const closeRegion = () => {
      if (region.length === 0) return;
      addDump(into, region);
      region = [];
      plainFrom = regionEnd;
    };
    while (lineStart <= text.length) {
      const lineBreak = text.indexOf("\n", lineStart);
      const lineEnd = lineBreak === -1 ? text.length : lineBreak;
      const cells = cellsOf(text.slice(lineStart, lineEnd), lineStart);
      if (cells === undefined) {
        closeRegion();
      } else {
        if (region.length === 0) addPlain(into, text, plainFrom, lineStart, apart);
        region.push(...cells);
        // The line break after a dump stays, so what follows is not read as more of it.
        regionEnd = lineEnd;
      }
      if (lineBreak === -1) break;
      lineStart = lineBreak + 1;
    }
    closeRegion();
  }
  addPlain(into, text, plainFrom, text.length, apart);
  const printed = into.printed.slice(0, into.length);
  if (!printed.some((each) => each !== Printed.AsIs)) return undefined;
  return {
    text: into.pieces.join(""),
    starts: into.starts.slice(0, into.length),
    ends: into.ends.slice(0, into.length),
    printed,
  };
};

/** Where a span of the joined text stands in the original. */
export const originalSpan = (
  joined: JoinedText,
  start: number,
  end: number,
): { readonly start: number; readonly end: number } => ({
  start: joined.starts[start] ?? start,
  end: joined.ends[end - 1] ?? end,
});
