/**
 * Runs written-out `ask_documents` calls through the real sealed path with no remote model:
 * sealed store, worker, checks, program, sealing. For each call it writes what the remote
 * model would be shown, and beside it the real values, to score the path against known answers.
 * The endpoint comes from WORKER_BASE_URL, WORKER_MODEL and WORKER_API_KEY (or GROQ_API_KEY).
 */
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { Vault } from "../src/vault.ts";
import type { StructuredOutput, WorkerDriver } from "../src/worker/client.ts";
import type { FieldSpec } from "../src/worker/fields.ts";
import { makeSealedWorker, type WorkerCallRecord } from "../src/worker/sealedWorker.ts";
import { SealedStore } from "../src/worker/store.ts";

interface BenchCall {
  readonly id: string;
  /** Calls of one session share a store and a vault and run in order, as one task's calls do. */
  readonly session?: string;
  readonly documents: ReadonlyArray<{ readonly name: string; readonly text: string }>;
  readonly instruction: string;
  readonly fields: ReadonlyArray<FieldSpec>;
  /** A program to run over the answers of the call. */
  readonly program?: string;
}

const argument = (name: string, fallback: string): string => {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? fallback : (process.argv[index + 1] ?? fallback);
};

const callsPath = argument("calls", "");
const outPath = argument("out", "");
if (callsPath === "" || outPath === "") {
  console.error(
    [
      "Usage: node scripts/ask-bench.ts --calls calls.jsonl --out results.jsonl",
      "  [--concurrency 16] [--effort none|low|medium|high|unset] [--driver chatCompletions|responses]",
      "  [--evidence on|off] [--parallel 2] [--limit N]",
      "calls.jsonl holds one { id, session?, documents: [{ name, text }], instruction, fields, program? } per line.",
    ].join("\n"),
  );
  process.exit(2);
}
const effort = argument("effort", "none");
const endpoint = {
  baseUrl: process.env.WORKER_BASE_URL ?? "https://api.groq.com/openai/v1",
  model: process.env.WORKER_MODEL ?? "qwen/qwen3.8-27b",
  apiKey: process.env.WORKER_API_KEY ?? process.env.GROQ_API_KEY,
  driver: argument("driver", "chatCompletions") as WorkerDriver,
  structured: "jsonSchema" as StructuredOutput,
  ...(effort === "unset" ? {} : { reasoningEffort: effort }),
};
const limit = Number(argument("limit", "0"));
const calls = NodeFS.readFileSync(callsPath, "utf8")
  .split("\n")
  .filter((line) => line.trim().length > 0)
  .map((line) => JSON.parse(line) as BenchCall)
  .slice(0, limit > 0 ? limit : undefined);

const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "ask-bench-"));
const out = NodeFS.createWriteStream(outPath, { encoding: "utf8" });
const started = performance.now();
const sessions = new Map<string, Array<BenchCall>>();
for (const call of calls) {
  const key = call.session ?? call.id;
  sessions.set(key, [...(sessions.get(key) ?? []), call]);
}
const queue = [...sessions];
let next = 0;
const lane = async () => {
  for (;;) {
    const entry = queue[next];
    next += 1;
    if (entry === undefined) return;
    const [session, group] = entry;
    // One store and one vault per session, as one task has in the app.
    const store = new SealedStore(NodePath.join(directory, session));
    const vault = new Vault();
    const handles: Record<string, string> = {};
    let record: WorkerCallRecord | undefined;
    const worker = makeSealedWorker({
      store,
      vault: () => vault,
      endpoint: () => endpoint,
      concurrency: Number(argument("concurrency", "16")),
      onCall: (seen) => {
        record = seen;
      },
      ...(argument("evidence", "on") === "off" ? { checks: { evidence: false } } : {}),
    });
    for (const call of group) {
      for (const document of call.documents) {
        if (Object.values(handles).includes(document.name)) continue;
        handles[store.add(session, document.name, document.text, "text/plain").handle] =
          document.name;
      }
      record = undefined;
      const answer = await worker.ask({
        project: session,
        caller: "bench",
        handles: [],
        instruction: call.instruction,
        fields: call.fields,
        ...(call.program === undefined ? {} : { program: call.program }),
      });
      out.write(
        `${JSON.stringify({
          id: call.id,
          ok: answer.ok,
          message: answer.ok ? null : answer.message,
          handles,
          shown: answer.ok ? answer.payload : null,
          // Inside the boundary: what each stand-in and each sealed reference stands for.
          vault: Object.fromEntries(vault.entries().map((entry) => [entry.token, entry.value])),
          values: store.values(session),
          ledger: store.ledger(session),
          record,
        })}\n`,
      );
    }
  }
};
await Promise.all(Array.from({ length: Math.max(1, Number(argument("parallel", "2"))) }, lane));
await new Promise((resolve) => out.end(resolve));
NodeFS.rmSync(directory, { recursive: true, force: true });
console.log(
  JSON.stringify({
    calls: calls.length,
    wallMs: Math.round(performance.now() - started),
    effort,
    model: endpoint.model,
  }),
);
