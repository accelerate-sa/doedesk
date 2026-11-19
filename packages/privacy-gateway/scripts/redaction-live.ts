/**
 * Runs real provider sessions through the real app server with images that hold planted,
 * made-up values, and reports from the captured request bodies whether any image or value left
 * this computer unredacted. Usage: see the message below.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";

import { compactOf } from "../src/redaction/words.ts";

const { values: args } = NodeUtil.parseArgs({
  options: {
    provider: { type: "string" },
    model: { type: "string" },
    endpoint: { type: "string" },
    attach: { type: "string" },
    workspace: { type: "string" },
    planted: { type: "string" },
    out: { type: "string" },
    "timeout-minutes": { type: "string", default: "8" },
  },
});
if (
  args.provider === undefined ||
  args.model === undefined ||
  args.endpoint === undefined ||
  args.attach === undefined ||
  args.workspace === undefined ||
  args.planted === undefined ||
  args.out === undefined
) {
  console.error(
    "usage: redaction-live.ts --provider claudeAgent|codex --model <id> --endpoint <reading and " +
      "detection service> --attach <image sent as an attachment> --workspace <image the agent " +
      "reads with its own tool> --planted <json array of the values in both images> --out <dir>",
  );
  process.exit(2);
}
const provider = args.provider;
const model = args.model;
const endpoint = args.endpoint;
const out = NodePath.resolve(args.out);
const planted = JSON.parse(args.planted) as ReadonlyArray<string>;
const checkout = NodePath.resolve(import.meta.dirname, "../../..");
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const freePort = (): Promise<number> =>
  new Promise((resolve, reject) => {
    const server = NodeNet.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() =>
        resolve(typeof address === "object" && address !== null ? address.port : 0),
      );
    });
  });

// A throwaway home: the server under test never touches the user's own DoeDesk state.
const home = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "doedesk-redaction-live-"));
const workspace = NodePath.join(home, "workspace");
NodeFS.mkdirSync(workspace, { recursive: true });
NodeFS.mkdirSync(out, { recursive: true });
const workspaceImage = NodePath.join(workspace, `scan${NodePath.extname(args.workspace)}`);
NodeFS.copyFileSync(args.workspace, workspaceImage);
const sentBodies = NodePath.join(out, "sent-bodies.jsonl");
const events = NodePath.join(out, "events.jsonl");
for (const file of [sentBodies, events]) NodeFS.rmSync(file, { force: true });

const contracts = NodeFS.readFileSync(
  NodePath.join(checkout, "packages/contracts/src/environment.ts"),
  "utf8",
);
const protocolVersion = /ORCHESTRATION_PROTOCOL_VERSION = (\d+)/.exec(contracts)?.[1] ?? "";
const protocolHeader = /ORCHESTRATION_PROTOCOL_HEADER = "([^"]+)"/.exec(contracts)?.[1] ?? "";

const port = await freePort();
const origin = `http://127.0.0.1:${port}`;
const bootstrapToken = NodeCrypto.randomUUID();
const environment: NodeJS.ProcessEnv = {};
for (const [name, value] of Object.entries(process.env)) {
  // Nothing of the session this script was started from reaches the server under test.
  if (
    !/^(T3CODE_|CLAUDECODE$|CLAUDE_CODE_|CLAUDE_PID$|CLAUDE_EFFORT$|CLAUDE_AGENT_SDK_VERSION$|DOEDESK_EVAL_)/.test(
      name,
    )
  ) {
    environment[name] = value;
  }
}
Object.assign(environment, {
  T3CODE_HOME: home,
  DOEDESK_EVAL_SENT_BODIES_FILE: sentBodies,
  DOEDESK_EVAL_EVENTS_FILE: events,
});
const log = NodeFS.openSync(NodePath.join(out, "server.log"), "w");
const server = NodeChildProcess.spawn(
  process.execPath,
  ["apps/server/src/bin.ts", "start", "--bootstrap-fd", "3", "--base-dir", home],
  { cwd: checkout, env: environment, detached: true, stdio: ["ignore", log, log, "pipe"] },
);
(server.stdio[3] as NodeJS.WritableStream).end(
  JSON.stringify({
    mode: "desktop",
    noBrowser: true,
    port,
    t3Home: home,
    host: "127.0.0.1",
    desktopBootstrapToken: bootstrapToken,
    tailscaleServeEnabled: false,
    tailscaleServePort: 443,
  }),
);
const stop = () => {
  try {
    if (server.pid !== undefined) process.kill(-server.pid, "SIGTERM");
  } catch {
    // Already gone.
  }
};
process.on("exit", stop);

for (let waited = 0; ; waited += 200) {
  if (waited > 120_000) throw new Error("The server did not start.");
  try {
    if ((await fetch(`${origin}/.well-known/t3/environment`)).ok) break;
  } catch {
    // Not listening yet.
  }
  await sleep(200);
}
const token = (
  (await (
    await fetch(`${origin}/oauth/token`, {
      method: "POST",
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
        subject_token: bootstrapToken,
        subject_token_type: "urn:t3:params:oauth:token-type:environment-bootstrap",
        requested_token_type: "urn:ietf:params:oauth:token-type:access_token",
      }),
    })
  ).json()) as { access_token: string }
).access_token;
const api = async <T>(method: string, path: string, body?: unknown): Promise<T> => {
  const response = await fetch(`${origin}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      [protocolHeader]: protocolVersion,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${method} ${path}: ${response.status} ${text.slice(0, 400)}`);
  return (text.length === 0 ? undefined : JSON.parse(text)) as T;
};

const { ticket } = await api<{ ticket: string }>("POST", "/api/auth/websocket-ticket");
const socket = new WebSocket(
  `ws://127.0.0.1:${port}/ws?orchestrationProtocol=${protocolVersion}&wsTicket=${encodeURIComponent(ticket)}`,
);
await new Promise((resolve, reject) => {
  socket.addEventListener("open", resolve, { once: true });
  socket.addEventListener("error", reject, { once: true });
});
const waiting = new Map<
  string,
  { resolve: (value: unknown) => void; reject: (cause: Error) => void }
>();
socket.addEventListener("message", (event) => {
  const parsed = JSON.parse(String(event.data)) as unknown;
  for (const message of Array.isArray(parsed) ? parsed : [parsed]) {
    const { _tag, requestId, exit } = message as {
      _tag?: string;
      requestId?: string;
      exit?: { _tag?: string; value?: unknown; cause?: unknown };
    };
    const entry =
      _tag === "Exit" && requestId !== undefined ? waiting.get(String(requestId)) : undefined;
    if (entry === undefined) continue;
    waiting.delete(String(requestId));
    if (exit?._tag === "Success") entry.resolve(exit.value);
    else entry.reject(new Error(JSON.stringify(exit?.cause).slice(0, 600)));
  }
});
let nextId = 1;
const rpc = <T>(tag: string, payload: unknown): Promise<T> =>
  new Promise((resolve, reject) => {
    const id = String(nextId++);
    waiting.set(id, { resolve: resolve as (value: unknown) => void, reject });
    socket.send(JSON.stringify({ _tag: "Request", id, tag, payload, headers: [] }));
  });

const configured = await api<{
  ok: boolean;
  message: string | null;
  status: Record<string, unknown>;
}>("POST", "/api/privacy/configure", { mode: "selfHosted", endpoint });
if (!configured.ok) throw new Error(`The gateway refused its configuration: ${configured.message}`);
console.log(
  `server up; images are sent "${String(configured.status.imageHandling)}", reading tool ${String(configured.status.readingTool)}`,
);

const projectId = NodeCrypto.randomUUID();
await api("POST", "/api/projects/mutate", {
  type: "project.create",
  commandId: NodeCrypto.randomUUID(),
  projectId,
  title: "redaction-live",
  workspaceRoot: workspace,
});

interface Projection {
  readonly runs: ReadonlyArray<{ readonly status: string }>;
  readonly turnItems: ReadonlyArray<Record<string, unknown> & { readonly type: string }>;
  readonly runtimeRequests: ReadonlyArray<{ readonly id: string; readonly status: string }>;
}

/** One thread: a first message, optionally with an image attached, run to its end. */
const converse = async (name: string, text: string, attachment?: string): Promise<string> => {
  const threadId = NodeCrypto.randomUUID();
  const messageId = NodeCrypto.randomUUID();
  let attachments: ReadonlyArray<unknown> = [];
  if (attachment !== undefined) {
    const bytes = NodeFS.readFileSync(attachment);
    const mimeType = attachment.endsWith(".png") ? "image/png" : "image/jpeg";
    attachments = (
      await rpc<{ attachments: ReadonlyArray<unknown> }>("assets.persistChatAttachments", {
        threadId,
        messageId,
        attachments: [
          {
            type: "image",
            name: NodePath.basename(attachment),
            mimeType,
            sizeBytes: bytes.length,
            dataUrl: `data:${mimeType};base64,${bytes.toString("base64")}`,
          },
        ],
      })
    ).attachments;
  }
  await rpc("orchestration.launchThread", {
    commandId: NodeCrypto.randomUUID(),
    threadId,
    projectId,
    title: name,
    generateTitle: false,
    modelSelection: { instanceId: provider, model, options: [{ id: "effort", value: "low" }] },
    runtimeMode: "full-access",
    interactionMode: "default",
    workspaceStrategy: { type: "root" },
    initialMessage: { messageId, text, attachments },
  });
  const deadline = Date.now() + Number(args["timeout-minutes"]) * 60_000;
  let settled = 0;
  for (;;) {
    await sleep(1500);
    const { projection } = await api<{ projection: Projection }>(
      "GET",
      `/api/orchestration/threads/${threadId}`,
    );
    for (const request of projection.runtimeRequests) {
      if (request.status !== "pending") continue;
      await rpc("orchestration.dispatchCommand", {
        type: "runtime-request.respond",
        commandId: NodeCrypto.randomUUID(),
        threadId,
        requestId: request.id,
        decision: "accept",
      }).catch(() => undefined);
    }
    const done =
      projection.runs.length > 0 &&
      projection.runs.every((run) =>
        ["completed", "failed", "interrupted", "cancelled"].includes(run.status),
      );
    if (done) {
      settled += 1;
      if (settled >= 3) {
        const said = projection.turnItems
          .filter((item) => item.type === "assistant_message" || item.type === "error")
          .map((item) =>
            String(item.text ?? (item.failure as { message?: string } | undefined)?.message ?? ""),
          )
          .join("\n");
        NodeFS.writeFileSync(NodePath.join(out, `${name}.reply.txt`), said);
        NodeFS.writeFileSync(
          NodePath.join(out, `${name}.items.json`),
          JSON.stringify(projection.turnItems, null, 1),
        );
        console.log(`${name}: runs ${projection.runs.map((run) => run.status).join(",")}`);
        return said;
      }
    } else settled = 0;
    if (Date.now() > deadline) throw new Error(`${name} did not finish in time.`);
  }
};

const replies: Record<string, string> = {};
try {
  replies.attached = await converse(
    "attached",
    "The attached image is a letter. Some parts are covered by black boxes with a label in white. " +
      "List every label you can read on a box, then say in one sentence what the letter is about. " +
      "Use no tools.",
    args.attach,
  );
  replies.tool = await converse(
    "tool",
    `Open the image file ${NodePath.basename(workspaceImage)} in this folder with your own image ` +
      "viewing tool (not a shell command), then list every label you can read on a black box in it " +
      "and say what kind of screen it shows.",
  );
  replies.reading = await converse(
    "reading",
    `Call the ocr_masked tool on ${workspaceImage} and reply with exactly the text it returns, ` +
      "in a code block. If the tool is not available, say so.",
  );
} finally {
  socket.close();
  stop();
  await sleep(1500);
}

// What left: every request body the gateway sent to a model host, as it was sent.
const originals = new Set(
  [args.attach, args.workspace].map((file) =>
    NodeCrypto.createHash("sha256").update(NodeFS.readFileSync(file)).digest("hex"),
  ),
);
const images = new Map<string, { bytes: Buffer; where: string }>();
const collect = (value: unknown, where: string): void => {
  if (typeof value === "string") {
    const data = /^data:image\/[a-z+.-]+;base64,(.+)$/s.exec(value)?.[1] ?? value;
    if (data.length < 400 || !/^[A-Za-z0-9+/=\s]+$/.test(data.slice(0, 400))) return;
    const bytes = Buffer.from(data, "base64");
    const magic = bytes.subarray(0, 4).toString("hex");
    if (!/^(89504e47|ffd8ff|47494638|52494646)/.test(magic)) return;
    images.set(NodeCrypto.createHash("sha256").update(bytes).digest("hex"), { bytes, where });
  } else if (Array.isArray(value)) {
    for (const child of value) collect(child, where);
  } else if (typeof value === "object" && value !== null) {
    for (const child of Object.values(value)) collect(child, where);
  }
};
const hosts: Record<string, number> = {};
const valueHits: Array<string> = [];
const lines = NodeFS.existsSync(sentBodies)
  ? NodeFS.readFileSync(sentBodies, "utf8").split("\n").filter(Boolean)
  : [];
for (const line of lines) {
  const entry = JSON.parse(line) as { host: string; path: string; body: string };
  hosts[`${entry.host}${entry.path.split("?")[0]}`] =
    (hosts[`${entry.host}${entry.path.split("?")[0]}`] ?? 0) + 1;
  const compactBody = compactOf(entry.body);
  for (const value of planted) {
    if (
      entry.body.includes(value) ||
      (compactOf(value).length >= 8 && compactBody.includes(compactOf(value)))
    ) {
      valueHits.push(`${value} in a request to ${entry.host}${entry.path.split("?")[0]}`);
    }
  }
  try {
    collect(JSON.parse(entry.body), `${entry.host}${entry.path.split("?")[0]}`);
  } catch {
    // Not JSON: searched as text above.
  }
}

// Each image that left is read again by the reading service and searched for the values.
const imageFindings: Array<Record<string, unknown>> = [];
let index = 0;
for (const [hash, image] of images) {
  index += 1;
  const png = image.bytes.subarray(0, 4).toString("hex") === "89504e47";
  const file = NodePath.join(out, `sent-image-${index}.${png ? "png" : "jpg"}`);
  NodeFS.writeFileSync(file, image.bytes);
  const read = (await (
    await fetch(`${endpoint.replace(/\/+$/, "")}/v1/ocr`, {
      method: "POST",
      headers: { "content-type": png ? "image/png" : "image/jpeg" },
      body: new Uint8Array(image.bytes),
    })
  ).json()) as { text?: string };
  const text = read.text ?? "";
  const legible = planted.filter(
    (value) =>
      text.includes(value) ||
      (compactOf(value).length >= 6 && compactOf(text).includes(compactOf(value))),
  );
  imageFindings.push({
    file,
    where: image.where,
    bytes: image.bytes.length,
    isAnOriginal: originals.has(hash),
    hasMetadataMarkers: ["Exif", "tEXt", "iTXt", "xmpmeta", "ICC_PROFILE"].filter((marker) =>
      image.bytes.includes(marker),
    ),
    plantedValuesLegible: legible,
    standInsRead: text.match(/\[[A-Z]+_[A-Z0-9]{5}\]/g)?.length ?? 0,
  });
}

const report = {
  provider,
  model,
  requestsByHost: hosts,
  imagesThatLeft: imageFindings,
  plantedValuesInRequestText: [...new Set(valueHits)],
  replies,
  verdict:
    imageFindings.length > 0 &&
    imageFindings.every(
      (finding) =>
        finding.isAnOriginal === false &&
        (finding.plantedValuesLegible as Array<string>).length === 0,
    ) &&
    valueHits.length === 0
      ? "no planted value left this computer, in text or in pixels"
      : "CHECK: see imagesThatLeft and plantedValuesInRequestText",
};
NodeFS.writeFileSync(NodePath.join(out, "report.json"), JSON.stringify(report, null, 1));
console.log(JSON.stringify({ ...report, replies: undefined }, null, 1));
for (const [name, reply] of Object.entries(replies))
  console.log(`--- ${name}\n${reply.slice(0, 1500)}`);
NodeFS.rmSync(home, { recursive: true, force: true });
process.exit(0);
