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
import { type GatewayOptions, startGateway } from "./gateway.ts";
import { Pseudonymizer } from "./pseudonymizer.ts";
import type { Reader } from "./reader.ts";
import { makeImageRedactor } from "./redaction/redactImage.ts";
import { paintPage, plantedReader, pngOf, shows } from "./redaction/testkit.ts";
import { Vault } from "./vault.ts";

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

  const post: Harness["post"] = (path, body) =>
    new Promise((resolve, reject) => {
      const connect = NodeHttp.request({
        host: "127.0.0.1",
        port: gateway.port,
        method: "CONNECT",
        path: "api.anthropic.com:443",
      });
      connect.on("error", reject);
      connect.on("connect", (_response, socket) => {
        const secure = NodeTls.connect({ socket, servername: "api.anthropic.com", ca: trusted });
        const payload = JSON.stringify(body);
        const request = NodeHttps.request(
          {
            createConnection: () => secure,
            host: "api.anthropic.com",
            method: "POST",
            path,
            headers: {
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
      });
      connect.end();
    });

  return {
    vault,
    received,
    post,
    [Symbol.asyncDispose]: async () => {
      await gateway.close();
      await new Promise((resolve) => upstream.close(resolve));
      NodeFS.rmSync(directory, { recursive: true, force: true });
    },
  };
};

const sse = (events: ReadonlyArray<unknown>): string =>
  events.map((event) => `event: message\ndata: ${JSON.stringify(event)}\n\n`).join("");

describe("privacy gateway", () => {
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
    await using harness = await makeHarness(
      nameDetector(["Khalid Al-Otaibi"]),
      (_request, _body, response) => {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ content: [{ type: "text", text: "ok" }] }));
      },
    );
    const turn = (text: string) =>
      harness.post("/v1/messages", { messages: [{ role: "user", content: text }] });
    await turn("Khalid Al-Otaibi asked for an extension.");
    // On this turn the assistant text is not sent to the detector, only matched against the vault.
    await harness.post("/v1/messages", {
      messages: [
        { role: "user", content: "Khalid Al-Otaibi asked for an extension." },
        { role: "assistant", content: "I will draft a letter to Khalid Al-Otaibi." },
      ],
    });
    const first = /\[PERSON_[A-Z2-9]{5}\]/.exec(harness.received[0] ?? "")?.[0];
    expect(first).toBeDefined();
    expect(harness.received[1]).toContain(`draft a letter to ${first}.`);
    expect(harness.received[1]).not.toContain("Khalid");
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
  const ok = (_request: unknown, _body: string, response: NodeHttp.ServerResponse) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end("{}");
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

  it("reports a request to a model host that it does not rewrite", async () => {
    const sentBodies: Array<string> = [];
    await using harness = await makeHarness(nameDetector(["Khalid Al-Otaibi"]), ok, undefined, {
      onSentBody: (_host, path, sent) => sentBodies.push(`${path} ${sent}`),
    });
    await harness.post("/api/other", { note: "Khalid Al-Otaibi" });
    expect(harness.received).toEqual(['{"note":"Khalid Al-Otaibi"}']);
    expect(sentBodies).toEqual(['/api/other {"note":"Khalid Al-Otaibi"}']);
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
