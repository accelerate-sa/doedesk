/**
 * Measures a worker on documents with known answers: fields right, time and tokens per job.
 * The endpoint comes from WORKER_BASE_URL, WORKER_MODEL and WORKER_API_KEY (or GROQ_API_KEY).
 * With real documents the output files hold confidential values. Usage: see the message below.
 */
import * as NodeFS from "node:fs";

import type { StructuredOutput, WorkerDriver } from "../src/worker/client.ts";
import type { FieldSpec } from "../src/worker/fields.ts";
import { runJob } from "../src/worker/job.ts";

interface BenchJob {
  readonly id: string;
  readonly handle: string;
  readonly text: string;
  readonly instruction: string;
  readonly fields: ReadonlyArray<FieldSpec>;
}

const argument = (name: string, fallback: string): string => {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? fallback : (process.argv[index + 1] ?? fallback);
};

const jobsPath = argument("jobs", "");
const outPath = argument("out", "");
if (jobsPath === "" || outPath === "") {
  console.error(
    [
      "Usage: node scripts/worker-bench.ts --jobs jobs.jsonl --out results.jsonl",
      "  [--concurrency 4] [--effort none|low|medium|high|unset] [--driver chatCompletions|responses]",
      "  [--evidence on|off] [--attempts 3] [--structured jsonSchema|jsonObject|none]",
      "  [--limit N] [--only id,id] [--raw exchanges.jsonl]",
      "jobs.jsonl holds one { id, handle, text, instruction, fields } per line.",
    ].join("\n"),
  );
  process.exit(2);
}
const concurrency = Number(argument("concurrency", "4"));
const effort = argument("effort", "none");
const driver = argument("driver", "chatCompletions") as WorkerDriver;
const evidence = argument("evidence", "on") === "on";
const attempts = Number(argument("attempts", "3"));
const structured = argument("structured", "jsonSchema") as StructuredOutput;
const limit = Number(argument("limit", "0"));
const rawPath = argument("raw", "");
const only = argument("only", "");
const apiKey = process.env.WORKER_API_KEY ?? process.env.GROQ_API_KEY;
const endpoint = {
  baseUrl: process.env.WORKER_BASE_URL ?? "https://api.groq.com/openai/v1",
  model: process.env.WORKER_MODEL ?? "qwen/qwen3.8-27b",
  apiKey,
  driver,
  structured,
  ...(effort === "unset" ? {} : { reasoningEffort: effort }),
};

const jobs = NodeFS.readFileSync(jobsPath, "utf8")
  .split("\n")
  .filter((line) => line.trim().length > 0)
  .map((line) => JSON.parse(line) as BenchJob)
  .filter((job) => only === "" || only.split(",").includes(job.id))
  .slice(0, limit > 0 ? limit : undefined);
const raw = rawPath === "" ? undefined : NodeFS.createWriteStream(rawPath, { encoding: "utf8" });

const out = NodeFS.createWriteStream(outPath, { encoding: "utf8" });
const started = performance.now();
let next = 0;
let done = 0;
const lane = async () => {
  for (;;) {
    const job = jobs[next];
    next += 1;
    if (job === undefined) return;
    const startedAt = performance.now() - started;
    const result = await runJob(
      { handle: job.handle, text: job.text },
      job.instruction,
      job.fields,
      {
        endpoint,
        checks: { evidence, maxTextChars: 240, maxCopiedWords: 0 },
        maxAttempts: attempts,
        deadlineMs: 120_000,
        onExchange: (exchange) =>
          raw?.write(
            `${JSON.stringify({ id: job.id, attempt: exchange.attempt, corrections: exchange.corrections, reply: exchange.reply })}\n`,
          ),
      },
    );
    out.write(
      `${JSON.stringify({
        id: job.id,
        startedAtMs: Math.round(startedAt),
        ms: Math.round(result.ms),
        status: result.status,
        problem: result.problem,
        endpointRetries: result.endpointRetries,
        attempts: result.attempts.map((attempt) => ({ ...attempt, ms: Math.round(attempt.ms) })),
        fields: result.fields.map((field) => ({
          name: field.name,
          type: field.type,
          status: field.status,
          value: field.value,
          surface: field.surface,
          evidence: field.evidence?.quote ?? null,
          problems: field.problems,
        })),
      })}\n`,
    );
    done += 1;
    if (done % 25 === 0) console.error(`${done}/${jobs.length}`);
  }
};
await Promise.all(Array.from({ length: Math.max(1, concurrency) }, lane));
await new Promise((resolve) => out.end(resolve));
console.log(
  JSON.stringify({
    jobs: jobs.length,
    wallMs: Math.round(performance.now() - started),
    concurrency,
    effort,
    driver,
    evidence,
    structured,
    model: endpoint.model,
  }),
);
