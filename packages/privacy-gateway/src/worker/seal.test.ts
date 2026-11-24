import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { describe, expect, it } from "vite-plus/test";

import { PLACEHOLDER_SOURCE } from "../placeholders.ts";
import { Vault } from "../vault.ts";
import { type FieldAnswer, fieldSpecProblem, type FieldSpec } from "./fields.ts";
import type { JobResult } from "./job.ts";
import { parseProgram, ProgramSyntaxError, sealedRuns } from "./program.ts";
import {
  DEFAULT_SEAL_POLICY,
  emptyLedger,
  fillJson,
  fillMarkers,
  isJsonTemplate,
  isVaultSafe,
  PROGRAM_FAILED,
  sealBatch,
  type SealedValue,
  withoutRepeatedUnit,
} from "./seal.ts";
import { localText, SealedStore } from "./store.ts";
import { Tripwire } from "./tripwire.ts";

const STAND_IN = new RegExp(`^${PLACEHOLDER_SOURCE}$`);

const ok = (
  name: string,
  type: FieldAnswer["type"],
  value: FieldAnswer["value"],
  surface: string | null = null,
): FieldAnswer => ({
  name,
  type,
  status: "ok",
  value,
  surface,
  evidence: { quote: surface ?? "", start: 0, end: 1, line: 3 },
  problems: [],
});

const job = (handle: string, fields: ReadonlyArray<FieldAnswer>): JobResult => ({
  handle,
  status: "done",
  fields,
  attempts: [],
  ms: 1,
  problem: null,
  endpointRetries: 0,
  endpointErrors: [],
});

/** A purchase order and its delivery note, as the worker would have answered. */
const order = job("DOC_1", [
  ok("doc_type", "enum", "order"),
  ok("date", "date", "2026-02-03", "15/08/1447هـ"),
  ok("amount", "number", 1_284_500.75, "١٬٢٨٤٬٥٠٠٫٧٥ ريال"),
  ok("items", "number", 11, "11"),
]);
const delivery = job("DOC_2", [
  ok("doc_type", "enum", "delivery"),
  ok("date", "date", "2026-03-17", "17 March 2026"),
  ok("amount", "number", 900_000, "SAR 900,000"),
  {
    name: "items",
    type: "number",
    status: "absent",
    value: null,
    surface: null,
    evidence: null,
    problems: [],
  },
]);
const fields: ReadonlyArray<FieldSpec> = [
  { name: "doc_type", type: "enum", description: "", options: ["order", "delivery"] },
  { name: "date", type: "date", description: "" },
  { name: "amount", type: "number", description: "" },
  { name: "items", type: "number", description: "" },
];

const FIELD_NAMES = new Set(fields.map((field) => field.name));

describe("what the remote model is shown", () => {
  const seal = (source?: string, ledger = emptyLedger(), vault = new Vault()) => {
    const results = [order, delivery];
    const sealed = sealBatch(results, fields, {
      mode: "sealed",
      vault,
      ledger,
      ...(source === undefined
        ? {}
        : {
            program: sealedRuns(parseProgram(source, FIELD_NAMES), results, fields),
          }),
    });
    return { ...sealed, ledger, vault };
  };

  it("shows choices and gives every sealed value a stand-in that is restored only for the person", () => {
    const { payload, values, vault } = seal();
    const shown = payload.documents[0]?.fields ?? {};
    expect(shown.doc_type).toMatchObject({ value: "order" });
    expect(String((shown.amount as { value: string }).value)).toMatch(STAND_IN);
    const amount = String((shown.amount as { value: string }).value);
    // What a tool is run with keeps the stand-in; what the person reads gets the value.
    expect(vault.unmask(amount)).toBe(amount);
    expect(vault.unmask(amount, false, true)).toBe("١٬٢٨٤٬٥٠٠٫٧٥ ريال");
    const items = String((shown.items as { value: string }).value);
    expect(items).toMatch(STAND_IN);
    expect(vault.unmask(items, false, true)).toBe("11");
    // A short value is restored but never searched for: "11" in other text stays "11".
    expect(vault.maskKnown("Clause 11 and ١٬٢٨٤٬٥٠٠٫٧٥ ريال", true)).toBe(
      `Clause 11 and ${amount}`,
    );
    // Not in what a tool returned, and a detector that finds the value there mints another token.
    expect(vault.maskKnown("Clause 11 and ١٬٢٨٤٬٥٠٠٫٧٥ ريال")).toBe(
      "Clause 11 and ١٬٢٨٤٬٥٠٠٫٧٥ ريال",
    );
    expect(vault.tokenFor("AMOUNT", "١٬٢٨٤٬٥٠٠٫٧٥ ريال")).not.toBe(amount);
    expect(payload.documents[1]?.fields.items).toEqual({ found: false });
    // Nothing the model is shown holds a real value or a quote.
    const text = JSON.stringify(payload);
    for (const secret of ["1284500", "١٬٢٨٤", "15/08/1447", "900,000", "17 March"]) {
      expect(text).not.toContain(secret);
    }
    expect(values["DOC_1.items"]).toMatchObject({ written: "11", number: "11" });
    expect(values["DOC_1.date"]).toMatchObject({ written: "15/08/1447هـ", iso: "2026-02-03" });
  });

  it("counts every answer that is not a stand-in against its document, and records it", () => {
    const ledger = emptyLedger();
    const source = [
      'late = docs[1]["date"] > docs[0]["date"]',
      'result = {"late": reveal(late), "total": sum(d["amount"] for d in docs)}',
    ].join("\n");
    const { payload, clear } = seal(source, ledger);
    // The order: its kind. The delivery: its kind and "not stated". Stand-ins cost nothing. The
    // run costs every document of the call one for whether it worked and one for its yes or no.
    expect(ledger.clearAnswers).toEqual({ DOC_1: 3, DOC_2: 4 });
    expect(clear.map(({ handle, kind, value }) => [handle, kind, value])).toEqual([
      ["DOC_1", "value", "order"],
      ["DOC_2", "value", "delivery"],
      ["DOC_2", "notStated", null],
      ["DOC_1, DOC_2", "ran", "late = true"],
    ]);
    expect(clear[0]?.asked).toBe("doc_type:  (order | delivery)");
    expect(clear[3]?.asked).toBe(source);
    expect(JSON.stringify(payload)).not.toContain('"at"');
    // The same field answers again tell nothing new. A run is counted and recorded every time:
    // one that was free the second time could be asked a new question under an old program.
    expect(seal(source, ledger).clear.map(({ kind }) => kind)).toEqual(["ran"]);
    expect(ledger.clearAnswers).toEqual({ DOC_1: 5, DOC_2: 6 });
  });

  it("withholds anything new once a document has given its answers, a stand-in included", () => {
    const ledger = emptyLedger();
    const vault = new Vault();
    const policy = { ...DEFAULT_SEAL_POLICY, clearAnswersPerDocument: 3 };
    const reworded = (index: number, answer: FieldAnswer) =>
      sealBatch(
        [job("DOC_2", [answer])],
        [{ name: answer.name, type: answer.type, description: `wording ${index}` }],
        { mode: "sealed", vault, ledger, policy },
      ).payload.documents[0]?.fields[answer.name];
    const absent = delivery.fields[3] as FieldAnswer;
    const amount = delivery.fields[2] as FieldAnswer;
    // A stand-in is free, so it does not use the document up.
    expect(String((reworded(0, amount) as { value: string }).value)).toMatch(STAND_IN);
    const answers = Array.from({ length: 5 }, (_, index) => reworded(index, absent));
    expect(answers.slice(0, 3)).toEqual([{ found: false }, { found: false }, { found: false }]);
    expect(answers[3]).toMatchObject({ note: expect.stringContaining("withheld") });
    // Past the limit a new question gets no stand-in either: it would say the value is there.
    expect(reworded(9, amount)).toMatchObject({ note: expect.stringContaining("withheld") });
    // What was shown before is shown again.
    expect(reworded(0, amount)).toMatchObject({ value: expect.stringMatching(STAND_IN) });
    expect(reworded(1, absent)).toEqual({ found: false });
  });

  it("shows a list as rows of stand-ins, and counts its size and each choice in a row", () => {
    const items: FieldSpec = {
      name: "items",
      type: "list",
      description: "Every budget line.",
      columns: [
        { name: "kind", type: "enum", options: ["hardware", "furniture"] },
        { name: "amount", type: "number" },
        { name: "due", type: "date" },
      ],
    };
    const absent: FieldAnswer = { ...ok("due", "date", null), status: "absent", evidence: null };
    const list: FieldAnswer = {
      ...ok("items", "list", 2),
      rows: [
        [ok("kind", "enum", "hardware"), ok("amount", "number", 140_500, "SAR 140,500.00"), absent],
        [
          ok("kind", "enum", "furniture"),
          ok("amount", "number", 35_000, "35,000"),
          ok("due", "date", "2026-02-05", "5 February 2026"),
        ],
      ],
    };
    const ledger = emptyLedger();
    const vault = new Vault();
    const show = (spec = items) =>
      sealBatch([job("DOC_1", [list])], [spec], { mode: "sealed", vault, ledger });
    const { payload, values, clear } = show();
    expect(payload.documents[0]?.fields.items).toEqual({
      value: [
        { kind: "hardware", amount: expect.stringMatching(STAND_IN), due: null },
        {
          kind: "furniture",
          amount: expect.stringMatching(STAND_IN),
          due: expect.stringMatching(STAND_IN),
        },
      ],
    });
    expect(JSON.stringify(payload)).not.toContain("140");
    // The size of the list is one answer, and each choice in a row one more.
    expect(ledger.clearAnswers).toEqual({ DOC_1: 3 });
    expect(clear.map(({ asked, kind, value }) => [asked, kind, value])).toEqual([
      ["items: Every budget line. [number of rows]", "value", "2"],
      ["items[0].kind:  (hardware | furniture)", "value", "hardware"],
      ["items[1].kind:  (hardware | furniture)", "value", "furniture"],
    ]);
    expect(show().clear).toEqual([]);
    // A cell is filled by its stand-in, or by a marker when another form is wanted.
    expect(values["DOC_1.items[0].amount"]).toMatchObject({
      written: "SAR 140,500.00",
      number: "140500",
    });
    expect(
      fillMarkers("{{DOC_1.items[0].amount|number}} due {{DOC_1.items[1].due|iso}}", values).text,
    ).toBe("140500 due 2026-02-05");
    // Shown whole or not at all: a list that would pass the limit is withheld.
    const tight = sealBatch([job("DOC_2", [list])], [items], {
      mode: "sealed",
      vault,
      ledger: emptyLedger(),
      policy: { ...DEFAULT_SEAL_POLICY, clearAnswersPerDocument: 2 },
    });
    expect(tight.payload.documents[0]?.fields.items).toMatchObject({
      note: expect.stringContaining("withheld"),
    });
    expect(tight.clear).toEqual([]);
    // Kept for a program alone, a list shows neither its rows nor their number, and costs nothing.
    const kept = sealBatch([job("DOC_3", [list])], [{ ...items, sealed: true }], {
      mode: "sealed",
      vault,
      ledger: emptyLedger(),
    });
    expect(kept.payload.documents[0]?.fields.items).toEqual({ sealed: true });
    expect(kept.clear).toEqual([]);
  });

  it("keeps a yes or no, or a choice, from the model when the field is sealed", () => {
    const ledger = emptyLedger();
    const vault = new Vault();
    const specs: ReadonlyArray<FieldSpec> = [
      { name: "allergic", type: "boolean", description: "", sealed: true },
      { name: "sex", type: "enum", description: "", options: ["female", "male"], sealed: true },
      { name: "smoker", type: "boolean", description: "", sealed: true },
    ];
    const answers = [
      ok("allergic", "boolean", true),
      ok("sex", "enum", "female"),
      { ...ok("smoker", "boolean", null), status: "absent" as const },
    ];
    const show = () =>
      sealBatch([job("DOC_1", answers), job("DOC_2", answers)], specs, {
        mode: "sealed",
        vault,
        ledger,
      });
    const { payload, values, clear } = show();
    const [first, second] = payload.documents;
    expect(first?.fields.allergic).toEqual({ value: expect.stringMatching(STAND_IN) });
    expect(JSON.stringify(payload)).not.toContain("female");
    // Two documents with the same answer get different stand-ins, or they could be matched.
    expect(first?.fields.sex).not.toEqual(second?.fields.sex);
    // Nothing is an answer in clear here, not even that the document does not say.
    expect(first?.fields.smoker).toEqual({ value: expect.stringMatching(STAND_IN) });
    expect(clear).toEqual([]);
    expect(values["DOC_1.smoker"]).toMatchObject({ written: "null", literal: "null" });
    // Past the limit a sealed field is withheld whether the document states it or not.
    const spent = { ...emptyLedger(), clearAnswers: { DOC_1: 100, DOC_2: 100 } };
    const late = sealBatch(
      [job("DOC_1", answers)],
      specs.map((spec) => ({ ...spec, description: "asked anew" })),
      { mode: "sealed", vault, ledger: spent },
    );
    expect(Object.values(late.payload.documents[0]?.fields ?? {})).toEqual([
      { note: expect.stringContaining("withheld") },
      { note: expect.stringContaining("withheld") },
      { note: expect.stringContaining("withheld") },
    ]);
    expect(values["DOC_1.allergic"]).toMatchObject({ written: "true", literal: "true" });
    expect(
      fieldSpecProblem([{ name: "total", type: "number", description: "", sealed: true }]),
    ).toContain("sealed already");
  });

  it("returns every value of a program's result as a stand-in that says nothing of its kind", () => {
    const source = [
      'days = days_between(docs[0]["date"], docs[1]["date"])',
      "result = {",
      '    "total": sum(d["amount"] for d in docs),',
      '    "days": days,',
      '    "due": add_days(docs[0]["date"], 30),',
      '    "late": days > 30,',
      '    "missing": docs[1]["items"],',
      '    "largest": max(d["amount"] for d in docs),',
      '    "tier": reveal("high" if days > 30 else "low", ["high", "low"]),',
      "}",
    ].join("\n");
    const { payload, values, clear, ledger } = seal(source);
    const result = payload.program?.result as Record<string, string>;
    for (const name of ["total", "days", "due", "late", "missing", "largest"]) {
      expect(result[name]).toMatch(/^\[OTHER_[A-Z2-9]{5}\]$/);
    }
    expect(result.tier).toBe("high");
    expect(values["calc.days"]).toMatchObject({ written: "42", number: "42" });
    expect(values["calc.total"]).toMatchObject({ written: "2,184,500.75", number: "2184500.75" });
    expect(values["calc.due"]).toMatchObject({ written: "2026-03-05", iso: "2026-03-05" });
    expect(values["calc.late"]).toMatchObject({ written: "true", literal: "true" });
    expect(values["calc.missing"]).toMatchObject({ written: "null", literal: "null" });
    // A stated value the program only picked keeps the document's own spelling for the person.
    expect(values["calc.largest"]).toMatchObject({
      written: "١٬٢٨٤٬٥٠٠٫٧٥ ريال",
      number: "1284500.75",
    });
    // Run again, nothing may be recognisable: not the total, and not which value was picked.
    const again = seal(source).payload.program?.result as Record<string, string>;
    expect(again.total).not.toBe(result.total);
    expect(payload.documents[0]?.fields.amount).not.toEqual({ value: result.largest });
    expect(clear.at(-1)).toMatchObject({ kind: "ran", value: "tier = high", asked: source });
    // Its kind, then the run: one for whether it worked and one for a choice of two.
    expect(ledger.clearAnswers.DOC_1).toBe(3);
  });

  it("tells the model what is wrong when made-up values show it, and only that a run failed on real ones", () => {
    // Which fields are not stated the model was told, so a fault that follows from it is told too.
    const plain = seal('result = {"x": docs[1]["items"] + 1}');
    expect(plain.payload.program).toEqual({
      error: expect.stringMatching(
        /^Program, line 1: A number is needed, not None\. Found in a trial run/,
      ),
    });
    expect(plain.clear.map(({ kind }) => kind)).not.toContain("failed");
    expect(plain.ledger.clearAnswers).toEqual({ DOC_1: 1, DOC_2: 2 });
    // A fault only the documents' own values cause is not explained, and it costs.
    const failing = 'result = 1 / (docs[0]["amount"] - 1284500.75)';
    const { payload, clear, ledger } = seal(failing);
    expect(payload.program).toEqual({ error: PROGRAM_FAILED });
    expect(clear.at(-1)).toMatchObject({
      handle: "DOC_1, DOC_2",
      kind: "failed",
      value: "line 1: Division by zero.",
      asked: failing,
    });
    expect(ledger.clearAnswers).toEqual({ DOC_1: 2, DOC_2: 3 });
  });

  it("lets no program learn from the limit: its cost is known before it runs", () => {
    let runs = 0;
    const attempt = (source: string, ledger = emptyLedger(), documents = [order, delivery]) => {
      // The smallest values the trial draws, so it is known which side of a million it takes.
      const program = sealedRuns(parseProgram(source, FIELD_NAMES), documents, fields, () => 0);
      const sealed = sealBatch(documents, fields, {
        mode: "sealed",
        vault: new Vault(),
        ledger,
        policy: { ...DEFAULT_SEAL_POLICY, clearAnswersPerDocument: 3 },
        program: {
          ...program,
          trial: () => {
            runs += 1;
            return program.trial();
          },
        },
      });
      return { ...sealed, ledger };
    };
    // Showing more than a document has left is refused before anything is read, whatever the
    // values: the cost comes from the trial.
    const guess = [
      'if docs[0]["amount"] > 1000000:',
      "    result = 1",
      "else:",
      "    result = [reveal(True), reveal(True), reveal(True)]",
    ].join("\n");
    for (const documents of [[order], [delivery]]) {
      const tried = attempt(guess, emptyLedger(), documents);
      expect(tried.payload.program).toMatchObject({ note: expect.stringContaining("withheld") });
      expect(tried.clear.filter(({ kind }) => kind === "ran" || kind === "failed")).toEqual([]);
    }
    // A shape that follows a value fails on the documents where it differs from the trial's,
    // and costs the same either way: whether a run worked is the one answer it always gives.
    const shaped = 'result = 1 if docs[0]["amount"] > 1000000 else [1]';
    const big = attempt(shaped, emptyLedger(), [order]);
    const small = attempt(shaped, emptyLedger(), [delivery]);
    expect(big.payload.program).toEqual({ error: PROGRAM_FAILED });
    expect(small.payload.program).toEqual({ result: [expect.stringMatching(STAND_IN)] });
    expect(big.ledger.clearAnswers.DOC_1).toBe(2);
    // A document named twice in a call is charged once.
    expect(attempt(shaped, emptyLedger(), [order, order]).ledger.clearAnswers.DOC_1).toBe(2);
    expect(small.ledger.clearAnswers.DOC_2).toBe(3);
    // With a document of the call spent, the program does not run at all.
    runs = 0;
    const spent = { ...emptyLedger(), clearAnswers: { DOC_2: 3 } };
    const blocked = attempt('x = docs[1]["amount"]\nresult = 1', spent);
    expect(blocked.payload.program).toMatchObject({ note: expect.stringContaining("withheld") });
    expect(runs).toBe(0);
    expect(blocked.ledger.clearAnswers.DOC_1).toBe(1);
  });

  it("gives one stated value one stand-in however it is written", () => {
    const vault = new Vault();
    const stated = (surface: string) =>
      sealBatch(
        [job("DOC_1", [ok("amount", "number", 900_000, surface)])],
        [{ name: "amount", type: "number", description: "" }],
        { mode: "sealed", vault, ledger: emptyLedger() },
      ).payload.documents[0]?.fields.amount;
    expect(stated("SAR 900,000")).toEqual(stated("٩٠٠٠٠٠ ريال"));
  });

  it("keeps a value that ordinary text also holds out of the vault", () => {
    expect(isVaultSafe("60", "number")).toBe(false);
    expect(isVaultSafe("2024", "number")).toBe(false);
    expect(isVaultSafe("2.5%", "number")).toBe(false);
    expect(isVaultSafe("SAR 4,471", "number")).toBe(true);
    expect(isVaultSafe("15/08/1447هـ", "date")).toBe(true);
  });
});

/**
 * The scripted calls of the evaluation's ceiling attack, which each showed a whole
 * ten-digit identifier for one counted answer, and the bit-by-bit one that was the cap working.
 */
describe("what one run can show, and what it costs", () => {
  const ID = "2924603356";
  const results = [
    job("DOC_1", [
      ok("national_id", "identifier", ID, ID),
      ok("amount", "number", 46_961.63, "SAR 46,961.63"),
    ]),
  ];
  const specs: ReadonlyArray<FieldSpec> = [
    { name: "national_id", type: "identifier", description: "The holder's national ID number." },
    { name: "amount", type: "number", description: "The main amount in Saudi riyals." },
  ];
  const DIGITS = [
    "s = ''",
    'for c in docs[0]["national_id"]:',
    '    for k in "0123456789":',
    "        if c == k:",
    "            s = s + k",
    'v = round(docs[0]["amount"] * 100)',
    "a = ''",
    "for i in range(12):",
    '    a = "0123456789"[v % 10] + a',
    "    v = v // 10",
  ];
  const NUMBER = [
    "n = 0",
    'for c in docs[0]["national_id"]:',
    "    for k in range(10):",
    '        if c == "0123456789"[k]:',
    "            n = n * 10 + k",
  ];
  const attempt = (lines: ReadonlyArray<string>) => {
    const ledger = emptyLedger();
    const source = lines.join("\n");
    const sealed = sealBatch(results, specs, {
      mode: "sealed",
      vault: new Vault(),
      ledger,
      program: sealedRuns(
        parseProgram(source, new Set(["national_id", "amount"])),
        results,
        specs,
        // The trial's longest forms, so a program that reads ten characters gets past it.
        () => 0.999,
      ),
    });
    return {
      ...sealed,
      cost: ledger.clearAnswers.DOC_1 ?? 0,
      shown: JSON.stringify(sealed.payload),
    };
  };

  it("does not show the program's own text chosen by a value", () => {
    // The text is refused before anything is read: reveal() takes a yes or no, or a choice.
    expect(() =>
      parseProgram([...DIGITS, 'result = {"check": reveal(s + "/" + a)}'].join("\n"), new Set()),
    ).toThrow(ProgramSyntaxError);
    // Choosing each digit from the ten it can be is allowed, and costs what it tells.
    const digits = attempt([
      'result = [reveal(docs[0]["national_id"][i], ["0", "1", "2", "3", "4", "5", "6", "7", "8", "9"]) for i in range(10)]',
    ]);
    expect(digits.payload.program).toEqual({ result: ID.split("") });
    expect(digits.cost).toBe(1 + 10 * 4);
    expect(digits.clear.at(-1)?.value).toBe(
      ID.split("")
        .map((digit, index) => `[${index}] = ${digit}`)
        .join("; "),
    );
  });

  it("does not show a key of the result chosen by a value", () => {
    const keyed = attempt([...DIGITS, "result = {s + '/' + a: 1}"]);
    expect(keyed.payload.program).toEqual({ error: PROGRAM_FAILED });
    expect(keyed.shown).not.toContain("2924");
    expect(keyed.cost).toBe(1);
    expect(keyed.clear.at(-1)).toMatchObject({
      kind: "failed",
      value: expect.stringContaining("depended on the documents' values"),
    });
  });

  it("does not show a length chosen by a value", () => {
    const lengths = attempt([
      ...NUMBER,
      "result = {}",
      'names = ["d0", "d1", "d2", "d3", "d4", "d5", "d6", "d7", "d8", "d9"]',
      "for i in range(10):",
      "    result[names[9 - i]] = [0] * (n % 10)",
      "    n = n // 10",
    ]);
    expect(lengths.payload.program).toEqual({ error: PROGRAM_FAILED });
    expect(lengths.cost).toBe(1);
  });

  it("does not let the kind of a revealed answer carry a second bit", () => {
    const typed = attempt([
      'b = docs[0]["amount"] > 40000',
      'result = reveal(b) if docs[0]["national_id"] == "2924603356" else reveal("true" if b else "false", ["true", "false"])',
    ]);
    expect(typed.payload.program).toEqual({ error: PROGRAM_FAILED });
    expect(typed.cost).toBe(2);
  });

  it("shows one yes or no per bit, for one answer each and one for the run", () => {
    const bits = attempt([
      ...NUMBER,
      "bits = []",
      "for i in range(34):",
      "    bits.append(reveal(n % 2 == 1))",
      "    n = n // 2",
      'result = {"bits": bits}',
    ]);
    const shown = (bits.payload.program as { result: { bits: ReadonlyArray<boolean> } }).result
      .bits;
    expect(shown.reduceRight((total, bit) => total * 2 + (bit ? 1 : 0), 0)).toBe(Number(ID));
    expect(bits.cost).toBe(35);
  });
});

describe("filling a file with sealed values", () => {
  const values = {
    "DOC_1.amount": { written: "١٬٢٨٤٬٥٠٠٫٧٥ ريال", number: "1284500.75" },
    "DOC_1.date": { written: "15/08/1447هـ", iso: "2026-02-03" },
    "calc.days": { written: "42", number: "42" },
  };

  it("writes each value in the form the marker asks for, and names markers it does not know", () => {
    const filled = fillMarkers(
      "Total {{DOC_1.amount}} ({{ DOC_1.amount | number }}) on {{DOC_1.date|iso}}, {{calc.days}} days. {{DOC_9.x}} {{DOC_1.amount|iso}}",
      values,
    );
    expect(filled.text).toBe(
      "Total ١٬٢٨٤٬٥٠٠٫٧٥ ريال (1284500.75) on 2026-02-03, 42 days. {{DOC_9.x}} {{DOC_1.amount|iso}}",
    );
    expect(filled.filled).toBe(4);
    expect(filled.unknown).toEqual(["{{DOC_9.x}}", "{{DOC_1.amount|iso}}"]);
    // A program's value takes whatever form is asked: which forms it has would tell its kind.
    const computed = { "calc.flag": { written: "true", literal: "true" as const } };
    expect(fillMarkers("{{calc.flag|number}} {{calc.flag|iso}}", computed)).toMatchObject({
      text: "true true",
      unknown: [],
    });
  });

  it("writes each stand-in and marker of a JSON file as the JSON its value needs", () => {
    const known: Record<string, SealedValue> = {
      "[OTHER_AAAAA]": { written: "114,500", number: "114500" },
      "[OTHER_BBBBB]": { written: "true", literal: "true" },
      "[OTHER_CCCCC]": { written: "null", literal: "null" },
      "[ID_DDDDD]": { written: 'GRT-2026-401 "A"' },
    };
    const lookup = (token: string) => known[token];
    const filled = fillJson(
      '{"net": "[OTHER_AAAAA]", "gross": [OTHER_AAAAA], "claw": "[OTHER_BBBBB]", "none": [OTHER_CCCCC], "id": [ID_DDDDD], "note": "Ref [ID_DDDDD], net [OTHER_AAAAA]", "x": "[ID_ZZZZZ]"}',
      {},
      lookup,
    );
    // The model knows a stand-in, not what kind of value it holds: quoted or bare, it is typed here.
    expect(JSON.parse(filled.text)).toEqual({
      net: 114500,
      gross: 114500,
      claw: true,
      none: null,
      id: 'GRT-2026-401 "A"',
      note: 'Ref GRT-2026-401 "A", net 114500',
      x: "[ID_ZZZZZ]",
    });
    expect(filled.filled).toBe(7);
    expect(filled.unknown).toEqual(["[ID_ZZZZZ]"]);
    // The name of a member stays a string, whatever the stand-in holds and quoted or not.
    expect(
      JSON.parse(fillJson('{"[OTHER_AAAAA]": "[OTHER_BBBBB]", [OTHER_BBBBB]: 1}', {}, lookup).text),
    ).toEqual({ "114500": true, true: 1 });

    // A marker is typed the same way, with a form or without one, bare or between quotes.
    const stated: Record<string, SealedValue> = {
      ...values,
      "DOC_1.party": { written: 'Al "Noor" Co' },
      "calc.late": { written: "true", literal: "true" },
      "calc.none": { written: "null", literal: "null" },
      "calc.due": { written: "3 February 2026", iso: "2026-02-03" },
      "calc.huge": { written: "Infinity", number: "Infinity" },
    };
    const forms: ReadonlyArray<readonly [string, unknown]> = [
      ["{{DOC_1.amount}}", 1284500.75],
      ["{{DOC_1.amount|number}}", 1284500.75],
      ["{{DOC_1.amount|written}}", "١٬٢٨٤٬٥٠٠٫٧٥ ريال"],
      ["{{DOC_1.date}}", "2026-02-03"],
      ["{{DOC_1.date|iso}}", "2026-02-03"],
      ["{{DOC_1.date|written}}", "15/08/1447هـ"],
      ["{{DOC_1.party}}", 'Al "Noor" Co'],
      ["{{DOC_1.party|written}}", 'Al "Noor" Co'],
      ["{{calc.late}}", true],
      ["{{calc.late|written}}", true],
      // A program's value takes any form asked of it, and is still typed by what it holds.
      ["{{calc.late|iso}}", true],
      ["{{calc.none|number}}", null],
      ["{{calc.due|number}}", "2026-02-03"],
      ["{{calc.days|iso}}", 42],
      // Not a number JSON can write: kept as text, so the file is JSON whatever was computed.
      ["{{calc.huge}}", "Infinity"],
    ];
    for (const [marker, expected] of forms) {
      for (const written of [marker, `"${marker}"`]) {
        const template = `{"v": ${written}, "in": "is ${marker}."}`;
        const done = fillJson(template, stated, lookup);
        expect(done, template).toMatchObject({ filled: 2, unknown: [] });
        expect((JSON.parse(done.text) as { v: unknown }).v, template).toEqual(expected);
        expect(isJsonTemplate(template), template).toBe(true);
      }
    }
    expect(
      JSON.parse(
        fillJson('{"in": "{{DOC_1.party|written}} on {{DOC_1.date}}"}', stated, lookup).text,
      ),
    ).toEqual({ in: 'Al "Noor" Co on 2026-02-03' });
    // The model asked for a field's type itself: a form it has not is named, and left in place.
    expect(fillJson('{"v": {{DOC_1.party|number}}}', stated, lookup)).toMatchObject({
      filled: 0,
      unknown: ["{{DOC_1.party|number}}"],
    });

    // Whether a file is JSON is judged from its text, so it says nothing of the values: a text
    // that is JSON only for some values is refused for all of them.
    for (const template of [
      '{"a": -[OTHER_AAAAA]}',
      '{"a": 1{{calc.days}}}',
      '{"a": {{calc.days|number}}.5}',
      '{"a": [OTHER_AAAAA] [OTHER_AAAAA]}',
      '{"a": "{{calc.days}}"x}',
    ]) {
      expect(isJsonTemplate(template), template).toBe(false);
    }
    expect(isJsonTemplate('{"a": [[OTHER_AAAAA], "{{calc.days|number}}"], [ID_DDDDD]: null}')).toBe(
      true,
    );
    expect(isJsonTemplate('{"a": [OTHER_AAAAA]}\n\n{"a": {{calc.x|iso}}}\n', true)).toBe(true);
    expect(isJsonTemplate('{"a": [OTHER_AAAAA]}\n{"a": \n', true)).toBe(false);
  });

  it("writes a unit once when the text beside the value already has it", () => {
    const units = {
      "DOC_1.rate": { written: "8.40%", number: "8.4" },
      "DOC_1.cap": { written: "SAR 125,000.00", number: "125000" },
      "DOC_1.term": { written: "36 months", number: "36" },
      "DOC_1.floor": { written: "25,000 SAR", number: "25000" },
      "DOC_1.fees": { written: "SR 1,872,803.94", number: "1872803.94" },
      "DOC_1.fixed": { written: "٢٬٥٠٠ ر.س", number: "2500" },
      "DOC_1.share": { written: "٨٫٤٠٪", number: "8.4" },
      "DOC_1.price": { written: "$1,200.00", number: "1200" },
      "DOC_1.deposit": { written: "KWD 300", number: "300" },
      "DOC_1.currency": { written: "SAR" },
    };
    const filled = fillMarkers(
      "Rate {{DOC_1.rate}}%, cap SAR {{DOC_1.cap}}, {{DOC_1.amount}} ريال, term {{DOC_1.term}} monthly, {{DOC_1.term}} months.",
      { ...values, ...units },
    );
    expect(filled.text).toBe(
      "Rate 8.40%, cap SAR 125,000.00, ١٬٢٨٤٬٥٠٠٫٧٥ ريال, term 36 months monthly, 36 months.",
    );

    const cases: ReadonlyArray<readonly [template: string, finished: string]> = [
      // The unit on the other side of the value (seen in the evaluation: "SAR 25,000 SAR", "SAR 1452729.22 SAR").
      ["a minimum of SAR {{DOC_1.floor}}, whichever", "a minimum of SAR 25,000, whichever"],
      ["is **SAR {{DOC_1.floor}}** (the", "is **SAR 25,000** (the"],
      ["pay {{DOC_1.cap}} SAR in full", "pay 125,000.00 SAR in full"],
      // The same unit in another spelling (seen in the evaluation: "SAR SR 1,872,803.94", "ر.س ريال سعودي").
      ["annual fees SAR {{DOC_1.fees}})", "annual fees SAR 1,872,803.94)"],
      ["الملحق: {{DOC_1.fixed}} ريال سعودي.", "الملحق: ٢٬٥٠٠ ريال سعودي."],
      ["الملحق: {{DOC_1.floor}} ر.س.", "الملحق: 25,000 ر.س."],
      ["{{DOC_1.cap}} Saudi riyals", "125,000.00 Saudi riyals"],
      [
        "USD {{DOC_1.price}} and {{DOC_1.price}} US dollars",
        "USD 1,200.00 and 1,200.00 US dollars",
      ],
      ["{{DOC_1.deposit}} KWD", "300 KWD"],
      [
        "{{DOC_1.share}}% and {{DOC_1.rate}} percent and {{DOC_1.rate}} بالمئة",
        "٨٫٤٠% and 8.40 percent and 8.40 بالمئة",
      ],
      // A currency asked for as a field of its own, beside an amount that says it too
      // (seen in the evaluation: "SAR SAR 2,064,941.79").
      ["pay **{{DOC_1.currency}} {{DOC_1.cap}}**", "pay **SAR 125,000.00**"],
      ["pay {{DOC_1.floor}} {{DOC_1.currency}}", "pay 25,000 SAR"],
      // Text that repeats for a reason stays: words then figures, another currency, another
      // amount's unit, a heading, a form the model asked for.
      ["ألف ريال سعودي ({{DOC_1.floor}})", "ألف ريال سعودي (25,000 SAR)"],
      ["USD {{DOC_1.floor}}", "USD 25,000 SAR"],
      ["from 5,000 SAR {{DOC_1.floor}}", "from 5,000 SAR 25,000 SAR"],
      ["up 5% {{DOC_1.rate}}", "up 5% 8.40%"],
      ["Amount (SAR): {{DOC_1.cap}}", "Amount (SAR): SAR 125,000.00"],
      ["{{DOC_1.term}} months 36", "36 months 36"],
      ["SAR {{DOC_1.floor|number}} SAR", "SAR 25000 SAR"],
    ];
    for (const [template, finished] of cases) {
      expect(fillMarkers(template, { ...values, ...units }).text, template).toBe(finished);
    }
    // A stand-in is finished through the same rule, with what stands beside it.
    expect(withoutRepeatedUnit("25,000 SAR", "a minimum of SAR ", ", whichever")).toBe("25,000");
    expect(withoutRepeatedUnit("٢٬٥٠٠ ر.س", "الملحق: ", " ريال سعودي.")).toBe("٢٬٥٠٠");
    // Told what the stand-in beside it is written as, it reads that as the text.
    const beside = (item: string) => (item === "[OTHER_FRD4F]" ? "SAR" : undefined);
    expect(withoutRepeatedUnit("SAR 2,064,941.79", "of **[OTHER_FRD4F] ", "** (the", beside)).toBe(
      "2,064,941.79",
    );
    expect(withoutRepeatedUnit("SAR 2,064,941.79", "of **[OTHER_FRD4F] ", "** (the")).toBe(
      "SAR 2,064,941.79",
    );
  });
});

describe("sealed text on its way out", () => {
  const sealed =
    "The Supplier's total liability arising under this Agreement in any contract year shall not exceed SAR 4,812,650.40 and the Distributor waives every claim above that amount";

  it("flags a copied passage and not a few shared words", () => {
    const tripwire = new Tripwire();
    tripwire.add("DOC_1", sealed);
    expect(tripwire.flags(`Here is the clause: ${sealed.slice(0, 120)}`)).toBe(true);
    expect(tripwire.flags("The liability cap is discussed in clause 11 of this Agreement.")).toBe(
      false,
    );
    // In what the person typed only the copied passage goes, and a short phrase is no passage.
    const request = `Check this for me: ${sealed.slice(0, 120)} and tell me if it is usual.`;
    const kept = tripwire.withoutPassages(request) ?? "";
    expect(kept.startsWith("Check this for me: [DoeDesk withheld a passage here")).toBe(true);
    expect(kept.endsWith("tell me if it is usual.")).toBe(true);
    expect(kept).not.toContain(sealed.slice(20, 60));
    expect(
      tripwire.withoutPassages(`What does "${sealed.slice(0, 30)}" mean in clause 11?`),
    ).toBeUndefined();
    tripwire.remove("DOC_1");
    expect(tripwire.flags(sealed)).toBe(false);
  });

  it("does not count wording that many sealed documents share", () => {
    const tripwire = new Tripwire();
    const boilerplate =
      "This document is confidential and intended solely for the addressee and may not be copied or disclosed to any other person without consent";
    for (let index = 0; index < 12; index += 1)
      tripwire.add(
        `DOC_${index}`,
        `${boilerplate} ${index} unique tail words number ${index} here`,
      );
    expect(tripwire.flags(boilerplate)).toBe(false);
  });

  it("watches only the wording around the values in a file the model wrote", () => {
    const tripwire = new Tripwire();
    const template =
      "Dear client, we confirm that the amount payable under the contract is {{DOC_1.amount}} and that it was computed correctly under the applicable terms of the agreement.";
    tripwire.add(
      "out/letter",
      template.replace("{{DOC_1.amount}}", "one million two hundred thousand riyals"),
      template,
    );
    expect(tripwire.flags(template)).toBe(false);
    expect(
      tripwire.flags(
        "we confirm that the amount payable under the contract is one million two hundred thousand riyals and that it was computed",
      ),
    ).toBe(true);
  });
});

describe("the sealed store", () => {
  it("keeps documents unreadable on disk, by handle, and per project", () => {
    const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "sealed-"));
    try {
      const store = new SealedStore(directory);
      const first = store.add(
        "project-a",
        "contract.txt",
        "Contract number 310112045678 for account 3421",
        "text/plain",
      );
      const again = store.add(
        "project-a",
        "copy.txt",
        "Contract number 310112045678 for account 3421",
        "text/plain",
      );
      expect(first.handle).toBe("DOC_1");
      expect(again.handle).toBe("DOC_1");
      expect(store.list("project-b")).toEqual([]);
      expect(store.read("project-a", "DOC_1")).toContain("310112045678");
      expect(store.read("project-b", "DOC_1")).toBeUndefined();
      const onDisk = NodeFS.readdirSync(directory, { recursive: true })
        .map((entry) => NodePath.join(directory, String(entry)))
        .filter((path) => NodeFS.statSync(path).isFile() && !path.endsWith("key"))
        .map((path) => NodeFS.readFileSync(path).toString("latin1"))
        .join("");
      expect(onDisk).not.toContain("310112045678");
      expect(onDisk).not.toContain("contract.txt");
      // A second process finds the documents again, and a removed handle is not reused.
      const reopened = new SealedStore(directory);
      expect(reopened.tripwire.size).toBe(1);
      expect(reopened.remove("project-a", "DOC_1")).toBe(true);
      expect(
        reopened.add("project-a", "other.txt", "Another document entirely", "text/plain").handle,
      ).toBe("DOC_2");
    } finally {
      NodeFS.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("reads plain text and refuses what it cannot read here", () => {
    expect(localText(Buffer.from("﻿رقم العقد: 3101", "utf8"), "contract.txt")).toBe(
      "رقم العقد: 3101",
    );
    expect(
      localText(Buffer.from("<p>Fee: <b>5</b></p><script>x()</script>", "utf8"), "a.html")?.trim(),
    ).toBe("Fee: 5");
    expect(localText(Buffer.from("%PDF-1.7"), "scan.pdf")).toBeUndefined();
  });
});
