/**
 * Runs the redaction corpus of the evaluation repository (audit/redaction) through this
 * package's own code against a reading and detection service, and writes for each case what
 * would be sent and every answer the services gave. Usage: see the message below.
 */
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";

import sharp from "sharp";

import {
  cacheDetector,
  combineDetectors,
  type Detector,
  ignoreAppAuthoredBlocks,
  makeRemoteDetector,
  patternDetector,
} from "../src/detect.ts";
import { Pseudonymizer } from "../src/pseudonymizer.ts";
import { makeRemoteReader, type ReaderLayoutAnswer } from "../src/reader.ts";
import { makeImageRedactor, type RedactionPolicy } from "../src/redaction/redactImage.ts";
import { Vault } from "../src/vault.ts";

const { values: args } = NodeUtil.parseArgs({
  options: {
    corpus: { type: "string" },
    endpoint: { type: "string" },
    out: { type: "string" },
    only: { type: "string" },
    concurrency: { type: "string", default: "4" },
    policy: { type: "string", default: "{}" },
  },
});
if (args.corpus === undefined || args.endpoint === undefined || args.out === undefined) {
  console.error(
    "usage: redaction-corpus.ts --corpus <dir> --endpoint <url> --out <dir> " +
      "[--only <text>] [--concurrency 4] [--policy <json>]",
  );
  process.exit(2);
}
const corpus = args.corpus;
const out = args.out;
const endpoint = args.endpoint;
const policy = JSON.parse(args.policy) as Partial<RedactionPolicy>;

interface Case {
  readonly id: string;
  readonly file: string;
  readonly declared: string;
}

const cases = (
  JSON.parse(NodeFS.readFileSync(NodePath.join(corpus, "manifest.json"), "utf8")) as Array<Case>
).filter((entry) => args.only === undefined || entry.id.includes(args.only));

const runCase = async (entry: Case): Promise<string> => {
  const folder = NodePath.join(out, entry.id);
  NodeFS.rmSync(folder, { recursive: true, force: true });
  NodeFS.mkdirSync(folder, { recursive: true });
  const bytes = NodeFS.readFileSync(NodePath.join(corpus, entry.id, entry.file));

  const reads: Array<{ sha256: string; bytes: number; ms: number; answer: ReaderLayoutAnswer }> =
    [];
  const remoteReader = makeRemoteReader({ endpoint });
  const detects: Array<{ texts: ReadonlyArray<string>; results: unknown }> = [];
  const remoteDetector = makeRemoteDetector({ endpoint, timeoutMs: 120_000 });
  const recordingDetector: Detector = {
    detect: async (texts) => {
      const results = await remoteDetector.detect(texts);
      detects.push({ texts, results });
      return results;
    },
  };
  const vault = new Vault();
  const pseudonymizer = new Pseudonymizer(
    vault,
    cacheDetector(combineDetectors([patternDetector, ignoreAppAuthoredBlocks(recordingDetector)])),
  );
  const rounds: Array<unknown> = [];
  const redactor = makeImageRedactor({
    pseudonymizer,
    policy,
    onRound: (round) => {
      rounds.push({ round: round.round, found: round.found });
      const extension = round.image.mediaType === "image/png" ? "png" : "jpg";
      NodeFS.writeFileSync(
        NodePath.join(folder, `round-${round.round}.${extension}`),
        round.image.bytes,
      );
    },
    reader: {
      readLayout: async (image, mediaType) => {
        const started = performance.now();
        const answer = await (
          remoteReader.readLayout as NonNullable<typeof remoteReader.readLayout>
        )(image, mediaType);
        reads.push({
          sha256: NodeCrypto.createHash("sha256").update(image).digest("hex"),
          bytes: image.length,
          ms: Math.round(performance.now() - started),
          answer,
        });
        return answer;
      },
    },
  });

  const started = performance.now();
  const result = await redactor.redact(bytes);
  const milliseconds = Math.round(performance.now() - started);
  const summary: Record<string, unknown> = {
    id: entry.id,
    kind: result.kind,
    milliseconds,
    reads: reads.length,
    readMilliseconds: reads.map((read) => read.ms),
    rounds,
    vault: vault
      .entries()
      .map(({ token, kind, value, surfaces }) => ({ token, kind, value, surfaces })),
  };
  if (result.kind === "redacted") {
    const extension = result.image.mediaType === "image/png" ? "png" : "jpg";
    NodeFS.writeFileSync(NodePath.join(folder, `output.${extension}`), result.image.bytes);
    await sharp(Buffer.from(result.coverage.data.map((value) => value * 255)), {
      raw: { width: result.coverage.width, height: result.coverage.height, channels: 1 },
    })
      .png()
      .toFile(NodePath.join(folder, "coverage.png"));
    NodeFS.writeFileSync(NodePath.join(folder, "masked.txt"), result.maskedText);
    Object.assign(summary, {
      output: `output.${extension}`,
      width: result.width,
      height: result.height,
      outputBytes: result.image.bytes.length,
      legend: result.legend,
      stats: result.stats,
    });
  } else {
    summary.reason = result.reason;
  }
  NodeFS.writeFileSync(NodePath.join(folder, "result.json"), JSON.stringify(summary, null, 1));
  NodeFS.writeFileSync(NodePath.join(folder, "reads.json"), JSON.stringify(reads));
  NodeFS.writeFileSync(NodePath.join(folder, "detects.json"), JSON.stringify(detects));
  return `${result.kind.padEnd(9)} ${String(milliseconds).padStart(6)} ms  reads ${reads.length}  ${entry.id}${
    result.kind === "withheld" ? `  (${result.reason})` : ""
  }`;
};

const queue = [...cases];
const workers = Array.from({ length: Math.max(1, Number(args.concurrency)) }, async () => {
  for (;;) {
    const entry = queue.shift();
    if (entry === undefined) return;
    try {
      console.log(await runCase(entry));
    } catch (cause) {
      console.log(`CRASHED   ${entry.id}: ${String(cause)}`);
      process.exitCode = 1;
    }
  }
});
await Promise.all(workers);
