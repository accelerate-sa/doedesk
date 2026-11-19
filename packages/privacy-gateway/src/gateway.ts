import * as NodeHttp from "node:http";
import * as NodeHttps from "node:https";
import * as NodeNet from "node:net";
import type * as NodeStream from "node:stream";
import * as NodeTls from "node:tls";
import * as NodeZlib from "node:zlib";

import type { LocalAuthority } from "./certificates.ts";
import { describeMaskingFailure } from "./core.ts";
import type { Pseudonymizer } from "./pseudonymizer.ts";
import type { Reader } from "./reader.ts";
import {
  type AttachmentHandling,
  maskRequestBody,
  type WireFormat,
  wireFormatForPath,
} from "./requestMasking.ts";
import { SseUnmasker, unmaskDeep } from "./responseUnmasking.ts";

/** Hosts whose traffic is opened and rewritten. Subdomains are included. */
export const DEFAULT_INSPECTED_HOSTS: ReadonlyArray<string> = [
  "api.anthropic.com",
  "api.openai.com",
  "chatgpt.com",
  "generativelanguage.googleapis.com",
  "cloudcode-pa.googleapis.com",
  "daily-cloudcode-pa.googleapis.com",
  "openrouter.ai",
  "api.x.ai",
  "api.groq.com",
  "api.mistral.ai",
  "api.deepseek.com",
  "api.z.ai",
  "opencode.ai",
];

/**
 * Model hosts that speak a format the gateway cannot rewrite. Requests to them are refused, so
 * an agent that uses one fails visibly instead of sending unmasked data.
 */
export const DEFAULT_BLOCKED_HOSTS: ReadonlyArray<string> = [
  "api2.cursor.sh",
  "api3.cursor.sh",
  "agent.api5.cursor.sh",
  "agentn.api5.cursor.sh",
  "repo42.cursor.sh",
];

export interface GatewayRecord {
  readonly at: string;
  readonly host: string;
  readonly path: string;
  readonly outcome: "masked" | "passed" | "refused" | "blocked";
  readonly format?: WireFormat;
  /** Texts checked for personal data in this request. */
  readonly checked?: number;
  /** Values replaced with placeholders in this request. */
  readonly masked?: number;
  /** Images and files removed because they could not be checked. */
  readonly withheld?: number;
  /** Images and files replaced by the text read from them. */
  readonly read?: number;
  /** Images sent with their personal data covered. */
  readonly redacted?: number;
  readonly reason?: string;
}

export interface GatewayOptions {
  readonly authority: LocalAuthority;
  readonly pseudonymizer: Pseudonymizer;
  /** Reads text out of images and files. Without one they are withheld. Looked up per request. */
  readonly reader?: () => Reader | undefined;
  /** How images are sent. Looked up per request. Without it they are replaced by their text. */
  readonly attachments?: () => AttachmentHandling;
  readonly inspectedHosts?: ReadonlyArray<string>;
  readonly blockedHosts?: ReadonlyArray<string>;
  readonly onRecord?: (record: GatewayRecord) => void;
  /**
   * When this returns false the gateway forwards everything unchanged. Only an agent process that
   * was started while masking was on still has the gateway in its path at that point: one started
   * with masking off is never given the gateway.
   */
  readonly masking?: () => boolean;
  /**
   * Receives each request body exactly as it was sent to the model, for inspection. Bodies are
   * confidential: with masking off, or with `attachmentsOnly`, they hold the real values.
   */
  readonly onSentBody?: (host: string, path: string, body: string) => void;
  /**
   * Evaluation only. While this returns true, a masked request has its images and files replaced
   * by the text read from them and nothing else: no value becomes a placeholder.
   */
  readonly attachmentsOnly?: () => boolean;
  /** Where intercepted requests are sent. Tests point this at a local server. */
  readonly upstream?: (host: string) => {
    readonly host: string;
    readonly port: number;
    readonly tls: boolean;
  };
}

export interface RunningGateway {
  readonly port: number;
  readonly close: () => Promise<void>;
}

const hostMatches = (host: string, list: ReadonlyArray<string>): boolean =>
  list.some((entry) => host === entry || host.endsWith(`.${entry}`));

const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

const decodeBody = (body: Buffer, encoding: string | undefined): Buffer => {
  switch ((encoding ?? "identity").trim().toLowerCase()) {
    case "":
    case "identity":
      return body;
    case "gzip":
    case "x-gzip":
      return NodeZlib.gunzipSync(body);
    case "deflate":
      return NodeZlib.inflateSync(body);
    case "br":
      return NodeZlib.brotliDecompressSync(body);
    case "zstd":
      return NodeZlib.zstdDecompressSync(body);
    default:
      throw new Error(`Unsupported request encoding: ${encoding}`);
  }
};

const readBody = (stream: NodeHttp.IncomingMessage): Promise<Buffer> =>
  new Promise((resolve, reject) => {
    const chunks: Array<Buffer> = [];
    stream.on("data", (chunk: Buffer) => chunks.push(chunk));
    stream.on("end", () => resolve(Buffer.concat(chunks)));
    stream.on("error", reject);
  });

/** An error in the shape model clients already know how to show. 400 is not retried. */
const refusalBody = (message: string): string =>
  JSON.stringify({
    type: "error",
    error: { type: "invalid_request_error", message, code: "doedesk_privacy_gateway" },
  });

export const startGateway = (options: GatewayOptions): Promise<RunningGateway> => {
  const inspectedHosts = options.inspectedHosts ?? DEFAULT_INSPECTED_HOSTS;
  const blockedHosts = options.blockedHosts ?? DEFAULT_BLOCKED_HOSTS;
  const record = (entry: Omit<GatewayRecord, "at">) =>
    options.onRecord?.({ at: new Date().toISOString(), ...entry });
  const upstreamFor =
    options.upstream ?? ((host: string) => ({ host, port: 443, tls: true as boolean }));
  const hostBySocket = new WeakMap<NodeStream.Duplex, string>();
  const sockets = new Set<NodeStream.Duplex>();
  const track = (socket: NodeStream.Duplex) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  };

  const forward = (
    host: string,
    request: NodeHttp.IncomingMessage,
    response: NodeHttp.ServerResponse,
    body: Buffer | undefined,
    unmask: boolean,
  ) => {
    const target = upstreamFor(host);
    const headers: NodeHttp.OutgoingHttpHeaders = {};
    for (const [name, value] of Object.entries(request.headers)) {
      if (value === undefined || HOP_BY_HOP.has(name)) continue;
      headers[name] = value;
    }
    headers.host = host;
    if (body !== undefined) {
      headers["content-length"] = body.length;
      delete headers["content-encoding"];
    }
    // The reply has to be readable to restore values in it.
    if (unmask) headers["accept-encoding"] = "identity";

    const transport = target.tls ? NodeHttps : NodeHttp;
    const upstream = transport.request(
      {
        host: target.host,
        port: target.port,
        servername: host,
        method: request.method,
        path: request.url,
        headers,
      },
      (reply) => {
        const replyHeaders: NodeHttp.OutgoingHttpHeaders = {};
        for (const [name, value] of Object.entries(reply.headers)) {
          if (value === undefined || HOP_BY_HOP.has(name)) continue;
          replyHeaders[name] = value;
        }
        const contentType = String(reply.headers["content-type"] ?? "");
        const readable = unmask && (reply.headers["content-encoding"] ?? "identity") === "identity";

        // Some backends stream events without declaring a content type.
        if (readable && (contentType.includes("text/event-stream") || contentType.trim() === "")) {
          delete replyHeaders["content-length"];
          response.writeHead(reply.statusCode ?? 502, replyHeaders);
          const stream = new SseUnmasker(options.pseudonymizer.vault);
          reply.on("data", (chunk: Buffer) => {
            const text = stream.push(chunk);
            if (text.length > 0) response.write(text);
          });
          reply.on("end", () => response.end(stream.end()));
          reply.on("error", () => response.destroy());
          return;
        }
        if (readable && contentType.includes("json")) {
          void readBody(reply).then(
            (raw) => {
              let text = raw.toString("utf8");
              try {
                text = JSON.stringify(unmaskDeep(JSON.parse(text), options.pseudonymizer.vault));
              } catch {
                // Not JSON after all: pass it on as it came.
              }
              const buffer = Buffer.from(text, "utf8");
              replyHeaders["content-length"] = buffer.length;
              response.writeHead(reply.statusCode ?? 502, replyHeaders);
              response.end(buffer);
            },
            () => response.destroy(),
          );
          return;
        }
        response.writeHead(reply.statusCode ?? 502, replyHeaders);
        reply.pipe(response);
      },
    );
    upstream.on("error", (cause) => {
      if (response.headersSent) {
        response.destroy();
        return;
      }
      response.writeHead(502, { "content-type": "application/json" });
      response.end(refusalBody(`DoeDesk could not reach ${host}: ${cause.message}`));
    });
    response.on("close", () => {
      if (!response.writableFinished) upstream.destroy();
    });
    if (body !== undefined) upstream.end(body);
    else request.pipe(upstream);
  };

  const handleInspected = async (
    request: NodeHttp.IncomingMessage,
    response: NodeHttp.ServerResponse,
  ) => {
    const host = hostBySocket.get(request.socket) ?? String(request.headers.host ?? "");
    const path = request.url ?? "/";
    const format = request.method === "POST" ? wireFormatForPath(path) : undefined;
    /** Forwards a request the gateway does not rewrite, showing its body to the listener. */
    const pass = async () => {
      if (options.onSentBody === undefined || request.method !== "POST") {
        forward(host, request, response, undefined, false);
        return;
      }
      let raw: Buffer;
      try {
        raw = decodeBody(await readBody(request), request.headers["content-encoding"]);
      } catch {
        response.destroy();
        return;
      }
      options.onSentBody(host, path, raw.toString("utf8"));
      forward(host, request, response, raw, false);
    };
    if (options.masking?.() === false) {
      if (options.onSentBody !== undefined && request.method === "POST") {
        record({ host, path, outcome: "passed", ...(format === undefined ? {} : { format }) });
      }
      await pass();
      return;
    }
    if (format === undefined) {
      if (request.method === "POST") record({ host, path, outcome: "passed" });
      await pass();
      return;
    }

    const refuse = (reason: string) => {
      record({ host, path, outcome: "refused", format, reason });
      response.writeHead(400, { "content-type": "application/json" });
      response.end(refusalBody(`DoeDesk did not send this request. ${reason}`));
    };

    let parsed: unknown;
    try {
      const raw = decodeBody(await readBody(request), request.headers["content-encoding"]);
      parsed = JSON.parse(raw.toString("utf8"));
    } catch (cause) {
      refuse(`The request could not be read to check it for personal data (${String(cause)}).`);
      return;
    }
    try {
      const attachmentsOnly = options.attachmentsOnly?.() === true;
      const masked = await maskRequestBody(
        format,
        parsed,
        options.pseudonymizer,
        options.reader?.(),
        { attachmentsOnly, attachments: options.attachments?.() },
      );
      record({
        host,
        path,
        outcome: "masked",
        format,
        checked: masked.stats.checked,
        masked: masked.stats.masked,
        withheld: masked.withheld,
        read: masked.read,
        redacted: masked.redacted,
      });
      const sent = JSON.stringify(masked.body);
      options.onSentBody?.(host, path, sent);
      forward(host, request, response, Buffer.from(sent, "utf8"), true);
    } catch (cause) {
      refuse(describeMaskingFailure(cause));
    }
  };

  const inner = NodeHttp.createServer((request, response) => {
    void handleInspected(request, response);
  });
  // A WebSocket to a model host would carry requests the gateway has not rewritten.
  inner.on("upgrade", (request, socket) => {
    const host = hostBySocket.get(request.socket) ?? "";
    record({
      host,
      path: request.url ?? "/",
      outcome: "blocked",
      reason: "WebSocket connections to model hosts are not inspected yet.",
    });
    socket.end("HTTP/1.1 426 Upgrade Required\r\nconnection: close\r\ncontent-length: 0\r\n\r\n");
  });
  inner.on("clientError", (_error, socket) => socket.destroy());

  const outer = NodeHttp.createServer((request, response) => {
    // Plain HTTP through the proxy. Model providers do not accept it; pass it on unchanged.
    let url: URL;
    try {
      url = new URL(request.url ?? "");
    } catch {
      response.writeHead(400).end();
      return;
    }
    const upstream = NodeHttp.request(
      {
        host: url.hostname,
        port: url.port || 80,
        method: request.method,
        path: `${url.pathname}${url.search}`,
        headers: request.headers,
      },
      (reply) => {
        response.writeHead(reply.statusCode ?? 502, reply.headers);
        reply.pipe(response);
      },
    );
    upstream.on("error", () => {
      if (!response.headersSent) response.writeHead(502);
      response.end();
    });
    request.pipe(upstream);
  });

  outer.on("connect", (request, clientSocket: NodeStream.Duplex, head: Buffer) => {
    track(clientSocket);
    const [host = "", portText = "443"] = (request.url ?? "").split(":");
    const port = Number(portText) || 443;
    clientSocket.on("error", () => clientSocket.destroy());

    if (options.masking?.() !== false && hostMatches(host, blockedHosts)) {
      record({
        host,
        path: "/",
        outcome: "blocked",
        reason: "This provider's traffic cannot be masked, so DoeDesk does not let it through.",
      });
      clientSocket.end("HTTP/1.1 403 Forbidden\r\nconnection: close\r\ncontent-length: 0\r\n\r\n");
      return;
    }

    if (!hostMatches(host, inspectedHosts)) {
      const upstream = NodeNet.connect(port, host, () => {
        clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        if (head.length > 0) upstream.write(head);
        upstream.pipe(clientSocket);
        clientSocket.pipe(upstream);
      });
      track(upstream);
      upstream.on("error", () => clientSocket.destroy());
      clientSocket.on("close", () => upstream.destroy());
      return;
    }

    clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    if (head.length > 0) clientSocket.unshift(head);
    const secure = new NodeTls.TLSSocket(clientSocket, {
      isServer: true,
      secureContext: options.authority.contextFor(host),
      // HTTP/1.1 only: every model client falls back to it, and it keeps rewriting simple.
      ALPNProtocols: ["http/1.1"],
    });
    secure.on("error", () => secure.destroy());
    hostBySocket.set(secure, host);
    inner.emit("connection", secure);
  });
  outer.on("clientError", (_error, socket) => socket.destroy());

  return new Promise((resolve, reject) => {
    outer.once("error", reject);
    outer.listen(0, "127.0.0.1", () => {
      const address = outer.address();
      if (address === null || typeof address === "string") {
        reject(new Error("The privacy gateway could not open a local port."));
        return;
      }
      resolve({
        port: address.port,
        close: () =>
          new Promise((done) => {
            for (const socket of sockets) socket.destroy();
            inner.close();
            outer.close(() => done());
            outer.closeAllConnections();
          }),
      });
    });
  });
};
