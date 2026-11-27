import type JSZip from "jszip";

import { findFixedFormats, isVerificationUrl } from "../../fixedFormats.ts";
import { type SpanEdit, UnreadableDocumentError } from "./shared.ts";

/**
 * What the Office formats share: a .docx, .pptx or .xlsx is a ZIP of XML parts. The parts are
 * edited as text, in place: only the characters that change are rewritten, so everything this
 * file does not understand (styles, layout, namespaces, extensions) comes out byte for byte as
 * it went in.
 */

type Zip = JSZip;

let library: Promise<typeof JSZip> | undefined;
const loadZipLibrary = (): Promise<typeof JSZip> => {
  library ??= import("jszip").then((module) => module.default);
  return library;
};

export const openPackage = async (bytes: Buffer, what: string): Promise<Zip> => {
  try {
    const zip = await (await loadZipLibrary()).loadAsync(bytes);
    if (zip.file("[Content_Types].xml") === null) throw new Error("not an Office file");
    return zip;
  } catch (cause) {
    throw new UnreadableDocumentError(`The file is not a ${what} DoeDesk can open.`, { cause });
  }
};

export const readPart = async (zip: Zip, name: string): Promise<string | undefined> =>
  zip.file(name)?.async("string");

export const writePackage = (zip: Zip): Promise<Buffer> =>
  zip.generateAsync({
    type: "nodebuffer",
    compression: "DEFLATE",
    compressionOptions: { level: 6 },
  });

/** The names of the package's parts that match, in the order a person counts them (2 before 10). */
export const partsMatching = (zip: Zip, pattern: RegExp): ReadonlyArray<string> =>
  Object.keys(zip.files)
    .filter((name) => zip.files[name]?.dir !== true && pattern.test(name))
    .toSorted((left, right) => left.localeCompare(right, "en", { numeric: true }));

const ENTITIES: Readonly<Record<string, string>> = {
  lt: "<",
  gt: ">",
  amp: "&",
  quot: '"',
  apos: "'",
};

export const decodeXml = (text: string): string =>
  text.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-z]+);/gu, (whole, name: string) => {
    if (name.startsWith("#x")) return String.fromCodePoint(Number.parseInt(name.slice(2), 16));
    if (name.startsWith("#")) return String.fromCodePoint(Number.parseInt(name.slice(1), 10));
    return ENTITIES[name] ?? whole;
  });

export const encodeXml = (text: string): string =>
  text.replace(/[&<>"]/gu, (character) =>
    character === "&"
      ? "&amp;"
      : character === "<"
        ? "&lt;"
        : character === ">"
          ? "&gt;"
          : "&quot;",
  );

/** The element names that make up the text of one family of parts. */
export interface TextGrammar {
  /** Elements whose content is text a person reads (`w:t`, `a:t`). */
  readonly text: ReadonlySet<string>;
  readonly paragraph: string;
  readonly tab: ReadonlySet<string>;
  /** Elements that hold settings spelled with the same names as content (`w:tabs`). */
  readonly settings: ReadonlySet<string>;
  readonly lineBreak: ReadonlySet<string>;
  readonly row: string;
  readonly cell: string;
}

interface Run {
  /** Where the element's opening tag ends: just before its `>`. */
  readonly openEnd: number;
  readonly preserves: boolean;
  readonly contentStart: number;
  readonly contentEnd: number;
  readonly text: string;
  /** Where the run's text starts in the part's text as read. */
  readonly at: number;
}

/** One XML part read as the text a person sees, with where each stretch of it is in the XML. */
export interface TextPart {
  readonly name: string;
  readonly xml: string;
  /**
   * The part's text in the order it is read, which is the order it is stored in: paragraphs a
   * line each, and a table's row one line with a tab between its cells.
   */
  readonly text: string;
  readonly runs: ReadonlyArray<Run>;
}

const TAG =
  /<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<\?[\s\S]*?\?>|<(\/?)([A-Za-z_][\w:.-]*)((?:"[^"]*"|'[^']*'|[^>"'])*?)(\/?)>/gu;

export const readTextPart = (name: string, xml: string, grammar: TextGrammar): TextPart => {
  const runs: Array<Run> = [];
  let text = "";
  let cells = 0;
  let settings = 0;
  /** Where the last separator put in by this function is, while it is the text's last character. */
  let tail = -1;
  // One separator between two stretches, and the widest wins: the space after a cell's last
  // paragraph becomes the cell's tab, and the tab after a row's last cell the row's line break.
  // Replaced, never trimmed: every run keeps the place it was given.
  const separate = (separator: string) => {
    if (tail >= 0 && tail === text.length - 1) text = text.slice(0, tail) + separator;
    else text += separator;
    tail = text.length - 1;
  };
  TAG.lastIndex = 0;
  for (let match = TAG.exec(xml); match !== null; match = TAG.exec(xml)) {
    const [whole, closing, tag = "", , selfClosing] = match;
    if (tag === "") continue;
    if (grammar.settings.has(tag)) {
      if (selfClosing !== "/") settings += closing === "/" ? -1 : 1;
      continue;
    }
    if (settings > 0) continue;
    if (closing === "/") {
      if (tag === grammar.paragraph) separate(cells > 0 ? " " : "\n");
      else if (tag === grammar.cell) {
        cells = Math.max(0, cells - 1);
        separate(cells > 0 ? " " : "\t");
      } else if (tag === grammar.row && cells === 0) separate("\n");
      continue;
    }
    if (tag === grammar.cell && selfClosing !== "/") cells += 1;
    else if (grammar.tab.has(tag)) text += "\t";
    else if (grammar.lineBreak.has(tag)) text += cells > 0 ? " " : "\n";
    if (!grammar.text.has(tag) || selfClosing === "/") continue;
    const contentStart = match.index + whole.length;
    const contentEnd = xml.indexOf(`</${tag}>`, contentStart);
    if (contentEnd === -1) break;
    const content = decodeXml(xml.slice(contentStart, contentEnd));
    runs.push({
      openEnd: contentStart - 1,
      preserves: /xml:space\s*=\s*["']preserve["']/u.test(match[3] ?? ""),
      contentStart,
      contentEnd,
      text: content,
      at: text.length,
    });
    text += content;
    TAG.lastIndex = contentEnd + tag.length + 3;
  }
  return { name, xml, text, runs };
};

/**
 * The part's XML with stretches of its text replaced. A stretch that runs over several runs (a
 * name typed in two fonts) is written into the first of them and taken out of the rest.
 */
export const rewriteTextPart = (part: TextPart, edits: ReadonlyArray<SpanEdit>): string => {
  if (edits.length === 0) return part.xml;
  const touches = (run: Run, edit: SpanEdit): boolean =>
    edit.start < run.at + run.text.length && edit.end > run.at;
  // The run each stretch is written into: the first it touches, wherever in a gap it starts.
  const writtenIn = new Map(
    edits.map((edit) => [edit, part.runs.find((run) => touches(run, edit))]),
  );
  let xml = part.xml;
  // From the last run to the first, so the places of the runs before stay true.
  for (const run of part.runs.toReversed()) {
    const from = run.at;
    const to = run.at + run.text.length;
    const here = edits.filter((edit) => touches(run, edit));
    if (here.length === 0) continue;
    let rewritten = "";
    let cursor = from;
    for (const edit of here) {
      rewritten += run.text.slice(cursor - from, Math.max(edit.start, from) - from);
      if (writtenIn.get(edit) === run) rewritten += edit.replacement;
      cursor = Math.min(edit.end, to);
    }
    rewritten += run.text.slice(cursor - from);
    const spaced = !run.preserves && rewritten !== rewritten.trim();
    xml =
      xml.slice(0, run.openEnd) +
      (spaced ? ' xml:space="preserve"' : "") +
      ">" +
      encodeXml(rewritten) +
      xml.slice(run.contentEnd);
  }
  return xml;
};

const blankElements = (xml: string, names: ReadonlyArray<string>): string =>
  names.reduce(
    (current, name) =>
      current.replace(new RegExp(`(<${name}(?:\\s[^>]*)?>)[^<]*(</${name}>)`, "gu"), "$1$2"),
    xml,
  );

/** Who wrote the file and where: the properties every Office program fills in unasked. */
export const scrubProperties = async (zip: Zip): Promise<void> => {
  const core = await readPart(zip, "docProps/core.xml");
  if (core !== undefined) {
    zip.file("docProps/core.xml", blankElements(core, ["dc:creator", "cp:lastModifiedBy"]));
  }
  const app = await readPart(zip, "docProps/app.xml");
  if (app !== undefined) {
    zip.file("docProps/app.xml", blankElements(app, ["Company", "Manager"]));
  }
  // Properties a person or a system added: any of them may name someone.
  if (zip.file("docProps/custom.xml") !== null) {
    zip.file(
      "docProps/custom.xml",
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
        '<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/custom-properties"/>',
    );
  }
};

const EXTERNAL_TARGET =
  /<Relationship\b(?=[^>]*\bTargetMode\s*=\s*"External")[^>]*?\bTarget\s*=\s*"([^"]*)"[^>]*>/gu;

/**
 * Links out of the document whose address is itself what was hidden: a verification link, an
 * address with an identifier in it, or one holding a hidden value. The text of a link can be
 * replaced and its address still lead to the original; the address is blanked here.
 */
export const scrubLinks = async (
  zip: Zip,
  hidden: ReadonlyArray<string>,
  kept: ReadonlyArray<string>,
): Promise<void> => {
  for (const name of partsMatching(zip, /\.rels$/u)) {
    const xml = await readPart(zip, name);
    if (xml === undefined || !xml.includes("External")) continue;
    const rewritten = xml.replace(EXTERNAL_TARGET, (whole, target: string) => {
      const address = decodeXml(target);
      // A link a person chose to keep in the text keeps its address.
      if (kept.some((value) => value.includes(address))) return whole;
      const names =
        isVerificationUrl(address) ||
        findFixedFormats(address).length > 0 ||
        hidden.some((value) => value.length >= 4 && address.includes(value));
      return names ? whole.replace(`"${target}"`, '"about:blank"') : whole;
    });
    if (rewritten !== xml) zip.file(name, rewritten);
  }
};

/** True when every tag that opens in the XML closes, in order: what a reader needs to open it. */
export const isWellFormed = (xml: string): boolean => {
  const open: Array<string> = [];
  TAG.lastIndex = 0;
  let cursor = 0;
  for (let match = TAG.exec(xml); match !== null; match = TAG.exec(xml)) {
    if (xml.slice(cursor, match.index).includes("<")) return false;
    cursor = match.index + match[0].length;
    const [, closing, tag = "", , selfClosing] = match;
    if (tag === "" || selfClosing === "/") continue;
    if (closing !== "/") open.push(tag);
    else if (open.pop() !== tag) return false;
  }
  return open.length === 0 && !xml.slice(cursor).includes("<");
};
