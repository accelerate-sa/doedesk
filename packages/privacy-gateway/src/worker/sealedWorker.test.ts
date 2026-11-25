import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { describe, expect, it, vi } from "vite-plus/test";

import { DetectorUnavailableError } from "../detect.ts";
import { Vault } from "../vault.ts";
import { probeWorker, type WorkerEndpoint } from "./client.ts";
import type { FieldSpec } from "./fields.ts";
import { NOT_REACHED, queuedBatchMs, runBatch, runJob, WORKER_BUSY } from "./job.ts";
import { makeSealedWorker } from "./sealedWorker.ts";
import { makeSecondPassDetector } from "./secondPass.ts";
import { SealedStore } from "./store.ts";

const ORDER = [
  "رقم أمر الشراء: PO-2026-703787",
  "تاريخ أمر الشراء: 15/08/1447هـ",
  "إجمالي قيمة الأمر: ٣٬٨٢٩٬٥٨٩٫٠٥ ريال",
  "عدد الأصناف: 11",
  "طريقة الشراء: منافسة عامة",
].join("\n");
const DELIVERY = ["إشعار استلام عن أمر الشراء رقم PO-2026-703787", "التاريخ: 17 مارس 2026م"].join(
  "\n",
);

const FIELDS: ReadonlyArray<FieldSpec> = [
  {
    name: "doc_type",
    type: "enum",
    description: "The kind of document.",
    options: ["order", "delivery"],
  },
  { name: "order_number", type: "identifier", description: "The purchase order number." },
  { name: "date", type: "date", description: "The document's own date." },
  { name: "total", type: "number", description: "The order's total value." },
  { name: "items", type: "number", description: "The number of line items." },
];

/** What a worker would answer for each of the two documents, keyed by a word only that one holds. */
const ANSWERS: ReadonlyArray<readonly [string, Record<string, unknown>]> = [
  [
    "الأصناف",
    {
      doc_type: { quote: "إجمالي قيمة الأمر", value: "order" },
      order_number: { quote: "رقم أمر الشراء: PO-2026-703787", value: "PO-2026-703787" },
      date: { quote: "تاريخ أمر الشراء: 15/08/1447هـ", value: "15/08/1447هـ" },
      total: {
        quote: "إجمالي قيمة الأمر: ٣٬٨٢٩٬٥٨٩٫٠٥ ريال",
        value: "٣٬٨٢٩٬٥٨٩٫٠٥ ريال",
        scale: "none",
      },
      items: { quote: "عدد الأصناف: 11", value: "11", scale: "none" },
    },
  ],
  [
    "استلام",
    {
      doc_type: { quote: "إشعار استلام", value: "delivery" },
      order_number: { quote: "أمر الشراء رقم PO-2026-703787", value: "PO-2026-703787" },
      date: { quote: "التاريخ: 17 مارس 2026م", value: "17 مارس 2026م" },
      total: { quote: "", value: null, scale: "none" },
      items: { quote: "", value: null, scale: "none" },
    },
  ],
];

const ENDPOINT: WorkerEndpoint = {
  baseUrl: "http://worker.test/v1",
  model: "test",
  driver: "chatCompletions",
  structured: "jsonSchema",
};

const setup = (
  fetchImpl?: typeof fetch,
  route?: () => string | null,
  endpoint: WorkerEndpoint = ENDPOINT,
) => {
  const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "sealed-worker-"));
  const store = new SealedStore(directory);
  store.add("p", "order.txt", ORDER, "text/plain");
  store.add("p", "delivery.txt", DELIVERY, "text/plain");
  const vault = new Vault();
  const sent: Array<string> = [];
  const answering: typeof fetch = async (_url, init) => {
    const body = String(init?.body ?? "");
    sent.push(body);
    const answer = ANSWERS.find(([marker]) => body.includes(marker))?.[1] ?? {};
    return new Response(
      JSON.stringify({
        choices: [{ finish_reason: "stop", message: { content: JSON.stringify(answer) } }],
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  };
  const worker = makeSealedWorker({
    store,
    vault: () => vault,
    endpoint: () => endpoint,
    route,
    fetch: fetchImpl ?? answering,
  });
  return {
    worker,
    store,
    vault,
    sent,
    [Symbol.dispose]: () => NodeFS.rmSync(directory, { recursive: true, force: true }),
  };
};

/** The days from each order to the delivery note that carries its number. */
const PROGRAM = [
  'orders = [d for d in docs if d["doc_type"] == "order"]',
  "rows = {}",
  "for order in orders:",
  '    note = [d for d in docs if d["doc_type"] == "delivery" and d["order_number"] == order["order_number"]][0]',
  '    days = days_between(order["date"], note["date"])',
  '    rows[order.handle] = {"days": days, "in_time": reveal(days <= 60)}',
  'result = {"rows": rows}',
].join("\n");

const ask = (
  worker: ReturnType<typeof setup>["worker"],
  caller = "thread-1",
  program: string | undefined = PROGRAM,
) =>
  worker.ask({
    project: "p",
    caller,
    handles: [],
    instruction: "For a register.",
    fields: FIELDS,
    ...(program === undefined ? {} : { program }),
  });

describe("asking about sealed documents", () => {
  it("answers with choices, stand-ins and yes or no, and nothing of the documents", async () => {
    using context = setup();
    const answer = await ask(context.worker);
    expect(answer.ok).toBe(true);
    const text = JSON.stringify(answer);
    for (const secret of [
      "PO-2026-703787",
      "1447",
      "٣٬٨٢٩",
      "3829589",
      "17 مارس",
      "رقم أمر الشراء",
    ]) {
      expect(text).not.toContain(secret);
    }
    const payload = (answer.ok ? answer.payload : {}) as {
      documents: Array<{
        handle: string;
        fields: Record<string, { value?: unknown; sealed?: boolean; found?: boolean }>;
      }>;
      program: { result: { rows: Record<string, { days: string; in_time: boolean }> } };
    };
    const [order, delivery] = payload.documents;
    expect(order?.fields.doc_type?.value).toBe("order");
    expect(context.vault.unmask(String(order?.fields.items?.value), false, true)).toBe("11");
    expect(delivery?.fields.total).toEqual({ found: false });
    // The same order number in both documents is one stand-in, so the model can match them.
    expect(order?.fields.order_number?.value).toBe(delivery?.fields.order_number?.value);
    expect(context.vault.unmask(String(order?.fields.total?.value), false, true)).toBe(
      "٣٬٨٢٩٬٥٨٩٫٠٥ ريال",
    );
    // A result for each document is keyed by its handle, which the model knows already.
    const row = payload.program.result.rows.DOC_1;
    expect(row?.in_time).toBe(true);
    expect(context.vault.unmask(String(row?.days), false, true)).toBe("42");
    // The worker was sent the documents whole: that is what it is for.
    expect(context.sent.some((body) => body.includes("PO-2026-703787"))).toBe(true);
    // Every answer given in clear is kept for the person, under the file's own name.
    const record = context.store.clearAnswers("p");
    expect(record.map((entry) => [entry.document, entry.kind, entry.value])).toEqual([
      ["order.txt", "value", "order"],
      ["delivery.txt", "value", "delivery"],
      ["delivery.txt", "notStated", null],
      ["delivery.txt", "notStated", null],
      ["order.txt, delivery.txt", "ran", "rows.DOC_1.in_time = true"],
    ]);
    expect(record[0]?.asked).toBe("doc_type: The kind of document. (order | delivery)");
    // Resetting the limit starts the count again and keeps the record.
    context.store.resetLedger("p");
    expect(context.store.ledger("p").clearAnswers).toEqual({});
    expect(context.store.clearAnswers("p")).toHaveLength(5);
  });

  it("asks the worker for a list as rows, and says how only when a list is asked for", async () => {
    using context = setup();
    await ask(context.worker);
    expect(context.sent.every((body) => !body.includes("A list field is an array"))).toBe(true);
    await context.worker.ask({
      project: "p",
      caller: "thread-1",
      handles: ["DOC_1"],
      instruction: "For a register.",
      fields: [
        {
          name: "lines",
          type: "list",
          description: "Every line of the order.",
          columns: [
            { name: "label", type: "identifier", description: "What the line is called." },
            { name: "amount", type: "number" },
          ],
        },
      ],
    });
    const request = JSON.parse(context.sent.at(-1) ?? "{}") as {
      messages: Array<{ role: string; content: string }>;
      response_format: { json_schema: { schema: { properties: Record<string, unknown> } } };
    };
    // The fake worker answers nothing for the list, so later messages are corrections.
    const prompt =
      request.messages.find((message) => message.content.includes("<fields>"))?.content ?? "";
    expect(prompt).toContain(
      "- lines (list of rows): Every line of the order.\n    - label (identifier): What the line is called.\n    - amount (number)",
    );
    expect(prompt).toContain("A list field is an array with one object for every row");
    expect(prompt).toContain('"lines":[{"quote":"...","label":...,"amount":...,"scale":"none"}]');
    expect(request.response_format.json_schema.schema.properties.lines).toMatchObject({
      type: "array",
    });
  });

  it("refuses the same question a third time, and a handle the project does not have", async () => {
    using context = setup();
    expect((await ask(context.worker)).ok).toBe(true);
    expect((await ask(context.worker)).ok).toBe(true);
    const third = await ask(context.worker);
    expect(third).toMatchObject({
      ok: false,
      message: expect.stringContaining("already asked twice"),
    });
    expect((await ask(context.worker, "thread-2")).ok).toBe(true);
    const unknown = await context.worker.ask({
      project: "p",
      caller: "t",
      handles: ["DOC_9"],
      instruction: "x",
      fields: FIELDS,
    });
    expect(unknown).toMatchObject({ ok: false, message: expect.stringContaining("DOC_9") });
  });

  it("says which sealed file cannot be asked about yet and why, and asks the others", async () => {
    using context = setup();
    const kept = { bytes: Buffer.from("not text"), path: "/case/contracts/signing.mp4" };
    const video = context.store.keep(
      "p",
      "signing.mp4",
      { unread: { kind: "unsupported", message: "This kind of file cannot be read." } },
      kept,
    );
    const scan = context.store.keep(
      "p",
      "scan.pdf",
      { unread: { kind: "service", message: "The reading service did not answer." } },
      { bytes: Buffer.from("%PDF"), path: "/case/contracts/scan.pdf" },
    );
    const one = (handle: string) =>
      context.worker.ask({
        project: "p",
        caller: "t",
        handles: [handle],
        instruction: "x",
        fields: FIELDS,
      });

    // Asked for alone, the agent is told why, in words that hold nothing of the file.
    const refused = await one(video.handle);
    expect(refused).toEqual({
      ok: false,
      message: `${video.handle}: This file is sealed but cannot be asked about yet: This kind of file cannot be read. Tell the person, who can try reading it again in DoeDesk. Do not look for the file elsewhere.`,
    });
    expect(context.sent).toEqual([]);

    // Asked with the others, they are answered and it is named as failed, with the reason.
    const answer = await ask(context.worker, "thread-1", undefined);
    const documents = (
      (answer.ok ? answer.payload : {}) as {
        documents: Array<{ handle: string; status: string; problem?: string }>;
      }
    ).documents;
    expect(documents.map((document) => [document.handle, document.status])).toEqual([
      ["DOC_1", "done"],
      ["DOC_2", "done"],
      [video.handle, "failed"],
      [scan.handle, "failed"],
    ]);
    expect(documents[3]?.problem).toContain("The reading service did not answer.");
    expect(context.sent.some((body) => body.includes("not text"))).toBe(false);
  });

  it("reads a file sealed while the reading service was down when it is first asked about", async () => {
    const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "sealed-worker-"));
    const store = new SealedStore(directory);
    const scan = store.keep(
      "p",
      "order.pdf",
      { unread: { kind: "service", message: "The reading service did not answer." } },
      { bytes: Buffer.from("%PDF"), path: "/case/order.pdf" },
    );
    const read: Array<string> = [];
    const worker = makeSealedWorker({
      store,
      vault: () => new Vault(),
      endpoint: () => ENDPOINT,
      readLater: async (project, handle) => {
        read.push(handle);
        store.setText(project, handle, ORDER, "application/pdf");
      },
      fetch: async () =>
        new Response(
          JSON.stringify({
            choices: [
              { finish_reason: "stop", message: { content: JSON.stringify(ANSWERS[0]?.[1]) } },
            ],
            usage: { prompt_tokens: 10, completion_tokens: 5 },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    });
    const answer = await worker.ask({
      project: "p",
      caller: "t",
      handles: [],
      instruction: "For a register.",
      fields: FIELDS,
    });
    expect(read).toEqual([scan.handle]);
    expect(answer).toMatchObject({ ok: true });
    expect(
      (answer.ok ? (answer.payload as { documents: Array<{ status: string }> }) : undefined)
        ?.documents[0]?.status,
    ).toBe("done");
    NodeFS.rmSync(directory, { recursive: true, force: true });
  });

  it("checks a program's text before asking the worker, and runs a second one without asking again until another worker answers", async () => {
    let route = "sa";
    using context = setup(undefined, () => route);
    const broken = await ask(
      context.worker,
      "t",
      'while True:\n    pass\nresult = docs[0]["total"]',
    );
    expect(broken).toEqual({
      ok: false,
      message:
        "Program, line 1: `while` is not supported: loop with `for` over a list or range(n).",
    });
    const misspelt = await ask(context.worker, "t", 'result = docs[0]["totl"]');
    expect(misspelt).toMatchObject({
      ok: false,
      message: expect.stringContaining('line 1: "totl" is not a field or a column of this call'),
    });
    expect(context.sent).toHaveLength(0);
    expect((await ask(context.worker, "t")).ok).toBe(true);
    const calls = context.sent.length;
    // The fields are the same, so the answers are too: only the program runs.
    const second = await ask(context.worker, "t", 'result = {"total": docs[0]["total"] * 2}');
    expect(second.ok).toBe(true);
    expect(context.sent).toHaveLength(calls);
    // Another worker answers from now on: it is asked, and the record says which gave each answer.
    const recorded = context.store.clearAnswers("p").length;
    route = "custom:worker.example";
    context.worker.reset();
    const third = await ask(context.worker, "t", 'result = {"total": docs[0]["total"] * 3}');
    expect(third.ok).toBe(true);
    expect(context.sent.length).toBeGreaterThan(calls);
    const routes = context.store.clearAnswers("p").map((entry) => entry.route);
    expect(recorded).toBeGreaterThan(0);
    expect(routes.length).toBeGreaterThan(recorded);
    expect(new Set(routes.slice(0, recorded))).toEqual(new Set(["sa"]));
    expect(new Set(routes.slice(recorded))).toEqual(new Set(["custom:worker.example"]));
  });

  it("never puts a sealed value where its answer would carry it back", async () => {
    using context = setup();
    const first = await ask(context.worker, "t", undefined);
    const payload = (first.ok ? first.payload : {}) as {
      documents: Array<{ fields: Record<string, { value?: string }> }>;
    };
    const number = String(payload.documents[0]?.fields.order_number?.value);
    const sentBefore = context.sent.length;
    // An enum's options are the answer itself: a stand-in in one is sent as a stand-in.
    await context.worker.ask({
      project: "p",
      caller: "t",
      handles: ["DOC_1"],
      instruction: "x",
      fields: [
        { name: "which", type: "enum", description: "Pick the first.", options: [number, "no"] },
      ],
    });
    const optionsCall = context.sent.slice(sentBefore).join("\n");
    // (The document itself holds the number: only the options are looked at.)
    expect(optionsCall).toContain(`(enum: \\"${number}\\"`);
    expect(optionsCall).not.toContain('(enum: \\"PO-2026-703787');
    // A file the model can read is answered in clear, so nothing sealed is restored for it.
    const before = context.sent.length;
    await context.worker.ask({
      project: "p",
      caller: "t",
      handles: [],
      files: [{ name: "/work/readme.md", text: "A public note." }],
      instruction: `Repeat this: ${number}`,
      fields: [{ name: "echo", type: "text", description: `Say ${number}` }],
    });
    expect(context.sent.slice(before).join("\n")).not.toContain("PO-2026-703787");
  });

  it("stops offering itself after the endpoint fails twice, and says so without guessing", async () => {
    const failing: typeof fetch = async () => new Response("nope", { status: 401 });
    using context = setup(failing);
    expect(context.worker.available()).toBe(true);
    expect((await ask(context.worker, "a")).ok).toBe(false);
    expect((await ask(context.worker, "b")).ok).toBe(false);
    expect(context.worker.available()).toBe(false);
    expect(await ask(context.worker, "c")).toMatchObject({
      ok: false,
      message: expect.stringContaining("did not answer"),
    });
    // Another worker has not failed: it is offered at once.
    context.worker.reset();
    expect(context.worker.available()).toBe(true);
  });

  it("fills a file with the sealed values and returns only counts", async () => {
    using context = setup();
    const answer = await ask(context.worker);
    const payload = (answer.ok ? answer.payload : {}) as {
      documents: Array<{ fields: Record<string, { value?: string }> }>;
      program: { result: { rows: Record<string, { days: string }> } };
    };
    // The model may write a stand-in or a marker; both are finished here and nowhere else.
    const total = String(payload.documents[0]?.fields.total?.value);
    const days = String(payload.program.result.rows.DOC_1?.days);
    const result = context.worker.fill(
      "p",
      "letter.txt",
      `Total ${total}. Delivered ${days} days after {{DOC_1.date|iso}}; {{DOC_1.items}} items. {{DOC_1.nothing}} [AMOUNT_ZZZZZ]`,
    );
    expect(result).toEqual({
      filled: 4,
      unknown: ["{{DOC_1.nothing}}", "[AMOUNT_ZZZZZ]"],
      name: "letter.txt",
      invalid: false,
    });
    expect(context.store.readOutput("p", "letter.txt")).toBe(
      "Total ٣٬٨٢٩٬٥٨٩٫٠٥ ريال. Delivered 42 days after 2026-02-03; 11 items. {{DOC_1.nothing}} [AMOUNT_ZZZZZ]",
    );
    // A stand-in beside the unit its value already carries leaves the unit written once.
    context.worker.fill("p", "note.txt", `Total ${total} ريال.`);
    expect(context.store.readOutput("p", "note.txt")).toBe("Total ٣٬٨٢٩٬٥٨٩٫٠٥ ريال.");
    // A data file gets plain digits and ISO days, so what is filled is still JSON.
    const order = String(payload.documents[0]?.fields.order_number?.value);
    const data = context.worker.fill(
      "p",
      "answers.json",
      `{"order": ${order}, "total": "${total}", "date": "{{DOC_1.date}}", "days": ${days}}`,
    );
    expect(data).toMatchObject({ filled: 4, unknown: [], invalid: false });
    expect(JSON.parse(context.store.readOutput("p", "answers.json") ?? "")).toEqual({
      order: "PO-2026-703787",
      total: 3829589.05,
      date: "2026-02-03",
      days: 42,
    });
    // A bare marker for a name is typed too, and whether the file is JSON is judged from the
    // text the model wrote: the same answer for any value, so it tells nothing about one.
    expect(
      context.worker.fill("p", "ok.json", `{"order": {{DOC_1.order_number}}, "t": ${total}}`)
        .invalid,
    ).toBe(false);
    expect(JSON.parse(context.store.readOutput("p", "ok.json") ?? "")).toEqual({
      order: "PO-2026-703787",
      t: 3829589.05,
    });
    expect(context.worker.fill("p", "bad.json", `{"order": ${order} ${order}}`).invalid).toBe(true);
  });

  it("finishes a data file as valid data whatever the agent quoted", () => {
    using context = setup();
    context.store.mergeValues("p", {
      "DOC_1.notice_en": { written: "15 days", number: "15", token: "[AMOUNT_AAAAA]" },
      "DOC_1.penalty_en": { written: "SAR 571,793", number: "571793", token: "[AMOUNT_BBBBB]" },
      "DOC_1.contract_date": { written: "27 May 2025", iso: "2025-05-27", token: "[DATE_CCCCC]" },
      "DOC_1.second_party": { written: 'شركة "إتقان" للخدمات', token: "[OTHER_67LS6]" },
    });
    // What the agent wrote in a recorded run: the date's marker has a form and no quotes.
    const recorded =
      '{"notice_period_days": {{DOC_1.notice_en|number}}, "delay_penalty": {{DOC_1.penalty_en|number}}, "prevailing_language": "english", "contract_date": {{DOC_1.contract_date|iso}}, "second_party": [OTHER_67LS6]}';
    const answers = {
      notice_period_days: 15,
      delay_penalty: 571793,
      prevailing_language: "english",
      contract_date: "2025-05-27",
      second_party: 'شركة "إتقان" للخدمات',
    };
    const quoted = recorded.replace(/(\{\{[^}]*\}\}|\[OTHER_67LS6\])/g, '"$1"');
    for (const template of [recorded, quoted]) {
      expect(context.worker.fill("p", "answers.json", template)).toMatchObject({
        filled: 4,
        unknown: [],
        invalid: false,
      });
      expect(JSON.parse(context.store.readOutput("p", "answers.json") ?? "")).toEqual(answers);
    }
    // Each line of a .jsonl file is finished the same way, and judged on its own.
    expect(context.worker.fill("p", "rows.jsonl", `${recorded}\n${quoted}\n`)).toMatchObject({
      filled: 8,
      invalid: false,
    });
    expect(
      (context.store.readOutput("p", "rows.jsonl") ?? "")
        .split("\n")
        .filter((line) => line !== "")
        .map((line) => JSON.parse(line)),
    ).toEqual([answers, answers]);
    expect(context.worker.fill("p", "bad.jsonl", `${recorded}\n{"a": \n`).invalid).toBe(true);
    // A sign or a digit beside a marker is JSON for some values and not for others: never accepted.
    expect(
      context.worker.fill("p", "sign.json", '{"t": -{{DOC_1.penalty_en|number}}}').invalid,
    ).toBe(true);
  });

  it("fills a sealed list as the kind of file it is written into", () => {
    using context = setup();
    context.store.mergeValues("p", {
      "calc.flagged": {
        written: "| ref | amount |\n| --- | --- |\n| INV-7 | SAR 60,000 |",
        token: "[OTHER_FLAGD]",
        table: {
          columns: ["ref", "amount"],
          rows: [[{ written: "INV-7" }, { written: "SAR 60,000", number: "60000" }]],
        },
      },
    });
    for (const [name, template, finished] of [
      [
        "flagged.md",
        "Flagged:\n[OTHER_FLAGD]",
        "Flagged:\n| ref | amount |\n| --- | --- |\n| INV-7 | SAR 60,000 |",
      ],
      ["flagged.csv", "{{calc.flagged}}", "ref,amount\nINV-7,60000"],
      ["flagged.csv", "[OTHER_FLAGD]", "ref,amount\nINV-7,60000"],
      ["flagged.tsv", "[OTHER_FLAGD]", "ref\tamount\nINV-7\t60000"],
      ["flagged.txt", "{{calc.flagged|lines}}", "INV-7; SAR 60,000"],
      [
        "flagged.json",
        '{"flagged": [OTHER_FLAGD]}',
        '{"flagged": [{"ref":"INV-7","amount":60000}]}',
      ],
    ] as const) {
      expect(context.worker.fill("p", name, template), name).toMatchObject({
        filled: 1,
        unknown: [],
        invalid: false,
      });
      expect(context.store.readOutput("p", name), name).toBe(finished);
    }
  });

  it("fills a program's value under any key, and names every marker it leaves", async () => {
    using context = setup();
    await ask(context.worker);
    context.store.mergeValues("p", {
      "calc.pay_DOC_1": { written: "256,160.45", number: "256160.45", token: "[OTHER_PJMA3]" },
      "calc.n30_DOC_1": { written: "true", literal: "true", token: "[OTHER_JS3H9]" },
    });
    // What the agent wrote in a recorded run, bare and then between quotes. Its
    // program keyed the result by handle, as the tool's description advises: `pay_DOC_1`.
    const recorded =
      '{"rows": [\n  {"payable_after_deductible": {{calc.pay_DOC_1}}, "notified_within_30_days": {{calc.n30_DOC_1}}}\n]}\n';
    for (const template of [recorded, recorded.replace(/(\{\{[^}]*\}\})/g, '"$1"')]) {
      expect(context.worker.fill("p", "answers.json", template)).toEqual({
        filled: 2,
        unknown: [],
        name: "answers.json",
        invalid: false,
      });
      expect(JSON.parse(context.store.readOutput("p", "answers.json") ?? "")).toEqual({
        rows: [{ payable_after_deductible: 256160.45, notified_within_30_days: true }],
      });
    }
    // A value deeper in the result is named by its keys, as the result shows them.
    expect(context.worker.fill("p", "days.txt", "{{ calc.rows.DOC_1.days }} days").filled).toBe(1);
    expect(context.store.readOutput("p", "days.txt")).toBe("42 days");
    // Whatever is left between double braces is named, in any kind of file.
    const left = [
      "{{calc.pay_DOC_9}}",
      "{{total}}",
      "{{ DOC_1.date | upper }}",
      "{{DOC_1.Date}}",
      "{{constructor}}",
    ];
    for (const name of ["left.txt", "left.json", "left.csv"]) {
      expect(context.worker.fill("p", name, `["${left.join('", "')}"]`)).toMatchObject({
        filled: 0,
        unknown: left,
      });
    }
  });

  it("does not read the values it fills in for stand-ins, or the counts would carry them back", async () => {
    using context = setup();
    const answer = await ask(context.worker);
    const payload = (answer.ok ? answer.payload : {}) as {
      documents: Array<{ fields: Record<string, { value?: string }> }>;
    };
    const total = String(payload.documents[0]?.fields.total?.value);
    // A program's text spelling a value as made-up stand-ins, and repeating a real one.
    context.store.mergeValues("p", {
      "calc.x": { written: `[ID_CKCEG][ID_ADDFG] ${total} ${total}`, token: "[OTHER_AAAAA]" },
    });
    for (const [name, template] of [
      ["x.txt", "{{calc.x}}"],
      ["x.json", '{"x": "{{calc.x|written}}"}'],
    ] as const) {
      expect(context.worker.fill("p", name, template)).toMatchObject({ filled: 1, unknown: [] });
    }
    expect(context.store.readOutput("p", "x.txt")).toBe(`[ID_CKCEG][ID_ADDFG] ${total} ${total}`);
  });

  it("refuses prose about a sealed document unless the person switched it on", async () => {
    using context = setup();
    const answer = await context.worker.ask({
      project: "p",
      caller: "t",
      handles: [],
      instruction: "Summarise.",
      fields: [{ name: "summary", type: "text", description: "What the document is about." }],
    });
    expect(answer).toMatchObject({ ok: false, message: expect.stringContaining("switched off") });
    expect(context.sent).toHaveLength(0);
  });

  it("returns values and quotes for files the model could read anyway", async () => {
    using context = setup();
    const answer = await context.worker.ask({
      project: "p",
      caller: "t",
      handles: [],
      files: [{ name: "/w/order.txt", text: ORDER }],
      instruction: "For a register.",
      fields: FIELDS,
    });
    const payload = (answer.ok ? answer.payload : {}) as {
      documents: Array<{ fields: Record<string, { value?: unknown; quote?: string }> }>;
    };
    expect(answer.ok && answer.mode).toBe("masked");
    expect(payload.documents[0]?.fields.total).toMatchObject({
      value: 3829589.05,
      quote: "إجمالي قيمة الأمر: ٣٬٨٢٩٬٥٨٩٫٠٥ ريال",
    });
  });
});

describe("the worker's second check before masking", () => {
  const TEXT =
    "The claim under file CLM-88-4471 was heard in the Al Rawdah district office. File CLM-88-44710 is another matter.";

  it("marks every whole occurrence of a value the worker lists, and asks once per text", async () => {
    let calls = 0;
    const listing: typeof fetch = async () => {
      calls += 1;
      const values = [
        { text: "CLM-88-4471", kind: "CASE" },
        { text: "Al Rawdah", kind: "LOCATION" },
        { text: "a name the text does not hold", kind: "PERSON" },
      ];
      return new Response(
        JSON.stringify({
          choices: [{ finish_reason: "stop", message: { content: JSON.stringify({ values }) } }],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    };
    const detector = makeSecondPassDetector({ endpoint: () => ENDPOINT, fetch: listing });
    const [spans] = await detector.detect([TEXT, "short"]);
    expect(spans?.map((span) => [TEXT.slice(span.start, span.end), span.kind])).toEqual([
      ["CLM-88-4471", "CASE"],
      ["Al Rawdah", "LOCATION"],
    ]);
    await detector.detect([TEXT]);
    expect(calls).toBe(1);
  });

  it("refuses to pass text on when no worker answers", async () => {
    const failing: typeof fetch = async () => new Response("nope", { status: 500 });
    await expect(
      makeSecondPassDetector({ endpoint: () => ENDPOINT, fetch: failing }).detect([TEXT]),
    ).rejects.toBeInstanceOf(DetectorUnavailableError);
    await expect(
      makeSecondPassDetector({ endpoint: () => undefined }).detect([TEXT]),
    ).rejects.toBeInstanceOf(DetectorUnavailableError);
  });
});

describe("a server that fails to fit its own output to the schema", () => {
  it("is asked again at once, and without the strict schema after two such failures", async () => {
    const formats: Array<string> = [];
    const flaky: typeof fetch = async (_url, init) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as {
        response_format?: { type?: string };
      };
      formats.push(body.response_format?.type ?? "none");
      if (body.response_format?.type === "json_schema") {
        return new Response(
          JSON.stringify({
            error: {
              message: "Failed to generate JSON. Please adjust your prompt.",
              code: "json_validate_failed",
            },
          }),
          { status: 400, headers: { "content-type": "application/json" } },
        );
      }
      return new Response(
        JSON.stringify({
          choices: [
            {
              finish_reason: "stop",
              message: {
                content: JSON.stringify({
                  items: { quote: "عدد الأصناف: 11", value: "11", scale: "none" },
                }),
              },
            },
          ],
          usage: { prompt_tokens: 10, completion_tokens: 5 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    };
    const result = await runJob(
      { handle: "DOC_1", text: ORDER },
      "For a register.",
      [{ name: "items", type: "number", description: "The number of line items." }],
      { endpoint: ENDPOINT, fetch: flaky },
    );
    expect(result.status).toBe("done");
    expect(result.fields[0]).toMatchObject({ status: "ok", value: 11 });
    expect(formats).toEqual(["json_schema", "json_schema", "json_object"]);
    expect(result.endpointErrors).toEqual([400, 400]);
  });

  it("is asked for a JSON object at once when a host refuses the schema itself, as a router reports it", async () => {
    const formats: Array<string> = [];
    // Anthropic's validator behind Google Vertex, through OpenRouter: the reason is in `raw`.
    const refusing: typeof fetch = async (_url, init) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as {
        response_format?: { type?: string };
      };
      formats.push(body.response_format?.type ?? "none");
      if (body.response_format?.type === "json_schema") {
        return Response.json(
          {
            error: {
              code: 400,
              message: "Provider returned error",
              metadata: {
                provider_name: "Google",
                raw: "Enum value None does not match declared type ['string', 'null']",
              },
            },
          },
          { status: 400 },
        );
      }
      return Response.json({
        choices: [
          {
            finish_reason: "stop",
            message: {
              content: JSON.stringify({
                kind: { quote: "رقم أمر الشراء: PO-2026-703787", value: "order" },
              }),
            },
          },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      });
    };
    const result = await runJob(
      { handle: "DOC_1", text: ORDER },
      "For a register.",
      [{ name: "kind", type: "enum", description: "What it is.", options: ["order", "invoice"] }],
      { endpoint: ENDPOINT, fetch: refusing },
    );
    expect(result.fields[0]).toMatchObject({ status: "ok", value: "order" });
    expect(formats).toEqual(["json_schema", "json_object"]);
    // The host's own reason reaches the record of the failure, not only the router's sentence.
    expect(result.endpointErrors).toEqual([400]);
  });
});

describe("connecting a server", () => {
  const answering = (
    refuse: (body: Record<string, unknown>) => string | null,
  ): { readonly fetch: typeof fetch; readonly asked: Array<Record<string, unknown>> } => {
    const asked: Array<Record<string, unknown>> = [];
    return {
      asked,
      fetch: async (_url, init) => {
        const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
        asked.push(body);
        const refusal = refuse(body);
        if (refusal !== null)
          return Response.json({ error: { message: refusal } }, { status: 400 });
        return Response.json({
          choices: [
            {
              finish_reason: "stop",
              message: { content: '{"word":{"quote":"is heron","value":"heron","kind":"test"}}' },
            },
          ],
          usage: { prompt_tokens: 10, completion_tokens: 5 },
        });
      },
    };
  };
  const { structured: _structured, ...UNPROBED } = ENDPOINT;
  const formatOf = (body: Record<string, unknown>) =>
    (body.response_format as { type?: string } | undefined)?.type ?? "none";

  it("asks with a choice field, so a host that refuses one is asked for a JSON object from then on", async () => {
    const host = answering((body) =>
      formatOf(body) === "json_schema"
        ? "Enum value None does not match declared type ['string', 'null']"
        : null,
    );
    expect(await probeWorker(UNPROBED, host.fetch)).toEqual({
      ok: true,
      structured: "jsonObject",
      message: null,
    });
    const schema = (
      host.asked[0]?.response_format as { json_schema?: { schema?: unknown } } | undefined
    )?.json_schema?.schema;
    expect(JSON.stringify(schema)).toContain('"enum":["test","other",null]');
  });

  it("drops a reasoning setting the server refuses, or takes the lowest one when it must reason", async () => {
    // One model refuses "none" and the absence of a setting alike; another refuses the setting.
    const mustReason = answering((body) =>
      body.reasoning_effort === "low"
        ? null
        : "reasoning_effort must be one of low, medium, or high",
    );
    expect(await probeWorker({ ...UNPROBED, reasoningEffort: "none" }, mustReason.fetch)).toEqual({
      ok: true,
      structured: "jsonSchema",
      message: null,
      reasoningEffort: "low",
    });
    // One call for each setting: no walk down the ways of asking for JSON, which was not refused.
    expect(mustReason.asked.map((body) => [body.reasoning_effort, formatOf(body)])).toEqual([
      ["none", "json_schema"],
      [undefined, "json_schema"],
      ["low", "json_schema"],
    ]);

    const takesNone = answering((body) =>
      body.reasoning_effort === undefined ? null : "property 'reasoning_effort' is unsupported",
    );
    expect(await probeWorker({ ...UNPROBED, reasoningEffort: "none" }, takesNone.fetch)).toEqual({
      ok: true,
      structured: "jsonSchema",
      message: null,
      reasoningEffort: null,
    });

    // A setting the server takes is left as typed, and a server that refuses all three says why.
    const fine = answering(() => null);
    expect(await probeWorker({ ...UNPROBED, reasoningEffort: "high" }, fine.fetch)).toEqual({
      ok: true,
      structured: "jsonSchema",
      message: null,
    });
    const never = answering(() => "Reasoning is not available on this plan");
    expect(await probeWorker({ ...UNPROBED, reasoningEffort: "none" }, never.fetch)).toMatchObject({
      ok: false,
      message: expect.stringContaining("Reasoning is not available"),
    });
  });

  it("does not stop the second check: it is asked again, and a rate limit is waited out", async () => {
    const seen: Array<string> = [];
    const flaky: typeof fetch = async (_url, init) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as {
        response_format?: { type?: string };
      };
      seen.push(body.response_format?.type ?? "none");
      if (seen.length === 1) {
        return new Response(JSON.stringify({ error: { message: "Rate limit reached." } }), {
          status: 429,
          headers: { "content-type": "application/json", "retry-after": "0.001" },
        });
      }
      if (body.response_format?.type === "json_schema") {
        return new Response(
          JSON.stringify({
            error: { message: "Failed to generate JSON.", code: "json_validate_failed" },
          }),
          { status: 400, headers: { "content-type": "application/json" } },
        );
      }
      const values = [{ text: "CLM-88-4471", kind: "CASE" }];
      return new Response(
        JSON.stringify({
          choices: [{ finish_reason: "stop", message: { content: JSON.stringify({ values }) } }],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    };
    const text = "The claim under file CLM-88-4471 was heard at the district office last week.";
    const [spans] = await makeSecondPassDetector({ endpoint: () => ENDPOINT, fetch: flaky }).detect(
      [text],
    );
    expect(spans?.map((span) => text.slice(span.start, span.end))).toEqual(["CLM-88-4471"]);
    expect(seen).toEqual(["json_schema", "json_schema", "json_schema", "json_object"]);

    // A used-up allowance is answered with 429 too, but no wait changes it: asked once.
    let calls = 0;
    const usedUp: typeof fetch = async () => {
      calls += 1;
      return Response.json(
        { error: { code: "quota_exceeded", message: "This account has used its allowance." } },
        { status: 429, headers: { "retry-after": "0.001" } },
      );
    };
    await expect(
      makeSecondPassDetector({ endpoint: () => ENDPOINT, fetch: usedUp }).detect([text]),
    ).rejects.toThrow("This account has used its allowance.");
    expect(calls).toBe(1);
  });
});

describe("a worker whose server queues calls for everyone", () => {
  /** DoeDesk Cloud's worker: two calls at once in the region, and up to five seconds in its line. */
  const QUEUED: WorkerEndpoint = { ...ENDPOINT, queue: { parallel: 2, maxWaitMs: 5_000 } };
  const ITEMS: ReadonlyArray<FieldSpec> = [
    { name: "items", type: "number", description: "The number of line items." },
  ];
  const answer = (headers: Record<string, string> = {}) =>
    new Response(
      JSON.stringify({
        choices: [
          {
            finish_reason: "stop",
            message: {
              content: JSON.stringify({
                items: { quote: "عدد الأصناف: 11", value: "11", scale: "none" },
              }),
            },
          },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      }),
      { status: 200, headers: { "content-type": "application/json", ...headers } },
    );
  const busy = (waiting: number) =>
    new Response(
      JSON.stringify({ error: { code: "worker_busy", message: "The worker is busy.", waiting } }),
      { status: 429, headers: { "content-type": "application/json", "retry-after": "7" } },
    );

  it("is sent no more calls at once than it takes, and no more once it says it is busy", async () => {
    let inFlight = 0;
    let most = 0;
    let calls = 0;
    const queueing: typeof fetch = async () => {
      calls += 1;
      const mine = calls;
      inFlight += 1;
      most = Math.max(most, inFlight);
      // Lets the other lane start its call before this one is answered.
      await Promise.resolve();
      inFlight -= 1;
      return mine <= 2 ? answer() : busy(4);
    };
    const documents = [1, 2, 3, 4, 5, 6].map((number) => ({
      handle: `DOC_${number}`,
      text: ORDER,
    }));
    const results = await runBatch(documents, "For a register.", ITEMS, {
      endpoint: QUEUED,
      // The number that would be used for a server that does not say.
      concurrency: 16,
      fetch: queueing,
    });
    expect(most).toBe(2);
    expect(results.map((result) => result.status)).toEqual([
      "done",
      "done",
      "failed",
      "failed",
      "failed",
      "failed",
    ]);
    // The two calls in flight were told "busy"; neither was sent again, and the last two never were.
    expect(calls).toBe(4);
    expect(results.slice(2).map((result) => result.busy)).toEqual(
      Array.from({ length: 4 }, () => ({ waiting: 4, retryAfter: 7 })),
    );
    expect(results[5]?.problem).toBe(WORKER_BUSY);
  });

  it("is not asked again when it says its region has no worker now", async () => {
    let calls = 0;
    const noWorker: typeof fetch = async () => {
      calls += 1;
      return new Response(
        JSON.stringify({ error: { code: "worker_unavailable", message: "Not available." } }),
        { status: 503, headers: { "content-type": "application/json" } },
      );
    };
    const [result] = await runBatch([{ handle: "DOC_1", text: ORDER }], "For a register.", ITEMS, {
      endpoint: QUEUED,
      fetch: noWorker,
    });
    // Any other 503 is asked three more times, with a wait before each.
    expect(calls).toBe(1);
    expect(result?.status).toBe("failed");
  });

  it("gives one question more time the fewer documents the server takes at once, and says which documents are still waiting", async () => {
    // Twenty seconds a round of documents, never less than another server gets, ten minutes at most.
    expect(queuedBatchMs(64, 16, 20_000)).toBe(120_000);
    expect(queuedBatchMs(16, 1, 20_000)).toBe(340_000);
    expect(queuedBatchMs(64, 5, 20_000)).toBe(280_000);
    expect(queuedBatchMs(64, 1, 20_000)).toBe(600_000);

    // The question's time runs out after the first document is read.
    const time = new AbortController();
    const first: typeof fetch = async () => {
      time.abort();
      return answer();
    };
    const documents = [1, 2, 3].map((number) => ({ handle: `DOC_${number}`, text: ORDER }));
    const queued = await runBatch(documents, "For a register.", ITEMS, {
      endpoint: { ...QUEUED, queue: { parallel: 1, maxWaitMs: 5_000 } },
      fetch: first,
      signal: time.signal,
    });
    expect(queued.map((result) => [result.status, result.notReached ?? false])).toEqual([
      ["done", false],
      ["failed", true],
      ["failed", true],
    ]);
    expect(queued[2]?.problem).toBe(NOT_REACHED);
    // A server that does not queue words it as before.
    const direct = await runBatch(documents, "For a register.", ITEMS, {
      endpoint: ENDPOINT,
      concurrency: 1,
      fetch: first,
      signal: time.signal,
    });
    expect(direct[2]).toMatchObject({
      problem: "The batch ran out of time before this document was read.",
    });
    expect(direct[2]?.notReached).toBeUndefined();
  });

  it("keeps the answers it has when the rest are still waiting, and reads only the rest when asked again", async () => {
    const sent: Array<string> = [];
    let busyNow = true;
    const oneThenBusy: typeof fetch = async (_url, init) => {
      const body = String(init?.body ?? "");
      // The order is read first; the delivery note is met by a busy server the first time.
      if (!body.includes("الأصناف") && busyNow) return busy(2);
      sent.push(body.includes("الأصناف") ? "order" : "delivery");
      const fields = ANSWERS.find(([marker]) => body.includes(marker))?.[1] ?? {};
      return new Response(
        JSON.stringify({
          choices: [{ finish_reason: "stop", message: { content: JSON.stringify(fields) } }],
          usage: { prompt_tokens: 10, completion_tokens: 5 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    };
    using context = setup(oneThenBusy, undefined, {
      ...ENDPOINT,
      queue: { parallel: 1, maxWaitMs: 5_000 },
    });
    const partial = await ask(context.worker, "t", undefined);
    expect(partial.ok).toBe(true);
    if (!partial.ok) return;
    const shown = partial.payload as {
      documents: ReadonlyArray<{ handle: string; status: string; problem?: string }>;
    };
    // The order's answers are given; the note says it is waiting and to ask again.
    expect(shown.documents.map((document) => [document.status, document.problem])).toEqual([
      ["done", undefined],
      ["failed", WORKER_BUSY],
    ]);
    expect(context.worker.busy()).toEqual({ waiting: 2 });
    expect(sent).toEqual(["order"]);

    busyNow = false;
    const whole = await ask(context.worker, "t", undefined);
    expect(whole.ok).toBe(true);
    if (!whole.ok) return;
    expect(
      (whole.payload as { documents: ReadonlyArray<{ status: string }> }).documents.map(
        (document) => document.status,
      ),
    ).toEqual(["done", "done"]);
    // Only the document that was waiting was sent: the order's answers were kept.
    expect(sent).toEqual(["order", "delivery"]);
    expect(context.worker.busy()).toBeNull();
    // The asking that was cut short did not use up the question: it may still be put once more.
    expect((await ask(context.worker, "t", undefined)).ok).toBe(true);
    expect(await ask(context.worker, "t", undefined)).toMatchObject({
      ok: false,
      message: expect.stringContaining("already asked twice"),
    });
  });

  it("says busy with how many are waiting, is not held to have failed, and may be asked again", async () => {
    let calls = 0;
    const alwaysBusy: typeof fetch = async () => {
      calls += 1;
      return busy(3);
    };
    using context = setup(alwaysBusy, undefined, QUEUED);
    for (const caller of ["a", "a", "a"]) {
      const said = await ask(context.worker, caller, undefined);
      expect(said).toMatchObject({
        ok: false,
        message: expect.stringMatching(/^The worker is busy: 3 calls are waiting for it\./),
      });
    }
    // The same question three times: a busy answer does not use up its two askings.
    expect(context.worker.busy()).toEqual({ waiting: 3 });
    expect(context.worker.available()).toBe(true);
    // One call per asking reaches the server before it stops: two documents, two lanes.
    expect(calls).toBe(6);
    context.worker.reset();
    expect(context.worker.busy()).toBeNull();
  });

  it("counts a document's time while its call is with the worker, not while it waits its turn", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      /** A call the test answers when it chooses, and that fails when its time is up. */
      const held = () => {
        let answerNow: (response: Response) => void = () => undefined;
        const call: typeof fetch = (_url, init) =>
          new Promise((resolve, reject) => {
            answerNow = resolve;
            init?.signal?.addEventListener("abort", () =>
              reject(new DOMException("aborted", "AbortError")),
            );
          });
        return { call, answer: (response: Response) => answerNow(response) };
      };
      const source = { handle: "DOC_1", text: ORDER };
      const throughQueue = held();
      const straight = held();
      const queued = runJob(source, "For a register.", ITEMS, {
        endpoint: QUEUED,
        deadlineMs: 1_000,
        fetch: throughQueue.call,
      });
      const direct = runJob(source, "For a register.", ITEMS, {
        endpoint: ENDPOINT,
        deadlineMs: 1_000,
        fetch: straight.call,
      });
      // Three seconds pass: the document's one second, and most of the wait a queue may take.
      await vi.advanceTimersByTimeAsync(3_000);
      // The queued call was in the server's line for 2.9 of them and with the worker for the rest.
      throughQueue.answer(answer({ "x-doedesk-worker-queued-ms": "2900" }));
      expect(await queued).toMatchObject({ status: "done", problem: null });
      // A server that does not queue is given the document's time and no more, as before.
      expect(await direct).toMatchObject({
        status: "failed",
        problem: "The worker ran out of time on this document.",
      });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("answers kept from one session to the next", () => {
  const ORDER_ANSWER = ANSWERS[0]?.[1] ?? {};
  /** A session: the store opened again over the same folder, and a worker with nothing in memory. */
  const session = (
    directory: string,
    options: {
      readonly reply?: Record<string, unknown>;
      readonly model?: string;
      readonly checks?: { readonly evidence: boolean };
      readonly gate?: Promise<void>;
    } = {},
  ) => {
    const store = new SealedStore(directory);
    const sent: Array<string> = [];
    const worker = makeSealedWorker({
      store,
      vault: () => new Vault(),
      endpoint: () => ({ ...ENDPOINT, model: options.model ?? ENDPOINT.model }),
      route: () => "sa",
      checks: options.checks,
      fetch: async (_url, init) => {
        sent.push(String(init?.body ?? ""));
        await options.gate;
        return new Response(
          JSON.stringify({
            choices: [
              {
                finish_reason: "stop",
                message: { content: JSON.stringify(options.reply ?? ORDER_ANSWER) },
              },
            ],
            usage: { prompt_tokens: 10, completion_tokens: 5 },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      },
    });
    return { store, worker, sent };
  };
  const sealed = () => {
    const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "sealed-kept-"));
    new SealedStore(directory).add("p", "order.txt", ORDER, "text/plain");
    return {
      directory,
      [Symbol.dispose]: () => NodeFS.rmSync(directory, { recursive: true, force: true }),
    };
  };
  const question = (
    worker: ReturnType<typeof session>["worker"],
    caller: string,
    fields: ReadonlyArray<FieldSpec> = FIELDS,
  ) =>
    worker.ask({
      project: "p",
      caller,
      handles: ["DOC_1"],
      instruction: "For a register.",
      fields,
    });
  /** A payload with each stand-in's random part taken out: two vaults never draw the same. */
  const shape = (answer: unknown) =>
    JSON.stringify(answer).replace(/\[([A-Z]+)_[A-Z0-9]+\]/g, "[$1]");
  const recorded = (store: SealedStore) =>
    store.clearAnswers("p").map(({ at: _at, ...answer }) => answer);
  const keptFiles = (directory: string) =>
    NodeFS.readdirSync(directory, { recursive: true }).filter((path) =>
      /answers.DOC_/.test(String(path)),
    );

  it("answers what an earlier session asked without the worker, counted and recorded as a fresh answer is", async () => {
    using kept = sealed();
    using fresh = sealed();
    // Several fields of one document are one call to the worker.
    for (const { directory } of [kept, fresh]) {
      const first = session(directory);
      expect((await question(first.worker, "thread-1")).ok).toBe(true);
      expect(first.sent).toHaveLength(1);
      // The person starts the count again, so every answer given next has to be counted anew.
      first.store.resetLedger("p");
    }
    new SealedStore(fresh.directory).forgetAnswers();

    const remembering = session(kept.directory, {
      reply: {
        ...ORDER_ANSWER,
        method: { quote: "طريقة الشراء: منافسة عامة", value: "منافسة عامة" },
      },
    });
    const asking = session(fresh.directory);
    const remembered = await question(remembering.worker, "thread-2");
    const asked = await question(asking.worker, "thread-2");
    expect(remembering.sent).toHaveLength(0);
    expect(asking.sent).toHaveLength(1);
    expect(shape(remembered)).toBe(shape(asked));
    expect(remembering.store.ledger("p")).toEqual(asking.store.ledger("p"));
    expect(remembering.store.ledger("p").clearAnswers.DOC_1).toBeGreaterThan(0);
    expect(recorded(remembering.store)).toEqual(recorded(asking.store));
    // Asked again in the same turn or a later one, and one field more: only that one is sent.
    await question(remembering.worker, "thread-3");
    const more = await question(remembering.worker, "thread-3", [
      ...FIELDS,
      { name: "method", type: "identifier", description: "How it was bought." },
    ]);
    expect(more.ok).toBe(true);
    expect(remembering.sent).toHaveLength(1);
    expect(remembering.sent[0]).toContain("- method (identifier)");
    expect(remembering.sent[0]).not.toContain("- total (number)");
  });

  it("asks the worker again once the file, the worker or the checks are no longer the same", async () => {
    using context = sealed();
    const { directory } = context;
    // Kept by weaker checks: a passage the document does not hold. It is checked again, and fails.
    const loose = session(directory, {
      checks: { evidence: false },
      reply: { ...ORDER_ANSWER, doc_type: { quote: "not in the document", value: "order" } },
    });
    expect((await question(loose.worker, "t")).ok).toBe(true);
    expect(keptFiles(directory)).toHaveLength(1);
    const strict = session(directory);
    expect((await question(strict.worker, "t")).ok).toBe(true);
    expect(strict.sent).toHaveLength(1);
    expect(strict.sent[0]).toContain("- doc_type (enum");
    expect(strict.sent[0]).not.toContain("- total (number)");

    // Another model at the same address is another worker.
    const other = session(directory, { model: "other" });
    await question(other.worker, "t");
    expect(other.sent).toHaveLength(1);
    const again = session(directory, { model: "other" });
    await question(again.worker, "t");
    expect(again.sent).toHaveLength(0);

    // The same file saved again keeps its handle and loses its answers.
    again.store.keep(
      "p",
      "order.txt",
      { text: `${ORDER}\n`, mediaType: "text/plain" },
      undefined,
      "DOC_1",
    );
    expect(keptFiles(directory)).toHaveLength(0);
    await question(again.worker, "t2");
    expect(again.sent).toHaveLength(1);
    expect(keptFiles(directory)).toHaveLength(1);

    // Another worker from now on, and then the file unsealed: nothing is left on disk.
    again.worker.reset();
    expect(keptFiles(directory)).toHaveLength(0);
    await question(again.worker, "t3");
    expect(again.sent).toHaveLength(2);
    again.store.remove("p", "DOC_1");
    expect(keptFiles(directory)).toHaveLength(0);
  });

  it("keeps a bounded number of answers for a document, the newest", () => {
    using context = sealed();
    const store = new SealedStore(context.directory);
    const reply = (key: string, raw: unknown = { quote: "", value: null }) => ({
      key,
      raw,
      unquotedChoice: false,
    });
    store.keepAnswers(
      "p",
      "DOC_1",
      "w",
      "text",
      Array.from({ length: 300 }, (_, i) => reply(`k${i}`)),
    );
    const keys = store.keptAnswers("p", "DOC_1", "w", "text").map((answer) => answer.key);
    expect(keys).toHaveLength(256);
    expect(keys.at(-1)).toBe("k299");
    store.keepAnswers("p", "DOC_1", "w", "text", [reply("large", { quote: "x".repeat(200_000) })]);
    const sizes = store.keptAnswers("p", "DOC_1", "w", "text");
    expect(sizes.at(-1)?.key).toBe("large");
    expect(JSON.stringify(sizes).length).toBeLessThan(256_000);
    // Another worker's answers, or answers about another text, are not these.
    expect(store.keptAnswers("p", "DOC_1", "other", "text")).toEqual([]);
    expect(store.keptAnswers("p", "DOC_1", "w", "changed")).toEqual([]);
  });

  it("sends one call when two questions about the same field of a document arrive at once", async () => {
    using context = sealed();
    let open: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    const { worker, sent } = session(context.directory, { gate });
    const total = FIELDS.filter((field) => field.name === "total");
    const both = FIELDS.filter((field) => field.name === "total" || field.name === "items");
    const answers = Promise.all([
      question(worker, "thread-1", total),
      question(worker, "thread-2", total),
      question(worker, "thread-3", both),
    ]);
    open();
    const [first, second, third] = await answers;
    expect(shape(first)).toBe(shape(second));
    expect(third.ok).toBe(true);
    // One call for the total, and one for the field only the third question asked.
    expect(sent).toHaveLength(2);
    expect(sent[1]).toContain("- items (number)");
    expect(sent[1]).not.toContain("- total (number)");
  });
});
