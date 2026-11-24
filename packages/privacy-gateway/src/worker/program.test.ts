import { describe, expect, it } from "vite-plus/test";

import type { FieldAnswer, FieldSpec } from "./fields.ts";
import {
  costOf,
  parseProgram,
  type ProgramOutput,
  ProgramSyntaxError,
  runProgram,
  shapeOf,
  trialAnswers,
} from "./program.ts";
import { isReferenceLike, parseDate, parseNumber } from "./values.ts";

type Scalar = boolean | number | string | null;
type Cell = Scalar | ReadonlyArray<Record<string, Scalar>>;
type Documents = ReadonlyArray<{ handle: string; fields: ReadonlyArray<FieldAnswer> }>;

const ISO = /^\d{4}-\d{2}-\d{2}$/;

/** A checked answer as the worker's reading would have left it, typed from the value given. */
const answer = (name: string, value: Cell): FieldAnswer => {
  const base = { name, surface: null, evidence: null, problems: [] } as const;
  if (value === null) return { ...base, type: "number", status: "absent", value: null };
  if (typeof value === "object") {
    return {
      ...base,
      type: "list",
      status: "ok",
      value: value.length,
      rows: value.map((row) => Object.entries(row).map(([key, cell]) => answer(key, cell))),
    };
  }
  // A word with no digit is what an enum answers: the model is shown it.
  const type =
    typeof value === "boolean"
      ? "boolean"
      : typeof value === "number"
        ? "number"
        : ISO.test(value as string)
          ? "date"
          : /\d/.test(value as string)
            ? "identifier"
            : "enum";
  return { ...base, type, status: "ok", value: value as boolean | number | string };
};

/** Documents from plain objects; a field one document lacks is "not stated" there. */
const documentsOf = (rows: ReadonlyArray<Record<string, Cell>>): Documents => {
  const names = [...new Set(rows.flatMap((row) => Object.keys(row)))];
  return rows.map((row, index) => ({
    handle: `DOC_${index + 1}`,
    fields: names.map((name) => answer(name, row[name] ?? null)),
  }));
};

const specsOf = (documents: Documents): ReadonlyArray<FieldSpec> => {
  const specs = new Map<string, FieldSpec>();
  for (const { fields } of documents) {
    for (const field of fields) {
      const columns = field.rows?.[0]?.map((cell) => ({
        name: cell.name,
        type: "number" as const,
      }));
      const known = specs.get(field.name);
      if (known === undefined || (field.type === "list" && known.type !== "list")) {
        specs.set(field.name, {
          name: field.name,
          type: field.type,
          description: "",
          ...(columns === undefined ? {} : { columns }),
        });
      }
    }
  }
  return [...specs.values()];
};

/** A result with the real values in it, as only this side of the boundary may see it. */
const real = (output: ProgramOutput): unknown =>
  "leaf" in output
    ? output.leaf.shown
      ? { shown: output.leaf.value }
      : output.leaf.value
    : "list" in output
      ? output.list.map(real)
      : Object.fromEntries(output.dict.map(([key, value]) => [key, real(value)]));

const run = (lines: ReadonlyArray<string>, rows: ReadonlyArray<Record<string, Cell>> = [{}]) => {
  const documents = documentsOf(rows);
  const specs = specsOf(documents);
  const known = new Map<string, string>(
    specs.flatMap((spec) => [
      ...(spec.columns ?? []).map((column) => [column.name, column.type] as const),
      [spec.name, spec.type] as const,
    ]),
  );
  const program = parseProgram(lines.join("\n"), known);
  const outcome = runProgram(program, documents, specs);
  if (!outcome.ok) return { failed: outcome.detail, read: outcome.read };
  // A result whose shape a value chose is refused, so each program here must keep the trial's.
  const trial = runProgram(program, trialAnswers(documents, specs), specs, { trial: true });
  expect(trial.ok ? shapeOf(trial.output) : trial.detail).toBe(shapeOf(outcome.output));
  return { result: real(outcome.output), read: outcome.read };
};

const value = (expression: string, rows?: ReadonlyArray<Record<string, Cell>>) =>
  run([`result = ${expression}`], rows).result;

const fault = (lines: ReadonlyArray<string>): string => {
  try {
    parseProgram(lines.join("\n"), new Set(["amount"]));
  } catch (cause) {
    if (cause instanceof ProgramSyntaxError) return `line ${cause.line}: ${cause.message}`;
    throw cause;
  }
  return "no fault";
};

const day = (written: string): string => parseDate(written)?.iso ?? "";

describe("the language a program is written in", () => {
  it("computes like Python, with decimal arithmetic that leaves no binary noise", () => {
    expect(value("0.1 + 0.2 == 0.3")).toBe(true);
    expect(
      value("[1 / 3 * 3 == 1, 100 / 3 * 3 >= 100, floor(100 / 3 * 3), 0.1 * 3 > 0.3]"),
    ).toEqual([true, true, 100, false]);
    expect(value("274477.23 - 75000")).toBe(199477.23);
    expect(value("[7 // 2, -7 // 2, 7 % 3, -7 % 3, 2 ** 10, 7 / 2]")).toEqual([
      3, -4, 1, 2, 1024, 3.5,
    ]);
    expect(value("1 < 2 <= 2 < 3 and not 3 < 3")).toBe(true);
    expect(value('"low" if 150_000 > 2e5 else "high"')).toBe("high");
    expect(value("None or 0")).toBe(0);
    expect(value("[x * 2 for x in range(5) if x % 2 == 1]")).toEqual([2, 6]);
    expect(value("{k: v for k, v in zip(('a', 'b'), [1, 2])}")).toEqual({ a: 1, b: 2 });
    expect(value("sorted([3, 1, 2], reverse=True)[:2]")).toEqual([3, 2]);
    expect(value("[i + v for i, v in enumerate([10, 20], 1)]")).toEqual([11, 22]);
    expect(value("sum(x for x in [1, 2, 3]) + max(4, 5) + min([6, 7]) + len('abc')")).toBe(20);
    expect(value("'b' in ('a', 'b') and 'c' not in ['a'] and 2 in {1, 2}")).toBe(true);
    expect(value("[int(7.9), int(-7.9), ceil(7.1), floor(-7.1), abs(-3), float(2)]")).toEqual([
      7, -7, 8, -8, 3, 2,
    ]);
    expect(
      run([
        "def bracket(spend, limit=150000, rate=0.6):",
        "    part = min(spend, limit)",
        "    return part * rate, spend - part",
        "grant, rest = bracket(200000)",
        "totals = {}",
        "for name, amount in [('a', 1), ('b', 2), ('a', 3)]:",
        "    totals[name] = totals.get(name, 0) + amount",
        "pairs = []",
        "for key, total in totals.items():",
        "    if total < 3:",
        "        continue",
        "    pairs.append([key, total])",
        "result = {'grant': grant, 'rest': rest, 'pairs': pairs, 'keys': list(totals.keys())}",
      ]).result,
    ).toEqual({ grant: 90000, rest: 50000, pairs: [["a", 4]], keys: ["a", "b"] });
  });

  it("keeps to Python where a model would count on it", () => {
    // A slice that starts before the list is the list's start, not a wrapped index.
    expect(value("[[1, 2, 3][:-5], [1, 2, 3][-10:2], [1, 2, 3][-2:], 'abcd'[1:3]]")).toEqual([
      [],
      [1, 2],
      [2, 3],
      "bc",
    ]);
    // Equal keys keep their order when the sort is reversed.
    expect(
      value("sorted([('a', 1), ('b', 2), ('c', 2), ('d', 1)], key=lambda x: x[1], reverse=True)"),
    ).toEqual([
      ["b", 2],
      ["c", 2],
      ["a", 1],
      ["d", 1],
    ]);
    expect(
      value("[list(enumerate(['a'], start=1)), sum([1, 2], start=10), round(3.14159, ndigits=2)]"),
    ).toEqual([[[1, "a"]], 13, 3.14]);
    expect(run(["result = sorted([1], revrse=True)"]).failed).toBe(
      'line 1: sorted() takes no "revrse".',
    );
    expect(
      value("[{'a': 1} == {'a': 1}, {'a': 1} == {'a': 2}, len({1, 1, 2}), 'USD' == 'usd']"),
    ).toEqual([true, false, 2, true]);
    // A key keeps the spelling it was first set with, so a later spelling cannot change it.
    expect(run(['r = {"Total": 0}', 'r["total"] = 1', "result = r"]).result).toEqual({ Total: 1 });
    expect(value("[0.3 % 0.1, 1.4 % 0.2, 7.5 % 2, round(5_000_000_000_000_000, 6)]")).toEqual([
      0, 0, 1.5, 5_000_000_000_000_000,
    ]);
    // An amount in the billions keeps its halalas, compared, rounded and written.
    expect(
      value(
        "[12_345_678_901.25 == 12_345_678_901.26, round(12_345_678_901.254, 2), int(123_456_789_012.9)]",
      ),
    ).toEqual([false, 12_345_678_901.25, 123_456_789_012]);
    expect(
      run(["total = 0", "def add(v):", "    total += v", "add(1)", "result = total"]).failed,
    ).toContain('"total" is not a name of this function');
    expect(run(['result = add_months(date("2026-01-01"), -24000)']).failed).toContain(
      "out of range",
    );
    expect(run(['result = add_days(date("2026-01-01"), 3000000)']).failed).toContain(
      "out of range",
    );
  });

  it("rounds a half away from zero on the decimal value, as documents mean", () => {
    expect(
      value(
        "[round(2.5), round(-2.5), round(0.5), round(1.005, 2), round(2.675, 2), round(1250, -2)]",
      ),
    ).toEqual([3, -3, 1, 1.01, 2.68, 1300]);
  });

  it("works with dates: the days between two, a date moved, and its parts", () => {
    const rows = [{ issued: day("15/08/1447هـ"), delivered: day("17 March 2026") }];
    expect(
      run(
        [
          "d = docs[0]",
          "result = {",
          '    "days": d["delivered"] - d["issued"],',
          '    "same": days_between(d["issued"], d["delivered"]),',
          '    "due": d["issued"] + 30,',
          '    "before": add_days(d["issued"], -3),',
          '    "month_end": add_months(date("2026-01-31"), 1),',
          '    "late": d["delivered"] > date(2026, 3, 1),',
          '    "year": d["delivered"].year,',
          "}",
        ],
        rows,
      ).result,
    ).toEqual({
      days: 42,
      same: 42,
      due: "2026-03-05",
      before: "2026-01-31",
      month_end: "2026-02-28",
      late: true,
      year: 2026,
    });
  });

  it("compares text the way stand-ins are matched, and joins documents on it", () => {
    const rows = [
      { kind: "order", number: "PO-2026-703787", amount: 100 },
      { kind: "note", number: "po–2026–٧٠٣٧٨٧", amount: 40 },
    ];
    expect(
      run(
        [
          'orders = {d["number"]: d for d in docs if d["kind"] == "order"}',
          'note = [d for d in docs if d["kind"] == "note"][0]',
          'result = orders[note["number"]]["amount"] - note["amount"]',
        ],
        rows,
      ).result,
    ).toBe(60);
  });
});

describe("what a program may show", () => {
  const rows = [
    { name: "Okapi Capital", amount: 500, flag: true },
    { name: "Marasi Holding", amount: 900, flag: false },
  ];

  it("seals every value, and shows only a yes or no or the program's own word when asked to", () => {
    expect(
      run(
        [
          'tier = "high" if docs[1]["amount"] > 600 else "low"',
          "result = {",
          '    "tier": reveal(tier, ["high", "low"]),',
          '    "larger": reveal(docs[1]["amount"] > docs[0]["amount"]),',
          '    "flag": docs[0]["flag"],',
          '    "who": docs[0]["name"],',
          '    "first": docs[0].handle,',
          '    "which": reveal(docs[1].handle, ["DOC_1", "DOC_2"]),',
          "}",
        ],
        rows,
      ),
    ).toEqual({
      result: {
        tier: { shown: "high" },
        larger: { shown: true },
        flag: true,
        who: "Okapi Capital",
        first: "DOC_1",
        which: { shown: "DOC_2" },
      },
      read: ["DOC_2", "DOC_1"],
    });
  });

  it("shows nothing but a yes or no, or one of the answers the program lists", () => {
    const refusal = (expression: string): string | undefined => {
      try {
        return run([`result = ${expression}`], rows).failed;
      } catch (cause) {
        if (cause instanceof ProgramSyntaxError) return `before running: ${cause.message}`;
        throw cause;
      }
    };
    // Plain from the text alone, so refused before anything is read, or else while running.
    for (const [expression, when] of [
      ['reveal(docs[0]["name"])', "before running"],
      ['reveal(docs[0]["amount"])', "before running"],
      ["reveal(len(docs))", "before running"],
      ['reveal("id " + docs[0]["name"])', "before running"],
      ['reveal("abc"[:2] + "abc"[0])', "before running"],
      ['reveal(docs[0]["name"][:3])', "line 1"],
      ['reveal(docs[0]["name"].lower())', "line 1"],
    ] as const) {
      expect(refusal(expression)).toMatch(new RegExp(`^${when}: reveal\\(\\) shows a yes or no`));
    }
    // The answers must be the program's own, few and different.
    for (const options of [
      '["a"]',
      '["a", "A"]',
      '[1, "a"]',
      "[docs[0].handle, 'x']",
      "range(4)",
    ]) {
      expect(refusal(`reveal(1 > 0, ${options})`)).toContain(
        "before running: The answers reveal()",
      );
    }
    // A choice among listed answers shows the answer as the program wrote it.
    expect(
      run(['result = reveal(docs[0]["name"], ["okapi capital", "Marasi Holding"])'], rows).result,
    ).toEqual({
      shown: "okapi capital",
    });
    expect(run(["result = reveal(len(docs), [0, 1, 2, 3])"], rows).result).toEqual({ shown: 2 });
    expect(run(["result = reveal(len(docs) - 3, [-1, 0, 1])"], rows).result).toEqual({ shown: -1 });
    // Passed around, reveal() could be given answers made at run time.
    expect(refusal("[1].append(reveal)")).toContain("before running: reveal is only called");
    expect(refusal('reveal(docs[0]["amount"], [100, 200])')).toBe(
      "line 1: The value is none of the options reveal() was given.",
    );
    // A dict of the program's own is not a document, whatever its keys are called.
    expect(
      run(['flags = {k: True for k in ["amount"]}', 'result = reveal(flags["amount"])'], rows)
        .result,
    ).toEqual({ shown: true });
    // A key is shown as it is, so a document's value cannot be one.
    expect(refusal('{docs[0]["name"]: 1}')).toContain("A key of `result`");
    expect(run(["result = {d.handle: d['amount'] for d in docs}"], rows).result).toEqual({
      DOC_1: 500,
      DOC_2: 900,
    });
  });

  it("names the documents it read, and only those", () => {
    expect(run(['result = [d.handle for d in docs] + ["x"]'], rows).read).toEqual([]);
    expect(run(['result = docs[1].get("amount")'], rows).read).toEqual(["DOC_2"]);
    expect(run(['x = docs[0]["amount"]', "result = 1 / 0"], rows)).toEqual({
      failed: "line 2: Division by zero.",
      read: ["DOC_1"],
    });
  });

  it("gives None for a field that is not stated, and an empty list for a list that is not", () => {
    const sparse = [
      { amount: 5, items: [{ amount: 1 }, { amount: 2 }] },
      { amount: null, items: null },
    ];
    const lines = [
      'result = [[d["amount"] is None, sum(i["amount"] for i in d["items"])] for d in docs]',
    ];
    expect(run(lines, sparse).result).toEqual([
      [false, 3],
      [true, 0],
    ]);
    // A list that failed its check is not an empty one: totalling it must fail, not give zero.
    const documents = documentsOf(sparse).map((document, index) => ({
      ...document,
      fields: document.fields.map((field) =>
        index === 1 && field.name === "items"
          ? { ...field, type: "list" as const, status: "unverified" as const }
          : field,
      ),
    }));
    const specs = specsOf(documents);
    const outcome = runProgram(
      parseProgram(lines.join("\n"), new Set(["amount", "items"])),
      documents,
      specs,
    );
    expect(outcome).toMatchObject({ ok: false, detail: "line 1: None cannot be looped over." });
  });
});

describe("a trial run's made-up values", () => {
  it("are equal only where the stand-ins are, and always end", () => {
    const documents = documentsOf([
      { a: 0.123456789012345, when: "2026-01-01", ref: "INV-1" },
      { a: 0.123456789012346, when: "2026-01-02", ref: "inv–1" },
      { a: 0.123456789012345, when: "2026-01-03", ref: "INV-2" },
    ]);
    // A source of chance that repeats itself must not make the draw loop for ever.
    for (const random of [Math.random, () => 0]) {
      const made = trialAnswers(documents, specsOf(documents), random);
      const column = (name: string) =>
        made.map((document) => document.fields.find((field) => field.name === name)?.value);
      const [a1, a2, a3] = column("a");
      const [r1, r2, r3] = column("ref");
      if (random === Math.random) {
        expect([a1 === a3, a1 === a2, r1 === r2, r1 === r3]).toEqual([true, false, true, false]);
      }
      expect(column("when").every((when) => ISO.test(String(when)))).toBe(true);
    }
  });

  /** The same draws every run, so a test of what trials look like does not depend on luck. */
  const seeded = (seed: number) => () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let mixed = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed;
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4_294_967_296;
  };
  const stated = (
    name: string,
    type: FieldAnswer["type"],
    value: string | number,
  ): FieldAnswer => ({
    name,
    type,
    status: "ok",
    value,
    surface: String(value),
    evidence: null,
    problems: [],
  });
  const one = (fields: ReadonlyArray<FieldAnswer>) => [{ handle: "DOC_1", fields }];

  it("carry no mark a program could tell them by: the forms of real identifiers all turn up", () => {
    // What a program can see of an identifier's form: each character's class, runs collapsed,
    // and its length; and whether it carries the mark trials once had.
    const program = parseProgram(
      [
        "def kind(c):",
        '    if c.strip() == "":',
        '        return "-"',
        '    if c in "-/.":',
        '        return "-"',
        '    if c in "0123456789":',
        '        return "9"',
        '    return "a"',
        'r = docs[0]["ref"]',
        'form = ""',
        "for c in r:",
        "    if not form.endswith(kind(c)):",
        "        form = form + kind(c)",
        'result = {"form": form, "length": len(r), "marked": r.startswith("trial")}',
      ].join("\n"),
      new Map([["ref", "identifier"]]),
    );
    const seen = (fields: ReadonlyArray<FieldAnswer>, trial: boolean) => {
      const outcome = runProgram(program, one(fields), [], { trial });
      if (!outcome.ok) throw new Error(outcome.detail);
      return Object.fromEntries(
        "dict" in outcome.output
          ? outcome.output.dict.map(([key, item]) => [key, "leaf" in item ? item.leaf.value : null])
          : [],
      ) as { form: string; length: number; marked: boolean };
    };
    for (const real of [
      "1010234567",
      "١٠١٠٢٣٤٥٦٧",
      "INV-2024-00417",
      "SA44 2000 0001 2345 6789 1234",
      "CR 1010234567",
      "A12345678",
      "Nora Al-Harbi",
      "شركة المراعي",
      "ACME",
      "BLD-7",
    ]) {
      const fields = [stated("ref", "identifier", real)];
      const truth = seen(fields, false);
      const trials = Array.from({ length: 400 }, (_, index) =>
        seen(trialAnswers(one(fields), [], seeded(index))[0]?.fields ?? [], true),
      );
      expect(trials.some((trial) => trial.marked)).toBe(false);
      expect(
        trials.some((trial) => trial.form === truth.form),
        real,
      ).toBe(true);
      const lengths = trials.map((trial) => trial.length);
      expect([
        Math.min(...lengths) <= truth.length,
        truth.length <= Math.max(...lengths),
        real,
      ]).toEqual([true, true, real]);
    }
  });

  it("are drawn from nothing of the real value but what the model holds in clear", () => {
    const fields = (ref: string, amount: number, when: string, note: string) => [
      stated("ref", "identifier", ref),
      stated("amount", "number", amount),
      stated("when", "date", when),
      { ...stated("note", "text", note), surface: null },
    ];
    // Two documents the model cannot tell apart from their stand-ins get the same trial: a
    // trial's free faults and its shape can then say nothing about which one is real.
    const short = fields("2924", 5, "1999-12-31", "Paid on time.");
    const long = fields("SA44 2000 0001 2345", 1_284_500.75, "2026-03-01", "Two payments missed.");
    for (let index = 0; index < 50; index += 1) {
      expect(trialAnswers(one(long), [], seeded(index))).toEqual(
        trialAnswers(one(short), [], seeded(index)),
      );
    }
    // Whether an identifier has four digits its stand-in shows (`ID` or `OTHER`), so the trial
    // keeps to it; a kept list's cells were never shown, so there it is drawn either way.
    const draws = (ref: string) =>
      Array.from({ length: 200 }, (_, index) =>
        String(
          trialAnswers(one([stated("ref", "identifier", ref)]), [], seeded(index))[0]?.fields[0]
            ?.value,
        ),
      );
    expect(draws("2924").every(isReferenceLike)).toBe(true);
    expect(draws("Nora Al-Harbi").some(isReferenceLike)).toBe(false);
    const kept: FieldSpec = {
      name: "rows",
      type: "list",
      description: "",
      sealed: true,
      columns: [{ name: "ref", type: "identifier" }],
    };
    const lists = Array.from({ length: 200 }, (_, index) => {
      const list = trialAnswers(
        one([{ ...stated("rows", "list", 1), rows: [[stated("ref", "identifier", "2924")]] }]),
        [kept],
        seeded(index),
      )[0]?.fields[0];
      return { count: Number(list?.value), refs: list?.rows?.map((cells) => cells[0]?.value) };
    });
    expect(new Set(lists.map((list) => list.count)).size).toBeGreaterThan(5);
    expect(Math.min(...lists.map((list) => list.count))).toBe(1);
    const refs = lists.flatMap((list) => list.refs ?? []).map(String);
    expect([refs.some(isReferenceLike), refs.every(isReferenceLike)]).toEqual([true, false]);
  });

  it("let a run tell no more than it is charged for, whatever the program does", () => {
    // A run's shape is the trial's, so what it can come back as is "failed" or one answer per
    // reveal: no more than 2 ^ cost outcomes, distinguished from a trial or not.
    for (const reveals of [[], [2], [2, 2], [3], [4, 16], [16, 16, 16]]) {
      const output: ProgramOutput = {
        list: reveals.map((count) => ({
          leaf: {
            type: "text",
            value: "0",
            shown: true,
            options: Array.from({ length: count }, (_, index) => String(index)),
          },
        })),
      };
      const outcomes = 1 + reveals.reduce((product, count) => product * count, 1);
      expect(costOf(output)).toBeGreaterThanOrEqual(Math.log2(outcomes));
    }
  });
});

describe("a program that cannot run", () => {
  it("is told what is wrong with its text, with the line, before anything is read", () => {
    expect(fault(["x = 1", "while x < 3:", "    x += 1", "result = x"])).toBe(
      "line 2: `while` is not supported: loop with `for` over a list or range(n).",
    );
    expect(fault(["import math", "result = 1"])).toContain("line 1: `import` is not supported");
    expect(fault(["result = math.ceil(2.5)"])).toContain("`math` is not available: ceil, floor");
    expect(fault(["result = str(1)"])).toContain('line 1: "str" is not defined. The functions are');
    expect(fault(["result = [1].pop()"])).toContain('line 1: ".pop" is not supported');
    expect(fault(['result = f"{1}"'])).toContain("f-strings are not supported");
    expect(fault(["if True:", "result = 1"])).toBe("line 2: An indented block is expected here.");
    expect(fault(["x = (1 +", "result = x"])).toContain("line 2:");
    expect(fault(["x = 1"])).toBe("line 1: The program never assigns `result`.");
    expect(fault(["return 1", "result = 1"])).toContain("`return` outside a function");
    expect(fault(['result = docs[0]["amuont"]'])).toBe(
      'line 1: "amuont" is not a field or a column of this call, nor a key the program sets.',
    );
    expect(fault(['result = {"total": docs[0]["amount"]}', 'x = result["total"]'])).toBe(
      "no fault",
    );
    // A dict keyed by values has keys the text cannot show, so its lookups are left alone.
    expect(
      fault([
        "by = {}",
        "for d in docs:",
        '    by[d["amount"]] = 1',
        'result = {"hardware": by.get("hardware", 0)}',
      ]),
    ).toBe("no fault");
    // reveal() passed around through a loop's target would escape the checks on its answers.
    expect(
      fault([
        "stash = []",
        "def grab(f):",
        "    stash.append(f)",
        "    return [0]",
        "for grab(reveal)[0] in [1]:",
        "    pass",
        'result = stash[0](docs[0]["amount"], list(range(2000)))',
      ]),
    ).toBe("line 5: reveal is only called, as reveal(...): it cannot be named otherwise.");
    expect(fault(["result = 1 @ 2"])).toContain('"@" is not supported here');
    expect(fault([`result = ${"1 + ".repeat(1400)}1`])).toBe(
      "line 1: A program may be at most 4000 characters.",
    );
  });

  it("always ends: too many steps, too much built, too deep, or too large a number", () => {
    const failed = (lines: ReadonlyArray<string>) => run(lines).failed;
    expect(
      failed([
        "n = 0",
        "for a in range(2000):",
        "    for b in range(2000):",
        "        n += 1",
        "result = n",
      ]),
    ).toBe("line 4: The program ran too long.");
    expect(failed(["result = [0] * 10_000_000"])).toContain("built too much");
    expect(failed(["result = list(range(10 ** 9))"])).toContain("built too much");
    expect(failed(["result = 10 ** 1000"])).toContain("That power is too large");
    expect(
      failed([
        "result = 10.0 ** 60 * 10.0 ** 60 * 10.0 ** 60 * 10.0 ** 60 * 10.0 ** 60 * 10.0 ** 60",
      ]),
    ).toContain("out of range");
    expect(failed(["def f(n):", "    return f(n + 1)", "result = f(0)"])).toContain("too deeply");
    expect(failed(["x = []", "x.append(x)", "result = x"])).toContain("nested too deeply");
    // Lists that share their parts are small to build and huge to walk.
    const shared = [
      "a = [1]",
      "b = [1]",
      "for _ in range(40):",
      "    a = [a, a]",
      "    b = [b, b]",
    ];
    expect(failed([...shared, "result = a == b"])).toContain("ran too long");
    expect(failed([...shared, "result = a < b"])).toContain("ran too long");
    expect(failed(["a = []", "for _ in range(8):", "    a = [a] * 100", "result = a"])).toContain(
      "holds too many values",
    );
    expect(run(["result = len([] * (10 ** 9)) + len([1] * 0)"]).result).toBe(0);
    expect(
      failed([
        "big = list(range(20000))",
        "n = 0",
        "for _ in range(1000):",
        "    n += any(big)",
        "result = n",
      ]),
    ).toContain("ran too long");
  });
});

/**
 * The four tasks sealing lost for want of conditions and running totals, as invented data: the
 * values the worker would extract from each task's documents, and a program a model could
 * plausibly write for it. The expected results are the tasks' own answer keys.
 */
describe("the tasks the rule language could not do", () => {
  it("ho-f2b-01: marginal brackets, a hard cap, then a clawback, over line items", () => {
    const application = (
      id: string,
      hardware: number,
      software: number,
      furniture: number,
      travel: number,
    ) => ({
      kind: "application",
      application_id: id,
      items: [
        { category: "hardware", amount: hardware },
        { category: "software", amount: software },
        { category: "furniture", amount: furniture },
        { category: "travel", amount: travel },
      ],
    });
    const memo = (id: string, open: boolean) => ({
      kind: "memo",
      application_id: id,
      open_finding: open,
    });
    const rows = [
      {
        kind: "circular",
        rate1: 60,
        limit1: 150_000,
        rate2: 35,
        limit2: 400_000,
        rate3: 15,
        cap: 200_000,
        clawback: 20,
      },
      application("GRT-2026-401", 140_000, 80_000, 35_000, 18_000),
      memo("GRT-2026-401", false),
      application("GRT-2026-402", 420_000, 160_000, 45_000, 22_000),
      memo("GRT-2026-402", true),
      application("GRT-2026-403", 95_000, 25_000, 20_000, 12_000),
      memo("GRT-2026-403", false),
      application("GRT-2026-404", 290_000, 90_000, 50_000, 15_000),
      memo("GRT-2026-404", true),
    ];
    const outcome = run(
      [
        'rules = [d for d in docs if d["kind"] == "circular"][0]',
        'memos = {d["application_id"]: d for d in docs if d["kind"] == "memo"}',
        "",
        "def gross(spend):",
        '    first = min(spend, rules["limit1"])',
        '    second = min(max(spend - rules["limit1"], 0), rules["limit2"] - rules["limit1"])',
        '    third = max(spend - rules["limit2"], 0)',
        '    grant = (first * rules["rate1"] + second * rules["rate2"] + third * rules["rate3"]) / 100',
        '    return min(grant, rules["cap"])',
        "",
        "rows = {}",
        "total = 0",
        "for app in docs:",
        '    if app["kind"] != "application":',
        "        continue",
        '    eligible = sum(i["amount"] for i in app["items"] if i["category"] in ("hardware", "software"))',
        "    g = gross(eligible)",
        '    clawback = memos[app["application_id"]]["open_finding"]',
        '    net = g * (1 - rules["clawback"] / 100) if clawback else g',
        "    total += net",
        "    rows[app.handle] = {",
        '        "application_id": app["application_id"],',
        '        "eligible_spend_sar": eligible,',
        '        "gross_grant_sar": g,',
        '        "clawback_applied": clawback,',
        '        "net_grant_payable_sar": net,',
        "    }",
        'result = {"total_net_grants_sar": total, "rows": rows}',
      ],
      rows,
    );
    const row = (id: string, eligible: number, gross: number, clawback: boolean, net: number) => ({
      application_id: id,
      eligible_spend_sar: eligible,
      gross_grant_sar: gross,
      clawback_applied: clawback,
      net_grant_payable_sar: net,
    });
    expect(outcome.result).toEqual({
      total_net_grants_sar: 482_900,
      rows: {
        DOC_2: row("GRT-2026-401", 220_000, 114_500, false, 114_500),
        DOC_4: row("GRT-2026-402", 580_000, 200_000, true, 160_000),
        DOC_6: row("GRT-2026-403", 120_000, 72_000, false, 72_000),
        DOC_8: row("GRT-2026-404", 380_000, 170_500, true, 136_400),
      },
    });
  });

  it("ho-f2b-02: claims in date order against a shared limit, with a waiting period", () => {
    const claim = (
      number: string,
      lossDate: string,
      cause: string,
      asset: string,
      assessed: number,
    ) => ({
      kind: "claim",
      claim_number: number,
      loss_date: day(lossDate),
      cause,
      asset_class: asset,
      assessed_loss: assessed,
    });
    const rows = [
      { kind: "policy", effective_date: day("٩ ربيع الآخر ١٤٤٧هـ"), aggregate_limit: 750_000 },
      {
        kind: "endorsement",
        waiting_days: 45,
        sublimit: 300_000,
        deductible_pct: 10,
        deductible_floor: 20_000,
        depreciation_pct: 15,
      },
      // The files are not in date order, and their dates are written in both calendars.
      claim("CLM-47-031", "٢٩ رجب ١٤٤٧هـ", "fire", "machinery", 460_000),
      claim("CLM-47-019", "١٩/٠٥/١٤٤٧هـ", "storm_flood", "inventory", 240_000),
      claim("CLM-47-038", "4 مارس 2026م", "theft", "inventory", 180_000),
      claim("CLM-47-024", "14/06/1447هـ", "storm_flood", "inventory", 410_000),
    ];
    const outcome = run(
      [
        'policy = [d for d in docs if d["kind"] == "policy"][0]',
        'terms = [d for d in docs if d["kind"] == "endorsement"][0]',
        'claims = sorted([d for d in docs if d["kind"] == "claim"], key=lambda d: d["loss_date"])',
        'remaining = policy["aggregate_limit"]',
        "rows = {}",
        "total = 0",
        "for c in claims:",
        '    storm = c["cause"] == "storm_flood"',
        '    waited = days_between(policy["effective_date"], c["loss_date"])',
        '    excluded = storm and waited <= terms["waiting_days"]',
        "    hit = False",
        "    net = 0",
        "    if not excluded:",
        '        amount = c["assessed_loss"]',
        '        if c["asset_class"] == "machinery":',
        '            amount *= 1 - terms["depreciation_pct"] / 100',
        "        if storm:",
        '            amount = min(amount, terms["sublimit"])',
        '        deductible = max(amount * terms["deductible_pct"] / 100, terms["deductible_floor"])',
        "        net = max(amount - deductible, 0)",
        "        if net > remaining:",
        "            net = remaining",
        "            hit = True",
        "        remaining -= net",
        "    total += net",
        "    rows[c.handle] = {",
        '        "claim_number": c["claim_number"],',
        '        "excluded_by_waiting_period": excluded,',
        '        "net_payout_sar": net,',
        '        "aggregate_limit_hit": hit,',
        "    }",
        'result = {"total_net_payout_sar": total, "rows": rows}',
      ],
      rows,
    );
    const row = (number: string, excluded: boolean, net: number, hit: boolean) => ({
      claim_number: number,
      excluded_by_waiting_period: excluded,
      net_payout_sar: net,
      aggregate_limit_hit: hit,
    });
    expect(outcome.result).toEqual({
      total_net_payout_sar: 750_000,
      rows: {
        DOC_4: row("CLM-47-019", true, 0, false),
        DOC_6: row("CLM-47-024", false, 270_000, false),
        DOC_3: row("CLM-47-031", false, 351_900, false),
        DOC_5: row("CLM-47-038", false, 128_100, true),
      },
    });
  });

  it("a covenant ratio, and invoices net of credit notes at each currency's rate", () => {
    const invoice = (number: string, currency: string, due: number) => ({
      kind: "invoice",
      invoice_number: number,
      currency,
      total_due: due,
    });
    const credit = (against: string, amount: number) => ({
      kind: "credit_note",
      against_invoice: against,
      credited: amount,
    });
    const rows = [
      {
        kind: "statements",
        long_term: 884_865_000,
        short_term: 351_527_000,
        lease: 99_020_000,
        shareholder_loan: 280_425_000,
        operating_profit: 222_235_000,
        // The statements write the charge in brackets, so it is read as negative.
        depreciation: -51_112_000,
      },
      invoice("INV-20419557", "USD", 157_689.94),
      invoice("INV-01220405", "SAR", 1_274_013.44),
      invoice("INV-28351361", "EUR", 199_693.98),
      invoice("INV-84148127", "USD", 213_603.82),
      { kind: "agreement", max_leverage: 3.5, usd_rate: 3.75, eur_rate: 4.05 },
      invoice("INV-41545158", "SAR", 134_708.38),
      invoice("INV-66896997", "EUR", 460_883.17),
      credit("INV-66896997", 123_293.21),
      credit("INV-20419557", 24_005),
      invoice("INV-39061852", "USD", 185_873.33),
    ];
    const outcome = run(
      [
        'fs = [d for d in docs if d["kind"] == "statements"][0]',
        'ag = [d for d in docs if d["kind"] == "agreement"][0]',
        'rate = {"SAR": 1, "USD": ag["usd_rate"], "EUR": ag["eur_rate"]}',
        'debt = fs["long_term"] + fs["short_term"] + fs["lease"] - fs["shareholder_loan"]',
        'ebitda = fs["operating_profit"] + abs(fs["depreciation"])',
        "ratio = debt / ebitda",
        "credits = {}",
        "for d in docs:",
        '    if d["kind"] == "credit_note":',
        '        credits[d["against_invoice"]] = credits.get(d["against_invoice"], 0) + d["credited"]',
        "net_ap = 0",
        "for d in docs:",
        '    if d["kind"] == "invoice":',
        '        net_ap += (d["total_due"] - credits.get(d["invoice_number"], 0)) * rate[d["currency"]]',
        "result = {",
        '    "total_covenant_debt_sar": debt,',
        '    "adjusted_leverage_ratio": round(ratio, 2),',
        '    "leverage_compliant": ratio <= ag["max_leverage"],',
        '    "net_ap_sar": round(net_ap, 2),',
        "}",
      ],
      rows,
    );
    expect(outcome.result).toEqual({
      total_covenant_debt_sar: 1_054_987_000,
      adjusted_leverage_ratio: 3.86,
      leverage_compliant: false,
      net_ap_sar: 5_584_079.61,
    });
  });

  it("late days against a schedule, a daily penalty, and the cap the words state", () => {
    const receipt = (batch: number, received: string) => ({
      kind: "receipt",
      batch,
      received: day(received),
    });
    const rows = [
      receipt(1, "23 سبتمبر 2025م"),
      receipt(2, "1447/05/17هـ"),
      {
        kind: "contract",
        rate: 11_250,
        cap_figures: 649_000,
        // The contract says the words prevail, and the words state another amount.
        cap_words: parseNumber("ستمئة وأربعة وتسعون ألف ريال سعودي")?.value ?? null,
        words_prevail: true,
        schedule: [
          { batch: 1, due: day("2 ربيع الآخر 1447هـ") },
          { batch: 2, due: day("٢٢/٠٤/١٤٤٧هـ") },
          { batch: 3, due: day("٧ جمادى الآخرة ١٤٤٧هـ") },
          { batch: 4, due: day("١٤ رجب ١٤٤٧هـ") },
          { batch: 5, due: day("١٣ شعبان ١٤٤٧هـ") },
        ],
      },
      receipt(5, "٠٦/٠٩/١٤٤٧هـ"),
      receipt(3, "٢٠/٠٦/١٤٤٧هـ"),
      receipt(4, "٢٣ يناير ٢٠٢٦م"),
    ];
    const outcome = run(
      [
        'contract = [d for d in docs if d["kind"] == "contract"][0]',
        'due = {row["batch"]: row["due"] for row in contract["schedule"]}',
        "late = 0",
        "for d in docs:",
        '    if d["kind"] == "receipt":',
        '        late += max(days_between(due[d["batch"]], d["received"]), 0)',
        'cap = contract["cap_words"] if contract["words_prevail"] else contract["cap_figures"]',
        "result = {",
        '    "daily_penalty_rate": contract["rate"],',
        '    "effective_penalty_cap": cap,',
        '    "total_late_days": late,',
        '    "net_penalty_due": min(late * contract["rate"], cap),',
        "}",
      ],
      rows,
    );
    expect(outcome.result).toEqual({
      daily_penalty_rate: 11_250,
      effective_penalty_cap: 694_000,
      total_late_days: 80,
      net_penalty_due: 694_000,
    });
  });

  it("runs the example the tool description gives", () => {
    const rows = [
      { due: "2026-01-01", paid: "2026-02-15", amount: 100_000 },
      { due: "2026-01-01", paid: "2026-01-10", amount: 900_000 },
    ];
    expect(
      run(
        [
          'days = {d.handle: days_between(d["due"], d["paid"]) for d in docs}',
          'result = {"days": days, "penalty": min(sum(0.01 * d["amount"] for d in docs if days[d.handle] > 30), 50000), "any_late": reveal(max(days.values()) > 30)}',
        ],
        rows,
      ).result,
    ).toEqual({ days: { DOC_1: 45, DOC_2: 9 }, penalty: 1000, any_late: { shown: true } });
  });
});
