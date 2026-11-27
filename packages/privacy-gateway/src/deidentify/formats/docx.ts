import { makeOfficeHandler, type OfficeFormat } from "./office.ts";

/**
 * Word documents: the body, headers, footers, footnotes, endnotes and comments, text that was
 * deleted with changes tracked (it is still in the file), and every embedded picture.
 */
export const docxFormat: OfficeFormat = {
  family: "docx",
  extension: ".docx",
  mediaType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  name: "Word document",
  textParts: /^word\/(?:document|header\d*|footer\d*|footnotes|endnotes|comments)\.xml$/u,
  media: /^word\/media\/[^/]+$/u,
  grammar: {
    text: new Set(["w:t", "w:delText", "w:instrText"]),
    paragraph: "w:p",
    tab: new Set(["w:tab"]),
    settings: new Set(["w:tabs"]),
    lineBreak: new Set(["w:br", "w:cr"]),
    row: "w:tr",
    cell: "w:tc",
  },
};

export const docxHandler = makeOfficeHandler(docxFormat);
