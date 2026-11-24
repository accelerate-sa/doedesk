import { describe, expect, it } from "vite-plus/test";

import { indexDocument, locateQuote, longestCopiedRun, quoteText } from "./evidence.ts";
import {
  answerSchema,
  checkField,
  DEFAULT_CHECKS,
  fieldSpecProblem,
  type FieldSpec,
} from "./fields.ts";
import { daysBetween, hijriToGregorian, parseDate, parseNumber } from "./values.ts";

describe("numbers as documents write them", () => {
  it.each([
    ["SAR 1,284,500.75", 1284500.75, false],
    ["١٬٢٨٤٬٥٠٠٫٧٥ ريال", 1284500.75, false],
    ["1 284 500,75", 1284500.75, false],
    ["1.284.500", 1284500, false],
    ["1.2 million", 1_200_000, false],
    ["SAR 617.1 mn", 617_100_000, false],
    ["٣ آلاف ريال", 3000, false],
    ["٢٫٥٪", 2.5, true],
    ["2.5 بالمئة", 2.5, true],
    ["(1,200)", -1200, false],
    ["3.50x", 3.5, false],
    ["45 days", 45, false],
  ])("%s", (text, value, percent) => {
    expect(parseNumber(text)).toEqual({ value, percent });
  });

  it.each([
    ["ستمئة وأربعة وتسعون ألف ريال سعودي", 694_000],
    ["ثلاثمائة ألف ريال", 300_000],
    ["سبعمائة وخمسون ألف ريال سعودي", 750_000],
    ["خمسة وأربعون يوماً", 45],
    ["أحد عشر", 11],
    ["ألفان وخمسمئة", 2_500],
    ["مليون ومئتا ألف", 1_000_000],
    ["eight hundred sixty-seven thousand Saudi Riyals", 867_000],
    ["one million two hundred and fifty thousand", 1_250_000],
    ["forty-five", 45],
    ["thirty days", 30],
  ])("reads the amount %s states in words", (written, expected) => {
    expect(parseNumber(written)?.value).toBe(expected);
  });

  it("reads figures and not words when a text has both, and nothing from ordinary words", () => {
    expect(parseNumber("649,000 ريال (ستمئة وأربعة وتسعون ألف)")?.value).toBe(649_000);
    expect(parseNumber("the Supplier shall deliver")).toBeNull();
  });

  it("reads a length in metres as written, not as millions", () => {
    expect(parseNumber("5 m")?.value).toBe(5);
  });
});

describe("dates as documents write them", () => {
  it.each([
    ["2026-03-14", "2026-03-14", "gregorian"],
    ["14/03/2026", "2026-03-14", "gregorian"],
    ["03/14/2026", "2026-03-14", "gregorian"],
    ["March 14, 2026", "2026-03-14", "gregorian"],
    ["14 مارس 2026م", "2026-03-14", "gregorian"],
    ["١٤/٠٣/٢٠٢٦م", "2026-03-14", "gregorian"],
    ["15/08/1447هـ", "2026-02-03", "hijri"],
    ["١٥ شعبان ١٤٤٧هـ", "2026-02-03", "hijri"],
    ["1447/08/15هـ", "2026-02-03", "hijri"],
    ["15 Shaban 1447 AH", "2026-02-03", "hijri"],
  ])("%s", (text, iso, calendar) => {
    expect(parseDate(text)).toEqual({ iso, calendar });
  });

  it("gives nothing for a month and year alone, or an impossible day", () => {
    expect(parseDate("March 2026")).toBeNull();
    expect(parseDate("31/02/2026")).toBeNull();
  });

  it("counts a Hijri year as its real length, not 365 days", () => {
    const start = hijriToGregorian(1446, 9, 1);
    const end = hijriToGregorian(1447, 9, 1);
    expect(start).not.toBeNull();
    expect(daysBetween(start ?? "", end ?? "")).toBe(354);
  });
});

describe("quotes checked against the document", () => {
  const document = indexDocument(
    "رقـم  أمر الشراء : PO-2025-554514\nالإجمالي المستحق :\n   ٨٥٢٬٠٥٨٫٩٠ ريال\nNet loss for the year   (240,759)   161,739",
  );

  it("finds a quote that differs only in digit script, marks and spacing", () => {
    const located = locateQuote(document, "رقم أمر الشراء: PO-2025-554514");
    expect(located).not.toBeNull();
    expect(located?.line).toBe(1);
    const amount = locateQuote(document, "852,058.90 ريال");
    expect(amount === null ? null : quoteText(document, amount)).toBe("٨٥٢٬٠٥٨٫٩٠ ريال");
  });

  it("does not find a quote with a changed digit", () => {
    expect(locateQuote(document, "PO-2025-554515")).toBeNull();
  });

  it("accepts parts joined by an ellipsis, in order only", () => {
    expect(locateQuote(document, "رقم أمر الشراء ... الإجمالي المستحق")).not.toBeNull();
    expect(locateQuote(document, "الإجمالي المستحق ... رقم أمر الشراء")).toBeNull();
  });

  it("measures how many consecutive words a text lifts from the document", () => {
    expect(longestCopiedRun(document, "The year ended with a net loss for the year again")).toBe(5);
    expect(longestCopiedRun(document, "The company lost money")).toBeLessThanOrEqual(1);
  });
});

describe("a field's answer", () => {
  const document = indexDocument(
    [
      "(All amounts in thousands of Saudi Riyals)",
      "Revenue 2,558,004",
      "Operating profit (loss) (228,656)",
      "Total Net Debt was SAR 617.1 million",
      "Approved on 08-04-2026. Auditor: Castlereagh Capital",
    ].join("\n"),
  );
  const number: FieldSpec = { name: "amount", type: "number", description: "" };
  const check = (field: FieldSpec, raw: unknown) =>
    checkField(field, raw, document, DEFAULT_CHECKS);

  it("applies the scale a heading states, and not twice when the value carries its own", () => {
    expect(
      check(number, { quote: "Revenue 2,558,004", value: "2,558,004", scale: "thousand" }).value,
    ).toBe(2_558_004_000);
    expect(
      check(number, {
        quote: "Total Net Debt was SAR 617.1 million",
        value: "SAR 617.1 million",
        scale: "million",
      }).value,
    ).toBe(617_100_000);
  });

  it("takes a no without a passage, and a choice without one only when asked again", () => {
    const flag: FieldSpec = { name: "audited", type: "boolean", description: "" };
    const kind: FieldSpec = {
      name: "kind",
      type: "enum",
      description: "",
      options: ["audit", "none"],
    };
    // The document is silent: there is nothing to quote for "no". A "yes" must show its passage.
    expect(check(flag, { quote: "", value: false })).toMatchObject({ status: "ok", value: false });
    expect(check(flag, { quote: "", value: true }).status).toBe("unverified");
    expect(check(flag, { quote: "Auditor: Castlereagh Capital", value: true }).status).toBe("ok");
    expect(check(kind, { quote: "", value: "none" }).status).toBe("unverified");
    expect(
      checkField(kind, { quote: "", value: "none" }, document, {
        ...DEFAULT_CHECKS,
        unquotedChoice: true,
      }),
    ).toMatchObject({ status: "ok", value: "none" });
  });

  it("reads a bracketed figure as negative even when the worker left the brackets out", () => {
    const answer = check(number, {
      quote: "Operating profit (loss) (228,656)",
      value: "228,656",
      scale: "thousand",
    });
    expect(answer.value).toBe(-228_656_000);
  });

  it("leaves a bracketed figure positive where the brackets are not a sign", () => {
    const contract = indexDocument(
      [
        "notice period from ninety (90) calendar days to forty-five (45) calendar days.",
        "Confidentiality survives for five (5) years. Cure period: thirty (30).",
        "يلتزم الطرف الثاني بالسداد خلال (30) يوماً، وتسعون (90) يوماً للتوريد.",
        "المادة (12)",
        "(3) The Supplier pays a penalty under Clause 14(2) and Article (7).",
        "Net loss for the year (1,250)",
        "Change in fair value\t(310)\tNote 9",
      ].join("\n"),
    );
    const read = (quote: string, value: string) =>
      checkField(number, { quote, value, scale: "none" }, contract, DEFAULT_CHECKS).value;
    expect(read("forty-five (45) calendar days", "45")).toBe(45);
    expect(read("five (5) years", "5")).toBe(5);
    expect(read("Cure period: thirty (30)", "30")).toBe(30);
    expect(read("خلال (30) يوماً", "30")).toBe(30);
    expect(read("وتسعون (90) يوماً", "90")).toBe(90);
    expect(read("المادة (12)", "12")).toBe(12);
    expect(read("(3) The Supplier", "3")).toBe(3);
    expect(read("Clause 14(2)", "2")).toBe(2);
    expect(read("Article (7)", "7")).toBe(7);
    // A figure of an account keeps its sign, at a line's end and before another column.
    expect(read("Net loss for the year (1,250)", "1,250")).toBe(-1250);
    expect(read("Change in fair value\t(310)", "310")).toBe(-310);
  });

  it("applies a scale without leaving floating-point noise in the value", () => {
    const report = indexDocument("(SAR thousands)\nBacklog 2.01\nPipeline was 2.05 million");
    const read = (quote: string, value: string, scale: string) =>
      checkField(number, { quote, value, scale }, report, DEFAULT_CHECKS).value;
    // In binary, 2.01 * 1e3 is 2009.9999999999998 and 2.05 * 1e6 is 2049999.9999999998.
    expect(read("Backlog 2.01", "2.01", "thousand")).toBe(2010);
    expect(read("Pipeline was 2.05 million", "2.05 million", "none")).toBe(2_050_000);
  });

  it("reads a list of rows, each cell checked like a single answer, and fails it on one bad cell", () => {
    const budget = indexDocument(
      [
        "ITEMIZED PROJECT BUDGET (SAR thousands)",
        "1. Laboratory hardware: 140.5 (quoted)",
        "2. Simulation software: 80 (quoted)",
        "3. Office furniture: (35)",
        "Due 5 February 2026.",
      ].join("\n"),
    );
    const items: FieldSpec = {
      name: "items",
      type: "list",
      description: "Every budget line.",
      columns: [
        { name: "label", type: "identifier" },
        { name: "amount", type: "number" },
        { name: "quoted", type: "boolean" },
        { name: "due", type: "date" },
      ],
    };
    const row = (quote: string, label: string, amount: string, quoted: boolean) => ({
      quote,
      label,
      amount,
      quoted,
      due: null,
      scale: "thousand",
    });
    const rows = [
      row("1. Laboratory hardware: 140.5 (quoted)", "Laboratory hardware", "140.5", true),
      row("2. Simulation software: 80 (quoted)", "Simulation software", "80", true),
      row("3. Office furniture: (35)", "Office furniture", "35", false),
    ];
    const read = (raw: unknown) => checkField(items, raw, budget, DEFAULT_CHECKS);
    const answer = read(rows);
    expect(answer).toMatchObject({ status: "ok", value: 3 });
    expect(answer.rows?.map((cells) => cells.map((cell) => cell.value))).toEqual([
      ["Laboratory hardware", 140_500, true, null],
      ["Simulation software", 80_000, true, null],
      ["Office furniture", -35_000, false, null],
    ]);
    // A cell that is not in its row fails the list: a list short of a row would be summed as whole.
    const wrong = read([rows[0], { ...rows[1], amount: "81" }, rows[2]]);
    expect(wrong.status).toBe("unverified");
    expect(wrong.problems[0]).toContain("row 2, amount");
    expect(read([]).status).toBe("absent");
    expect(read({ quote: "", value: null }).status).toBe("unverified");
    expect(fieldSpecProblem([{ ...items, columns: [] }])).toContain("between 1 and 8 columns");
    expect(
      fieldSpecProblem([{ ...items, columns: [{ name: "quote", type: "number" }] }]),
    ).toContain('not "quote" or "scale"');
    // The worker is held to one object per row, with the row's passage and its scale.
    expect(answerSchema([items]).properties).toMatchObject({
      items: {
        type: "array",
        items: { required: ["quote", "label", "amount", "quoted", "due", "scale"] },
      },
    });
  });

  it("reads an amount copied in words, where a contract says the words prevail", () => {
    const contract = indexDocument(
      "(SAR thousands)\nلا يتجاوز مجموع الغرامات مبلغ 649,000 ريال (ستمئة وأربعة وتسعون ألف ريال سعودي).",
    );
    const read = (value: string) =>
      checkField(number, { quote: value, value, scale: "thousand" }, contract, DEFAULT_CHECKS);
    // The words state the whole amount, so a heading's scale does not apply to them.
    expect(read("ستمئة وأربعة وتسعون ألف ريال سعودي")).toMatchObject({
      status: "ok",
      value: 694_000,
    });
    expect(read("649,000").value).toBe(649_000_000);
    // Words that are not in the document are refused like any other value.
    expect(read("ستمئة وتسعة وأربعون ألف").status).toBe("unverified");
  });

  it("refuses a value that is not in the document, and says why", () => {
    const answer = check(number, { quote: "Revenue 2,558,004", value: "2,558,040", scale: "none" });
    expect(answer.status).toBe("unverified");
    expect(answer.value).toBeNull();
    expect(answer.problems[0]).toContain("does not occur");
  });

  it("finds a short value as one token, in the passage that states it", () => {
    const order = indexDocument(
      [
        "الصنف 1",
        "5 كراتين",
        "بند الميزانية: 272815352",
        "مدة التوريد: ١٥ يوماً من تاريخ أمر الشراء",
      ].join("\n"),
    );
    const answer = checkField(
      { name: "period", type: "number", description: "" },
      { quote: "مدة التوريد: 15 يوماً", value: "15", scale: "none" },
      order,
      DEFAULT_CHECKS,
    );
    expect(answer).toMatchObject({ status: "ok", value: 15, surface: "١٥" });
    // Digits cut out of a longer number are not the value, even with the check asking only that it occurs.
    expect(
      checkField(
        { name: "period", type: "number", description: "" },
        { quote: "بند الميزانية", value: "2815", scale: "none" },
        order,
        DEFAULT_CHECKS,
      ).status,
    ).toBe("unverified");
  });

  it("finds an Arabic name written with a letter attached in front of it", () => {
    const contract = indexDocument(
      "عقد توريد بين مؤسسة وهج (الطرف الأول) وشركة أفق للصناعة (الطرف الثاني).",
    );
    const answer = checkField(
      { name: "second_party", type: "identifier", description: "" },
      { quote: "وشركة أفق للصناعة (الطرف الثاني)", value: "شركة أفق للصناعة" },
      contract,
      DEFAULT_CHECKS,
    );
    expect(answer).toMatchObject({ status: "ok", value: "شركة أفق للصناعة" });
  });

  it("treats null as absent, not as a failure", () => {
    expect(check(number, { quote: "", value: null, scale: "none" }).status).toBe("absent");
  });

  it("returns an identifier in the document's own spelling", () => {
    const answer = check(
      { name: "auditor", type: "identifier", description: "" },
      { quote: "Auditor: Castlereagh Capital", value: "castlereagh  capital" },
    );
    expect(answer.value).toBe("Castlereagh Capital");
  });

  it("takes numbers out of prose when told to, and refuses a passage as an identifier", () => {
    const sealedText = checkField(
      { name: "note", type: "text", description: "" },
      { quote: "", value: "Revenue was 2,558,004 in 2025, up from 4 units." },
      document,
      { ...DEFAULT_CHECKS, textWithoutNumbers: true },
    );
    expect(sealedText.value).toBe("Revenue was # in #, up from # units.");
    const long = indexDocument("A ".repeat(150));
    expect(
      checkField(
        { name: "id", type: "identifier", description: "" },
        { quote: "A A A", value: "A ".repeat(120) },
        long,
        DEFAULT_CHECKS,
      ).status,
    ).toBe("unverified");
  });

  it("accepts an unsupported boolean only with the check switched off", () => {
    const field: FieldSpec = { name: "flag", type: "boolean", description: "" };
    expect(check(field, { quote: "not in the document at all", value: true }).status).toBe(
      "unverified",
    );
    expect(
      checkField(field, { quote: "not in the document at all", value: true }, document, {
        ...DEFAULT_CHECKS,
        evidence: false,
      }).status,
    ).toBe("ok");
  });
});
