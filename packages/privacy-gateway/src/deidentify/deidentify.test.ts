import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import sharp from "sharp";
import { describe, expect, it } from "vite-plus/test";

import {
  codePixels,
  darkShare,
  paintPage,
  type Planted,
  plantedReader,
  pngOf,
  shows,
  stampOn,
} from "../redaction/testkit.ts";
import { isWellFormed, readTextPart } from "./formats/ooxml.ts";
import {
  addLayerItem,
  applyLayer,
  boxRegion,
  columnTarget,
  CSV_SHEET,
  deidentifyFile,
  type DeidentificationLayer,
  exportDeidentified,
  type LayerItem,
  manualItem,
  openPdf,
  PagePdfBuilder,
  rangeTarget,
  readSpreadsheet,
  rowTarget,
  setItemAction,
  setReviewState,
  StaleLayerError,
  UnsupportedFormatError,
} from "./index.ts";
import {
  contextWith,
  docxOf,
  paragraph,
  partsOf,
  pptxOf,
  rawPdf,
  streamObject,
  table,
  wordPart,
  xlsxOf,
} from "./testkit.ts";

// Every name, number and link in this file is made up.
const NAME = "Sami Alharbi";
const IBAN = "SA4420000001234567891234";
const PHONE = "0551234567";
const LINK = "https://alah.li/7Xk2PqR";
const TOKEN = String.raw`\[[A-Z]+_\w{5}\]`;

const WIDTH = 1000;
const HEIGHT = 600;

/** A line of words, each a block of strokes 22 pixels high, starting at `x`. */
const line = (y: number, texts: ReadonlyArray<string>, x = 60): Array<Planted> => {
  let cursor = x;
  return texts.map((text) => {
    const width = Math.max(14, text.length * 12);
    const word = { text, x: cursor, y, width, height: 22 };
    cursor += width + 10;
    return word;
  });
};

const itemOf = (layer: DeidentificationLayer, preview: string): LayerItem => {
  const item = layer.items.find((candidate) => candidate.preview === preview);
  if (item === undefined) throw new Error(`nothing was found for ${preview}`);
  return item;
};

const kinds = (layer: DeidentificationLayer) =>
  layer.items.map((item) => [item.kind, item.preview, item.action]);

describe("text and Markdown", () => {
  const LETTER = `Dear ${NAME},\nYour IBAN is ${IBAN}.\nTo verify, visit ${LINK}\nRegards from the branch, ${NAME}\n`;
  const file = { path: "clients/letter.md", bytes: Buffer.from(LETTER), mtimeMs: 10 };

  it("finds without touching the vault, masks on apply, and gives every value back", async () => {
    const context = contextWith([NAME]);
    const layer = await deidentifyFile(file, context, { projectId: "p1" });
    expect(layer).toMatchObject({
      family: "text",
      defaultMode: "mask",
      reviewState: "unreviewed",
      fileMtimeMs: 10,
    });
    expect(kinds(layer)).toEqual([
      ["PERSON", NAME, "mask"],
      ["IBAN", IBAN, "mask"],
      ["URL", LINK, "mask"],
      ["PERSON", NAME, "mask"],
    ]);
    expect(context.pseudonymizer.vault.entries()).toEqual([]);

    const applied = await applyLayer(file, layer, context);
    const text = applied.bytes.toString("utf8");
    expect(text).toMatch(
      new RegExp(
        `^Dear ${TOKEN},\\nYour IBAN is ${TOKEN}\\.\\nTo verify, visit ${TOKEN}\\nRegards from the branch, ${TOKEN}\\n$`,
      ),
    );
    expect(applied).toMatchObject({
      mediaType: "text/markdown",
      counts: { mask: 4, redact: 0, keep: 0 },
    });
    expect(
      applied.layer.items.every(
        (item) => item.replacement !== undefined && text.includes(item.replacement),
      ),
    ).toBe(true);
    expect(context.pseudonymizer.unmask(text)).toBe(LETTER);
    // The file itself is as it was.
    expect(file.bytes.toString("utf8")).toBe(LETTER);
  });

  it("redacts a whole document with nothing written to the vault", async () => {
    const context = contextWith([NAME]);
    const layer = await deidentifyFile(file, context, { projectId: "p1", defaultMode: "redact" });
    const applied = await applyLayer(file, layer, context);
    expect(applied.bytes.toString("utf8")).toBe(
      "Dear [REDACTED],\nYour IBAN is [REDACTED].\nTo verify, visit [REDACTED]\nRegards from the branch, [REDACTED]\n",
    );
    expect(applied.counts).toEqual({ mask: 0, redact: 4, keep: 0 });
    expect(context.pseudonymizer.vault.entries()).toEqual([]);
    expect(context.pseudonymizer.vault.spellingCount).toBe(0);
  });

  it("carries out each item's own action, and a person's own marks", async () => {
    const context = contextWith([NAME]);
    let layer = await deidentifyFile(file, context, { projectId: "p1" });
    layer = setItemAction(layer, itemOf(layer, IBAN).id, "redact");
    layer = setItemAction(layer, itemOf(layer, LINK).id, "keep");
    const start = LETTER.indexOf("the branch");
    layer = addLayerItem(
      layer,
      manualItem({
        target: { type: "text", start, end: start + 10 },
        action: "redact",
        preview: "the branch",
      }),
    );
    const applied = await applyLayer(file, layer, context);
    expect(applied.bytes.toString("utf8")).toMatch(
      new RegExp(
        `^Dear \\[PERSON_\\w{5}\\],\\nYour IBAN is \\[REDACTED\\]\\.\\nTo verify, visit ${LINK}\\nRegards from \\[REDACTED\\], \\[PERSON_\\w{5}\\]\\n$`,
      ),
    );
    expect(applied.counts).toEqual({ mask: 2, redact: 2, keep: 1 });
    // Only what was masked is in the vault.
    expect(context.pseudonymizer.vault.entries().map((entry) => entry.value)).toEqual([NAME]);
  });

  it("names the copy, writes it where asked, and never over the file", async () => {
    const folder = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "doedesk-export-"));
    try {
      const context = contextWith([NAME]);
      const source = NodePath.join(folder, "letter.txt");
      NodeFS.writeFileSync(source, LETTER);
      const onDisk = { path: source, bytes: NodeFS.readFileSync(source) };
      const layer = await deidentifyFile(onDisk, context, {
        projectId: "p1",
        defaultMode: "redact",
      });
      const outputPath = NodePath.join(folder, "out", "letter.deidentified.txt");
      const exported = await exportDeidentified(onDisk, layer, context, { outputPath });
      expect(exported).toMatchObject({
        fileName: "letter.deidentified.txt",
        mediaType: "text/plain",
        path: outputPath,
      });
      expect(NodeFS.readFileSync(outputPath, "utf8")).not.toContain(NAME);
      expect(NodeFS.statSync(outputPath).mode & 0o777).toBe(0o600);
      await expect(
        exportDeidentified(onDisk, layer, context, { outputPath: source }),
      ).rejects.toThrow(/over the file/);
      expect(NodeFS.readFileSync(source, "utf8")).toBe(LETTER);
    } finally {
      NodeFS.rmSync(folder, { recursive: true, force: true });
    }
  });

  it("refuses a file that changed since it was checked, and formats it cannot open", async () => {
    const context = contextWith([NAME]);
    const layer = await deidentifyFile(file, context, { projectId: "p1" });
    const edited = { ...file, bytes: Buffer.from(`${LETTER}PS: call ${PHONE}\n`) };
    await expect(applyLayer(edited, layer, context)).rejects.toBeInstanceOf(StaleLayerError);
    const legacy = { path: "old/contract.doc", bytes: Buffer.from("x") };
    await expect(deidentifyFile(legacy, context, { projectId: "p1" })).rejects.toBeInstanceOf(
      UnsupportedFormatError,
    );
    await expect(deidentifyFile(legacy, context, { projectId: "p1" })).rejects.toThrow(/\.docx/);
  });

  it("brings a reviewed layer up to an edited file: stale, with choices and marks where they still hold", async () => {
    const context = contextWith([NAME]);
    let layer = await deidentifyFile(file, context, { projectId: "p1" });
    layer = setItemAction(layer, itemOf(layer, IBAN).id, "redact");
    const start = LETTER.indexOf("the branch");
    const mark = manualItem({
      target: { type: "text", start, end: start + 10 },
      action: "redact",
      preview: "the branch",
    });
    const gone = manualItem({
      target: { type: "text", start: 0, end: 4 },
      action: "redact",
      preview: "Dear",
    });
    layer = setReviewState(addLayerItem(addLayerItem(layer, mark), gone), "reviewed");

    // Unchanged content: the same layer, and nothing is looked for again.
    expect(
      await deidentifyFile({ ...file, mtimeMs: 99 }, context, { projectId: "p1", existing: layer }),
    ).toEqual({
      ...layer,
      fileMtimeMs: 99,
    });

    const text = `Ref 44\n${LETTER.replace("Dear", "Hello")}Call ${PHONE}\n`;
    const edited = { path: file.path, bytes: Buffer.from(text), mtimeMs: 200 };
    const next = await deidentifyFile(edited, context, { projectId: "p1", existing: layer });
    expect(next).toMatchObject({ reviewState: "stale", fileMtimeMs: 200, defaultMode: "mask" });
    expect(next.fileHash).not.toBe(layer.fileHash);
    expect(itemOf(next, IBAN)).toMatchObject({ action: "redact", overridden: true });
    expect(itemOf(next, PHONE).action).toBe("mask");
    const moved = next.items.find((item) => item.id === mark.id);
    expect(moved?.target).toEqual({
      type: "text",
      start: text.indexOf("the branch"),
      end: text.indexOf("the branch") + 10,
    });
    expect(next.items.some((item) => item.id === gone.id)).toBe(false);
    // The layer is good for the file as it is now.
    const applied = await applyLayer(edited, next, context);
    expect(applied.bytes.toString("utf8")).toContain("Regards from [REDACTED],");
  });
});

describe("spreadsheets", () => {
  const CSV =
    "Full Name,Mobile,Salary,Notes\r\n" +
    `"Alharbi, Sami",${PHONE},12000,"Pays from ${IBAN}, monthly"\r\n` +
    "Noura Alqahtani,0559876543,9000,\r\n";
  const csv = { path: "hr/staff.csv", bytes: Buffer.from(CSV) };

  it("finds values cell by cell, takes a column by its header, and writes the same table back", async () => {
    const context = contextWith();
    const layer = await deidentifyFile(csv, context, { projectId: "p1" });
    expect(layer.family).toBe("csv");
    expect(layer.items.map((item) => [item.kind, item.preview, item.target])).toEqual(
      expect.arrayContaining([
        // No detector knows these for names: the column's header says what they are.
        [
          "PERSON",
          "Alharbi, Sami",
          expect.objectContaining({ scope: "cell", startRow: 1, startColumn: 0 }),
        ],
        ["PERSON", "Noura Alqahtani", expect.objectContaining({ startRow: 2, startColumn: 0 })],
        ["PHONE", PHONE, expect.objectContaining({ startRow: 1, startColumn: 1 })],
        [
          "IBAN",
          IBAN,
          expect.objectContaining({ startRow: 1, startColumn: 3, start: 10, end: 34 }),
        ],
      ]),
    );
    const applied = await applyLayer(csv, layer, context);
    const written = applied.bytes.toString("utf8");
    const [sheet] = await readSpreadsheet({ path: csv.path, bytes: applied.bytes });
    expect(sheet?.rows[0]?.cells).toEqual(["Full Name", "Mobile", "Salary", "Notes"]);
    expect(sheet?.rows[1]?.cells).toEqual([
      expect.stringMatching(/^\[PERSON_\w{5}\]$/),
      expect.stringMatching(/^\[PHONE_\w{5}\]$/),
      "12000",
      expect.stringMatching(/^Pays from \[IBAN_\w{5}\], monthly$/),
    ]);
    // Line endings, the last line's break and the quotes a comma needs are as they were.
    expect(written.split("\r\n")).toHaveLength(4);
    expect(written).toMatch(/,"Pays from \[IBAN_\w{5}\], monthly"\r\n/);
    for (const value of ["Sami", "Noura", PHONE, IBAN]) expect(written).not.toContain(value);
    expect(context.pseudonymizer.unmask(sheet?.rows[1]?.cells[0] ?? "")).toBe("Alharbi, Sami");
  });

  it("carries out a person's rules over a whole column, a row and a range", async () => {
    const context = contextWith();
    let layer = await deidentifyFile(csv, context, { projectId: "p1" });
    // The salary column from under its header, all of the second person's row, and one phone kept.
    layer = addLayerItem(
      layer,
      manualItem({ target: columnTarget(CSV_SHEET, 2), action: "redact", kind: "AMOUNT" }),
    );
    layer = addLayerItem(layer, manualItem({ target: rowTarget(CSV_SHEET, 2), action: "redact" }));
    layer = addLayerItem(
      layer,
      manualItem({
        target: rangeTarget(CSV_SHEET, { startRow: 1, endRow: 1, startColumn: 1, endColumn: 1 }),
        action: "keep",
      }),
    );
    const applied = await applyLayer(csv, layer, context);
    const [sheet] = await readSpreadsheet({ path: csv.path, bytes: applied.bytes });
    expect(sheet?.rows.map((row) => row.cells)).toEqual([
      ["Full Name", "Mobile", "Salary", "Notes"],
      [
        expect.stringMatching(/^\[PERSON_/),
        PHONE,
        "[REDACTED]",
        expect.stringMatching(/^Pays from \[IBAN_/),
      ],
      ["[REDACTED]", "[REDACTED]", "[REDACTED]", ""],
    ]);
    // Nothing of the redacted row or the kept phone is in the vault.
    expect(
      context.pseudonymizer.vault
        .entries()
        .map((entry) => entry.value)
        .toSorted(),
    ).toEqual(["Alharbi, Sami", IBAN]);
  });

  it("rewrites an .xlsx cell by cell, keeps every sheet, and leaves no old value anywhere in the file", async () => {
    const bytes = await xlsxOf({
      Staff: [
        ["Full Name", "National ID", "IBAN", "Greeting"],
        [NAME, 1098765432, IBAN, { formula: 'CONCATENATE("Dear ",A2)', value: `Dear ${NAME}` }],
        ["", "", "", ""],
      ],
      Notes: [[`Call ${NAME} on ${PHONE}`], ["Nothing personal here"], ["Nothing personal here"]],
    });
    const file = { path: "hr/staff.xlsx", bytes };
    const context = contextWith([NAME]);
    let layer = await deidentifyFile(file, context, { projectId: "p1" });
    expect(layer.family).toBe("xlsx");
    expect(layer.items.map((item) => [item.kind, item.preview])).toEqual(
      expect.arrayContaining([
        ["PERSON", NAME],
        ["ID", "1098765432"],
        ["IBAN", IBAN],
        ["PHONE", PHONE],
      ]),
    );
    layer = addLayerItem(layer, manualItem({ target: columnTarget("Staff", 1), action: "redact" }));
    const applied = await applyLayer(file, layer, context);

    const sheets = await readSpreadsheet({ path: file.path, bytes: applied.bytes });
    expect(sheets.map((sheet) => sheet.name)).toEqual(["Staff", "Notes"]);
    expect(sheets[0]?.rows[1]?.cells).toEqual([
      expect.stringMatching(/^\[PERSON_\w{5}\]$/),
      "[REDACTED]",
      expect.stringMatching(/^\[IBAN_\w{5}\]$/),
      expect.stringMatching(/^Dear \[PERSON_\w{5}\]$/),
    ]);
    expect(sheets[0]?.rows[0]?.cells).toEqual(["Full Name", "National ID", "IBAN", "Greeting"]);
    expect(sheets[1]?.rows.map((row) => row.cells[0])).toEqual([
      expect.stringMatching(/^Call \[PERSON_\w{5}\] on \[PHONE_\w{5}\]$/),
      "Nothing personal here",
      "Nothing personal here",
    ]);

    const parts = await partsOf(applied.bytes);
    for (const [name, content] of parts) {
      if (typeof content !== "string") continue;
      expect(isWellFormed(content), name).toBe(true);
      // Not in a cell, not in the shared strings, not in the properties.
      for (const value of [NAME, "1098765432", IBAN, PHONE, "Huda Alsubaie"]) {
        expect(content, `${name} holds ${value}`).not.toContain(value);
      }
    }
    // The formula went with its cell, and so did the list that named it.
    expect(parts.has("xl/calcChain.xml")).toBe(false);
    expect(parts.get("[Content_Types].xml")).not.toContain("calcChain");
    expect(parts.get("xl/_rels/workbook.xml.rels")).not.toContain("calcChain");
    expect(parts.get("xl/worksheets/sheet1.xml")).not.toContain("<f>");
    expect(String(parts.get("xl/sharedStrings.xml"))).toContain("Nothing personal here");
  });
});

/** A picture to embed: a line with a name in it, and a QR code that opens the document. */
const embeddedPicture = async () => {
  const words = line(80, ["Signed", "by", "Sami", "Alharbi", "today"]);
  const page = paintPage(WIDTH, HEIGHT, words);
  const code = await codePixels(LINK);
  stampOn(page, code, 620, 260);
  const symbol = { x: 640, y: 280, width: code.width - 40, height: code.height - 40 };
  return { words, bytes: await pngOf(page), symbol };
};

const expectPictureScrubbed = async (
  bytes: Buffer,
  picture: Awaited<ReturnType<typeof embeddedPicture>>,
) => {
  expect((await sharp(bytes).metadata()).format).toBe("png");
  for (const word of picture.words) {
    const sensitive = ["Sami", "Alharbi"].includes(word.text);
    expect(await shows(bytes, WIDTH, word), word.text).toBe(sensitive ? "hidden" : "shown");
  }
  expect(await darkShare(bytes, picture.symbol)).toBeGreaterThan(0.85);
};

describe("Word documents", () => {
  const W = {
    text: new Set(["w:t", "w:delText", "w:instrText"]),
    paragraph: "w:p",
    tab: new Set(["w:tab"]),
    settings: new Set(["w:tabs"]),
    lineBreak: new Set(["w:br"]),
    row: "w:tr",
    cell: "w:tc",
  };

  const build = async () => {
    const picture = await embeddedPicture();
    const body =
      // A name typed in two runs, an ampersand, and tab stops that are settings, not text.
      paragraph("Dear Sa", "mi Alharbi,") +
      paragraph(`IBAN ${IBAN} &amp; phone ${PHONE}`) +
      table([
        ["Full Name", "esrablishment alwaha", "اسم الشخص"],
        ["Bank Name", "Example Bank", "اسم البنك"],
      ]) +
      `<w:p><w:del><w:r><w:delText>${NAME}</w:delText></w:r></w:del></w:p>` +
      '<w:p><w:pPr><w:tabs><w:tab w:val="left" w:pos="720"/></w:tabs></w:pPr><w:r><w:t>Plain line</w:t></w:r></w:p>';
    const bytes = await docxOf(body, {
      "word/header1.xml": wordPart("hdr", paragraph(`Prepared for ${NAME}`)),
      "word/footnotes.xml": wordPart(
        "footnotes",
        `<w:footnote>${paragraph(`Verify at ${LINK}`)}</w:footnote>`,
      ),
      "word/_rels/document.xml.rels":
        '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        `<Relationship Id="rId5" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="${LINK}" TargetMode="External"/>` +
        '<Relationship Id="rId6" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="https://www.example.com/" TargetMode="External"/>' +
        "</Relationships>",
      "word/media/image1.png": picture.bytes,
      "word/media/drawing1.emf": Buffer.from("not pixels"),
    });
    return { file: { path: "offers/offer.docx", bytes }, picture };
  };

  it("replaces text in every part in the order it is read, paints its pictures, and stays a document", async () => {
    const { file, picture } = await build();
    const context = contextWith([NAME], plantedReader(WIDTH, picture.words));
    const layer = await deidentifyFile(file, context, { projectId: "p1" });
    expect(layer.family).toBe("docx");
    expect(layer.warnings).toEqual(["unscanned-media: word/media/drawing1.emf"]);
    expect(context.pseudonymizer.vault.entries()).toEqual([]);
    const places = layer.items.map((item) =>
      item.target.type === "xml" || item.target.type === "media"
        ? [item.target.part, item.kind, item.preview]
        : [],
    );
    expect(places).toEqual(
      expect.arrayContaining([
        ["word/document.xml", "PERSON", NAME],
        ["word/document.xml", "IBAN", IBAN],
        ["word/document.xml", "PHONE", PHONE],
        // A name no detector knows, found by the label in the cell beside it.
        ["word/document.xml", "PERSON", "esrablishment alwaha"],
        ["word/header1.xml", "PERSON", NAME],
        ["word/footnotes.xml", "URL", LINK],
        ["word/media/image1.png", "PERSON", NAME],
        ["word/media/image1.png", "URL", LINK],
      ]),
    );

    const applied = await applyLayer(file, layer, context);
    const parts = await partsOf(applied.bytes);
    expect([...parts.keys()].toSorted()).toEqual(
      [...(await partsOf(file.bytes)).keys()].toSorted(),
    );
    const document = String(parts.get("word/document.xml"));
    const text = readTextPart("word/document.xml", document, W).text;
    expect(text).toMatch(
      new RegExp(
        `^Dear (\\[PERSON_\\w{5}\\]),\\nIBAN \\[IBAN_\\w{5}\\] & phone \\[PHONE_\\w{5}\\]\\n` +
          `Full Name\\t\\[PERSON_\\w{5}\\]\\tاسم الشخص\\nBank Name\\tExample Bank\\tاسم البنك\\n\\1\\nPlain line\\n$`,
      ),
    );
    expect(context.pseudonymizer.unmask(text)).toContain(
      `Dear ${NAME},\nIBAN ${IBAN} & phone ${PHONE}\n`,
    );
    for (const [name, content] of parts) {
      if (typeof content !== "string") continue;
      expect(isWellFormed(content), name).toBe(true);
      for (const value of [
        NAME,
        "mi Alharbi",
        IBAN,
        PHONE,
        "esrablishment",
        "7Xk2PqR",
        "Huda Alsubaie",
      ]) {
        expect(content, `${name} holds ${value}`).not.toContain(value);
      }
    }
    // Formatting is untouched: every run still carries its own.
    expect(document.match(/<w:rPr><w:b\/><\/w:rPr>/g)).toHaveLength(9);
    // The link's address went with its text; a link that names nobody stays.
    expect(parts.get("word/_rels/document.xml.rels")).toContain('Target="about:blank"');
    expect(parts.get("word/_rels/document.xml.rels")).toContain("https://www.example.com/");
    await expectPictureScrubbed(parts.get("word/media/image1.png") as Buffer, picture);
    expect((parts.get("word/media/drawing1.emf") as Buffer).toString()).toBe("not pixels");
  });

  it("writes a hand-marked stretch that runs over two paragraphs into the first, and empties the rest", async () => {
    const bytes = await docxOf(
      paragraph("Project Falcon is", " confidential") + paragraph("until launch", ". Then public."),
    );
    const file = { path: "notes/plan.docx", bytes };
    const context = contextWith();
    let layer = await deidentifyFile(file, context, { projectId: "p1", defaultMode: "redact" });
    expect(layer.items).toEqual([]);
    // From "confidential" to "launch": across a run's edge and a paragraph's.
    const text = "Project Falcon is confidential\nuntil launch. Then public.\n";
    layer = addLayerItem(
      layer,
      manualItem({
        target: {
          type: "xml",
          part: "word/document.xml",
          start: text.indexOf("confidential"),
          end: text.indexOf(". Then"),
        },
        action: "redact",
      }),
    );
    const applied = await applyLayer(file, layer, context);
    const document = String((await partsOf(applied.bytes)).get("word/document.xml"));
    expect(isWellFormed(document)).toBe(true);
    expect(readTextPart("d", document, W).text).toBe(
      "Project Falcon is [REDACTED]\n. Then public.\n",
    );
  });

  it("redacts text and pictures alike with nothing written to the vault", async () => {
    const { file, picture } = await build();
    const context = contextWith([NAME], plantedReader(WIDTH, picture.words));
    const layer = await deidentifyFile(file, context, { projectId: "p1", defaultMode: "redact" });
    const applied = await applyLayer(file, layer, context);
    const parts = await partsOf(applied.bytes);
    expect(readTextPart("d", String(parts.get("word/document.xml")), W).text).toBe(
      "Dear [REDACTED],\nIBAN [REDACTED] & phone [REDACTED]\nFull Name\t[REDACTED]\tاسم الشخص\nBank Name\tExample Bank\tاسم البنك\n[REDACTED]\nPlain line\n",
    );
    await expectPictureScrubbed(parts.get("word/media/image1.png") as Buffer, picture);
    expect(context.pseudonymizer.vault.entries()).toEqual([]);
  });
});

describe("PowerPoint files", () => {
  it("replaces text on slides and in notes, and paints the pictures", async () => {
    const picture = await embeddedPicture();
    const bytes = await pptxOf(
      [[["Quarterly review"], ["Prepared for ", "Sa", "mi Alharbi"]], [[`Account ${IBAN}`]]],
      [[[`Call ${NAME} on ${PHONE} before the meeting`]]],
      { "ppt/media/image1.png": picture.bytes },
    );
    const file = { path: "decks/review.pptx", bytes };
    const context = contextWith([NAME], plantedReader(WIDTH, picture.words));
    let layer = await deidentifyFile(file, context, { projectId: "p1" });
    expect(layer.family).toBe("pptx");
    layer = setItemAction(layer, itemOf(layer, IBAN).id, "redact");
    const applied = await applyLayer(file, layer, context);
    const parts = await partsOf(applied.bytes);
    const A = {
      text: new Set(["a:t"]),
      paragraph: "a:p",
      tab: new Set<string>(),
      settings: new Set<string>(),
      lineBreak: new Set(["a:br"]),
      row: "a:tr",
      cell: "a:tc",
    };
    const textOf = (name: string) => readTextPart(name, String(parts.get(name)), A).text;
    expect(textOf("ppt/slides/slide1.xml")).toMatch(
      /^Quarterly review\nPrepared for \[PERSON_\w{5}\]\n$/,
    );
    expect(textOf("ppt/slides/slide2.xml")).toBe("Account [REDACTED]\n");
    expect(textOf("ppt/notesSlides/notesSlide1.xml")).toMatch(
      /^Call \[PERSON_\w{5}\] on \[PHONE_\w{5}\] before the meeting\n$/,
    );
    for (const [name, content] of parts) {
      if (typeof content !== "string") continue;
      expect(isWellFormed(content), name).toBe(true);
      for (const value of [NAME, "mi Alharbi", IBAN, PHONE, "Huda Alsubaie"]) {
        expect(content, `${name} holds ${value}`).not.toContain(value);
      }
    }
    expect(
      String(parts.get("ppt/slides/slide1.xml")).match(/<a:rPr lang="en-US"\/>/g),
    ).toHaveLength(4);
    await expectPictureScrubbed(parts.get("ppt/media/image1.png") as Buffer, picture);
    // The redacted account is not in the vault; the masked values are.
    expect(
      context.pseudonymizer.vault
        .entries()
        .map((entry) => entry.kind)
        .toSorted(),
    ).toEqual(["PERSON", "PHONE", "URL"]);
  });
});

describe("pictures", () => {
  const words = [
    ...line(80, ["Contract", "of", "Sami", "Alharbi", "ends", "in", "March"]),
    ...line(140, ["Call", PHONE, "after", "noon"]),
  ];
  const picture = async (format: "png" | "jpeg" = "png") => {
    const page = paintPage(WIDTH, HEIGHT, words);
    const code = await codePixels(LINK);
    stampOn(page, code, 620, 260);
    const raw = sharp(page.data, { raw: { width: WIDTH, height: HEIGHT, channels: 3 } });
    return {
      bytes: await (format === "png" ? raw.png() : raw.jpeg({ quality: 95 })).toBuffer(),
      symbol: { x: 640, y: 280, width: code.width - 40, height: code.height - 40 },
    };
  };
  const hidden = async (bytes: Buffer, texts: ReadonlyArray<string>) => {
    for (const word of words) {
      expect(await shows(bytes, WIDTH, word), word.text).toBe(
        texts.includes(word.text) ? "hidden" : "shown",
      );
    }
  };

  it("finds values and codes with where they are, and paints what each item's action says", async () => {
    const { bytes, symbol } = await picture();
    const file = { path: "scans/contract.png", bytes };
    const context = contextWith([NAME], plantedReader(WIDTH, words));
    let layer = await deidentifyFile(file, context, { projectId: "p1" });
    expect(layer.family).toBe("image");
    expect(layer.items.map((item) => [item.origin, item.kind, item.preview, item.label])).toEqual([
      ["value", "PERSON", NAME, "Name"],
      ["value", "PHONE", PHONE, "Phone number"],
      ["code", "URL", LINK, "QR code: verification link (alah.li)"],
    ]);
    for (const item of layer.items) {
      expect(item.target.type).toBe("region");
      if (item.target.type !== "region") continue;
      expect(item.target.page).toBe(0);
      for (const point of item.target.polygon) {
        expect(point.x).toBeGreaterThanOrEqual(0);
        expect(point.x).toBeLessThanOrEqual(1);
        expect(point.y).toBeLessThanOrEqual(1);
      }
    }
    expect(context.pseudonymizer.vault.entries()).toEqual([]);

    // The phone is kept, and a box is drawn by hand over the first word.
    layer = setItemAction(layer, itemOf(layer, PHONE).id, "keep");
    const [first] = words;
    layer = addLayerItem(
      layer,
      manualItem({
        target: boxRegion(0, {
          x: 55 / WIDTH,
          y: 75 / HEIGHT,
          width: ((first?.width ?? 0) + 10) / WIDTH,
          height: 32 / HEIGHT,
        }),
        action: "mask",
      }),
    );
    const applied = await applyLayer(file, layer, context);
    const metadata = await sharp(applied.bytes).metadata();
    expect([metadata.format, metadata.width, metadata.height]).toEqual(["png", WIDTH, HEIGHT]);
    expect(applied.mediaType).toBe("image/png");
    await hidden(applied.bytes, ["Contract", "Sami", "Alharbi"]);
    expect(await darkShare(applied.bytes, symbol)).toBeGreaterThan(0.85);
    expect(applied.layer.items.map((item) => item.replacement)).toEqual([
      expect.stringMatching(/^\[PERSON_\w{5}\]$/),
      undefined,
      expect.stringMatching(/^\[URL_\w{5}\]$/),
      // A box drawn over something that was never read holds no value to give back.
      "[REDACTED]",
    ]);
    expect(
      context.pseudonymizer.vault
        .entries()
        .map((entry) => entry.value)
        .toSorted(),
    ).toEqual([NAME, LINK].toSorted());
  });

  it("redacts a JPEG to a JPEG, with solid boxes and an empty vault", async () => {
    const { bytes, symbol } = await picture("jpeg");
    const file = { path: "scans/contract.jpg", bytes };
    const context = contextWith([NAME], plantedReader(WIDTH, words));
    const layer = await deidentifyFile(file, context, { projectId: "p1", defaultMode: "redact" });
    const applied = await applyLayer(file, layer, context);
    expect((await sharp(applied.bytes).metadata()).format).toBe("jpeg");
    expect(applied.mediaType).toBe("image/jpeg");
    await hidden(applied.bytes, ["Sami", "Alharbi", PHONE]);
    expect(await darkShare(applied.bytes, symbol)).toBeGreaterThan(0.85);
    expect(applied.layer.items.every((item) => item.replacement === "[REDACTED]")).toBe(true);
    expect(context.pseudonymizer.vault.entries()).toEqual([]);
  });

  it("hides a picture whole when nothing can read it, still decodes its codes, and says so", async () => {
    const { bytes } = await picture();
    const file = { path: "scans/contract.png", bytes };
    const context = contextWith([NAME]);
    const layer = await deidentifyFile(file, context, { projectId: "p1" });
    expect(layer.warnings).toEqual(["no-reader"]);
    expect(layer.items.map((item) => [item.origin, item.action, item.preview])).toEqual([
      ["unreadable", "mask", undefined],
      ["code", "mask", LINK],
    ]);
    const applied = await applyLayer(file, layer, context);
    expect(
      await darkShare(applied.bytes, { x: 0, y: 0, width: WIDTH, height: HEIGHT }),
    ).toBeGreaterThan(0.97);
    // A person who has looked may open it again and mark what they see.
    const [whole] = layer.items;
    const opened = await applyLayer(file, setItemAction(layer, whole?.id ?? "", "keep"), context);
    await hidden(opened.bytes, []);
  });
});

describe("PDFs", () => {
  const first = [
    ...line(80, ["Contract", "of", "Sami", "Alharbi", "ends", "in", "March"]),
    ...line(140, ["Call", PHONE, "after", "noon"]),
  ];
  const second = line(420, ["Account", IBAN, "at", "the", "bank"]);

  const build = async () => {
    const pageOne = paintPage(WIDTH, HEIGHT, first);
    const pageTwo = paintPage(WIDTH, HEIGHT, second);
    const code = await codePixels(LINK);
    stampOn(pageTwo, code, 620, 60);
    const builder = new PagePdfBuilder();
    await builder.addPage(pageOne, WIDTH, HEIGHT);
    await builder.addPage(pageTwo, WIDTH, HEIGHT);
    return {
      file: { path: "letters/iban-letter.pdf", bytes: builder.finish() },
      symbol: { x: 640, y: 80, width: code.width - 40, height: code.height - 40 },
      // One reader for both pages: it reads the words whose ink is on the page it is shown.
      reader: plantedReader(WIDTH, [...first, ...second]),
    };
  };

  const pagesOf = async (bytes: Buffer) => {
    const pdf = await openPdf(bytes, { scale: 1 });
    try {
      const pages: Array<Buffer> = [];
      for (let index = 0; index < pdf.pageCount; index += 1) {
        const page = await pdf.renderPage(index);
        expect([page.widthPoints, page.heightPoints]).toEqual([WIDTH, HEIGHT]);
        pages.push(await pngOf(page.raster));
      }
      return pages;
    } finally {
      await pdf.close();
    }
  };

  it("reads every page as a picture, paints found and hand-drawn regions, and writes a PDF of pictures", async () => {
    const { file, symbol, reader } = await build();
    const context = contextWith([NAME], reader);
    let layer = await deidentifyFile(file, context, { projectId: "p1" });
    expect(layer.family).toBe("pdf");
    expect(
      layer.items.map((item) => [
        item.target.type === "region" ? item.target.page : -1,
        item.kind,
        item.preview,
      ]),
    ).toEqual([
      [0, "PERSON", NAME],
      [0, "PHONE", PHONE],
      [1, "IBAN", IBAN],
      [1, "URL", LINK],
    ]);
    expect(context.pseudonymizer.vault.entries()).toEqual([]);
    // A free-form box on the second page, over the word "bank".
    const bank = second.at(-1);
    layer = addLayerItem(
      layer,
      manualItem({
        target: boxRegion(1, {
          x: ((bank?.x ?? 0) - 5) / WIDTH,
          y: ((bank?.y ?? 0) - 5) / HEIGHT,
          width: ((bank?.width ?? 0) + 10) / WIDTH,
          height: 32 / HEIGHT,
        }),
        action: "redact",
      }),
    );
    layer = setItemAction(layer, itemOf(layer, PHONE).id, "redact");

    const exported = await exportDeidentified(file, layer, context);
    expect(exported).toMatchObject({
      fileName: "iban-letter.deidentified.pdf",
      mediaType: "application/pdf",
    });
    expect(exported.counts).toEqual({ mask: 3, redact: 2, keep: 0 });
    const [pageOne, pageTwo] = await pagesOf(exported.bytes);
    for (const word of first) {
      const sensitive = ["Sami", "Alharbi", PHONE].includes(word.text);
      expect(await shows(pageOne ?? Buffer.alloc(0), WIDTH, word), word.text).toBe(
        sensitive ? "hidden" : "shown",
      );
    }
    for (const word of second) {
      const sensitive = [IBAN, "bank"].includes(word.text);
      expect(await shows(pageTwo ?? Buffer.alloc(0), WIDTH, word), word.text).toBe(
        sensitive ? "hidden" : "shown",
      );
    }
    expect(await darkShare(pageTwo ?? Buffer.alloc(0), symbol)).toBeGreaterThan(0.85);
    expect(
      context.pseudonymizer.vault
        .entries()
        .map((entry) => entry.value)
        .toSorted(),
    ).toEqual([NAME, IBAN, LINK].toSorted());
  });

  it("leaves none of a page's own text, links or form answers in the copy", async () => {
    // Real text, an annotation as a filled form holds its answers, and a link to the original.
    const bytes = rawPdf([
      "<< /Type /Catalog /Pages 2 0 R >>",
      "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
      "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 400 200] /Contents 4 0 R " +
        "/Resources << /Font << /F1 5 0 R >> >> /Annots [6 0 R 8 0 R] >>",
      streamObject("", `BT /F1 18 Tf 20 150 Td (IBAN ${IBAN}) Tj ET`),
      "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
      `<< /Type /Annot /Subtype /FreeText /Rect [20 40 220 70] /F 4 /Contents (${NAME}) /DA (/F1 14 Tf 0 g) /AP << /N 7 0 R >> >>`,
      streamObject(
        "/Type /XObject /Subtype /Form /BBox [0 0 200 30] /Resources << /Font << /F1 5 0 R >> >>",
        `BT /F1 14 Tf 2 8 Td (${NAME}) Tj ET`,
      ),
      `<< /Type /Annot /Subtype /Link /Rect [20 10 200 30] /A << /S /URI /URI (${LINK}) >> >>`,
    ]);
    const file = { path: "forms/kyc.pdf", bytes };
    expect(bytes.toString("latin1")).toContain(NAME);
    // No reader: the page is hidden whole, which is all this test needs of the picture.
    const context = contextWith();
    const layer = await deidentifyFile(file, context, { projectId: "p1", defaultMode: "redact" });
    const applied = await applyLayer(file, layer, context);
    const source = applied.bytes.toString("latin1");
    for (const absent of [NAME, IBAN, LINK, "/Font", "/Annots", "/URI", "/Contents (", "BT "]) {
      expect(source, absent).not.toContain(absent);
    }
    const [page] = await (async () => {
      const pdf = await openPdf(applied.bytes, { scale: 1 });
      try {
        return [await pdf.renderPage(0)];
      } finally {
        await pdf.close();
      }
    })();
    expect([page?.widthPoints, page?.heightPoints]).toEqual([400, 200]);
  });
});
