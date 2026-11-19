/**
 * Runs one planted session against a real Claude Code or Codex (claude-native, claude-gateway,
 * codex-native, codex-gateway) and reports, from what left this computer, whether a planted
 * value reached the AI company. Detection and reading are stand-ins that know the planted values.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeModule from "node:module";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import { loadLocalAuthority } from "../src/certificates.ts";
import { makeMaskingCore } from "../src/core.ts";
import { combineDetectors, type Detector, patternDetector } from "../src/detect.ts";
import { startGateway } from "../src/gateway.ts";
import {
  CLAUDE_NATIVE_DISALLOWED_TOOLS,
  CLAUDE_NATIVE_ENVIRONMENT,
  makeClaudeHooks,
  maskClaudePrompt,
  readClaudeAttachment,
} from "../src/native/claude.ts";
import {
  codexHookArguments,
  maskCodexPrompt,
  readCodexAttachment,
  startCodexHookEndpoint,
} from "../src/native/codex.ts";
import { type ObservedExchange, startObserver } from "../src/observer.ts";
import { Pseudonymizer } from "../src/pseudonymizer.ts";
import type { Reader } from "../src/reader.ts";
import { Vault } from "../src/vault.ts";

const PLANTED = {
  name: "Marta Kowalczyk",
  id: "44051401359",
  phone: "+48 601 234 567",
  iban: "PL61109010140000071219812874",
} as const;
const PLANTED_VALUES = Object.values(PLANTED);
const NEW_PHONE = "+48 000 000 000";

const frontEnd = process.argv[2] ?? "";
const workFolder = process.argv[3] ?? "";
if (!/^(claude|codex)-(native|gateway)$/.test(frontEnd) || workFolder === "") {
  console.error("usage: conformance-real.ts <claude|codex>-<native|gateway> <empty work folder>");
  process.exit(2);
}
const [provider, method] = frontEnd.split("-") as ["claude" | "codex", "native" | "gateway"];
const here = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));

const workspace = NodePath.join(workFolder, "workspace");
NodeFS.rmSync(workspace, { recursive: true, force: true });
NodeFS.mkdirSync(workspace, { recursive: true });
NodeFS.writeFileSync(
  NodePath.join(workspace, "notes.txt"),
  `Client: ${PLANTED.name}\nID: ${PLANTED.id}\nPhone: ${PLANTED.phone}\nIBAN: ${PLANTED.iban}\n`,
);
NodeFS.writeFileSync(
  NodePath.join(workspace, `${PLANTED.name} contract.txt`),
  `Contract signed by ${PLANTED.name}.\n`,
);

/** Stands in for the detection service: finds exactly the planted values. */
const plantedDetector: Detector = {
  detect: (texts) =>
    Promise.resolve(
      texts.map((text) =>
        (
          [
            [PLANTED.name, "PERSON"],
            [PLANTED.id, "ID"],
            [PLANTED.phone, "PHONE"],
            [PLANTED.iban, "IBAN"],
          ] as const
        ).flatMap(([value, kind]) => {
          const spans = [];
          for (let from = text.indexOf(value); from !== -1; from = text.indexOf(value, from + 1)) {
            spans.push({ start: from, end: from + value.length, kind });
          }
          return spans;
        }),
      ),
    ),
};
/** Stands in for the reading service: every attachment "contains" the planted values. */
const plantedReader: Reader = {
  read: (_bytes, mediaType) =>
    Promise.resolve(`(${mediaType}) Power of attorney for ${PLANTED.name}, ID ${PLANTED.id}.`),
};

const vault = new Vault(NodePath.join(workFolder, "vault.json"));
const pseudonymizer = new Pseudonymizer(
  vault,
  combineDetectors([patternDetector, plantedDetector]),
);
const activity: Array<unknown> = [];
const core = makeMaskingCore({
  pseudonymizer,
  reader: () => plantedReader,
  onRecord: (record) => activity.push(record),
});
const authority = loadLocalAuthority(NodePath.join(workFolder, "authority"));

/** Everything that left for the AI company, as text, with where it was going. */
const left: Array<{ readonly where: string; readonly body: string }> = [];
const noteExchange = (exchange: ObservedExchange) =>
  left.push({
    where: `${exchange.method} ${exchange.host}${exchange.path.split("?")[0]}`,
    body: exchange.body,
  });

const PROVIDER_HOSTS =
  provider === "claude"
    ? ["anthropic.com", "claude.ai", "claude.com"]
    : ["openai.com", "chatgpt.com"];

let environment: Readonly<Record<string, string>>;
let closeNetwork: () => Promise<void>;
let hosts: ReadonlyArray<string> = [];
let unchangedOnTheWire = true;
if (method === "native") {
  const observer = await startObserver({
    authority,
    inspectHosts: PROVIDER_HOSTS,
    onExchange: (exchange) => {
      noteExchange(exchange);
      if (exchange.receivedSha256 !== exchange.forwardedSha256) unchangedOnTheWire = false;
    },
  });
  environment = observer.environment;
  closeNetwork = async () => {
    hosts = [...new Set(observer.connects)];
    await observer.close();
  };
} else {
  const gateway = await startGateway({
    authority,
    pseudonymizer,
    reader: () => plantedReader,
    onRecord: (record) => activity.push(record),
    onSentBody: (host, path, body) =>
      left.push({ where: `POST ${host}${path.split("?")[0]}`, body }),
  });
  const proxy = `http://127.0.0.1:${gateway.port}`;
  environment = {
    HTTPS_PROXY: proxy,
    https_proxy: proxy,
    NODE_EXTRA_CA_CERTS: authority.certificatePath,
    NODE_USE_ENV_PROXY: "1",
    SSL_CERT_FILE: authority.bundlePath,
    CODEX_CA_CERTIFICATE: authority.bundlePath,
  };
  closeNetwork = gateway.close;
}

const attachmentNote = async (read: typeof readClaudeAttachment): Promise<string> =>
  [
    await read(
      core,
      { bytes: Buffer.from("%PDF-1.4 planted"), mediaType: "application/pdf" },
      "file",
    ),
    await read(core, { bytes: Buffer.from("planted image"), mediaType: "image/png" }, "image"),
  ].join("\n");

const firstTurn = (attachments: string, editWord: string) =>
  `My client is ${PLANTED.name} (ID ${PLANTED.id}).\n${attachments}\n` +
  "Do these steps in order, one at a time, and go on when a step fails.\n" +
  "1. Read notes.txt.\n" +
  "2. List the .txt files in this folder.\n" +
  `3. Run the shell command: cat 'missing ${PLANTED.name}.txt'\n` +
  "4. Search the files in this folder for the client's phone number with grep.\n" +
  "5. Call the lookup_client tool of the planted server.\n" +
  "6. Write the file summary.txt holding the client's name, ID, phone and IBAN, one per line.\n" +
  `7. Run the shell command: grep -c '${PLANTED.name}' notes.txt\n` +
  `8. In notes.txt replace the client's phone number with ${NEW_PHONE} ${editWord}.\n` +
  "Then reply with the word finished and the output of step 7.";
const secondTurn =
  "Give this task to a subagent: read the file whose name starts with the client's name and " +
  "report its first line. Then reply with that line and with the client's IBAN.";

const planted = {
  command: process.execPath,
  args: [NodePath.join(here, "planted-mcp-server.mjs")],
  env: {
    PLANTED_TEXT: `Office record: ${PLANTED.name}, phone ${PLANTED.phone}, IBAN ${PLANTED.iban}.`,
  },
};

const shown: Array<string> = [];

if (provider === "claude") {
  const require = NodeModule.createRequire(
    NodePath.join(here, "../../../apps/server/package.json"),
  );
  const sdk = (await import(
    NodeURL.pathToFileURL(require.resolve("@anthropic-ai/claude-agent-sdk")).href
  )) as { query: (input: unknown) => AsyncIterable<Record<string, unknown>> };
  const base: Record<string, string | undefined> = { ...process.env, ...environment };
  delete base.CLAUDE_CODE_ENTRYPOINT;
  base.CLAUDE_AGENT_SDK_CLIENT_APP = "doedesk-conformance/1";
  if (method === "native") Object.assign(base, CLAUDE_NATIVE_ENVIRONMENT);
  // The SDK's bundled program is left out of this repository's install, as it is in the app.
  const claudeProgram =
    process.env.CLAUDE_BIN ??
    NodeChildProcess.execFileSync("which", ["claude"], { encoding: "utf8" }).trim();
  const options = (resume: string | undefined) => ({
    cwd: workspace,
    pathToClaudeCodeExecutable: claudeProgram,
    model: "haiku",
    permissionMode: "bypassPermissions",
    allowDangerouslySkipPermissions: true,
    settingSources: [],
    strictMcpConfig: true,
    mcpServers: { planted },
    systemPrompt: { type: "preset", preset: "claude_code" },
    maxTurns: 30,
    env: base,
    ...(method === "native"
      ? { hooks: makeClaudeHooks(core), disallowedTools: CLAUDE_NATIVE_DISALLOWED_TOOLS }
      : {}),
    ...(resume === undefined ? {} : { resume }),
  });
  let session: string | undefined;
  const turn = async (prompt: string) => {
    for await (const message of sdk.query({ prompt, options: options(session) })) {
      if (typeof message.session_id === "string") session = message.session_id;
      if (message.type === "result" && typeof message.result === "string") {
        shown.push(method === "native" ? core.restore(message.result) : message.result);
      }
    }
  };
  const attachments =
    method === "native"
      ? await attachmentNote(readClaudeAttachment)
      : "(The gateway run sends no attachment: the SDK needs a different call for one.)";
  const first = firstTurn(attachments, "with the Edit tool");
  await turn(method === "native" ? await maskClaudePrompt(core, first) : first);
  await turn(method === "native" ? await maskClaudePrompt(core, secondTurn) : secondTurn);
  await turn("/compact");
  await turn("After the summary above: what is the client's name and IBAN? Answer in one line.");
} else {
  const endpoint = method === "native" ? await startCodexHookEndpoint(core) : undefined;
  const hookFile = NodePath.join(workFolder, "doedesk-codex-hook.mjs");
  if (endpoint !== undefined) NodeFS.writeFileSync(hookFile, endpoint.clientSource);
  const run = (args: ReadonlyArray<string>): Promise<string> =>
    new Promise((resolve) => {
      const child = NodeChildProcess.spawn(
        "codex",
        [
          "exec",
          ...args,
          "--json",
          "--skip-git-repo-check",
          "-m",
          "gpt-6-luna",
          "-c",
          `mcp_servers.planted={command=${JSON.stringify(planted.command)}, args=${JSON.stringify(planted.args)}, env={PLANTED_TEXT=${JSON.stringify(planted.env.PLANTED_TEXT)}}}`,
          ...(endpoint === undefined
            ? []
            : codexHookArguments(
                `${JSON.stringify(process.execPath)} ${JSON.stringify(hookFile)}`,
              )),
        ],
        {
          cwd: workspace,
          env: { ...process.env, ...environment, ...endpoint?.environment },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      let output = "";
      child.stdout.on("data", (chunk: Buffer) => (output += chunk.toString("utf8")));
      child.stderr.on("data", (chunk: Buffer) =>
        NodeFS.appendFileSync(NodePath.join(workFolder, "codex-stderr.txt"), chunk),
      );
      child.on("close", () => resolve(output));
    });
  const lastMessage = (output: string): { readonly text: string; readonly thread: string } => {
    let text = "";
    let thread = "";
    for (const line of output.split("\n")) {
      try {
        const event = JSON.parse(line) as {
          type?: string;
          thread_id?: string;
          item?: { type?: string; text?: string };
        };
        if (event.type === "thread.started" && event.thread_id) thread = event.thread_id;
        if (event.type === "item.completed" && event.item?.type === "agent_message") {
          text = event.item.text ?? text;
        }
      } catch {
        // Not an event line.
      }
    }
    return { text, thread };
  };
  const attachments =
    method === "native"
      ? await attachmentNote(readCodexAttachment)
      : "(The gateway run sends no attachment.)";
  const first = firstTurn(attachments, "with apply_patch");
  const one = lastMessage(
    await run([
      "-s",
      "workspace-write",
      method === "native" ? await maskCodexPrompt(core, first) : first,
    ]),
  );
  shown.push(method === "native" ? core.restore(one.text) : one.text);
  const two = lastMessage(
    await run([
      "resume",
      one.thread,
      method === "native" ? await maskCodexPrompt(core, secondTurn) : secondTurn,
    ]),
  );
  shown.push(method === "native" ? core.restore(two.text) : two.text);
  await endpoint?.close();
}
await closeNetwork();

const read = (name: string): string => {
  try {
    return NodeFS.readFileSync(NodePath.join(workspace, name), "utf8");
  } catch {
    return "";
  }
};
const leaks: Array<{ readonly value: string; readonly where: string; readonly context: string }> =
  [];
for (const item of left) {
  for (const value of PLANTED_VALUES) {
    const at = item.body.indexOf(value);
    if (at === -1) continue;
    leaks.push({
      value,
      where: item.where,
      context: item.body.slice(Math.max(0, at - 90), at + value.length + 40).replaceAll("\n", " "),
    });
  }
}
const summary = read("summary.txt");
const report = {
  frontEnd,
  requestsSeen: left.length,
  hosts,
  bytesUnchangedBetweenClientAndProvider:
    method === "native" ? unchangedOnTheWire : "not applicable",
  plantedValuesThatLeft: leaks,
  realValuesWrittenToSummary: PLANTED_VALUES.filter((value) => summary.includes(value)).length,
  editAppliedToNotes: read("notes.txt").includes(NEW_PHONE),
  whatTheUserRead: shown,
  standInsInWhatTheUserRead: shown.some((text) => /\[[A-Z]+_[A-Z0-9]{5}\]/.test(text)),
  vaultEntries: vault.size,
};
NodeFS.writeFileSync(NodePath.join(workFolder, "report.json"), JSON.stringify(report, null, 1));
NodeFS.writeFileSync(NodePath.join(workFolder, "left.json"), JSON.stringify(left));
NodeFS.writeFileSync(NodePath.join(workFolder, "activity.json"), JSON.stringify(activity, null, 1));
console.log(JSON.stringify(report, null, 1));
