import JSZip from "jszip";

import { makePseudonymizer } from "../redaction/testkit.ts";
import type { LayoutReader } from "../redaction/redactImage.ts";
import type { DeidentifyContext } from "./formats/shared.ts";

/** Test files, built here from made-up values: no real document is ever a fixture. */

/** A context as the app builds one: the fixed patterns, a list of names, and maybe a reader. */
export const contextWith = (
  names: ReadonlyArray<string> = [],
  reader?: LayoutReader,
): DeidentifyContext => ({
  pseudonymizer: makePseudonymizer(names),
  ...(reader === undefined ? {} : { reader }),
  // One pixel a point: a page drawn from a test PDF is the picture the PDF was made from.
  pdf: { scale: 1 },
});

const XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';

const zipOf = async (parts: Readonly<Record<string, string | Buffer>>): Promise<Buffer> => {
  const zip = new JSZip();
  for (const [name, content] of Object.entries(parts)) zip.file(name, content);
  return zip.generateAsync({ type: "nodebuffer" });
};

/** Every part of an Office file, by name: text parts as text, the rest as bytes. */
export const partsOf = async (bytes: Buffer): Promise<ReadonlyMap<string, string | Buffer>> => {
  const zip = await JSZip.loadAsync(bytes);
  const parts = new Map<string, string | Buffer>();
  for (const [name, entry] of Object.entries(zip.files)) {
    if (entry.dir) continue;
    parts.set(
      name,
      /\.(?:xml|rels)$/u.test(name) ? await entry.async("string") : await entry.async("nodebuffer"),
    );
  }
  return parts;
};

const CORE =
  `${XML}<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" ` +
  'xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>Offer</dc:title>' +
  "<dc:creator>Huda Alsubaie</dc:creator><cp:lastModifiedBy>Huda Alsubaie</cp:lastModifiedBy></cp:coreProperties>";

const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';

/** A Word file from the inner XML of its body, with optional further parts. */
export const docxOf = (
  body: string,
  extra: Readonly<Record<string, string | Buffer>> = {},
): Promise<Buffer> =>
  zipOf({
    "[Content_Types].xml":
      `${XML}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
      '<Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/>' +
      '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
    "_rels/.rels":
      `${XML}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
    "word/document.xml": `${XML}<w:document ${W}><w:body>${body}</w:body></w:document>`,
    "docProps/core.xml": CORE,
    ...extra,
  });

/** One paragraph of a Word file: each string is a run of its own. */
export const paragraph = (...runs: ReadonlyArray<string>): string =>
  `<w:p>${runs.map((run) => `<w:r><w:rPr><w:b/></w:rPr><w:t>${run}</w:t></w:r>`).join("")}</w:p>`;

/** A table of a Word file, a paragraph in every cell. */
export const table = (rows: ReadonlyArray<ReadonlyArray<string>>): string =>
  `<w:tbl>${rows
    .map((row) => `<w:tr>${row.map((cell) => `<w:tc>${paragraph(cell)}</w:tc>`).join("")}</w:tr>`)
    .join("")}</w:tbl>`;

/** Another part of a Word file (a header, the footnotes) holding the given body. */
export const wordPart = (root: string, body: string): string =>
  `${XML}<w:${root} ${W}>${body}</w:${root}>`;

const A = 'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"';
const P = 'xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"';

const shapes = (root: string, paragraphs: ReadonlyArray<ReadonlyArray<string>>): string =>
  `${XML}<p:${root} ${A} ${P}><p:cSld><p:spTree><p:sp><p:txBody><a:bodyPr/>${paragraphs
    .map(
      (runs) =>
        `<a:p>${runs.map((run) => `<a:r><a:rPr lang="en-US"/><a:t>${run}</a:t></a:r>`).join("")}</a:p>`,
    )
    .join("")}</p:txBody></p:sp></p:spTree></p:cSld></p:${root}>`;

/** A PowerPoint file: each slide and each notes page is a list of paragraphs, each a list of runs. */
export const pptxOf = (
  slides: ReadonlyArray<ReadonlyArray<ReadonlyArray<string>>>,
  notes: ReadonlyArray<ReadonlyArray<ReadonlyArray<string>>> = [],
  extra: Readonly<Record<string, string | Buffer>> = {},
): Promise<Buffer> =>
  zipOf({
    "[Content_Types].xml":
      `${XML}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
      '<Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/></Types>',
    "ppt/presentation.xml": `${XML}<p:presentation ${P}/>`,
    ...Object.fromEntries(
      slides.map((slide, index) => [`ppt/slides/slide${index + 1}.xml`, shapes("sld", slide)]),
    ),
    ...Object.fromEntries(
      notes.map((page, index) => [
        `ppt/notesSlides/notesSlide${index + 1}.xml`,
        shapes("notes", page),
      ]),
    ),
    "docProps/core.xml": CORE,
    ...extra,
  });

/** A cell of a test workbook: text goes to the shared strings, a number is stored as one. */
export type TestCell = string | number | { readonly formula: string; readonly value: string };

const columnName = (index: number): string => String.fromCharCode(65 + index);

/** A workbook of named sheets. Text cells share one table of strings, as Excel writes them. */
export const xlsxOf = (
  sheets: Readonly<Record<string, ReadonlyArray<ReadonlyArray<TestCell>>>>,
): Promise<Buffer> => {
  const strings: Array<string> = [];
  const shared = (text: string): number => {
    const index = strings.indexOf(text);
    return index === -1 ? strings.push(text) - 1 : index;
  };
  const names = Object.keys(sheets);
  const sheetXml = (rows: ReadonlyArray<ReadonlyArray<TestCell>>): string =>
    `${XML}<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${rows
      .map(
        (row, r) =>
          `<row r="${r + 1}">${row
            .map((cell, c) => {
              const at = `r="${columnName(c)}${r + 1}"`;
              if (typeof cell === "number") return `<c ${at} s="1"><v>${cell}</v></c>`;
              if (typeof cell === "string") {
                return cell === "" ? `<c ${at}/>` : `<c ${at} t="s"><v>${shared(cell)}</v></c>`;
              }
              return `<c ${at} t="str"><f>${cell.formula}</f><v>${cell.value}</v></c>`;
            })
            .join("")}</row>`,
      )
      .join("")}</sheetData></worksheet>`;
  const parts: Record<string, string> = {};
  names.forEach((name, index) => {
    parts[`xl/worksheets/sheet${index + 1}.xml`] = sheetXml(sheets[name] ?? []);
  });
  return zipOf({
    "[Content_Types].xml":
      `${XML}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
      '<Default Extension="xml" ContentType="application/xml"/>' +
      '<Override PartName="/xl/calcChain.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.calcChain+xml"/></Types>',
    "xl/workbook.xml":
      `${XML}<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ` +
      'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>' +
      names
        .map(
          (name, index) => `<sheet name="${name}" sheetId="${index + 1}" r:id="rId${index + 1}"/>`,
        )
        .join("") +
      "</sheets></workbook>",
    "xl/_rels/workbook.xml.rels":
      `${XML}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
      names
        .map(
          (_, index) =>
            `<Relationship Id="rId${index + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${index + 1}.xml"/>`,
        )
        .join("") +
      '<Relationship Id="rId90" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/>' +
      '<Relationship Id="rId91" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/calcChain" Target="calcChain.xml"/>' +
      "</Relationships>",
    ...parts,
    "xl/sharedStrings.xml":
      `${XML}<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">` +
      strings.map((text) => `<si><t>${text}</t></si>`).join("") +
      "</sst>",
    "xl/calcChain.xml": `${XML}<calcChain xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><c r="A1"/></calcChain>`,
    "docProps/core.xml": CORE,
  });
};

/**
 * A PDF written out object by object, for a page that holds real text and an annotation: what a
 * PDF made of pictures cannot show to be drawn.
 */
export const rawPdf = (objects: ReadonlyArray<string>): Buffer => {
  let body = "%PDF-1.4\n";
  const offsets = objects.map((object, index) => {
    const offset = Buffer.byteLength(body, "latin1");
    body += `${index + 1} 0 obj\n${object}\nendobj\n`;
    return offset;
  });
  const start = Buffer.byteLength(body, "latin1");
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) body += `${String(offset).padStart(10, "0")} 00000 n \n`;
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${start}\n%%EOF\n`;
  return Buffer.from(body, "latin1");
};

export const streamObject = (dictionary: string, content: string): string =>
  `<< ${dictionary} /Length ${content.length} >>\nstream\n${content}\nendstream`;
