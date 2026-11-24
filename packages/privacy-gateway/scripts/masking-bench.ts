/**
 * Measures what masking adds to each request of a long session, with no agent and no network:
 * request bodies go through the same masking path the gateway uses, and a stand-in detection
 * service answers after a fixed wait. Run from this package. Usage: see the message below.
 */
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeZlib from "node:zlib";

import {
  cacheDetector,
  combineDetectors,
  ignoreAppAuthoredBlocks,
  makeRemoteDetector,
  patternDetector,
} from "../src/detect.ts";
import { Pseudonymizer } from "../src/pseudonymizer.ts";
import { maskRequestBody, type WireFormat, wireFormatForPath } from "../src/requestMasking.ts";
import { Vault } from "../src/vault.ts";

const argument = (name: string, fallback: string): string => {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? fallback : (process.argv[index + 1] ?? fallback);
};

if (process.argv.includes("--help")) {
  console.error(
    [
      "Usage: node scripts/masking-bench.ts [--turns 120] [--latency 120] [--per-chunk 0]",
      "  [--large 600] [--source folder] [--bodies sent-bodies.ndjson(.gz)] [--json]",
      "Without --bodies a coding session is built: each turn the agent reads a source file of this",
      "package, and each request carries the whole history, as an agent's does.",
      "--large: the size in KB of one long file read on the third turn (0 for none).",
      "--source: the folder whose .ts files the agent reads (this package's src by default). Give",
      "the same folder to two versions of the code to compare them on the same session.",
      "The last line is a digest of everything that was sent, with each stand-in reduced to its",
      "kind: two versions of the code that mask the same things print the same digest.",
      "--latency: milliseconds the stand-in detection service takes per call; --per-chunk: more",
      "per piece of text in the call. --bodies replays recorded bodies ({ path, body } per line).",
    ].join("\n"),
  );
  process.exit(2);
}

const turns = Number(argument("turns", "120"));
const latency = Number(argument("latency", "120"));
const perChunk = Number(argument("per-chunk", "0"));
const largeKb = Number(argument("large", "600"));
const bodiesPath = argument("bodies", "");
const sourcePath = argument("source", NodePath.join(import.meta.dirname, "..", "src"));

/** People and organisations planted in the session, for the stand-in service to find. */
const NAMES = [
  "Khalid Al-Otaibi",
  "Noura Al-Harbi",
  "Faisal Al-Dosari",
  "Sara Nasser",
  "Mishal Al-Subaie",
  "Reem Al-Zahrani",
  "Tilal National Medical Services",
  "Rawasi Advanced Trading",
  "محمد بن سعد العتيبي",
  "نورة الحربي",
  "شركة قمم الحجاز",
  "Thessaly Brackenridge",
];
const NAME_PATTERN = new RegExp(
  NAMES.map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"),
  "g",
);

interface Request {
  readonly format: WireFormat;
  readonly body: string;
}

/** A session in which an agent reads one file a turn and the person writes now and then. */
const buildSession = (): ReadonlyArray<Request> => {
  const source = NodePath.resolve(sourcePath);
  const files = NodeFS.readdirSync(source)
    .filter((name) => name.endsWith(".ts"))
    .toSorted()
    .map((name) => ({ name, text: NodeFS.readFileSync(NodePath.join(source, name), "utf8") }));
  const system = NodeFS.readFileSync(NodePath.join(import.meta.dirname, "..", "README.md"), "utf8");
  const tools = ["Read", "Edit", "Write", "Bash", "Grep", "Glob", "WebFetch", "WebSearch"].map(
    (name) => ({ name, description: `The ${name} tool.`, input_schema: { type: "object" } }),
  );
  const messages: Array<unknown> = [];
  const requests: Array<Request> = [];
  for (let turn = 0; turn < turns; turn += 1) {
    const file = files[turn % files.length];
    if (file === undefined) break;
    const name = NAMES[turn % NAMES.length] ?? "";
    if (turn % 8 === 0) {
      messages.push({
        role: "user",
        content: `Turn ${turn}: ${name} asked for the report on ${file.name}. Call 0551234${String(100 + turn).slice(-3)} when it is ready.`,
      });
    }
    const id = `toolu_${turn}`;
    const path = `/Users/ada/project/src/${file.name}`;
    messages.push({
      role: "assistant",
      content: [
        { type: "text", text: `I will read ${file.name} for ${name} next.` },
        { type: "tool_use", id, name: "Read", input: { file_path: path } },
      ],
    });
    // Every fifth file carries names, as a client list or a letter in a workspace would.
    const listing = file.text
      .split("\n")
      .map((line, index) => `${String(index + 1).padStart(6)}\t${line}`)
      .join("\n");
    const all = files.map((each) => each.text).join("\n");
    const result =
      turn === 2 && largeKb > 0
        ? all.repeat(Math.ceil((largeKb * 1000) / all.length)).slice(0, largeKb * 1000)
        : turn % 5 === 0
          ? `${NAMES.map((planted, row) => `${row}\t${planted}\t10${String(98765432 - turn * 7 - row)}`).join("\n")}\n${listing}`
          : listing;
    messages.push({
      role: "user",
      content: [{ type: "tool_result", tool_use_id: id, content: result }],
    });
    requests.push({
      format: "anthropic-messages",
      body: JSON.stringify({ model: "bench", system, tools, messages, stream: true }),
    });
  }
  return requests;
};

const readBodies = (path: string): ReadonlyArray<Request> => {
  const raw = NodeFS.readFileSync(path);
  const text = (path.endsWith(".gz") ? NodeZlib.gunzipSync(raw) : raw).toString("utf8");
  return text
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .flatMap((line) => {
      const record = JSON.parse(line) as { readonly path?: string; readonly body?: string };
      const format = wireFormatForPath(record.path ?? "");
      return format === undefined || typeof record.body !== "string"
        ? []
        : [{ format, body: record.body }];
    });
};

const requests = bodiesPath === "" ? buildSession() : readBodies(bodiesPath);

// The stand-in service: waits, then reports the planted names. Its own time is counted apart.
let detectorWaitMs = 0;
let detectorCalls = 0;
let detectorChunks = 0;
let inFlight = 0;
let waitingSince = 0;
const standIn: typeof fetch = async (_url, init) => {
  const { texts } = JSON.parse(String(init?.body)) as { texts: ReadonlyArray<string> };
  detectorCalls += 1;
  detectorChunks += texts.length;
  if (inFlight === 0) waitingSince = performance.now();
  inFlight += 1;
  await new Promise((resolve) => setTimeout(resolve, latency + perChunk * texts.length));
  const results = texts.map((text) => ({
    entities: [...text.matchAll(NAME_PATTERN)].map((match) => ({
      start: match.index,
      end: match.index + match[0].length,
      kind: "PERSON",
    })),
  }));
  inFlight -= 1;
  // Calls that overlap are waited for once: the wall time with any call open.
  if (inFlight === 0) detectorWaitMs += performance.now() - waitingSince;
  return Response.json({ results });
};

const vault = new Vault();
const remote = makeRemoteDetector({ endpoint: "http://stand-in.invalid", fetch: standIn });
const pseudonymizer = new Pseudonymizer(
  vault,
  cacheDetector(combineDetectors([patternDetector, ignoreAppAuthoredBlocks(remote)])),
);

interface Sample {
  readonly bytes: number;
  readonly totalMs: number;
  readonly waitMs: number;
  readonly parseMs: number;
  readonly stringifyMs: number;
}
const samples: Array<Sample> = [];
const digest = NodeCrypto.createHash("sha256");
for (const request of requests) {
  const waitBefore = detectorWaitMs;
  const start = performance.now();
  const parsed: unknown = JSON.parse(request.body);
  const parsedAt = performance.now();
  const masked = await maskRequestBody(request.format, parsed, pseudonymizer, undefined, {
    webResults: "known",
  });
  const maskedAt = performance.now();
  const sent = JSON.stringify(masked.body);
  const end = performance.now();
  digest.update(sent.replace(/\[([A-Z]+)_[A-HJ-NP-Z2-9]{5}\]/g, "[$1]"));
  samples.push({
    bytes: request.body.length,
    totalMs: end - start,
    waitMs: detectorWaitMs - waitBefore,
    parseMs: parsedAt - start,
    stringifyMs: end - maskedAt,
  });
}

const sum = (values: ReadonlyArray<number>) => values.reduce((total, value) => total + value, 0);
const percentile = (values: ReadonlyArray<number>, share: number) =>
  values.toSorted((left, right) => left - right)[
    Math.min(values.length - 1, Math.floor(values.length * share))
  ] ?? 0;
const local = samples.map((sample) => sample.totalMs - sample.waitMs);
const lastTen = samples.slice(-10);
const report = {
  requests: samples.length,
  megabytes: Number((sum(samples.map((sample) => sample.bytes)) / 1e6).toFixed(1)),
  largestBodyKb: Math.round(Math.max(...samples.map((sample) => sample.bytes)) / 1000),
  totalMs: Math.round(sum(samples.map((sample) => sample.totalMs))),
  waitingOnDetectorMs: Math.round(sum(samples.map((sample) => sample.waitMs))),
  localMs: Math.round(sum(local)),
  parseAndStringifyMs: Math.round(
    sum(samples.map((sample) => sample.parseMs + sample.stringifyMs)),
  ),
  localPerRequestMs: {
    median: Number(percentile(local, 0.5).toFixed(1)),
    p95: Number(percentile(local, 0.95).toFixed(1)),
    max: Number(Math.max(...local).toFixed(1)),
    lastTenMean: Number(
      (sum(lastTen.map((sample) => sample.totalMs - sample.waitMs)) / lastTen.length).toFixed(1),
    ),
  },
  totalPerRequestMs: {
    median: Number(
      percentile(
        samples.map((sample) => sample.totalMs),
        0.5,
      ).toFixed(1),
    ),
    p95: Number(
      percentile(
        samples.map((sample) => sample.totalMs),
        0.95,
      ).toFixed(1),
    ),
    max: Number(Math.max(...samples.map((sample) => sample.totalMs)).toFixed(1)),
  },
  detectorCalls,
  detectorChunks,
  vaultEntries: vault.size,
  sentDigest: digest.digest("hex").slice(0, 16),
};

if (process.argv.includes("--json")) {
  console.log(JSON.stringify(report));
} else {
  console.log(
    [
      `${report.requests} requests, ${report.megabytes} MB in all, largest ${report.largestBodyKb} KB`,
      `stand-in detection service: ${latency} ms a call${perChunk > 0 ? ` + ${perChunk} ms a piece` : ""}; ${detectorCalls} calls, ${detectorChunks} pieces`,
      `time added in all: ${report.totalMs} ms = ${report.waitingOnDetectorMs} ms waiting on detection + ${report.localMs} ms on this computer`,
      `  of the local time, reading and writing the JSON: ${report.parseAndStringifyMs} ms`,
      `local time a request: median ${report.localPerRequestMs.median} ms, p95 ${report.localPerRequestMs.p95} ms, max ${report.localPerRequestMs.max} ms, last ten ${report.localPerRequestMs.lastTenMean} ms`,
      `total time a request: median ${report.totalPerRequestMs.median} ms, p95 ${report.totalPerRequestMs.p95} ms, max ${report.totalPerRequestMs.max} ms`,
      `vault: ${report.vaultEntries} entries`,
      `digest of what was sent: ${report.sentDigest}`,
    ].join("\n"),
  );
}
