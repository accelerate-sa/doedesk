import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { describe, expect, it } from "vite-plus/test";

import type { DetectedEntity, Detector } from "./detect.ts";
import type { EntityKind } from "./placeholders.ts";
import { Pseudonymizer } from "./pseudonymizer.ts";
import { Vault } from "./vault.ts";

/** Reports each listed value wherever it stands, as a detection service would. */
const finds = (values: ReadonlyArray<readonly [string, EntityKind]>): Detector => ({
  detect: (texts) =>
    Promise.resolve(
      texts.map((text) =>
        values.flatMap(([value, kind]) =>
          [...text.matchAll(new RegExp(value, "g"))].map((match): DetectedEntity => ({
            start: match.index,
            end: match.index + value.length,
            kind,
          })),
        ),
      ),
    ),
});

const STAND_IN = /\[[A-Z]+_[A-HJ-NP-Z2-9]{5}\]/g;

describe("Arabic prefix letters", () => {
  it("leaves the letter outside the stand-in, and restores the text exactly", async () => {
    // The detector reports the attached letter as part of the name, as one engine does.
    const pseudonymizer = new Pseudonymizer(
      new Vault(),
      finds([
        ["كمحمد العتيبي", "PERSON"],
        ["لشركة قمم الحجاز", "ORG"],
        ["وبندر الغامدي", "PERSON"],
        ["فهد الشمري", "PERSON"],
      ]),
    );
    const text =
      "يعامل الموظف كمحمد العتيبي، وسلمت النسخة لشركة قمم الحجاز، وحضر وبندر الغامدي مع فهد الشمري.";
    const { texts } = await pseudonymizer.mask([{ text, mode: "detect" }]);
    const sent = texts[0] ?? "";
    expect(sent.replace(STAND_IN, "[X]")).toBe(
      "يعامل الموظف ك[X]، وسلمت النسخة ل[X]، وحضر و[X] مع [X].",
    );
    expect(pseudonymizer.unmask(sent)).toBe(text);
    const [spans = []] = await pseudonymizer.locate([text]);
    expect(spans.map((span) => text.slice(span.start, span.end))).toEqual([
      "محمد العتيبي",
      "شركة قمم الحجاز",
      "بندر الغامدي",
      "فهد الشمري",
    ]);
  });

  it("masks a known name wherever it appears again, with or without a letter attached", async () => {
    const pseudonymizer = new Pseudonymizer(
      new Vault(),
      finds([
        ["محمد العتيبي", "PERSON"],
        ["علي", "PERSON"],
      ]),
    );
    const first = await pseudonymizer.mask([{ text: "حضر محمد العتيبي مع علي.", mode: "detect" }]);
    const token = /\[PERSON_[A-HJ-NP-Z2-9]{5}\]/.exec(first.texts[0] ?? "")?.[0] ?? "";
    // The detector misses the prefixed form; the vault does not.
    const { texts } = await new Pseudonymizer(pseudonymizer.vault, finds([])).mask([
      { text: "اتصلت الإدارة بمحمد العتيبي وكمحمد العتيبي، وهذا فعلي.", mode: "detect" },
      { text: "أرسلت الخطاب لمحمد العتيبي.", mode: "known" },
    ]);
    expect(texts).toEqual([
      `اتصلت الإدارة ب${token} وك${token}، وهذا فعلي.`,
      `أرسلت الخطاب ل${token}.`,
    ]);
  });
});

describe("what a batch reports", () => {
  it("names each stand-in it wrote once, and not one the text already held", async () => {
    const pseudonymizer = new Pseudonymizer(new Vault(), finds([["Khalid Al-Otaibi", "PERSON"]]));
    const first = await pseudonymizer.mask([
      { text: "Khalid Al-Otaibi wrote. Khalid Al-Otaibi called.", mode: "detect" },
    ]);
    const token = /\[PERSON_[A-HJ-NP-Z2-9]{5}\]/.exec(first.texts[0] ?? "")?.[0] ?? "";
    expect(first.stats).toEqual({ checked: 1, masked: 2, replaced: [token] });
    // The model's own stand-in, sent back as it wrote it, was not replaced by this batch.
    const again = await pseudonymizer.mask([{ text: `Write to ${token}.`, mode: "known" }]);
    expect(again.stats).toEqual({ checked: 0, masked: 0, replaced: [] });
  });
});

describe("initials", () => {
  it("masks initials that stand for a known person or follow an honorific, and no abbreviation", async () => {
    const pseudonymizer = new Pseudonymizer(
      new Vault(),
      finds([
        ["محمد بن سعد العتيبي", "PERSON"],
        ["Umar Saleh", "PERSON"],
      ]),
    );
    const text = [
      "تقدم محمد بن سعد العتيبي بطلب، ووقع عليه بالأحرف الأولى (م. ع.).",
      "وراجعه د. ف. ق. ثم Dr. J. K. والعنوان ص.ب. 1234 والمبلغ 50 ر.س.",
      "Umar Saleh moved from the U.S. to the U.K.",
    ].join("\n");
    const { texts } = await pseudonymizer.mask([{ text, mode: "detect" }]);
    expect((texts[0] ?? "").replace(STAND_IN, "[X]")).toBe(
      [
        "تقدم [X] بطلب، ووقع عليه بالأحرف الأولى ([X]).",
        "وراجعه د. [X] ثم Dr. [X] والعنوان ص.ب. 1234 والمبلغ 50 ر.س.",
        "[X] moved from the U.S. to the U.K.",
      ].join("\n"),
    );
  });
});

/** Reports the first place each value stands in a text. */
const findsOnce = (values: ReadonlyArray<readonly [string, EntityKind]>): Detector => ({
  detect: (texts) =>
    Promise.resolve(
      texts.map((text) =>
        values.flatMap(([value, kind]): ReadonlyArray<DetectedEntity> => {
          const start = text.indexOf(value);
          return start === -1 ? [] : [{ start, end: start + value.length, kind }];
        }),
      ),
    ),
});

describe("code and file names", () => {
  it("leaves the words of code alone", async () => {
    // What a name detector reported in recorded runs: each of these went into the vault.
    const vault = new Vault();
    const pseudonymizer = new Pseudonymizer(
      vault,
      findsOnce([
        ["import", "ORG"],
        ["import sys", "ORG"],
        ["import hijridate", "ORG"],
        ["convertdate import islamic", "ORG"],
        ["json", "ORG"],
        ["elif", "PERSON"],
        ["exit 1", "ADDRESS"],
        ["re.search", "URL"],
        ["u0646", "ID"],
      ]),
    );
    const text = [
      "`import` starts the file:",
      "import sys",
      "import hijridate",
      "from convertdate import islamic",
      "rows = json.loads(raw)",
      "    elif not rows:",
      "        exit 1",
      "found = re.search(pattern, line)",
      'label = "\\u0646\\u0635"',
    ].join("\n");
    const { texts } = await pseudonymizer.mask([{ text, mode: "detect" }]);
    expect(texts[0]).toBe(text);
    expect(vault.size).toBe(0);
  });

  it("still masks a name that is spelled like a word of code", async () => {
    const pseudonymizer = new Pseudonymizer(
      new Vault(),
      findsOnce([
        ["Elif Demir", "PERSON"],
        ["elif", "PERSON"],
        ["Import Gulf Trading", "ORG"],
      ]),
    );
    const { texts } = await pseudonymizer.mask([
      { text: "Elif Demir of Import Gulf Trading signed it.", mode: "detect" },
      { text: "ask elif about the invoice", mode: "detect" },
    ]);
    expect(texts.map((sent) => sent.replace(STAND_IN, "[X]"))).toEqual([
      "[X] of [X] signed it.",
      "ask [X] about the invoice",
    ]);
  });

  it("keeps numbers, prose and capitalised words that only look like code", async () => {
    const cases: ReadonlyArray<readonly [string, string, EntityKind, string]> = [
      ["Filed as case 44102938 last year.", "case 44102938", "CASE", "Filed as [X] last year."],
      ["See order 1029384756 for it.", "order 1029384756", "ID", "See [X] for it."],
      ["A call from 0551234567 came in.", "from 0551234567", "PHONE", "A call [X] came in."],
      ["A letter from noura arrived.", "from noura", "PERSON", "A letter [X] arrived."],
      ["Ask Dr.Smith(cardiology) first.", "Dr.Smith", "PERSON", "Ask [X](cardiology) first."],
      ["so elif in turn agreed", "elif in", "PERSON", "so [X] turn agreed"],
      ["and nil signed the form", "nil", "PERSON", "and [X] signed the form"],
      ["return 4410 units", "return 4410", "ID", "[X] units"],
    ];
    for (const [text, span, kind, expected] of cases) {
      const pseudonymizer = new Pseudonymizer(new Vault(), findsOnce([[span, kind]]));
      const { texts } = await pseudonymizer.mask([{ text, mode: "detect" }]);
      expect((texts[0] ?? "").replace(STAND_IN, "[X]"), text).toBe(expected);
    }
    // The same words in code are left alone.
    const code = "    if err != nil {\n        return 1\n    }";
    const pseudonymizer = new Pseudonymizer(
      new Vault(),
      findsOnce([
        ["nil", "PERSON"],
        ["return 1", "ORG"],
      ]),
    );
    expect((await pseudonymizer.mask([{ text: code, mode: "detect" }])).texts[0]).toBe(code);
  });

  it("leaves the name of a workspace file alone unless it holds a name", async () => {
    const files = new Set([
      "case_summary.md",
      "cure_notice.md",
      "noura_contract.docx",
      "clients/noura/summary.md",
      "NouraContract2026.md",
      "team@corp.io",
      "notes.md",
    ]);
    const vault = new Vault();
    const pseudonymizer = new Pseudonymizer(
      vault,
      findsOnce([
        ["Noura", "PERSON"],
        ["case_summary.md", "URL"],
        ["cure_notice.md:0", "URL"],
        ["elsewhere.md", "URL"],
        ["noura_contract.docx", "URL"],
        ["clients/noura/summary.md", "URL"],
        ["NouraContract2026.md", "URL"],
        ["team@corp.io", "EMAIL"],
        // Only a web address is taken for a file name: an ID that is also one stays masked.
        ["notes.md", "ID"],
        ["Khalid Al-Otaibi.pdf", "PERSON"],
      ]),
      [],
      {
        find: (names) => Promise.resolve(new Set(names.filter((name) => files.has(name)))),
        forget: () => undefined,
      },
    );
    const text = [
      "Noura asked for these:",
      "case_summary.md",
      "cure_notice.md:0",
      "elsewhere.md",
      "noura_contract.docx",
      "clients/noura/summary.md",
      "NouraContract2026.md",
      "team@corp.io",
      "notes.md",
      "Khalid Al-Otaibi.pdf",
    ].join("\n");
    const { texts } = await pseudonymizer.mask([{ text, mode: "detect" }]);
    expect((texts[0] ?? "").replace(STAND_IN, "[X]")).toBe(
      [
        "[X] asked for these:",
        "case_summary.md",
        "cure_notice.md:0",
        "[X]",
        "[X]",
        "[X]",
        "[X]",
        "[X]",
        "[X]",
        "[X]",
      ].join("\n"),
    );
    expect(pseudonymizer.unmask(texts[0] ?? "")).toBe(text);
  });
});

describe("the name of a sealed file", () => {
  it("is sent as the label kept for it, in every kind of text, and a handle stands for one unless another file has the name", async () => {
    const vault = new Vault();
    const files = new Set(["notes.txt"]);
    let forgotten = 0;
    // A detector that reads words: it finds "Sara", and nothing inside "AlDossari".
    const pseudonymizer = new Pseudonymizer(vault, finds([["Sara", "PERSON"]]), [], {
      find: (names) => Promise.resolve(new Set(names.filter((name) => files.has(name)))),
      forget: () => {
        forgotten += 1;
      },
    });
    const sara = vault.tokenFor("PERSON", "Sara");
    const dossari = vault.tokenFor("PERSON", "Dossari");
    const label = `${sara}_Al${dossari}_bank_letter.txt`;
    vault.fileLabels.from(() => [
      { name: "Sara_AlDossari_bank_letter.txt", label },
      { name: "notes.txt", label: "DOC_2.txt", neutral: true },
      { name: "Omar_report.txt", label: "DOC_3.txt", neutral: true },
    ]);
    const sent = () =>
      pseudonymizer.mask([
        {
          text: "[File: Sara_AlDossari_bank_letter.txt; ref=file_1] with Omar_report.txt and notes.txt",
          mode: "typed",
        },
        // What a tool returned, and what the app composed: the same label.
        { text: " D Sara_AlDossari_bank_letter.txt", mode: "detect" },
        { text: "Sealed: Sara_AlDossari_bank_letter.txt", mode: "known" },
      ]);
    const first = await sent();
    expect(first.texts).toEqual([
      `[File: ${label}; ref=file_1] with DOC_3.txt and notes.txt`,
      ` D ${label}`,
      `Sealed: ${label}`,
    ]);
    expect(first.stats.masked).toBe(6);
    expect([...first.stats.replaced].toSorted()).toEqual([sara, dossari].toSorted());
    // The folder is read again after a file was sealed out of it, and not on every request.
    expect(forgotten).toBe(1);

    // Once no other file has the name, it can only be the sealed one.
    files.clear();
    expect((await sent()).texts[0]).toBe(
      `[File: ${label}; ref=file_1] with DOC_3.txt and DOC_2.txt`,
    );
    expect(forgotten).toBe(1);
  });
});

describe("names of files and paths, wherever they are written", () => {
  /** A detection service that reads words, as one does: it finds no name inside a joined word. */
  const readsWords = (values: ReadonlyArray<readonly [string, EntityKind]>): Detector => ({
    detect: (texts) =>
      Promise.resolve(
        texts.map((text) =>
          values.flatMap(([value, kind]) =>
            [
              ...text.matchAll(new RegExp(`(?<![\\p{L}\\p{N}_])${value}(?![\\p{L}\\p{N}_])`, "gu")),
            ].map((match): DetectedEntity => ({
              start: match.index,
              end: match.index + value.length,
              kind,
            })),
          ),
        ),
      ),
  });
  const detector = readsWords([
    ["Sara", "PERSON"],
    ["Dossari", "PERSON"],
    ["Khalid Al Otaibi", "PERSON"],
    ["خالد العتيبي", "PERSON"],
    ["1293040015", "ID"],
    ["helvetia", "ORG"],
  ]);
  const P = "[PERSON]";
  const CASES: ReadonlyArray<readonly [what: string, written: string, sent: string]> = [
    [
      "Latin, joined by underscores and capitals",
      "Open Sara_AlDossari_bank_letter.txt now.",
      `Open ${P}_Al${P}_bank_letter.txt now.`,
    ],
    ["Latin, joined by capitals alone", "KhalidAlOtaibi-diabetes.pdf", `${P}-diabetes.pdf`],
    ["Arabic", "افتح خالد_العتيبي_تقرير.txt", `افتح ${P}_تقرير.txt`],
    ["two scripts in one name", "تقريرSara_2026.pdf", `تقرير${P}_2026.pdf`],
    ["a number joined to a name", "Sara1293040015.txt", `${P}[ID].txt`],
    [
      "each folder of a path, with no file type at its end",
      "see clients/Sara_AlDossari/2026/notes and C:\\Users\\KhalidAlOtaibi\\Desktop",
      `see clients/${P}_Al${P}/2026/notes and C:\\Users\\${P}\\Desktop`,
    ],
    [
      "a shell command",
      'cp "hr/Sara_AlDossari_review.docx" --out=/tmp/KhalidAlOtaibi.zip && ls ./SaraDossari/',
      `cp "hr/${P}_Al${P}_review.docx" --out=/tmp/${P}.zip && ls ./${P}${P}/`,
    ],
    [
      "a diff's header",
      "diff --git a/hr/Sara_AlDossari.txt b/hr/Sara_AlDossari.txt\n--- a/hr/Sara_AlDossari.txt\n+++ b/hr/Sara_AlDossari.txt",
      `diff --git a/hr/${P}_Al${P}.txt b/hr/${P}_Al${P}.txt\n--- a/hr/${P}_Al${P}.txt\n+++ b/hr/${P}_Al${P}.txt`,
    ],
    ["a folder's name alone, as a listing prints it", "Sara_AlDossari", `${P}_Al${P}`],
    // A sealed file's label is asked the same: a listing masks what a label would.
    [
      "a document's name in small letters",
      "ls quotes/quote_helvetia.txt",
      "ls quotes/quote_[ORG].txt",
    ],
    // Code and ordinary words are not names of files: nothing in them is looked for.
    [
      "code is left as written",
      "const saraDossari = handleSaraDossariClick(SaraDossari.value); SaraDossari.map((row) => row)",
      "const saraDossari = handleSaraDossariClick(SaraDossari.value); SaraDossari.map((row) => row)",
    ],
    [
      "ordinary words with a slash or a dot are left as written",
      "and/or 12/05/2026 v1.2.3 e.g. SARA_DOSSARI_LIMIT sara_dossari_count",
      "and/or 12/05/2026 v1.2.3 e.g. SARA_DOSSARI_LIMIT sara_dossari_count",
    ],
  ];

  it("masks what a name holds where its words are joined, and gives the name back exactly", async () => {
    for (const mode of ["typed", "detect"] as const) {
      const pseudonymizer = new Pseudonymizer(new Vault(), detector);
      const { texts } = await pseudonymizer.mask(CASES.map(([, text]) => ({ text, mode })));
      CASES.forEach(([what, written, sent], index) => {
        const masked = texts[index] ?? "";
        expect(
          masked.replace(STAND_IN, (token) => `[${token.slice(1, token.indexOf("_"))}]`),
          what,
        ).toBe(sent);
        expect(pseudonymizer.unmask(masked), what).toBe(written);
      });
    }
  });

  it("asks about a document's name in small letters, and not about a source file's", async () => {
    const asked: Array<string> = [];
    const pseudonymizer = new Pseudonymizer(new Vault(), {
      detect: (texts) => {
        asked.push(...texts);
        return Promise.resolve(texts.map(() => []));
      },
    });
    const text = "ls quote_helvetia.txt src/user_service/order_items.ts node_modules/left_pad";
    await pseudonymizer.mask([{ text, mode: "detect" }]);
    expect(asked).toEqual([text, "quote helvetia"]);
  });

  it("gives one stand-in to a name in a file's name and in prose, and finds a name it learned later", async () => {
    const vault = new Vault();
    const pseudonymizer = new Pseudonymizer(vault, detector);
    const listing = "hr/Sara_AlDossari_review.txt\nhr/Reem_AlHarbi_review.txt";
    const [prose = "", first = ""] = (
      await pseudonymizer.mask([
        { text: "Write to Sara about Dossari.", mode: "typed" },
        { text: listing, mode: "detect" },
      ])
    ).texts;
    const [sara, dossari] = prose.match(STAND_IN) ?? [];
    expect(first).toBe(`hr/${sara}_Al${dossari}_review.txt\nhr/Reem_AlHarbi_review.txt`);

    // "Harbi" becomes known from a later message: the listing, sent again, is masked afresh.
    const harbi = vault.tokenFor("PERSON", "Harbi");
    const [again = ""] = (await pseudonymizer.mask([{ text: listing, mode: "detect" }])).texts;
    expect(again).toBe(`hr/${sara}_Al${dossari}_review.txt\nhr/Reem_Al${harbi}_review.txt`);
  });
});

/** The file names the evaluation's held-out tasks sent, each with what the vault knew there. */
describe("the part of a known value that a file's name writes", () => {
  const never: Detector = { detect: (texts) => Promise.resolve(texts.map(() => [])) };
  type Known = ReadonlyArray<readonly [EntityKind, string]>;
  const REINSURERS: Known = [
    ["ORG", "Caledonia Specialty Re Ltd"],
    ["ORG", "Helvetia Meridian Reinsurance AG"],
    ["ORG", "Meridian Crest Reinsurance Holdings"],
    ["ORG", "Vortex Global Reinsurance Corp."],
  ];
  const CASES: ReadonlyArray<readonly [known: Known, written: string, sent: string]> = [
    [[["ID", "MNT-2025-8042"]], "amendment_mnt_8042.txt", "amendment_[ID].txt"],
    [[["ID", "SP-2026-4305"]], "addendum_sp_4305.txt", "addendum_[ID].txt"],
    [[["ID", "TD-47-8841"]], "amendment_td_8841.txt", "amendment_[ID].txt"],
    [[["ID", "ACC-2025-2908"]], "modification_acc_2908.txt", "modification_[ID].txt"],
    // The serial alone, when one known record number ends with it.
    [[["ID", "INV-26-701"]], "credit_note_701.txt", "credit_note_[ID].txt"],
    [[["ID", "CLM-26-411"]], "adjuster_revision_411.txt", "adjuster_revision_[ID].txt"],
    [
      [["ORG", "Meridian Diagnostic Robotics GmbH"]],
      "ls: nda_meridian.txt diagnostic_report.txt",
      "ls: nda_[ORG].txt diagnostic_report.txt",
    ],
    [
      REINSURERS,
      "quote_caledonia.txt\nquote_helvetia.txt\nquote_meridian_crest.txt\nquote_vortex.txt",
      "quote_[ORG].txt\nquote_[ORG].txt\nquote_[ORG].txt\nquote_[ORG].txt",
    ],
    // However the name joins the parts, in a folder's name too, and the whole number re-joined.
    [
      [["ID", "MNT-2025-8042"]],
      "cat contracts/MNT8042/Amendment-Mnt-8042.pdf mnt_2025_8042.txt",
      "cat contracts/[ID]/Amendment-[ID].pdf [ID].txt",
    ],
    [[["ID", "MNT-2025-8042"]], "open scans/8042.pdf", "open scans/[ID].pdf"],
    // A year, a short run, a longer number, digits inside a code and prose are no record's serial.
    [
      [
        ["ID", "MNT-2025-8042"],
        ["ID", "INV-26-701"],
        ["ID", "REQ-7-2024"],
      ],
      "report_2025.txt invoice_26.txt notes_18042.txt cache/3a701e/x.txt budget_2024.xlsx req_2024.xlsx page 701 of mnt 8042",
      "report_2025.txt invoice_26.txt notes_18042.txt cache/3a701e/x.txt budget_2024.xlsx [ID].xlsx page 701 of mnt 8042",
    ],
    // A serial two record numbers end with names neither; beside its letters it names one.
    [
      [
        ["ID", "INV-26-701"],
        ["ID", "CN-25-701"],
      ],
      "credit_note_701.txt cn_701.txt",
      "credit_note_701.txt [ID].txt",
    ],
    // A phone number or an amount is no record number; a word many organisations start with, or
    // the first word of a body named for what it does, is no name.
    [
      [
        ["PHONE", "+966 55 123 4567"],
        ["AMOUNT", "SAR 4500"],
        ["ORG", "National Water Company"],
        ["ORG", "Placement Committee"],
      ],
      "scan_4567.pdf sar_4500.txt national_report.txt placement_brief.txt",
      "scan_4567.pdf sar_4500.txt national_report.txt placement_brief.txt",
    ],
    [
      [["ORG", "Al Rajhi Bank"]],
      "al_rajhi_statement.pdf alrajhi_letter.pdf al_notes.txt",
      "[ORG]_statement.pdf [ORG]_letter.pdf al_notes.txt",
    ],
  ];
  const kinds = (text: string): string =>
    text.replace(STAND_IN, (token) => `[${token.slice(1, token.indexOf("_"))}]`);

  it("is replaced by the value's own stand-in, and the name comes back as it was written", async () => {
    for (const [known, written, sent] of CASES) {
      const vault = new Vault();
      const tokens = new Map(known.map(([kind, value]) => [vault.tokenFor(kind, value), value]));
      const pseudonymizer = new Pseudonymizer(vault, never);
      const [masked = ""] = (await pseudonymizer.mask([{ text: written, mode: "detect" }])).texts;
      expect(kinds(masked), written).toBe(sent);
      // No stand-in but the known values' own: the part is tied to its value.
      for (const token of masked.match(STAND_IN) ?? [])
        expect(tokens.has(token), written).toBe(true);
      expect(pseudonymizer.unmask(masked), written).toBe(written);
    }
    // A file met in a path and named again without its folders is spelled as it was.
    const vault = new Vault();
    const record = vault.tokenFor("ID", "MNT-2025-8042");
    const pseudonymizer = new Pseudonymizer(vault, never);
    await pseudonymizer.mask([{ text: "cat contracts/Amendment-Mnt-8042.pdf", mode: "detect" }]);
    expect(pseudonymizer.unmask(`open Amendment-${record}.pdf`)).toBe(
      "open Amendment-Mnt-8042.pdf",
    );
  });

  it("is found in a listing sent before the value was known, and one word two companies start with is masked as itself", async () => {
    const vault = new Vault();
    const pseudonymizer = new Pseudonymizer(vault, never);
    const listing = "amendment_mnt_8042.txt\nnda_meridian.txt\nquote_meridian_crest.txt";
    const mask = async () =>
      (await pseudonymizer.mask([{ text: listing, mode: "detect" }])).texts[0] ?? "";
    expect(await mask()).toBe(listing);
    const record = vault.tokenFor("ID", "MNT-2025-8042");
    expect(await mask()).toBe(
      `amendment_${record}.txt\nnda_meridian.txt\nquote_meridian_crest.txt`,
    );
    const crest = vault.tokenFor("ORG", "Meridian Crest Reinsurance Holdings");
    const robotics = vault.tokenFor("ORG", "Meridian Diagnostic Robotics GmbH");
    const again = await mask();
    const [, word] = again.match(STAND_IN) ?? [];
    expect(again).toBe(`amendment_${record}.txt\nnda_${word}.txt\nquote_${crest}.txt`);
    expect([crest, robotics]).not.toContain(word);
    expect(pseudonymizer.unmask(again)).toBe(listing);

    // A name masked further than before comes back by its newest label.
    const sara = vault.tokenFor("PERSON", "Sara");
    const report = "Sara_report_701.txt";
    const once = (await pseudonymizer.mask([{ text: report, mode: "detect" }])).texts[0];
    expect(once).toBe(`${sara}_report_701.txt`);
    const invoice = vault.tokenFor("ID", "INV-26-701");
    const twice = (await pseudonymizer.mask([{ text: report, mode: "detect" }])).texts[0] ?? "";
    expect(twice).toBe(`${sara}_report_${invoice}.txt`);
    expect(pseudonymizer.unmask(twice)).toBe(report);
  });
});

describe("a value the person stopped masking", () => {
  it("is sent as written, its stand-in still restores, and masking it again brings it back", async () => {
    const vault = new Vault();
    const pseudonymizer = new Pseudonymizer(vault, findsOnce([["MASTER", "ORG"]]));
    const text = "Sign the MASTER agreement.";
    const first = await pseudonymizer.mask([{ text, mode: "detect" }]);
    const token = STAND_IN.exec(first.texts[0] ?? "")?.[0] ?? "";
    STAND_IN.lastIndex = 0;
    expect(first.texts[0]).toBe(`Sign the ${token} agreement.`);

    expect(vault.release(token)?.value).toBe("MASTER");
    expect(vault.entries()).toEqual([]);
    expect(vault.released().map((entry) => entry.value)).toEqual(["MASTER"]);
    // The detector reports it again on every request: it is left alone, in new text and old.
    const after = await pseudonymizer.mask([
      { text, mode: "detect" },
      { text: "The MASTER agreement is signed.", mode: "known" },
    ]);
    expect(after.texts).toEqual([text, "The MASTER agreement is signed."]);
    // A stand-in the model already saw, and writes again, is still restored.
    expect(pseudonymizer.unmask(`rm ${token}.txt`)).toBe("rm MASTER.txt");

    expect(vault.restore(token)).toBe(true);
    const again = await pseudonymizer.mask([{ text, mode: "detect" }]);
    expect(again.texts[0]).toBe(`Sign the ${token} agreement.`);
  });

  it("stays unmasked after a restart, and a sealed value cannot be released", () => {
    const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "vault-"));
    const filePath = NodePath.join(directory, "vault.json");
    const vault = new Vault(filePath);
    const token = vault.tokenFor("ORG", "json");
    const sealed = vault.sealedTokenFor("AMOUNT", "4,200", true);
    vault.release(token);
    expect(vault.release(sealed)).toBeUndefined();
    vault.flush();

    const reopened = new Vault(filePath);
    expect(reopened.isReleased("json")).toBe(true);
    expect(reopened.has("json")).toBe(false);
    expect(reopened.maskKnown("the json file")).toBe("the json file");
    expect(reopened.unmask(`${token} and ${sealed}`, false, true)).toBe("json and 4,200");
    NodeFS.rmSync(directory, { recursive: true, force: true });
  });
});

describe("a text sent again on every request", () => {
  it("is masked afresh when a value in it becomes known later", async () => {
    // The detector knows Sara only in the second message: the first is masked through the vault.
    const pseudonymizer = new Pseudonymizer(
      new Vault(),
      findsOnce([["Sara Nasser called", "PERSON"]]),
    );
    const history = [
      { text: "The file names Sara Nasser twice: Sara Nasser.", mode: "detect" as const },
    ];
    const first = await pseudonymizer.mask(history);
    expect(first.texts[0]).toBe(history[0]?.text);
    const detected = new Pseudonymizer(pseudonymizer.vault, findsOnce([["Sara Nasser", "PERSON"]]));
    await detected.mask([{ text: "Sara Nasser called.", mode: "typed" }]);
    const second = await pseudonymizer.mask(history);
    expect((second.texts[0] ?? "").replace(STAND_IN, "[X]")).toBe("The file names [X] twice: [X].");
    // And the same again, unchanged, on the request after that.
    expect((await pseudonymizer.mask(history)).texts).toEqual(second.texts);
    expect((await pseudonymizer.mask(history)).stats).toEqual(second.stats);
  });

  it("masks initials once the person they stand for is known", async () => {
    const vault = new Vault();
    const pseudonymizer = new Pseudonymizer(vault, findsOnce([["Khalid Rashed", "PERSON"]]));
    const note = { text: "The form is marked K. R. at the foot.", mode: "detect" as const };
    expect((await pseudonymizer.mask([note])).texts[0]).toBe(note.text);
    await pseudonymizer.mask([{ text: "Khalid Rashed signed.", mode: "typed" }]);
    expect(((await pseudonymizer.mask([note])).texts[0] ?? "").replace(STAND_IN, "[X]")).toBe(
      "The form is marked [X] at the foot.",
    );
  });

  it("is masked afresh when the detector finds something else in it", async () => {
    const vault = new Vault();
    const text = "Lama and Mazen met.";
    const one = await new Pseudonymizer(vault, findsOnce([["Lama", "PERSON"]])).mask([
      { text, mode: "detect" },
    ]);
    expect((one.texts[0] ?? "").replace(STAND_IN, "[X]")).toBe("[X] and Mazen met.");
    // A second check switched on: the same pseudonymizer is asked again with more spans.
    let more = false;
    const pseudonymizer = new Pseudonymizer(vault, {
      detect: (texts) =>
        findsOnce(
          more
            ? [
                ["Lama", "PERSON"],
                ["Mazen", "PERSON"],
              ]
            : [["Lama", "PERSON"]],
        ).detect(texts),
    });
    await pseudonymizer.mask([{ text, mode: "detect" }]);
    more = true;
    const two = await pseudonymizer.mask([{ text, mode: "detect" }]);
    expect((two.texts[0] ?? "").replace(STAND_IN, "[X]")).toBe("[X] and [X] met.");
  });
});

describe("characters a tool printed apart", () => {
  /** What a reader takes from a dump: offsets, spaces and `od`'s continuation marks dropped. */
  const squeezed = (text: string) => text.replace(/^[0-9a-f]{7}/gmu, "").replace(/\*\*|\s+/gu, "");

  it("replaces known values in `od -c` output, as an agent printed them", async () => {
    const vault = new Vault();
    const pseudonymizer = new Pseudonymizer(
      vault,
      finds([
        ["1293965659", "ID"],
        ["2726581192", "ID"],
        ["Khalid Ibrahim Al-Otaibi", "PERSON"],
        ["MRN-0360118", "ID"],
      ]),
    );
    // Earlier in the session the agent read the documents and every value became known.
    await pseudonymizer.mask([
      {
        text: "National ID: 1293965659\nPatient: Khalid Ibrahim Al-Otaibi\nMRN: MRN-0360118\nNational ID: 2726581192",
        mode: "detect",
      },
    ]);
    // `grep -n "MRN\|Patient:\|discharge serum\|National" documents/doc_0[1256]* | od -c`
    const dump =
      "Exit code 1\n0000000    d   o   c   u   m   e   n   t   s   /   d   o   c   _   0   2\n0000020    .   t   x   t   :   5   :   N   a   t   i   o   n   a   l    \n0000040    I   D   :       1   2   9   3   9   6   5   6   5   9  \\n   d\n0000060    o   c   u   m   e   n   t   s   /   d   o   c   _   0   2   .\n0000100    t   x   t   :   7   :   P   a   t   i   e   n   t   :       K\n0000120    h   a   l   i   d       I   b   r   a   h   i   m       A   l\n0000140    -   O   t   a   i   b   i  \\n   d   o   c   u   m   e   n   t\n0000160    s   /   d   o   c   _   0   2   .   t   x   t   :   8   :   M\n0000200    R   N   :       M   R   N   -   0   3   6   0   1   1   8  \\n\n0001020    d   o   c   _   0   1   .   t   x   t   :   5   :   M   R   N\n0001040    :       M   R   N   -   2   8   5   3   8   6   9  \\n   d   o\n0001060    c   u   m   e   n   t   s   /   d   o   c   _   0   1   .   t\n0001100    x   t   :   6   :   N   a   t   i   o   n   a   l       I   D\n0001120    :       2   7   2   6   5   8   1   1   9   2  \\n   d   o   c";
    // The detection service finds nothing it can use in a dump.
    const { texts } = await new Pseudonymizer(vault, finds([])).mask([
      { text: dump, mode: "detect" },
    ]);
    const sent = squeezed(texts[0] ?? "");
    for (const value of ["1293965659", "2726581192", "KhalidIbrahimAl-Otaibi", "MRN-0360118"]) {
      expect(sent).not.toContain(value);
    }
    expect(sent).toContain("documents/doc_02.txt:5:NationalID:[ID_");
  });

  it("finds new values in digits a command spaced out, and replaces them as written plainly", async () => {
    const vault = new Vault();
    // The detection service finds the record number once it can read it.
    const pseudonymizer = new Pseudonymizer(
      vault,
      finds([
        ["1652344118", "ID"],
        ["1158454", "ID"],
        ["Noura Abdullah Al-Ajlan", "PERSON"],
      ]),
    );
    // `awk '/ANNEX/{exit} {print}' "$f" | sed 's/[0-9]/&_/g'`
    const printed =
      "DISCHARGE SUMMARY\n\nPatient: Noura Abdullah Al-Ajlan\nWeight: 5_0_.4_ kg\nNational ID: 1_6_5_2_3_4_4_1_1_8_\nMRN: MRN-1_1_5_8_4_5_4_\nAge / Sex: 3_8_ / F\n";
    const { texts } = await pseudonymizer.mask([{ text: printed, mode: "detect" }]);
    const sent = texts[0] ?? "";
    expect(sent.replace(STAND_IN, "[X]")).toBe(
      "DISCHARGE SUMMARY\n\nPatient: [X]\nWeight: 5_0_.4_ kg\nNational ID: [X]_\nMRN: MRN-[X]_\nAge / Sex: 3_8_ / F\n",
    );
    // The answers the agent then writes hold the same stand-in.
    const written = await pseudonymizer.mask([
      { text: '{"mrn": "MRN-1158454", "length_of_stay_days": 5}', mode: "known" },
    ]);
    const token = sent.match(/MRN-(\[ID_[A-Z0-9]{5}\])/u)?.[1] ?? "none";
    expect(written.texts[0]).toBe(`{"mrn": "MRN-${token}", "length_of_stay_days": 5}`);
  });

  it("reads Arabic letters in `od -c` output, where each takes two cells", async () => {
    const vault = new Vault();
    const pseudonymizer = new Pseudonymizer(
      vault,
      finds([
        ["ماجد بن أنس الغامدي", "PERSON"],
        ["1128516880", "ID"],
      ]),
    );
    await pseudonymizer.mask([
      {
        text: '{"applicant_name": "ماجد بن أنس الغامدي", "applicant_national_id": "1128516880"}',
        mode: "detect",
      },
    ]);
    // `head -c 200 output/answers.json | od -c | head -12`
    const dump =
      '0000000    {   "   a   p   p   l   i   c   a   n   t   _   n   a   m   e\n0000020    "   :       "   \u0645  **   \u0627  **   \u062c  **   \u062f  **       \u0628  **   \u0646\n0000040   **       \u0623  **   \u0646  **   \u0633  **       \u0627  **   \u0644  **   \u063a  **   \u0627\n0000060   **   \u0645  **   \u062f  **   \u064a  **   "   ,       "   a   p   p   l   i\n0000100    c   a   n   t   _   n   a   t   i   o   n   a   l   _   i   d\n0000120    "   :       "   1   1   2   8   5   1   6   8   8   0   "   ,\n0000140        "   c   a   s   e   _   n   u   m   b   e   r   "   :    \n';
    const { texts } = await new Pseudonymizer(vault, finds([])).mask([
      { text: dump, mode: "detect" },
    ]);
    const sent = squeezed(texts[0] ?? "");
    expect(sent).not.toContain("1128516880");
    expect(sent).not.toContain("ماجدبنأنسالغامدي");
    expect(sent).toContain('{"applicant_name":"[PERSON_');
  });

  it("replaces known values in text a command spaced out letter by letter (ho-f2a-01)", async () => {
    const vault = new Vault();
    vault.tokenFor("PERSON", "Evelyn Hargrove");
    vault.tokenFor("ID", "50211");
    // `grep -h "Patient Name\|MRN\|..." clinic_note_0*.txt | sed 's/./& /g'`
    const printed =
      "P a t i e n t   N a m e :   E v e l y n   H a r g r o v e \nM e d i c a l   R e c o r d   N u m b e r   ( M R N ) :   M R N - 5 0 2 1 1                 D a t e   o f   B i r t h :   1 9 5 4 - 0 6 - 1 4 \n";
    const { texts } = await new Pseudonymizer(vault, finds([])).mask([
      { text: printed, mode: "detect" },
    ]);
    expect(texts[0]?.replace(STAND_IN, "[X]")).toBe(
      "P a t i e n t   N a m e :   [X] \nM e d i c a l   R e c o r d   N u m b e r   ( M R N ) :   M R N - [X]                 D a t e   o f   B i r t h :   1 9 5 4 - 0 6 - 1 4 \n",
    );
  });

  it("leaves a short known value alone among single characters printed apart", async () => {
    const vault = new Vault();
    vault.tokenFor("ID", "2025");
    vault.tokenFor("ID", "50211");
    const { texts } = await new Pseudonymizer(vault, finds([])).mask([
      { text: "Digits: 2 0 2 5 9 7\nRecord: 5 0 2 1 1", mode: "detect" },
    ]);
    expect(texts[0]?.replace(STAND_IN, "[X]")).toBe("Digits: 2 0 2 5 9 7\nRecord: [X]");
  });
});

describe("mask, redact and keep", () => {
  const TEXT =
    "Noura Alqahtani pays from SA4420000001234567891234. Call Noura Alqahtani on 0551234567.";
  const detector = finds([
    // Reported once: a detector that saw the name in the first sentence and missed the second.
    ["^Noura Alqahtani", "PERSON"],
    ["SA4420000001234567891234", "IBAN"],
    ["0551234567", "PHONE"],
  ]);
  const nameOnce: Detector = {
    detect: async (texts) =>
      (await detector.detect(texts)).map((spans) =>
        spans.map((span) => (span.kind === "PERSON" ? { ...span, end: span.start + 15 } : span)),
      ),
  };

  it("redacts with no stand-in, nothing in the vault, and nothing to restore", async () => {
    const folder = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "doedesk-redact-"));
    try {
      const vaultFile = NodePath.join(folder, "vault.json");
      const vault = new Vault(vaultFile);
      const pseudonymizer = new Pseudonymizer(vault, nameOnce);
      const result = await pseudonymizer.deidentify(TEXT, { mode: "redact" });

      // The name is redacted where the detector missed it too.
      expect(result.text).toBe("[REDACTED] pays from [REDACTED]. Call [REDACTED] on [REDACTED].");
      expect(result.spans.map((span) => span.action)).toEqual([
        "redact",
        "redact",
        "redact",
        "redact",
      ]);
      expect(result.text.match(STAND_IN)).toBeNull();
      expect(vault.entries()).toEqual([]);
      expect(vault.spellingCount).toBe(0);
      vault.flush();
      expect(JSON.parse(NodeFS.readFileSync(vaultFile, "utf8")).entries).toEqual([]);
      // Nothing was kept, so nothing comes back.
      expect(pseudonymizer.unmask(result.text)).toBe(result.text);
    } finally {
      NodeFS.rmSync(folder, { recursive: true, force: true });
    }
  });

  it("masks with stand-ins the vault restores, the same value the same stand-in", async () => {
    const pseudonymizer = new Pseudonymizer(new Vault(), nameOnce);
    const result = await pseudonymizer.deidentify(TEXT, { mode: "mask" });
    const tokens = result.text.match(STAND_IN) ?? [];
    expect(tokens).toHaveLength(4);
    expect(tokens[0]).toBe(tokens[2]);
    expect(result.text).not.toContain("[REDACTED]");
    expect(
      pseudonymizer.vault
        .entries()
        .map((entry) => entry.value)
        .toSorted(),
    ).toEqual(["0551234567", "Noura Alqahtani", "SA4420000001234567891234"]);
    expect(pseudonymizer.unmask(result.text)).toBe(TEXT);
  });

  it("lets one item differ from its document: redacted in a masked one, kept in a redacted one", async () => {
    const masked = new Pseudonymizer(new Vault(), nameOnce);
    const mixed = await masked.deidentify(TEXT, {
      mode: "mask",
      actionFor: (span) => (span.kind === "IBAN" ? "redact" : undefined),
    });
    expect(mixed.text).toMatch(
      /^\[PERSON_\w{5}\] pays from \[REDACTED\]\. Call \[PERSON_\w{5}\] on \[PHONE_\w{5}\]\.$/,
    );
    // The redacted account is nowhere in the vault; the rest is.
    expect(
      masked.vault
        .entries()
        .map((entry) => entry.kind)
        .toSorted(),
    ).toEqual(["PERSON", "PHONE"]);
    expect(masked.unmask(mixed.text)).toBe(TEXT.replace("SA4420000001234567891234", "[REDACTED]"));

    const redacted = new Pseudonymizer(new Vault(), nameOnce);
    const kept = await redacted.deidentify(TEXT, {
      mode: "redact",
      actionFor: (_span, surface) => (surface === "Noura Alqahtani" ? "keep" : undefined),
    });
    expect(kept.text).toBe(
      "Noura Alqahtani pays from [REDACTED]. Call Noura Alqahtani on [REDACTED].",
    );
    expect(redacted.vault.entries()).toEqual([]);
  });

  it("finds without making a stand-in, and says which values the vault already holds", async () => {
    const pseudonymizer = new Pseudonymizer(new Vault(), nameOnce);
    const known = pseudonymizer.vault.tokenFor("PHONE", "0551234567");
    const before = pseudonymizer.vault.spellingCount;
    const [found = []] = await pseudonymizer.find([TEXT]);
    expect(found.map((span) => [TEXT.slice(span.start, span.end), span.kind])).toEqual([
      ["Noura Alqahtani", "PERSON"],
      ["SA4420000001234567891234", "IBAN"],
      ["0551234567", "PHONE"],
    ]);
    expect(found.find((span) => span.kind === "PHONE")?.token).toBe(known);
    expect(pseudonymizer.vault.spellingCount).toBe(before);
  });
});
