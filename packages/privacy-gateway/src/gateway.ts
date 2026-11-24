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
import type { Restorations } from "./restorations.ts";
import {
  type AttachmentHandling,
  maskRequestBody,
  replaceKnownValues,
  type WireFormat,
  wireFormatForPath,
} from "./requestMasking.ts";
import { SseUnmasker, unmaskDeep } from "./responseUnmasking.ts";
import { appsBodyIsPlain, type Route, routeFor } from "./routes.ts";
import { sessionsNamedIn } from "./turns.ts";
import { connectThrough, plainProxyHeaders, ProxyError, tunnelThrough } from "./upstream.ts";

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
  // Grok Build with a grok.com sign-in sends here, not to api.x.ai (read in its program text).
  "cli-chat-proxy.grok.com",
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

/**
 * What happens to traffic for hosts that are not model hosts. The gateway restores real values
 * in what the model writes, so a command the model runs can carry them to any host it can reach.
 * `open`: every host passes, unread. `allowlist`: only listed hosts pass. `closed`: none do.
 * Model hosts are inspected and masked whatever this says.
 */
export type EgressPolicy = "open" | "allowlist" | "closed";

export interface EgressRules {
  readonly policy: EgressPolicy;
  /** Hosts that pass under `allowlist`. Subdomains are included. */
  readonly hosts: ReadonlyArray<string>;
  /** Hosts the person let through until the app closes. They pass under `closed` too. */
  readonly untilClose?: ReadonlyArray<string>;
}

/**
 * Hosts the agent tools themselves need to sign in and stay signed in. They pass under
 * `allowlist` and `closed`, or the tool could not start at all.
 */
export const SIGN_IN_HOSTS: ReadonlyArray<string> = [
  "console.anthropic.com",
  "platform.claude.com",
  "claude.ai",
  "auth.openai.com",
  "oauth2.googleapis.com",
  "accounts.google.com",
];

/**
 * An entry the app words itself, in the reader's language. `websocketToMaskedRoute`: a WebSocket
 * was refused to an address whose HTTPS requests are masked, so the refusal cost the tool
 * nothing but a retry.
 */
export type GatewayNotice =
  | "websocketToMaskedRoute"
  /** A request with a body on a path the gateway has no rule for: not sent. */
  | "unknownRequest"
  /** A call to an app the AI company hosts: not sent. */
  | "appCall"
  /** The person's proxy asked for a name and password, or would not carry the connection. */
  | "proxySignIn"
  | "proxyRefused";

export interface GatewayRecord {
  readonly at: string;
  readonly host: string;
  readonly path: string;
  /** The request's method. Absent for a connection that was refused before any request. */
  readonly method?: string;
  readonly outcome: "masked" | "passed" | "refused" | "blocked";
  /** What kind of request to an AI host it was, when it was not a model request. */
  readonly route?: Exclude<Route["kind"], "masked">;
  /** What happened, for an app that words it itself. `reason` says the same in English. */
  readonly notice?: GatewayNotice;
  readonly format?: WireFormat;
  /** Texts checked for personal data in this request. */
  readonly checked?: number;
  /** Values replaced with placeholders in this request. */
  readonly masked?: number;
  /** The distinct stand-ins those replacements wrote. */
  readonly replaced?: ReadonlyArray<string>;
  /** The names the provider's program gives the chat this request belongs to. See `turns.ts`. */
  readonly sessions?: ReadonlyArray<string>;
  /** Images and files removed because they could not be checked. */
  readonly withheld?: number;
  /** Images and files replaced by the text read from them. */
  readonly read?: number;
  /** Images sent with their personal data covered. */
  readonly redacted?: number;
  /** Texts replaced by a note because they held sealed document text. */
  readonly sealed?: number;
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
   * Told the stand-ins restored in a reply, once it has ended, with the chat its request named.
   * A reply can use a stand-in no request of the turn wrote: one the model has from earlier.
   */
  readonly onRestored?: (restored: {
    readonly sessions?: ReadonlyArray<string>;
    readonly tokens: ReadonlyArray<string>;
  }) => void;
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
   * Measurement only (`scripts/routes-seen.ts`): the body of a request with no rule, which was
   * not sent, so that a person can read what it carries before writing its rule.
   */
  readonly onUnsentBody?: (host: string, path: string, body: string) => void;
  /**
   * Evaluation only. While this returns true, a masked request has its images and files replaced
   * by the text read from them and nothing else: no value becomes a placeholder.
   */
  readonly attachmentsOnly?: () => boolean;
  /** Remembers assistant text in which sealed values were restored. See `Restorations`. */
  readonly restorations?: Restorations;
  /** Which other hosts may be reached. Looked up per connection. Without it every host passes. */
  readonly egress?: () => EgressRules;
  /** See `MaskRequestOptions.webResults`. Looked up per request. */
  readonly webResults?: () => "known" | "detect";
  /** See `MaskRequestOptions.withholdSealedText`. Looked up per request. */
  readonly withholdSealedText?: (text: string, typed: boolean) => string | undefined;
  /**
   * Evaluation only: told of every connection to a host that is not a model host, and whether
   * it was let through.
   */
  readonly onOtherHost?: (host: string, port: number, outcome: "passed" | "blocked") => void;
  /**
   * The person's own proxy for a host, or undefined to connect to it directly. The gateway sits
   * where their proxy was, so it sends through theirs. See `readHostNetwork`.
   */
  readonly upstreamProxy?: (host: string, port: number, secure: boolean) => URL | undefined;
  /** Certificates the person trusts beyond the public roots, for the gateway's own connections. */
  readonly upstreamCertificates?: ReadonlyArray<string>;
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

const proxyNotice = (cause: unknown): GatewayNotice =>
  cause instanceof ProxyError && cause.kind === "signIn" ? "proxySignIn" : "proxyRefused";

/** A path as a person is shown it: no query, which can hold identifiers, and no great length. */
const shownPath = (path: string): string => (path.split("?")[0] ?? path).slice(0, 120);

/** An error in the shape model clients already know how to show. 400 is not retried. */
/**
 * What a program is answered for a request DoeDesk did not send. The program wraps the words in
 * its own and adds to them (an address, an id), so they close with a fixed sentence: the app
 * shows what stands between the two (`makeProviderFailure` in provider-core).
 */
const notSentBody = (reason: string): string =>
  refusalBody(
    `DoeDesk did not send this request. ${reason.trim().replace(/([^.!?])$/u, "$1.")} Nothing of it was sent.`,
  );

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
  /** Whether a host that is not a model host may be reached now. */
  const mayReach = (host: string): boolean => {
    if (options.masking?.() === false) return true;
    const rules = options.egress?.();
    if (rules === undefined || rules.policy === "open") return true;
    if (hostMatches(host, SIGN_IN_HOSTS) || hostMatches(host, rules.untilClose ?? [])) return true;
    return rules.policy === "allowlist" && hostMatches(host, rules.hosts);
  };
  const EGRESS_REASON =
    "This host is not on the list of hosts agents may reach. Add it in Settings, under Privacy, if it should be.";
  const trusted =
    options.upstreamCertificates === undefined || options.upstreamCertificates.length === 0
      ? undefined
      : [...NodeTls.rootCertificates, ...options.upstreamCertificates];
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
    /** The chat the request named, for telling what its reply restored. */
    sessions: ReadonlyArray<string> | undefined,
    /** The way through the person's proxy, already open. Undefined: straight to the host. */
    connection: NodeStream.Duplex | undefined,
  ) => {
    const restoredTokens = new Set<string>();
    const tellRestored = () => {
      if (restoredTokens.size === 0) return;
      options.onRestored?.({
        ...(sessions === undefined || sessions.length === 0 ? {} : { sessions }),
        tokens: [...restoredTokens],
      });
    };
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

    // A request given its connection must be given no agent: with `agent: false` Node makes an
    // agent of its own, which ignores `createConnection` and connects straight to the host.
    const upstream = (connection === undefined && target.tls ? NodeHttps : NodeHttp).request(
      {
        ...(connection === undefined
          ? {
              host: target.host,
              port: target.port,
              servername: host,
              ...(trusted ? { ca: trusted } : {}),
            }
          : { createConnection: () => connection }),
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
          const stream = new SseUnmasker(
            options.pseudonymizer.vault,
            options.restorations,
            restoredTokens,
          );
          reply.on("data", (chunk: Buffer) => {
            const text = stream.push(chunk);
            if (text.length > 0) response.write(text);
          });
          reply.on("end", () => {
            response.end(stream.end());
            tellRestored();
          });
          reply.on("error", () => response.destroy());
          return;
        }
        if (readable && contentType.includes("json")) {
          void readBody(reply).then(
            (raw) => {
              let text = raw.toString("utf8");
              try {
                text = JSON.stringify(
                  unmaskDeep(
                    JSON.parse(text),
                    options.pseudonymizer.vault,
                    options.restorations,
                    true,
                    restoredTokens,
                  ),
                );
              } catch {
                // Not JSON after all: pass it on as it came.
              }
              tellRestored();
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
      connection?.destroy();
      if (response.headersSent) {
        response.destroy();
        return;
      }
      response.writeHead(502, { "content-type": "application/json" });
      response.end(refusalBody(`DoeDesk could not reach ${host}: ${cause.message}`));
    });
    // One request to a tunnel: it is closed with the reply, never left open and idle.
    upstream.on("close", () => connection?.destroy());
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
    const method = request.method ?? "GET";
    const hasBody =
      Number(request.headers["content-length"] ?? 0) > 0 ||
      request.headers["transfer-encoding"] !== undefined;
    /**
     * Opens the way to the host: through the person's proxy when one applies, and then through
     * nothing else. Null when the proxy would not carry it: the program is answered, the
     * failure recorded, and nothing is sent.
     */
    const open = async (
      about: Partial<GatewayRecord> = {},
    ): Promise<NodeStream.Duplex | undefined | null> => {
      const target = upstreamFor(host);
      const proxy = options.upstreamProxy?.(target.host, target.port, target.tls);
      if (proxy === undefined) return undefined;
      try {
        const connection = await connectThrough(
          proxy,
          { host: target.host, port: target.port, secure: target.tls },
          { servername: host, ca: trusted },
        );
        track(connection);
        return connection;
      } catch (cause) {
        const reason = cause instanceof Error ? cause.message : String(cause);
        record({
          host,
          path,
          method,
          outcome: "refused",
          ...about,
          notice: proxyNotice(cause),
          reason,
        });
        request.resume();
        // 400, as for every request DoeDesk refuses: a program asks again after a 502.
        response.writeHead(400, { "content-type": "application/json" });
        response.end(notSentBody(reason));
        return null;
      }
    };
    /** Forwards a request the gateway does not rewrite, showing its body to the listener. */
    const pass = async (connection: NodeStream.Duplex | undefined) => {
      if (options.onSentBody === undefined || !hasBody) {
        forward(host, request, response, undefined, false, undefined, connection);
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
      forward(host, request, response, raw, false, undefined, connection);
    };
    if (options.masking?.() === false) {
      const known = hasBody ? wireFormatForPath(path) : undefined;
      const connection = await open();
      if (connection === null) return;
      record({ host, path, method, outcome: "passed", ...(known ? { format: known } : {}) });
      await pass(connection);
      return;
    }
    const route = routeFor(host, path, hasBody);
    if (route.kind === "plain") {
      const connection = await open({ route: "plain" });
      if (connection === null) return;
      record({ host, path, method, outcome: "passed", route: "plain" });
      await pass(connection);
      return;
    }
    /** Answers the program itself. What it sent is read to the end and dropped. */
    const notSent = (notice: GatewayNotice, reason: string) => {
      const kind = route.kind === "masked" ? {} : { route: route.kind };
      record({ host, path, method, outcome: "refused", ...kind, notice, reason });
      if (options.onUnsentBody !== undefined && !request.readableEnded) {
        const show = options.onUnsentBody;
        const encoding = request.headers["content-encoding"];
        void readBody(request).then(
          (raw) => {
            try {
              show(host, path, decodeBody(raw, encoding).toString("utf8"));
            } catch {
              show(host, path, "");
            }
          },
          () => undefined,
        );
      } else {
        request.resume();
      }
      response.writeHead(400, { "content-type": "application/json" });
      response.end(notSentBody(reason));
    };
    if (route.kind === "unknown") {
      notSent(
        "unknownRequest",
        `${method} ${host}${shownPath(path)} is a kind of request DoeDesk has no rule for, so it could not check it for personal data. Settings, Privacy, Recent requests lists it.`,
      );
      return;
    }
    if (route.kind !== "masked") {
      let raw: Buffer;
      try {
        raw = decodeBody(await readBody(request), request.headers["content-encoding"]);
      } catch (cause) {
        notSent("unknownRequest", `The request could not be read (${String(cause)}).`);
        return;
      }
      let sent = raw;
      let replaced = 0;
      try {
        const body: unknown = JSON.parse(raw.toString("utf8"));
        if (route.kind === "apps" && !appsBodyIsPlain(body)) {
          notSent(
            "appCall",
            "A call to an app that the AI company hosts would carry what the agent wrote, with the real values, to that company.",
          );
          return;
        }
        if (route.kind === "report") {
          replaced = replaceKnownValues(body, options.pseudonymizer.vault);
          if (replaced > 0) sent = Buffer.from(JSON.stringify(body), "utf8");
        }
      } catch {
        // A report that is not JSON is sent as written. An app call that is not JSON is not one.
        if (route.kind === "apps") {
          notSent("unknownRequest", "The request to the app server could not be read.");
          return;
        }
      }
      const connection = await open({ route: route.kind });
      if (connection === null) return;
      record({
        host,
        path,
        method,
        outcome: "passed",
        route: route.kind,
        ...(replaced > 0 ? { masked: replaced } : {}),
      });
      options.onSentBody?.(host, path, sent.toString("utf8"));
      forward(host, request, response, sent, false, undefined, connection);
      return;
    }
    const { format } = route;

    let sessions: ReadonlyArray<string> = [];
    const named = () => (sessions.length === 0 ? {} : { sessions });
    const refuse = (reason: string) => {
      record({ host, path, method, outcome: "refused", format, reason, ...named() });
      response.writeHead(400, { "content-type": "application/json" });
      response.end(notSentBody(reason));
    };

    let parsed: unknown;
    try {
      const raw = decodeBody(await readBody(request), request.headers["content-encoding"]);
      parsed = JSON.parse(raw.toString("utf8"));
    } catch (cause) {
      refuse(`The request could not be read to check it for personal data (${String(cause)}).`);
      return;
    }
    sessions = sessionsNamedIn(request.headers, parsed);
    try {
      const attachmentsOnly = options.attachmentsOnly?.() === true;
      const masked = await maskRequestBody(
        format,
        parsed,
        options.pseudonymizer,
        options.reader?.(),
        {
          attachmentsOnly,
          attachments: options.attachments?.(),
          withholdSealedText: options.withholdSealedText,
          remask: (text: string) => options.restorations?.masked(text),
          webResults: options.webResults?.(),
        },
      );
      const connection = await open({ format, ...named() });
      if (connection === null) return;
      record({
        host,
        path,
        method,
        outcome: "masked",
        format,
        checked: masked.stats.checked,
        masked: masked.stats.masked,
        replaced: masked.stats.replaced,
        ...named(),
        withheld: masked.withheld,
        read: masked.read,
        redacted: masked.redacted,
        ...(masked.sealed > 0 ? { sealed: masked.sealed } : {}),
      });
      const sent = JSON.stringify(masked.body);
      options.onSentBody?.(host, path, sent);
      forward(host, request, response, Buffer.from(sent, "utf8"), true, sessions, connection);
    } catch (cause) {
      refuse(describeMaskingFailure(cause));
    }
  };

  const inner = NodeHttp.createServer((request, response) => {
    void handleInspected(request, response);
  });
  // A WebSocket to a model host would carry requests the gateway has not rewritten: every one is
  // refused, masking on or off. A tool that then posts to the same address (Codex does) is
  // masked there when the address is one the gateway rewrites and masking is on.
  inner.on("upgrade", (request, socket) => {
    const host = hostBySocket.get(request.socket) ?? "";
    const path = request.url ?? "/";
    const maskedOverHttps = options.masking?.() !== false && wireFormatForPath(path) !== undefined;
    record({
      host,
      path,
      outcome: "blocked",
      ...(maskedOverHttps
        ? {
            notice: "websocketToMaskedRoute",
            reason:
              "The AI tool asked for a WebSocket connection, which DoeDesk cannot mask, so DoeDesk refused it and nothing was sent on it. The tool then sends its requests over HTTPS, and DoeDesk masks them. Nothing needs fixing.",
          }
        : {
            reason:
              "DoeDesk refused a WebSocket connection to this AI host: it cannot mask what such a connection carries. Nothing was sent on it.",
          }),
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
    const allowed = mayReach(url.hostname);
    options.onOtherHost?.(url.hostname, Number(url.port) || 80, allowed ? "passed" : "blocked");
    if (!allowed) {
      record({ host: url.hostname, path: "/", outcome: "blocked", reason: EGRESS_REASON });
      response.writeHead(403, { "content-type": "text/plain" }).end(`DoeDesk: ${EGRESS_REASON}\n`);
      return;
    }
    const port = Number(url.port) || 80;
    const proxy = options.upstreamProxy?.(url.hostname, port, false);
    const upstream = NodeHttp.request(
      proxy === undefined
        ? {
            host: url.hostname,
            port,
            method: request.method,
            path: `${url.pathname}${url.search}`,
            headers: request.headers,
          }
        : {
            // The person's proxy takes the whole address, as this gateway was given it.
            host: proxy.hostname,
            port: proxy.port || 80,
            method: request.method,
            path: url.href,
            headers: { ...request.headers, ...plainProxyHeaders(proxy) },
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
      const allowed = mayReach(host);
      options.onOtherHost?.(host, port, allowed ? "passed" : "blocked");
      if (!allowed) {
        record({ host, path: "/", outcome: "blocked", reason: EGRESS_REASON });
        clientSocket.end(
          "HTTP/1.1 403 Forbidden\r\nconnection: close\r\ncontent-length: 0\r\n\r\n",
        );
        return;
      }
      const join = (upstream: NodeNet.Socket) => {
        clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        if (head.length > 0) upstream.write(head);
        upstream.pipe(clientSocket);
        clientSocket.pipe(upstream);
      };
      const watch = (upstream: NodeNet.Socket) => {
        track(upstream);
        upstream.on("error", () => clientSocket.destroy());
        clientSocket.on("close", () => upstream.destroy());
      };
      const proxy = options.upstreamProxy?.(host, port, true);
      if (proxy === undefined) {
        const upstream = NodeNet.connect(port, host, () => join(upstream));
        watch(upstream);
        return;
      }
      tunnelThrough(proxy, host, port).then(
        (upstream) => {
          watch(upstream);
          if (clientSocket.destroyed) upstream.destroy();
          else join(upstream);
        },
        (cause: unknown) => {
          const reason = cause instanceof Error ? cause.message : String(cause);
          record({ host, path: "/", outcome: "blocked", notice: proxyNotice(cause), reason });
          clientSocket.end(
            "HTTP/1.1 502 Bad Gateway\r\nconnection: close\r\ncontent-length: 0\r\n\r\n",
          );
        },
      );
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
