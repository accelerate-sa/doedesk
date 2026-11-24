import * as NodeFS from "node:fs";
import * as NodeHttp from "node:http";
import * as NodeHttps from "node:https";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeTls from "node:tls";

import { describe, expect, it } from "vite-plus/test";

import { loadLocalAuthority } from "./certificates.ts";
import type { Detector } from "./detect.ts";
import { combineDetectors, DetectorUnavailableError, patternDetector } from "./detect.ts";
import { type GatewayOptions, type GatewayRecord, startGateway } from "./gateway.ts";
import { Pseudonymizer } from "./pseudonymizer.ts";
import { makeProxy } from "./proxy.testkit.ts";
import { ProxyRefusal } from "./refusals.ts";
import type { Reader } from "./reader.ts";
import { makeImageRedactor } from "./redaction/redactImage.ts";
import { paintPage, plantedReader, pngOf, shows } from "./redaction/testkit.ts";
import { Vault } from "./vault.ts";
import { Tripwire, WITHHELD_SEALED_NOTE } from "./worker/tripwire.ts";

/** Finds a fixed list of names, standing in for a detection service. */
const nameDetector = (names: ReadonlyArray<string>): Detector => ({
  detect: (texts) =>
    Promise.resolve(
      texts.map((text) =>
        names.flatMap((name) => {
          const spans = [];
          let from = text.indexOf(name);
          while (from !== -1) {
            spans.push({ start: from, end: from + name.length, kind: "PERSON" as const });
            from = text.indexOf(name, from + name.length);
          }
          return spans;
        }),
      ),
    ),
});

interface Harness extends AsyncDisposable {
  readonly vault: Vault;
  readonly received: Array<string>;
  readonly post: (path: string, body: unknown) => Promise<{ status: number; text: string }>;
  /** Any request to a model host, `api.anthropic.com` unless `host` says another. No body: none sent. */
  readonly send: (request: {
    readonly method: string;
    readonly path: string;
    readonly body?: unknown;
    readonly host?: string;
  }) => Promise<{ status: number; text: string }>;
  /** Asks a model host for a WebSocket on `path`, and answers the status it was given. */
  readonly upgrade: (path: string) => Promise<number>;
  /** Opens a tunnel to a host that is not a model host, writes `request`, and reads to the end. */
  readonly tunnel: (host: string, port: number, request: string) => Promise<string>;
}

const makeHarness = async (
  detector: Detector,
  reply: (
    request: NodeHttp.IncomingMessage,
    body: string,
    response: NodeHttp.ServerResponse,
  ) => void,
  reader?: Reader,
  extra: Partial<GatewayOptions> = {},
): Promise<Harness> => {
  const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "doedesk-gateway-"));
  const received: Array<string> = [];
  const upstream = NodeHttp.createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => (body += chunk));
    request.on("end", () => {
      received.push(body);
      reply(request, body, response);
    });
  });
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const upstreamAddress = upstream.address();
  if (upstreamAddress === null || typeof upstreamAddress === "string") throw new Error("no port");

  const vault = new Vault();
  const authority = loadLocalAuthority(directory);
  const gateway = await startGateway({
    authority,
    ...(reader === undefined ? {} : { reader: () => reader }),
    pseudonymizer: new Pseudonymizer(vault, combineDetectors([patternDetector, detector])),
    upstream: () => ({ host: "127.0.0.1", port: upstreamAddress.port, tls: false }),
    ...extra,
  });
  const trusted = NodeFS.readFileSync(authority.certificatePath, "utf8");

  /** A connection to a model host through the gateway, as an agent program opens one. */
  const toModelHost = (
    use: (secure: NodeTls.TLSSocket) => void,
    reject: (cause: Error) => void,
    host = "api.anthropic.com",
  ) => {
    const connect = NodeHttp.request({
      host: "127.0.0.1",
      port: gateway.port,
      method: "CONNECT",
      path: `${host}:443`,
    });
    connect.on("error", reject);
    connect.on("connect", (_response, socket) => {
      use(NodeTls.connect({ socket, servername: host, ca: trusted }));
    });
    connect.end();
  };

  const upgrade: Harness["upgrade"] = (path) =>
    new Promise((resolve, reject) => {
      toModelHost((secure) => {
        const request = NodeHttps.request(
          {
            createConnection: () => secure,
            host: "api.anthropic.com",
            path,
            headers: { connection: "Upgrade", upgrade: "websocket" },
          },
          (response) => {
            response.resume();
            response.on("end", () => {
              secure.destroy();
              resolve(response.statusCode ?? 0);
            });
          },
        );
        request.on("error", reject);
        request.end();
      }, reject);
    });

  const send: Harness["send"] = ({ method, path, body, host = "api.anthropic.com" }) =>
    new Promise((resolve, reject) => {
      toModelHost(
        (secure) => {
          const payload = body === undefined ? undefined : JSON.stringify(body);
          const request = NodeHttps.request(
            {
              createConnection: () => secure,
              host,
              method,
              path,
              headers:
                payload === undefined
                  ? {}
                  : {
                      "content-type": "application/json",
                      "content-length": Buffer.byteLength(payload),
                    },
            },
            (response) => {
              let text = "";
              response.on("data", (chunk) => (text += chunk));
              response.on("end", () => {
                secure.destroy();
                resolve({ status: response.statusCode ?? 0, text });
              });
            },
          );
          request.on("error", reject);
          request.end(payload);
        },
        reject,
        host,
      );
    });
  const post: Harness["post"] = (path, body) => send({ method: "POST", path, body });

  const tunnel: Harness["tunnel"] = (host, port, request) =>
    new Promise((resolve, reject) => {
      const connect = NodeHttp.request({
        host: "127.0.0.1",
        port: gateway.port,
        method: "CONNECT",
        path: `${host}:${port}`,
      });
      connect.on("error", reject);
      connect.on("connect", (response, socket) => {
        if (response.statusCode !== 200) {
          socket.destroy();
          reject(new Error(`tunnel refused: ${response.statusCode}`));
          return;
        }
        let text = "";
        socket.on("data", (chunk) => (text += chunk));
        socket.on("end", () => resolve(text));
        socket.on("error", reject);
        socket.write(request);
      });
      connect.end();
    });

  return {
    vault,
    received,
    post,
    send,
    upgrade,
    tunnel,
    [Symbol.asyncDispose]: async () => {
      await gateway.close();
      await new Promise((resolve) => upstream.close(resolve));
      NodeFS.rmSync(directory, { recursive: true, force: true });
    },
  };
};

const sse = (events: ReadonlyArray<unknown>): string =>
  events.map((event) => `event: message\ndata: ${JSON.stringify(event)}\n\n`).join("");

const SESSION = "f4206ace-2856-4b36-950d-7168209aca03";

/**
 * A model host that only the proxy can reach: it speaks TLS under a name that resolves nowhere,
 * and the proxy alone knows its port. A request that skipped the proxy cannot arrive.
 */
const makeHiddenHost = async (proxy: Awaited<ReturnType<typeof makeProxy>>) => {
  const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "doedesk-hidden-"));
  const authority = loadLocalAuthority(directory);
  const received: Array<string> = [];
  const server = NodeHttps.createServer(
    { SNICallback: (name, done) => done(null, authority.contextFor(name)) },
    (request, response) => {
      let body = "";
      request.on("data", (chunk) => (body += chunk));
      request.on("end", () => {
        received.push(`${request.method} ${request.url} ${body}`);
        response.writeHead(200, { "content-type": "application/json" });
        response.end("{}");
      });
    },
  );
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no port");
  proxy.routes.set("model.test:443", address.port);
  return {
    received,
    /** Gateway options that send every AI host to this one, by way of the proxy. */
    options: {
      upstream: () => ({ host: "model.test", port: 443, tls: true }),
      upstreamProxy: () => proxy.url,
      upstreamCertificates: [NodeFS.readFileSync(authority.certificatePath, "utf8")],
    } satisfies Partial<GatewayOptions>,
    [Symbol.asyncDispose]: async () => {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
      NodeFS.rmSync(directory, { recursive: true, force: true });
    },
  };
};

const ok = (_request: unknown, _body: string, response: NodeHttp.ServerResponse) => {
  response.writeHead(200, { "content-type": "application/json" });
  response.end("{}");
};

describe("privacy gateway", () => {
  it("reaches model hosts and other hosts through the person's own proxy", async () => {
    await using proxy = await makeProxy();
    const other = NodeHttp.createServer((_request, response) => response.end("from the intranet"));
    await new Promise<void>((resolve) => other.listen(0, "127.0.0.1", resolve));
    const otherAddress = other.address();
    if (otherAddress === null || typeof otherAddress === "string") throw new Error("no port");
    await using harness = await makeHarness(
      nameDetector(["Khalid Al-Otaibi"]),
      (_request, _body, response) => {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ content: [{ type: "text", text: "ok" }] }));
      },
      undefined,
      // The person exempted one host: the gateway reaches that one directly.
      { upstreamProxy: (host) => (host === "exempt.test" ? undefined : proxy.url) },
    );

    const reply = await harness.post("/v1/messages", {
      messages: [{ role: "user", content: "Khalid Al-Otaibi asked for an extension." }],
    });
    expect(reply.status).toBe(200);
    expect(harness.received[0]).not.toContain("Khalid");
    expect(proxy.tunnels).toHaveLength(1);
    expect(proxy.tunnels[0]?.authorization).toBe(
      `Basic ${Buffer.from("ada:secret").toString("base64")}`,
    );

    // A host that is not a model host: tunnelled through the proxy, unread.
    const page = await harness.tunnel(
      "127.0.0.1",
      otherAddress.port,
      "GET / HTTP/1.1\r\nhost: x\r\nconnection: close\r\n\r\n",
    );
    expect(page).toContain("from the intranet");
    expect(proxy.tunnels.map((tunnel) => tunnel.target)).toEqual([
      expect.stringMatching(/^127\.0\.0\.1:\d+$/),
      `127.0.0.1:${otherAddress.port}`,
    ]);
    await new Promise((resolve) => other.close(resolve));
  });

  it("sends every request to an AI host through the person's proxy, and leaves no tunnel open", async () => {
    await using proxy = await makeProxy();
    await using hidden = await makeHiddenHost(proxy);
    const records: Array<GatewayRecord> = [];
    await using harness = await makeHarness(nameDetector(["Khalid Al-Otaibi"]), ok, undefined, {
      ...hidden.options,
      onRecord: (entry) => records.push(entry),
    });
    // A model request, a set-up call, a usage report and a question with no body.
    const replies = [
      await harness.post("/v1/messages", {
        messages: [{ role: "user", content: "Khalid Al-Otaibi asked for an extension." }],
      }),
      await harness.post("/api/eval/sdk-abc", { attributes: { id: "d1" } }),
      await harness.post("/api/event_logging/v2/batch", { events: [] }),
      await harness.send({ method: "GET", path: "/api/claude_cli/bootstrap" }),
    ];
    expect(replies.map((reply) => reply.status)).toEqual([200, 200, 200, 200]);
    expect(hidden.received.map((line) => line.split(" ").slice(0, 2).join(" "))).toEqual([
      "POST /v1/messages",
      "POST /api/eval/sdk-abc",
      "POST /api/event_logging/v2/batch",
      "GET /api/claude_cli/bootstrap",
    ]);
    expect(hidden.received[0]).toMatch(/\[PERSON_/);
    expect(hidden.received.join()).not.toContain("Khalid");
    // One tunnel for each request, each asked for with the person's sign-in. The host answers
    // to no other address, so what it received came through them.
    expect(proxy.tunnels.map((tunnel) => tunnel.target)).toEqual(Array(4).fill("model.test:443"));
    expect(new Set(proxy.tunnels.map((tunnel) => tunnel.authorization))).toEqual(
      new Set([`Basic ${Buffer.from("ada:secret").toString("base64")}`]),
    );
    expect(records.map((entry) => entry.outcome)).toEqual(["masked", "passed", "passed", "passed"]);
    // Every tunnel is closed again: one left open would keep this waiting.
    await proxy.idle();
  });

  it("says what the person's proxy did when it will not carry a request, and sends nothing", async () => {
    const cases = [
      [407, "proxySignIn", "asks for a user name and password, and it refused the ones given"],
      [403, "proxyRefused", "refused the connection to model.test (it answered 403)"],
    ] as const;
    for (const [answer, notice, words] of cases) {
      await using proxy = await makeProxy({ answer });
      await using hidden = await makeHiddenHost(proxy);
      const records: Array<GatewayRecord> = [];
      await using harness = await makeHarness(nameDetector(["Khalid Al-Otaibi"]), ok, undefined, {
        ...hidden.options,
        onRecord: (entry) => records.push(entry),
      });
      const model = await harness.post("/v1/messages", {
        messages: [{ role: "user", content: "Khalid Al-Otaibi asked for an extension." }],
      });
      const setUp = await harness.send({ method: "GET", path: "/api/claude_cli/bootstrap" });
      for (const reply of [model, setUp]) {
        // Not an answer a program tries again: asking five times gets the same refusal.
        expect(reply.status, String(answer)).toBe(400);
        expect(reply.text).toContain("DoeDesk did not send this request. The proxy this computer");
        expect(reply.text).toContain(" Nothing of it was sent.");
        expect(reply.text).toContain(words);
      }
      expect(hidden.received).toEqual([]);
      expect(
        records.map((entry) => [
          entry.method,
          entry.outcome,
          entry.notice,
          entry.format,
          entry.route,
        ]),
      ).toEqual([
        ["POST", "refused", notice, "anthropic-messages", undefined],
        ["GET", "refused", notice, undefined, "plain"],
      ]);
      expect(records[0]?.reason).toContain(`127.0.0.1:${proxy.port}`);

      // A program whose setup request was the first to be refused reports it in its own words.
      // What the gateway knows is kept for the app to say, until a request gets out again.
      const refusal = new ProxyRefusal();
      const [, setUpRefused] = records;
      if (setUpRefused === undefined) throw new Error("The setup request left no record.");
      refusal.note(setUpRefused, 1_000);
      expect(refusal.reason(2_000)).toBe(setUpRefused.reason);
      expect(refusal.reason(2_000)).toContain(words);
      expect(refusal.reason(120_000)).toBeUndefined();
      const { at, host, path } = setUpRefused;
      refusal.note({ at, host, path, method: "GET", outcome: "passed", route: "plain" }, 3_000);
      expect(refusal.reason(3_500)).toBeUndefined();
    }

    // A proxy that is not there at all: said in the same place, with no wait and no way round it.
    const gone = await makeProxy();
    const url = gone.url;
    await gone[Symbol.asyncDispose]();
    await using proxy = await makeProxy();
    await using hidden = await makeHiddenHost(proxy);
    await using harness = await makeHarness(nameDetector([]), ok, undefined, {
      ...hidden.options,
      upstreamProxy: () => url,
    });
    const reply = await harness.post("/v1/messages", {
      messages: [{ role: "user", content: "Hello." }],
    });
    expect(reply.status).toBe(400);
    expect(reply.text).toContain("could not be reached (ECONNREFUSED)");
    expect(hidden.received).toEqual([]);
  });

  it("passes a usage report on as written and never answers it itself", async () => {
    await using harness = await makeHarness(nameDetector([]), (_request, _body, response) => {
      response.writeHead(202, { "content-type": "application/json" });
      response.end(`{"from":"the provider"}`);
    });
    const report = { events: [{ event_name: "started", device_id: "d1" }] };
    const reply = await harness.post("/api/event_logging/v2/batch", report);

    expect(harness.received).toEqual([JSON.stringify(report)]);
    expect(reply).toEqual({ status: 202, text: `{"from":"the provider"}` });
  });

  it("refuses every WebSocket to a model host, and says when the same address is masked over HTTPS", async () => {
    const records: Array<GatewayRecord> = [];
    const seen = () => records.map((entry) => [entry.outcome, entry.path, entry.notice]);
    await using harness = await makeHarness(nameDetector(["Khalid Al-Otaibi"]), ok, undefined, {
      onRecord: (entry) => records.push(entry),
    });
    // Codex asks for its WebSocket on the address it posts to; a voice session has no such address.
    expect(await harness.upgrade("/backend-api/codex/responses")).toBe(426);
    expect(await harness.upgrade("/v1/realtime")).toBe(426);
    expect(harness.received).toEqual([]);
    await harness.post("/backend-api/codex/responses", {
      input: [{ role: "user", content: [{ type: "input_text", text: "Ask Khalid Al-Otaibi." }] }],
    });
    expect(harness.received.join()).not.toContain("Khalid");
    expect(seen()).toEqual([
      ["blocked", "/backend-api/codex/responses", "websocketToMaskedRoute"],
      ["blocked", "/v1/realtime", undefined],
      ["masked", "/backend-api/codex/responses", undefined],
    ]);

    // With masking off the HTTPS request is sent as written, so the entry does not say otherwise.
    records.length = 0;
    await using off = await makeHarness(nameDetector([]), ok, undefined, {
      masking: () => false,
      onRecord: (entry) => records.push(entry),
    });
    expect(await off.upgrade("/backend-api/codex/responses")).toBe(426);
    expect(seen()).toEqual([["blocked", "/backend-api/codex/responses", undefined]]);
  });

  it("sends no body it has not read: an unknown path is refused, and every request is recorded", async () => {
    const records: Array<GatewayRecord> = [];
    await using harness = await makeHarness(nameDetector(["Khalid Al-Otaibi"]), ok, undefined, {
      onRecord: (entry) => records.push(entry),
    });
    const note = { note: "Khalid Al-Otaibi, ID 1098765432" };
    // A file upload, a batch, a transcript: whatever the path, a body nobody read stays here.
    for (const [method, path] of [
      ["POST", "/v1/files"],
      ["POST", "/v1/messages/batches"],
      ["PUT", "/api/claude_code/team_memory?repo=acme"],
      ["POST", "/api/other"],
    ] as const) {
      const reply = await harness.send({ method, path, body: note });
      expect(reply.status, path).toBe(400);
      expect(reply.text, path).toContain("DoeDesk did not send this request");
      // It names the request, without the query: a program shows this text to the person.
      expect(reply.text, path).toContain(`${method} api.anthropic.com${path.split("?")[0]} is`);
    }
    expect(harness.received).toEqual([]);
    // With nothing to read there is nothing to refuse: the program asks, and is answered.
    expect((await harness.send({ method: "GET", path: "/api/claude_cli/bootstrap" })).status).toBe(
      200,
    );
    expect((await harness.send({ method: "DELETE", path: "/v1/files/f1" })).status).toBe(200);
    expect(harness.received).toEqual(["", ""]);
    expect(
      records.map((entry) => [entry.method, entry.path, entry.outcome, entry.route, entry.notice]),
    ).toEqual([
      ["POST", "/v1/files", "refused", "unknown", "unknownRequest"],
      ["POST", "/v1/messages/batches", "refused", "unknown", "unknownRequest"],
      ["PUT", "/api/claude_code/team_memory?repo=acme", "refused", "unknown", "unknownRequest"],
      ["POST", "/api/other", "refused", "unknown", "unknownRequest"],
      ["GET", "/api/claude_cli/bootstrap", "passed", "plain", undefined],
      ["DELETE", "/v1/files/f1", "passed", "plain", undefined],
    ]);
  });

  it("checks every string of a body that carries text in a shape of its own", async () => {
    const records: Array<GatewayRecord> = [];
    await using harness = await makeHarness(nameDetector(["Khalid Al-Otaibi"]), ok, undefined, {
      onRecord: (entry) => records.push(entry),
    });
    await harness.send({
      method: "POST",
      host: "api.openai.com",
      path: "/v1/responses/input_tokens",
      body: { model: "gpt-x", input: [{ role: "user", content: "Ask Khalid Al-Otaibi." }] },
    });
    await harness.send({
      method: "POST",
      host: "api.openai.com",
      path: "/v1/embeddings",
      body: { model: "embed-x", input: ["Khalid Al-Otaibi, ID 1098765432"] },
    });
    expect(harness.received).toHaveLength(2);
    expect(harness.received.join()).not.toMatch(/Khalid|1098765432/);
    expect(harness.received[0]).toMatch(/"model":"gpt-x".*Ask \[PERSON_/);
    expect(harness.received[1]).toMatch(/\[PERSON_.*\[ID_/);
    expect(records.map((entry) => [entry.outcome, entry.format])).toEqual([
      ["masked", "json-text"],
      ["masked", "json-text"],
    ]);
  });

  it("replaces the values it knows in a usage report, also inside an event's encoded details", async () => {
    const records: Array<GatewayRecord> = [];
    await using harness = await makeHarness(nameDetector(["Khalid Al-Otaibi"]), ok, undefined, {
      onRecord: (entry) => records.push(entry),
    });
    await harness.post("/v1/messages", {
      messages: [{ role: "user", content: "Write to Khalid Al-Otaibi." }],
    });
    const details = (text: string) =>
      Buffer.from(JSON.stringify({ error: text })).toString("base64");
    const report = (text: string) => ({
      events: [
        {
          event_data: { event_name: "tool_error", note: text, additional_metadata: details(text) },
        },
      ],
    });
    // Nothing known in it: the bytes the program wrote. A known value: its stand-in, in both places.
    await harness.post("/api/event_logging/v2/batch", report("exit 1"));
    await harness.post("/api/event_logging/v2/batch", report("no file Khalid Al-Otaibi.txt"));
    await harness.send({
      method: "POST",
      host: "chatgpt.com",
      path: "/backend-api/codex/analytics-events/events",
      body: { events: [{ event_params: { tool: "Khalid Al-Otaibi" } }] },
    });
    expect(harness.received[1]).toBe(JSON.stringify(report("exit 1")));
    const sent = JSON.parse(harness.received[2] ?? "{}") as ReturnType<typeof report>;
    const event = sent.events[0]?.event_data;
    expect(event?.note).toMatch(/^no file \[PERSON_[A-Z2-9]{5}\]\.txt$/);
    expect(Buffer.from(event?.additional_metadata ?? "", "base64").toString("utf8")).toMatch(
      /^\{"error":"no file \[PERSON_[A-Z2-9]{5}\]\.txt"\}$/,
    );
    expect(harness.received.slice(1).join()).not.toContain("Khalid");
    expect(records.slice(1).map((entry) => [entry.outcome, entry.route, entry.masked])).toEqual([
      ["passed", "report", undefined],
      ["passed", "report", 2],
      ["passed", "report", 1],
    ]);
  });

  it("lets a program list the apps an AI company hosts, and does not send a call to one", async () => {
    const records: Array<GatewayRecord> = [];
    await using harness = await makeHarness(nameDetector([]), ok, undefined, {
      onRecord: (entry) => records.push(entry),
    });
    const apps = (body: unknown) =>
      harness.send({ method: "POST", host: "chatgpt.com", path: "/backend-api/ps/mcp", body });
    const list = { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} };
    expect((await apps({ jsonrpc: "2.0", id: 0, method: "initialize", params: {} })).status).toBe(
      200,
    );
    expect((await apps(list)).status).toBe(200);
    const call = {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "search_drive", arguments: { query: "Khalid Al-Otaibi contract" } },
    };
    expect((await apps(call)).status).toBe(400);
    expect((await apps([list, call])).status).toBe(400);
    expect(harness.received).toHaveLength(2);
    expect(harness.received.join()).not.toContain("Khalid");
    expect(records.map((entry) => [entry.outcome, entry.notice])).toEqual([
      ["passed", undefined],
      ["passed", undefined],
      ["refused", "appCall"],
      ["refused", "appCall"],
    ]);
  });

  it("masks what the model receives and restores what the client receives", async () => {
    await using harness = await makeHarness(
      nameDetector(["Khalid Al-Otaibi"]),
      (_request, body, response) => {
        const token = /\[PERSON_[A-Z2-9]{5}\]/.exec(body)?.[0] ?? "";
        response.writeHead(200, { "content-type": "text/event-stream" });
        // The model's reply names the person by placeholder, cut across two streamed pieces.
        response.end(
          sse([
            { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
            {
              type: "content_block_delta",
              index: 0,
              delta: { type: "text_delta", text: `Dear ${token.slice(0, 6)}` },
            },
            {
              type: "content_block_delta",
              index: 0,
              delta: { type: "text_delta", text: `${token.slice(6)}, approved.` },
            },
            { type: "content_block_stop", index: 0 },
            {
              type: "content_block_start",
              index: 1,
              content_block: { type: "tool_use", id: "t1", name: "Read", input: {} },
            },
            {
              type: "content_block_delta",
              index: 1,
              delta: { type: "input_json_delta", partial_json: `{"path":"/cases/${token}.pdf"}` },
            },
            { type: "content_block_stop", index: 1 },
            { type: "message_stop" },
          ]),
        );
      },
    );

    const reply = await harness.post("/v1/messages", {
      model: "claude",
      system: "You review land extension requests.",
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "Applicant Khalid Al-Otaibi, phone 0551234567, ID 1098765432." },
            { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } },
          ],
        },
      ],
    });

    const sent = harness.received[0] ?? "";
    expect(sent).not.toContain("Khalid");
    expect(sent).not.toContain("0551234567");
    expect(sent).not.toContain("1098765432");
    expect(sent).not.toContain("AAAA");
    expect(sent).toContain("Image withheld by DoeDesk");
    expect(sent).toMatch(
      /Applicant \[PERSON_[A-Z2-9]{5}\], phone \[PHONE_[A-Z2-9]{5}\], ID \[ID_[A-Z2-9]{5}\]\./,
    );

    expect(reply.status).toBe(200);
    expect(reply.text).toContain("Dear ");
    const text = reply.text
      .split("\n")
      .filter((line) => line.startsWith("data: "))
      .map(
        (line) => JSON.parse(line.slice(6)) as { delta?: { text?: string; partial_json?: string } },
      )
      .map((event) => event.delta?.text ?? event.delta?.partial_json ?? "")
      .join("");
    expect(text).toBe('Dear Khalid Al-Otaibi, approved.{"path":"/cases/Khalid Al-Otaibi.pdf"}');
  });

  it("sends the same placeholder for the same person on later turns", async () => {
    const records: Array<GatewayRecord> = [];
    const restored: Array<unknown> = [];
    let answer = "ok";
    await using harness = await makeHarness(
      nameDetector(["Khalid Al-Otaibi"]),
      (_request, _body, response) => {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ content: [{ type: "text", text: answer }] }));
      },
      undefined,
      {
        onRecord: (record) => records.push(record),
        onRestored: (entry) => restored.push(entry),
      },
    );
    const turn = (text: string) =>
      harness.post("/v1/messages", { messages: [{ role: "user", content: text }] });
    await turn("Khalid Al-Otaibi asked for an extension.");
    // On this turn the assistant text is not sent to the detector, only matched against the vault.
    await harness.post("/v1/messages", {
      metadata: { user_id: JSON.stringify({ session_id: SESSION }) },
      messages: [
        { role: "user", content: "Khalid Al-Otaibi asked for an extension." },
        { role: "assistant", content: "I will draft a letter to Khalid Al-Otaibi." },
      ],
    });
    const first = /\[PERSON_[A-Z2-9]{5}\]/.exec(harness.received[0] ?? "")?.[0];
    expect(first).toBeDefined();
    expect(harness.received[1]).toContain(`draft a letter to ${first}.`);
    expect(harness.received[1]).not.toContain("Khalid");
    // Each record names the stand-ins it wrote once, and the chat when the request names one.
    expect(records.map(({ replaced, sessions }) => ({ replaced, sessions }))).toEqual([
      { replaced: [first], sessions: undefined },
      { replaced: [first], sessions: [SESSION] },
    ]);

    // A client that keeps its history with the model sends only what is new. Nothing in this
    // request is replaced, and the reply still uses the stand-in: the chat is told it was restored.
    answer = `Sent to ${first}.`;
    const reply = await harness.post("/v1/messages", {
      metadata: { user_id: JSON.stringify({ session_id: SESSION }) },
      messages: [{ role: "user", content: "Send it." }],
    });
    expect(reply.text).toContain("Sent to Khalid Al-Otaibi.");
    expect(records.at(-1)?.replaced).toEqual([]);
    expect(restored).toEqual([{ sessions: [SESSION], tokens: [first] }]);
  });

  it("sends nothing when the text cannot be checked", async () => {
    const failing: Detector = {
      detect: () => Promise.reject(new DetectorUnavailableError("The detection service is down.")),
    };
    await using harness = await makeHarness(failing, (_request, _body, response) => {
      response.writeHead(200).end("{}");
    });
    const reply = await harness.post("/v1/messages", {
      messages: [{ role: "user", content: "Khalid Al-Otaibi asked for an extension." }],
    });
    expect(reply.status).toBe(400);
    expect(reply.text).toContain("nothing left this device");
    expect(harness.received).toHaveLength(0);
  });

  it("restores placeholders in OpenAI Responses streams and re-masks tool arguments", async () => {
    await using harness = await makeHarness(
      nameDetector(["Sara Nasser"]),
      (_request, body, response) => {
        const token = /\[PERSON_[A-Z2-9]{5}\]/.exec(body)?.[0] ?? "";
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.end(
          sse([
            {
              type: "response.output_text.delta",
              item_id: "m1",
              content_index: 0,
              delta: `Hello ${token.slice(0, 3)}`,
            },
            {
              type: "response.output_text.delta",
              item_id: "m1",
              content_index: 0,
              delta: token.slice(3),
            },
            {
              type: "response.output_text.done",
              item_id: "m1",
              content_index: 0,
              text: `Hello ${token}`,
            },
            {
              type: "response.function_call_arguments.done",
              item_id: "f1",
              arguments: `{"to":"${token}"}`,
            },
          ]),
        );
      },
    );
    const reply = await harness.post("/v1/responses", {
      instructions: "Help with cases.",
      input: [
        {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: 'Write to Sara Nasser "the owner".' }],
        },
        { type: "function_call", call_id: "c1", name: "send", arguments: '{"to":"Sara Nasser"}' },
        { type: "function_call_output", call_id: "c1", output: "Delivered to Sara Nasser." },
      ],
    });
    const sent = harness.received[0] ?? "";
    expect(sent).not.toContain("Sara");
    const events = reply.text
      .split("\n")
      .filter((line) => line.startsWith("data: "))
      .map((line) => JSON.parse(line.slice(6)) as Record<string, string>);
    expect(
      events
        .slice(0, 2)
        .map((event) => event.delta)
        .join(""),
    ).toBe("Hello Sara Nasser");
    expect(events[2]?.text).toBe("Hello Sara Nasser");
    expect(events[3]?.arguments).toBe('{"to":"Sara Nasser"}');
  });
});

describe("images through the gateway", () => {
  it("forwards the redacted picture, never the one it was given", async () => {
    const words = [
      { text: "Owner", x: 60, y: 80, width: 70, height: 24 },
      { text: "0551234567", x: 150, y: 80, width: 150, height: 24 },
    ];
    const png = await pngOf(paintPage(640, 240, words));
    const planted = plantedReader(640, words);
    const vault = new Vault();
    const pseudonymizer = new Pseudonymizer(vault, patternDetector);
    const redactor = makeImageRedactor({ reader: planted, pseudonymizer });
    await using harness = await makeHarness(
      { detect: (texts) => Promise.resolve(texts.map(() => [])) },
      (_request, _body, response) => {
        response.writeHead(200, { "content-type": "application/json" });
        response.end("{}");
      },
      { read: () => Promise.resolve("Owner 0551234567"), readLayout: planted.readLayout },
      { pseudonymizer, attachments: () => ({ images: "redacted", redactor }) },
    );
    await harness.post("/v1/messages", {
      messages: [
        {
          role: "user",
          content: [
            {
              type: "image",
              source: { type: "base64", media_type: "image/png", data: png.toString("base64") },
            },
          ],
        },
      ],
    });
    const sent = JSON.parse(harness.received[0] ?? "{}") as {
      messages: Array<{
        content: Array<{ type: string; text?: string; source?: { data: string } }>;
      }>;
    };
    const content = sent.messages[0]?.content ?? [];
    expect(content.map((block) => block.type)).toEqual(["image", "text"]);
    const forwarded = Buffer.from(content[0]?.source?.data ?? "", "base64");
    expect(forwarded.equals(png)).toBe(false);
    expect(await shows(forwarded, 640, words[1] as (typeof words)[number])).toBe("hidden");
    expect(await shows(forwarded, 640, words[0] as (typeof words)[number])).toBe("shown");
    expect(content[1]?.text).toContain(vault.entries()[0]?.token);
    expect(harness.received[0]).not.toContain("0551234567");
  });
});

describe("attachments", () => {
  it("sends the masked text read from an image, never the image", async () => {
    const reader: Reader = { read: () => Promise.resolve("Owner: Khalid Al-Otaibi, 0551234567") };
    await using harness = await makeHarness(
      nameDetector(["Khalid Al-Otaibi"]),
      (_request, _body, response) => {
        response.writeHead(200, { "content-type": "application/json" });
        response.end("{}");
      },
      reader,
    );
    await harness.post("/v1/messages", {
      messages: [
        {
          role: "user",
          content: [
            { type: "image", source: { type: "base64", media_type: "image/png", data: "QUJD" } },
          ],
        },
      ],
    });
    const sent = harness.received[0] ?? "";
    expect(sent).not.toContain("QUJD");
    expect(sent).not.toContain("Khalid");
    expect(sent).not.toContain("0551234567");
    expect(sent).toMatch(
      /Text read from an attached image by DoeDesk.*Owner: \[PERSON_[A-Z2-9]{5}\], \[PHONE_[A-Z2-9]{5}\]/s,
    );
  });
});

describe("evaluation switches", () => {
  const body = {
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: "Applicant Khalid Al-Otaibi, phone 0551234567." },
          { type: "image", source: { type: "base64", media_type: "image/png", data: "QUJD" } },
        ],
      },
    ],
  };

  it("reads attachments as text but masks nothing when only attachments are asked for", async () => {
    const reader: Reader = { read: () => Promise.resolve("Owner: Khalid Al-Otaibi") };
    const sentBodies: Array<string> = [];
    await using harness = await makeHarness(nameDetector(["Khalid Al-Otaibi"]), ok, reader, {
      attachmentsOnly: () => true,
      onSentBody: (_host, _path, sent) => sentBodies.push(sent),
    });
    await harness.post("/v1/messages", body);
    const sent = harness.received[0] ?? "";
    expect(sent).not.toContain("QUJD");
    expect(sent).toContain("Applicant Khalid Al-Otaibi, phone 0551234567.");
    expect(sent).toMatch(/Text read from an attached image by DoeDesk.*Owner: Khalid Al-Otaibi/s);
    expect(harness.vault.size).toBe(0);
    expect(sentBodies).toEqual([sent]);
  });

  it("reports the body, and forwards it unchanged, while masking is off", async () => {
    const sentBodies: Array<string> = [];
    await using harness = await makeHarness(nameDetector(["Khalid Al-Otaibi"]), ok, undefined, {
      masking: () => false,
      onSentBody: (_host, path, sent) => sentBodies.push(`${path} ${sent}`),
    });
    await harness.post("/v1/messages", body);
    expect(harness.received).toEqual([JSON.stringify(body)]);
    expect(sentBodies).toEqual([`/v1/messages ${JSON.stringify(body)}`]);
  });

  it("reports a request that carries nothing of the session, and sends it as written", async () => {
    const sentBodies: Array<string> = [];
    await using harness = await makeHarness(nameDetector(["Khalid Al-Otaibi"]), ok, undefined, {
      onSentBody: (_host, path, sent) => sentBodies.push(`${path} ${sent}`),
    });
    await harness.post("/api/eval/sdk-abc", { attributes: { id: "d1" } });
    expect(harness.received).toEqual(['{"attributes":{"id":"d1"}}']);
    expect(sentBodies).toEqual(['/api/eval/sdk-abc {"attributes":{"id":"d1"}}']);
  });
});

describe("span tidying", () => {
  it("keeps a detected value on one line and leaves app-written blocks to the pattern detector", async () => {
    const { normalizeSpans, ignoreAppAuthoredBlocks } = await import("./detect.ts");
    const text = "ID: 1098765432\n5\tPhone";
    // A detector that ran the number into the next line.
    expect(normalizeSpans(text, [{ start: 4, end: 16, kind: "ID" }])).toEqual([
      { start: 4, end: 14, kind: "ID" },
    ]);
    expect(
      normalizeSpans("budget 15000000 riyals", [{ start: 7, end: 15, kind: "PHONE" }]),
    ).toEqual([]);

    const seen: Array<string> = [];
    const spy: Detector = {
      detect: (texts) => {
        seen.push(...texts);
        return Promise.resolve(texts.map(() => []));
      },
    };
    const input = "Hi <system-reminder>Use WebFetch</system-reminder> there";
    await ignoreAppAuthoredBlocks(spy).detect([input]);
    expect(seen[0]).toHaveLength(input.length);
    expect(seen[0]).not.toContain("WebFetch");
    expect(seen[0]?.startsWith("Hi ")).toBe(true);
  });
});

describe("hosts that are not model hosts", () => {
  /** Asks the gateway for a tunnel to a local server and returns the status line it answers. */
  const connectThrough = async (
    extra: Partial<GatewayOptions>,
  ): Promise<{ status: number; reached: boolean; seen: Array<string> }> => {
    const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "doedesk-egress-"));
    let reached = false;
    const target = NodeHttp.createServer((_request, response) => {
      reached = true;
      response.end("ok");
    });
    await new Promise<void>((resolve) => target.listen(0, "127.0.0.1", resolve));
    const address = target.address();
    if (address === null || typeof address === "string") throw new Error("no port");
    const seen: Array<string> = [];
    const gateway = await startGateway({
      authority: loadLocalAuthority(directory),
      pseudonymizer: new Pseudonymizer(new Vault(), patternDetector),
      onOtherHost: (host, _port, outcome) => seen.push(`${host} ${outcome}`),
      ...extra,
    });
    try {
      const status = await new Promise<number>((resolve, reject) => {
        const connect = NodeHttp.request({
          host: "127.0.0.1",
          port: gateway.port,
          method: "CONNECT",
          path: `127.0.0.1:${address.port}`,
        });
        connect.on("error", reject);
        connect.on("connect", (response, socket) => {
          if (response.statusCode !== 200) {
            socket.destroy();
            resolve(response.statusCode ?? 0);
            return;
          }
          socket.write("GET / HTTP/1.1\r\nhost: x\r\nconnection: close\r\n\r\n");
          socket.on("data", () => undefined);
          socket.on("close", () => resolve(200));
        });
        connect.end();
      });
      return { status, reached, seen };
    } finally {
      await gateway.close();
      await new Promise((resolve) => target.close(resolve));
      NodeFS.rmSync(directory, { recursive: true, force: true });
    }
  };

  it.each([
    ["open", [], 200, true],
    ["closed", ["127.0.0.1"], 403, false],
    ["allowlist", [], 403, false],
    ["allowlist", ["127.0.0.1"], 200, true],
  ] as const)("%s with %j answers %i", async (policy, hosts, status, reached) => {
    const result = await connectThrough({ egress: () => ({ policy, hosts }) });
    expect(result.status).toBe(status);
    expect(result.reached).toBe(reached);
    expect(result.seen).toEqual([`127.0.0.1 ${reached ? "passed" : "blocked"}`]);
  });

  it("lets a host through that the person allowed until the app closes, with AI hosts only", async () => {
    const result = await connectThrough({
      egress: () => ({ policy: "closed", hosts: [], untilClose: ["127.0.0.1"] }),
    });
    expect(result.status).toBe(200);
    expect(result.reached).toBe(true);
  });

  it("lets every host through while masking is off, whatever the rule says", async () => {
    const result = await connectThrough({
      egress: () => ({ policy: "closed", hosts: [] }),
      masking: () => false,
    });
    expect(result.status).toBe(200);
  });
});

describe("sealed text", () => {
  it("sends a note in place of a tool result that holds sealed text, and of a passage the person quotes", async () => {
    const sealed =
      "The Supplier's total liability in any contract year shall not exceed SAR 4,812,650.40";
    const tripwire = new Tripwire();
    tripwire.add("DOC_1", `Clause 11. ${sealed}, save for fraud.`);
    await using harness = await makeHarness(
      nameDetector([]),
      (_request, _body, response) => {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ content: [{ type: "text", text: "ok" }] }));
      },
      undefined,
      {
        withholdSealedText: (text, typed) =>
          typed
            ? tripwire.withoutPassages(text)
            : tripwire.flags(text)
              ? WITHHELD_SEALED_NOTE
              : undefined,
      },
    );
    await harness.post("/v1/messages", {
      messages: [
        {
          role: "user",
          content: `Review the workspace. The clause reads: "${sealed}". Is that cap usual?`,
        },
        {
          role: "assistant",
          content: [{ type: "tool_use", id: "t1", name: "Read", input: { path: "/w/a.txt" } }],
        },
        {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "t1", content: `1\t${sealed}` }],
        },
      ],
    });
    const sent = harness.received[0] ?? "";
    expect(sent).not.toContain("4,812,650.40");
    expect(sent).toContain("DoeDesk withheld this content");
    // The person's own request survives around the passage they quoted.
    expect(sent).toContain("Review the workspace. The clause reads:");
    expect(sent).toContain("DoeDesk withheld a passage here");
    expect(sent).toContain("Is that cap usual?");
  });
});

describe("tool payloads", () => {
  it("masks a value under any key of a tool's input and output, whatever the key is called", async () => {
    await using harness = await makeHarness(
      nameDetector(["Thessaly Brackenridge"]),
      (_request, _body, response) => {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ content: [{ type: "text", text: "ok" }] }));
      },
    );
    // The first request puts the name in the vault; the model's later tool call carries it back
    // restored, under keys that are also names of protocol fields.
    await harness.post("/v1/messages", {
      messages: [
        { role: "user", content: "Add Thessaly Brackenridge as a contact." },
        {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "t1",
              name: "create_contact",
              input: {
                name: "Thessaly Brackenridge",
                data: { id: "Thessaly Brackenridge", status: "new" },
              },
            },
          ],
        },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "done" }] },
      ],
    });
    const sent = JSON.parse(harness.received[0] ?? "{}") as {
      messages: Array<{
        content: Array<{
          name?: string;
          input?: { name: string; data: { id: string; status: string } };
        }>;
      }>;
    };
    const call = sent.messages[1]?.content[0];
    expect(harness.received[0]).not.toContain("Thessaly Brackenridge");
    // The tool's own name is protocol, and stays.
    expect(call?.name).toBe("create_contact");
    expect(call?.input?.name).toMatch(/^\[PERSON_/);
    expect(call?.input?.data.id).toMatch(/^\[PERSON_/);
    expect(call?.input?.data.status).toBe("new");

    // A command told to print only a count that prints the values all the same: its output is
    // a tool result like any other, in both request formats.
    const printed =
      "name,id_number\nThessaly Brackenridge,1098765432\n2456789013\nrow 3: 2187654321 yes";
    await harness.post("/v1/messages", {
      messages: [
        { role: "user", content: "How many are residents?" },
        {
          role: "assistant",
          content: [
            { type: "tool_use", id: "t2", name: "Bash", input: { command: "cat payroll.csv" } },
          ],
        },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "t2", content: printed }] },
      ],
    });
    await harness.post("/v1/responses", {
      input: [
        { role: "user", content: [{ type: "input_text", text: "How many are residents?" }] },
        { type: "function_call", call_id: "c1", name: "exec_command", arguments: "{}" },
        { type: "function_call_output", call_id: "c1", output: printed },
      ],
    });
    expect(harness.received).toHaveLength(3);
    for (const body of harness.received.slice(1)) {
      expect(body).not.toMatch(/1098765432|2456789013|2187654321|Thessaly/);
      expect(body.match(/\[ID_/g)).toHaveLength(3);
      expect(body).toContain("row 3: [ID_");
    }
  });
});
