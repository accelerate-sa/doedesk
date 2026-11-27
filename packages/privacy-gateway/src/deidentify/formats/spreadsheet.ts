import { kindOfHeader } from "../../labelDetector.ts";
import type { DeidentificationMode } from "../../pseudonymizer.ts";
import type { CellsTarget, ItemTarget, LayerItem } from "../layer.ts";
import {
  decodeXml,
  encodeXml,
  openPackage,
  partsMatching,
  readPart,
  scrubProperties,
  writePackage,
} from "./ooxml.ts";
import {
  type DeidentifyContext,
  type Detection,
  extensionOf,
  findInTexts,
  type FormatHandler,
  foundItem,
  replacementFor,
  rewriteSpans,
  spanEdits,
  UnreadableDocumentError,
} from "./shared.ts";

/**
 * Spreadsheets: .csv and .xlsx. Each cell is searched with its row and its column's header in
 * view, and a person may also mark whole columns, rows or ranges. The copy keeps every sheet,
 * with the marked cells rewritten and nothing of their old values left in the file.
 */

/** One sheet as text: a row's cells from its first column to its last filled one. */
export interface SheetModel {
  readonly name: string;
  readonly rows: ReadonlyArray<{ readonly index: number; readonly cells: ReadonlyArray<string> }>;
}

/** The name the single sheet of a .csv file goes by in a target. */
export const CSV_SHEET = "csv";

interface Csv {
  readonly bom: boolean;
  readonly delimiter: string;
  readonly newline: string;
  readonly endsWithNewline: boolean;
  readonly rows: ReadonlyArray<ReadonlyArray<string>>;
}

const delimiterOf = (text: string): string => {
  const firstLine = text.slice(0, Math.max(0, text.search(/\r?\n/u)) || text.length);
  const count = (character: string) => firstLine.split(character).length - 1;
  return [",", ";", "\t"].reduce((best, next) => (count(next) > count(best) ? next : best));
};

const parseCsv = (raw: string): Csv => {
  const bom = raw.startsWith("﻿");
  const text = bom ? raw.slice(1) : raw;
  const delimiter = delimiterOf(text);
  const rows: Array<Array<string>> = [];
  let row: Array<string> = [];
  let cell = "";
  let quoted = false;
  let index = 0;
  while (index < text.length) {
    const character = text[index] as string;
    if (quoted) {
      if (character === '"' && text[index + 1] === '"') {
        cell += '"';
        index += 2;
      } else if (character === '"') {
        quoted = false;
        index += 1;
      } else {
        cell += character;
        index += 1;
      }
    } else if (character === '"' && cell === "") {
      quoted = true;
      index += 1;
    } else if (character === delimiter) {
      row.push(cell);
      cell = "";
      index += 1;
    } else if (character === "\n" || character === "\r") {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
      index += character === "\r" && text[index + 1] === "\n" ? 2 : 1;
    } else {
      cell += character;
      index += 1;
    }
  }
  const endsWithNewline = /[\r\n]$/u.test(text);
  if (!endsWithNewline && text.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  return { bom, delimiter, newline: text.includes("\r\n") ? "\r\n" : "\n", endsWithNewline, rows };
};

const writeCsv = (csv: Csv, rows: ReadonlyArray<ReadonlyArray<string>>): string => {
  const needsQuotes = new RegExp(
    `["\\r\\n${csv.delimiter === "\t" ? "\\t" : csv.delimiter}]|^\\s|\\s$`,
    "u",
  );
  const body = rows
    .map((row) =>
      row
        .map((cell) => (needsQuotes.test(cell) ? `"${cell.replaceAll('"', '""')}"` : cell))
        .join(csv.delimiter),
    )
    .join(csv.newline);
  return (csv.bom ? "﻿" : "") + body + (csv.endsWithNewline ? csv.newline : "");
};

/** A sheet as lines of tab-separated cells, with where each cell stands in that text. */
const asText = (sheet: SheetModel) => {
  const cells: Array<{
    readonly row: number;
    readonly column: number;
    readonly start: number;
    readonly text: string;
  }> = [];
  let text = "";
  for (const row of sheet.rows) {
    if (text.length > 0) text += "\n";
    row.cells.forEach((cell, column) => {
      if (column > 0) text += "\t";
      // A tab or a line break inside a cell would read as the edge of one.
      const flat = cell.replace(/[\t\r\n]/gu, " ");
      cells.push({ row: row.index, column, start: text.length, text: cell });
      text += flat;
    });
  }
  return { text, cells };
};

const cellTarget = (
  sheet: string,
  row: number,
  column: number,
  span?: { readonly start: number; readonly end: number },
): CellsTarget => ({
  type: "cells",
  sheet,
  scope: "cell",
  startRow: row,
  endRow: row,
  startColumn: column,
  endColumn: column,
  ...span,
});

const keyOf = (row: number, column: number): string => `${row}:${column}`;

const detectSheets = async (
  sheets: ReadonlyArray<SheetModel>,
  context: DeidentifyContext,
  mode: DeidentificationMode,
): Promise<ReadonlyArray<LayerItem>> => {
  const read = sheets.map(asText);
  const found = await findInTexts(
    context,
    read.map((sheet) => sheet.text),
  );
  const items: Array<LayerItem> = [];
  sheets.forEach((sheet, sheetIndex) => {
    const { cells } = read[sheetIndex] as ReturnType<typeof asText>;
    // The cells under a header that names what they hold are taken whole, whatever they look like.
    const whole = new Map<string, LayerItem>();
    const [header, ...body] = sheet.rows;
    header?.cells.forEach((title, column) => {
      const kind = kindOfHeader(title);
      if (kind === undefined) return;
      for (const row of body) {
        const value = row.cells[column] ?? "";
        if (value.trim() === "") continue;
        whole.set(
          keyOf(row.index, column),
          foundItem(cellTarget(sheet.name, row.index, column), kind, value, mode),
        );
      }
    });
    let cursor = 0;
    for (const span of found[sheetIndex] ?? []) {
      while (
        cursor + 1 < cells.length &&
        (cells[cursor + 1] as (typeof cells)[number]).start <= span.start
      ) {
        cursor += 1;
      }
      const cell = cells[cursor];
      if (cell === undefined || whole.has(keyOf(cell.row, cell.column))) continue;
      const start = span.start - cell.start;
      const end = Math.min(span.end - cell.start, cell.text.length);
      if (start < 0 || end <= start) continue;
      const all = start === 0 && end === cell.text.length;
      items.push(
        foundItem(
          cellTarget(sheet.name, cell.row, cell.column, all ? undefined : { start, end }),
          span.kind,
          cell.text.slice(start, end),
          mode,
        ),
      );
    }
    items.push(...whole.values());
  });
  return items;
};

const covers = (target: CellsTarget, row: number, column: number): boolean =>
  row >= target.startRow &&
  row <= (target.endRow ?? Infinity) &&
  column >= target.startColumn &&
  column <= (target.endColumn ?? Infinity);

/**
 * The new text of every cell that changes, by sheet and place. A rule over whole cells decides
 * each of its cells outright, a person's rule before a found one and their later rule before
 * their earlier; a kept cell is left alone whatever was found inside it.
 */
const planCells = (
  sheets: ReadonlyArray<SheetModel>,
  items: ReadonlyArray<LayerItem>,
  context: DeidentifyContext,
  replacements: Map<string, string>,
): ReadonlyMap<string, ReadonlyMap<string, string>> => {
  const plan = new Map<string, Map<string, string>>();
  for (const sheet of sheets) {
    const here = items.flatMap((item) =>
      item.target.type === "cells" && item.target.sheet === sheet.name
        ? [{ item, target: item.target }]
        : [],
    );
    if (here.length === 0) continue;
    const whole = here
      .filter(({ target }) => target.start === undefined || target.end === undefined)
      .toSorted(
        (left, right) =>
          Number(left.item.source === "manual") - Number(right.item.source === "manual"),
      );
    const partial = here.filter(
      ({ target }) => target.start !== undefined && target.end !== undefined,
    );
    const changed = new Map<string, string>();
    for (const row of sheet.rows) {
      row.cells.forEach((text, column) => {
        if (text.trim() === "") return;
        const rule = whole.findLast(({ target }) => covers(target, row.index, column));
        if (rule !== undefined) {
          const replacement = replacementFor(rule.item, text, context);
          if (replacement === undefined) return;
          changed.set(keyOf(row.index, column), replacement);
          // One rule over many cells writes a stand-in for each: only a single cell's is the item's.
          if (rule.item.action === "redact" || rule.target.scope === "cell") {
            replacements.set(rule.item.id, replacement);
          }
          return;
        }
        const spans = partial.flatMap(({ item, target }) =>
          covers(target, row.index, column)
            ? [{ ...item, span: { start: target.start as number, end: target.end as number } }]
            : [],
        );
        if (spans.length === 0) return;
        const rewritten = rewriteSpans(text, spanEdits(text, spans, context, replacements));
        if (rewritten !== text) changed.set(keyOf(row.index, column), rewritten);
      });
    }
    if (changed.size > 0) plan.set(sheet.name, changed);
  }
  return plan;
};

/** A person's rule marks places; it stays while its sheet is still in the file. */
const reanchorCells = (
  sheets: ReadonlyArray<SheetModel>,
  items: ReadonlyArray<LayerItem>,
): ReadonlyMap<string, ItemTarget> => {
  const names = new Set(sheets.map((sheet) => sheet.name));
  return new Map<string, ItemTarget>(
    items.flatMap((item) =>
      item.target.type === "cells" && names.has(item.target.sheet) ? [[item.id, item.target]] : [],
    ),
  );
};

const csvSheets = (csv: Csv): ReadonlyArray<SheetModel> => [
  { name: CSV_SHEET, rows: csv.rows.map((cells, index) => ({ index, cells })) },
];

const columnIndex = (letters: string): number => {
  let index = 0;
  for (const letter of letters.toUpperCase()) index = index * 26 + (letter.charCodeAt(0) - 64);
  return index - 1;
};

const attribute = (attributes: string, name: string): string | undefined =>
  new RegExp(`(?:^|\\s)${name}\\s*=\\s*"([^"]*)"`, "u").exec(attributes)?.[1];

/** The text of a string item: its runs joined, phonetic guides left out. */
const stringItemText = (inner: string): string =>
  [
    ...inner
      .replace(/<(?:\w+:)?rPh\b[\s\S]*?<\/(?:\w+:)?rPh>/gu, "")
      .matchAll(/<(?:\w+:)?t\b[^>]*>([\s\S]*?)<\/(?:\w+:)?t>/gu),
  ]
    .map((match) => decodeXml(match[1] ?? ""))
    .join("");

const STRING_ITEM = /<((?:\w+:)?si)\b[^>]*?(?:\/>|>([\s\S]*?)<\/\1>)/gu;
const ROW = /<((?:\w+:)?row)\b([^>]*?)(?:\/>|>([\s\S]*?)<\/\1>)/gu;
const CELL = /<((?:\w+:)?)c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/\1c>)/gu;

interface XlsxCell {
  readonly row: number;
  readonly column: number;
  readonly text: string;
  /** Where the whole cell element is in its sheet's XML. */
  readonly start: number;
  readonly end: number;
  readonly prefix: string;
  readonly attributes: string;
  readonly formula: boolean;
}

interface XlsxSheet {
  readonly name: string;
  readonly part: string;
  readonly xml: string;
  readonly cells: ReadonlyArray<XlsxCell>;
}

const readSheetCells = (xml: string, strings: ReadonlyArray<string>): ReadonlyArray<XlsxCell> => {
  const cells: Array<XlsxCell> = [];
  let rowIndex = -1;
  for (const row of xml.matchAll(ROW)) {
    const numbered = Number(attribute(row[2] ?? "", "r"));
    rowIndex = Number.isInteger(numbered) && numbered > 0 ? numbered - 1 : rowIndex + 1;
    const inner = row[3];
    if (inner === undefined) continue;
    const innerStart = row.index + row[0].indexOf(">") + 1;
    let column = -1;
    for (const cell of inner.matchAll(CELL)) {
      const attributes = cell[2] ?? "";
      const reference = /^([A-Za-z]+)/u.exec(attribute(attributes, "r") ?? "")?.[1];
      column = reference === undefined ? column + 1 : columnIndex(reference);
      const body = cell[3] ?? "";
      const type = attribute(attributes, "t");
      const value = decodeXml(/<(?:\w+:)?v\b[^>]*>([\s\S]*?)<\/(?:\w+:)?v>/u.exec(body)?.[1] ?? "");
      const text =
        type === "s"
          ? (strings[Number(value)] ?? "")
          : type === "inlineStr"
            ? stringItemText(body)
            : value;
      cells.push({
        row: rowIndex,
        column,
        text,
        start: innerStart + cell.index,
        end: innerStart + cell.index + cell[0].length,
        prefix: cell[1] ?? "",
        attributes,
        formula: /<(?:\w+:)?f\b/u.test(body),
      });
    }
  }
  return cells;
};

const resolveTarget = (target: string): string =>
  target.startsWith("/") ? target.slice(1) : `xl/${target.replace(/^\.\//u, "")}`;

interface Workbook {
  readonly zip: Awaited<ReturnType<typeof openPackage>>;
  readonly sheets: ReadonlyArray<XlsxSheet>;
  readonly stringsPart: string | undefined;
  readonly stringsXml: string | undefined;
}

const readWorkbook = async (bytes: Buffer): Promise<Workbook> => {
  const zip = await openPackage(bytes, "spreadsheet");
  const workbook = await readPart(zip, "xl/workbook.xml");
  const relations = (await readPart(zip, "xl/_rels/workbook.xml.rels")) ?? "";
  if (workbook === undefined) {
    throw new UnreadableDocumentError("The file is not a spreadsheet DoeDesk can open.");
  }
  const targets = new Map<string, { readonly target: string; readonly type: string }>();
  for (const relation of relations.matchAll(/<Relationship\b([^>]*)>/gu)) {
    const attributes = relation[1] ?? "";
    const id = attribute(attributes, "Id");
    const target = attribute(attributes, "Target");
    if (id !== undefined && target !== undefined) {
      targets.set(id, {
        target: resolveTarget(decodeXml(target)),
        type: attribute(attributes, "Type") ?? "",
      });
    }
  }
  const stringsPart =
    [...targets.values()].find((relation) => relation.type.endsWith("/sharedStrings"))?.target ??
    (zip.file("xl/sharedStrings.xml") === null ? undefined : "xl/sharedStrings.xml");
  const stringsXml = stringsPart === undefined ? undefined : await readPart(zip, stringsPart);
  const strings = [...(stringsXml ?? "").matchAll(STRING_ITEM)].map((item) =>
    stringItemText(item[2] ?? ""),
  );
  const sheets: Array<XlsxSheet> = [];
  for (const sheet of workbook.matchAll(/<(?:\w+:)?sheet\b([^>]*?)\/?>/gu)) {
    const attributes = sheet[1] ?? "";
    const name = decodeXml(attribute(attributes, "name") ?? "");
    const part = targets.get(attribute(attributes, "r:id") ?? "")?.target;
    const xml = part === undefined ? undefined : await readPart(zip, part);
    // A chart sheet has no cells: it is not a worksheet part and is left as it is.
    if (part === undefined || xml === undefined || !/<(?:\w+:)?sheetData\b/u.test(xml)) continue;
    sheets.push({ name, part, xml, cells: readSheetCells(xml, strings) });
  }
  return { zip, sheets, stringsPart, stringsXml };
};

const modelOf = (sheet: XlsxSheet): SheetModel => {
  const rows = new Map<number, Array<string>>();
  for (const cell of sheet.cells) {
    const row = rows.get(cell.row) ?? [];
    while (row.length <= cell.column) row.push("");
    row[cell.column] = cell.text;
    rows.set(cell.row, row);
  }
  return {
    name: sheet.name,
    rows: [...rows]
      .toSorted(([left], [right]) => left - right)
      .map(([index, cells]) => ({ index, cells })),
  };
};

/** Parts of a workbook that can hold values and are not cells: a person is told they exist. */
const UNSCANNED: ReadonlyArray<readonly [string, RegExp]> = [
  ["comments", /^xl\/(?:comments|threadedComments)/u],
  ["drawings", /^xl\/drawings\/[^/]+\.xml$/u],
  ["pictures", /^xl\/media\//u],
  ["pivot tables", /^xl\/pivotCache\//u],
  ["links to other workbooks", /^xl\/externalLinks\//u],
];

const xlsxMediaType = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

const applyToWorkbook = async (
  workbook: Workbook,
  plan: ReadonlyMap<string, ReadonlyMap<string, string>>,
): Promise<Buffer> => {
  const { zip } = workbook;
  let formulasRemoved = false;
  const rewritten = new Map<string, string>();
  for (const sheet of workbook.sheets) {
    const changed = plan.get(sheet.name);
    let xml = sheet.xml;
    // From the last cell to the first, so the places of the cells before stay true.
    for (const cell of sheet.cells.toReversed()) {
      const text = changed?.get(keyOf(cell.row, cell.column));
      if (text === undefined) continue;
      if (cell.formula) formulasRemoved = true;
      const p = cell.prefix;
      // Written into the cell itself, with the cell's place and style kept: the shared table of
      // strings is not edited, so no other cell changes with this one.
      const kept = ["r", "s"]
        .flatMap((name) => {
          const value = attribute(cell.attributes, name);
          return value === undefined ? [] : [` ${name}="${value}"`];
        })
        .join("");
      xml =
        xml.slice(0, cell.start) +
        `<${p}c${kept} t="inlineStr"><${p}is><${p}t xml:space="preserve">${encodeXml(text)}</${p}t></${p}is></${p}c>` +
        xml.slice(cell.end);
    }
    rewritten.set(sheet.part, xml);
    if (xml !== sheet.xml) zip.file(sheet.part, xml);
  }
  // A shared string no cell points at any more is the old value of a rewritten cell: blanked
  // where it stands, so every other string keeps its number.
  if (workbook.stringsPart !== undefined && workbook.stringsXml !== undefined) {
    const used = new Set<number>();
    for (const xml of rewritten.values()) {
      for (const cell of xml.matchAll(CELL)) {
        if (attribute(cell[2] ?? "", "t") !== "s") continue;
        const value = /<(?:\w+:)?v\b[^>]*>([\s\S]*?)<\/(?:\w+:)?v>/u.exec(cell[3] ?? "")?.[1];
        if (value !== undefined) used.add(Number(value));
      }
    }
    let index = -1;
    zip.file(
      workbook.stringsPart,
      workbook.stringsXml.replace(STRING_ITEM, (whole, tag: string) => {
        index += 1;
        const prefix = tag.slice(0, tag.length - 2);
        return used.has(index) ? whole : `<${tag}><${prefix}t></${prefix}t></${tag}>`;
      }),
    );
  }
  // The order formulas were worked out in names cells that hold none now: the program that
  // opens the file writes it again, and refuses a list that is wrong.
  if (formulasRemoved && zip.file("xl/calcChain.xml") !== null) {
    zip.remove("xl/calcChain.xml");
    for (const [name, pattern] of [
      ["[Content_Types].xml", /<Override\b[^>]*calcChain\.xml[^>]*>/gu],
      ["xl/_rels/workbook.xml.rels", /<Relationship\b[^>]*calcChain\.xml[^>]*>/gu],
    ] as const) {
      const xml = await readPart(zip, name);
      if (xml !== undefined) zip.file(name, xml.replace(pattern, ""));
    }
  }
  await scrubProperties(zip);
  return writePackage(zip);
};

const isCsv = (path: string): boolean => extensionOf(path) === ".csv";

/** The sheets of a .csv or .xlsx file as text, for whoever shows them to a person. */
export const readSpreadsheet = async (file: {
  readonly path: string;
  readonly bytes: Buffer;
}): Promise<ReadonlyArray<SheetModel>> =>
  isCsv(file.path)
    ? csvSheets(parseCsv(file.bytes.toString("utf8")))
    : (await readWorkbook(file.bytes)).sheets.map(modelOf);

const detectIn = async (
  sheets: ReadonlyArray<SheetModel>,
  context: DeidentifyContext,
  mode: DeidentificationMode,
  warnings: ReadonlyArray<string> = [],
): Promise<Detection> => ({ items: await detectSheets(sheets, context, mode), warnings });

export const csvHandler: FormatHandler = {
  family: "csv",
  extensions: [".csv"],
  detect: (file, context, mode) =>
    detectIn(csvSheets(parseCsv(file.bytes.toString("utf8"))), context, mode),
  apply: async (file, items, context) => {
    const csv = parseCsv(file.bytes.toString("utf8"));
    const replacements = new Map<string, string>();
    const changed = planCells(csvSheets(csv), items, context, replacements).get(CSV_SHEET);
    const rows = csv.rows.map((cells, row) =>
      cells.map((cell, column) => changed?.get(keyOf(row, column)) ?? cell),
    );
    return { bytes: Buffer.from(writeCsv(csv, rows), "utf8"), mediaType: "text/csv", replacements };
  },
  reanchor: async (file, items) =>
    reanchorCells(csvSheets(parseCsv(file.bytes.toString("utf8"))), items),
};

export const xlsxHandler: FormatHandler = {
  family: "xlsx",
  extensions: [".xlsx"],
  detect: async (file, context, mode) => {
    const workbook = await readWorkbook(file.bytes);
    const unscanned = UNSCANNED.filter(
      ([, pattern]) => partsMatching(workbook.zip, pattern).length > 0,
    );
    return detectIn(
      workbook.sheets.map(modelOf),
      context,
      mode,
      unscanned.length === 0
        ? []
        : [`unscanned-parts: ${unscanned.map(([name]) => name).join(", ")}`],
    );
  },
  apply: async (file, items, context) => {
    const workbook = await readWorkbook(file.bytes);
    const replacements = new Map<string, string>();
    const plan = planCells(workbook.sheets.map(modelOf), items, context, replacements);
    return { bytes: await applyToWorkbook(workbook, plan), mediaType: xlsxMediaType, replacements };
  },
  reanchor: async (file, items) =>
    reanchorCells((await readWorkbook(file.bytes)).sheets.map(modelOf), items),
};
