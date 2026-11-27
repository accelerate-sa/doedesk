import { makeOfficeHandler, type OfficeFormat } from "./office.ts";

/** PowerPoint files: every slide, the speaker's notes under each, and every embedded picture. */
export const pptxFormat: OfficeFormat = {
  family: "pptx",
  extension: ".pptx",
  mediaType: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  name: "PowerPoint file",
  textParts: /^ppt\/(?:slides\/slide|notesSlides\/notesSlide)\d+\.xml$/u,
  media: /^ppt\/media\/[^/]+$/u,
  grammar: {
    text: new Set(["a:t"]),
    paragraph: "a:p",
    tab: new Set(),
    settings: new Set(),
    lineBreak: new Set(["a:br"]),
    row: "a:tr",
    cell: "a:tc",
  },
};

export const pptxHandler = makeOfficeHandler(pptxFormat);
