/**
 * Runs one command behind the gateway, with the environment an agent's process is given, and
 * writes down every request the gateway saw: host, method, path, and what it did with it. Run it
 * on a provider's program before its paths go into `src/routes.ts`, and again when the program
 * is updated. The values given with `--planted` are what its detector knows.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import type { Detector } from "../src/detect.ts";
import type { GatewayRecord } from "../src/gateway.ts";
import { startPrivacyGateway } from "../src/index.ts";

const args = process.argv.slice(2);
const split = args.indexOf("--");
const [outFolder = "", ...flags] = split === -1 ? [] : args.slice(0, split);
const command = split === -1 ? [] : args.slice(split + 1);
const planted: Array<string> = [];
const alsoInspect: Array<string> = [];
let timeoutSeconds = 300;
let masking = true;
for (let index = 0; index < flags.length; index += 2) {
  const value = flags[index + 1] ?? "";
  if (flags[index] === "--planted") planted.push(value);
  else if (flags[index] === "--open") alsoInspect.push(value);
  else if (flags[index] === "--timeout") timeoutSeconds = Number(value);
  else if (flags[index] === "--masking") masking = value !== "off";
  else command.length = 0;
}
if (outFolder === "" || command.length === 0) {
  console.error(
    "usage: routes-seen.ts <output folder> [--planted <value>]... [--open <host>]... [--masking off] [--timeout <seconds>] -- <command> [arguments]",
  );
  process.exit(2);
}
NodeFS.mkdirSync(outFolder, { recursive: true });

const plantedDetector: Detector = {
  detect: (texts) =>
    Promise.resolve(
      texts.map((text) =>
        planted.flatMap((value) => {
          const spans = [];
          for (let from = text.indexOf(value); from !== -1; from = text.indexOf(value, from + 1)) {
            spans.push({ start: from, end: from + value.length, kind: "PERSON" as const });
          }
          return spans;
        }),
      ),
    ),
};

const records: Array<GatewayRecord> = [];
const otherHosts = new Map<string, number>();
const bodies = NodePath.join(outFolder, "bodies.ndjson");
NodeFS.rmSync(bodies, { force: true });
const gateway = await startPrivacyGateway({
  dataDirectory: NodePath.join(outFolder, "gateway"),
  detector: plantedDetector,
  // Off: the same hop with nothing rewritten, to tell what the hop breaks from what masking does.
  masking: () => masking,
  // A host the program reaches that is not an AI host by the list: opened here to see what goes.
  ...(alsoInspect.length === 0 ? {} : { alsoInspect }),
  onRecord: (record) => records.push(record),
  onSentBody: (host, path, body) =>
    NodeFS.appendFileSync(bodies, `${JSON.stringify({ host, path, body })}\n`),
  // What had no rule stayed here: read it in this file before giving its path one.
  onUnsentBody: (host, path, body) =>
    NodeFS.appendFileSync(bodies, `${JSON.stringify({ host, path, body, sent: false })}\n`),
  onOtherHost: (host, _port, outcome) =>
    otherHosts.set(`${host} ${outcome}`, (otherHosts.get(`${host} ${outcome}`) ?? 0) + 1),
});

const child = NodeChildProcess.spawn(command[0] ?? "", command.slice(1), {
  env: { ...process.env, ...gateway.environment },
  stdio: "inherit",
});
const timer = setTimeout(() => child.kill("SIGTERM"), timeoutSeconds * 1000);
const exit = await new Promise<number | string>((resolve) => {
  child.on("error", (cause) => resolve(String(cause)));
  child.on("close", (code, signal) => resolve(code ?? signal ?? "closed"));
});
clearTimeout(timer);
await gateway.close();

/** Identifiers in a path, so that the same call counts once. */
const shape = (path: string): string =>
  (path.split("?")[0] ?? path)
    .replace(/[0-9a-f]{8}-[0-9a-f-]{27,}/gi, "<id>")
    .replace(/\/sdk-\w+/, "/sdk-<key>");
const seen = new Map<string, number>();
for (const record of records) {
  const what = [
    record.method ?? "CONNECT",
    `${record.host}${shape(record.path)}`,
    record.outcome,
    record.route ?? record.format ?? "",
    record.notice ?? "",
  ].join("\t");
  seen.set(what, (seen.get(what) ?? 0) + 1);
}
const lines = [...seen].toSorted().map(([what, count]) => `${count}\t${what}`);
const hosts = [...otherHosts].toSorted().map(([host, count]) => `${count}\t${host}`);
NodeFS.writeFileSync(NodePath.join(outFolder, "activity.json"), JSON.stringify(records, null, 1));
NodeFS.writeFileSync(
  NodePath.join(outFolder, "seen.txt"),
  [`exit: ${exit}`, "requests to AI hosts:", ...lines, "other hosts:", ...hosts, ""].join("\n"),
);
console.log(NodeFS.readFileSync(NodePath.join(outFolder, "seen.txt"), "utf8"));
