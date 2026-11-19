import * as NodeCrypto from "node:crypto";
import * as NodeHttp from "node:http";
import * as NodeHttps from "node:https";
import * as NodeNet from "node:net";
import type * as NodeStream from "node:stream";
import * as NodeTls from "node:tls";
import * as NodeZlib from "node:zlib";

import type { LocalAuthority } from "./certificates.ts";

/**
 * A recorder for tests and measurements. It sits where a corporate TLS-inspecting proxy sits and
 * writes down what a program sent, then forwards the same bytes. It never changes a request or a
 * reply, and DoeDesk never starts it for a user: only the conformance suite and the measurement
 * scripts do.
 */
export interface ObservedExchange {
  readonly at: string;
  readonly host: string;
  readonly method: string;
  readonly path: string;
  /** Header names and values as received, with credentials replaced by their length. */
  readonly headers: Readonly<Record<string, string>>;
  /** The body after undoing its content encoding. Empty for requests without one. */
  readonly body: string;
  /** SHA-256 of the body bytes received from the program. */
  readonly receivedSha256: string;
  /** SHA-256 of the body bytes sent on to the provider. Always equal to `receivedSha256`. */
  readonly forwardedSha256: string;
  readonly status: number | undefined;
}

/**
 * Reads the messages a program sends on a WebSocket, from a copy of the bytes. Text frames only;
 * a compressed connection (permessage-deflate) is inflated with its shared window.
 */
class WebSocketReader {
  #buffer = Buffer.alloc(0);
  #fragments: Array<Buffer> = [];
  #compressedMessage = false;
  #inflate: NodeZlib.InflateRaw | undefined;
  #inflated: Array<Buffer> = [];
  readonly #onMessage: (text: string) => void;

  constructor(onMessage: (text: string) => void) {
    this.#onMessage = onMessage;
  }

  enableCompression(): void {
    this.#inflate = NodeZlib.createInflateRaw();
    this.#inflate.on("data", (chunk: Buffer) => this.#inflated.push(chunk));
    this.#inflate.on("error", () => {
      this.#inflate = undefined;
    });
  }

  push(chunk: Buffer): void {
    this.#buffer = Buffer.concat([this.#buffer, chunk]);
    for (;;) {
      if (this.#buffer.length < 2) return;
      const first = this.#buffer[0] ?? 0;
      const second = this.#buffer[1] ?? 0;
      let length = second & 0x7f;
      let offset = 2;
      if (length === 126) {
        if (this.#buffer.length < 4) return;
        length = this.#buffer.readUInt16BE(2);
        offset = 4;
      } else if (length === 127) {
        if (this.#buffer.length < 10) return;
        length = Number(this.#buffer.readBigUInt64BE(2));
        offset = 10;
      }
      const masked = (second & 0x80) !== 0;
      const maskOffset = offset;
      if (masked) offset += 4;
      if (this.#buffer.length < offset + length) return;
      const payload = Buffer.from(this.#buffer.subarray(offset, offset + length));
      if (masked) {
        for (let index = 0; index < payload.length; index += 1) {
          payload[index] = (payload[index] ?? 0) ^ (this.#buffer[maskOffset + (index % 4)] ?? 0);
        }
      }
      this.#buffer = this.#buffer.subarray(offset + length);
      const opcode = first & 0x0f;
      if (opcode >= 0x8) continue;
      if (opcode !== 0) {
        this.#fragments = [];
        this.#compressedMessage = (first & 0x40) !== 0;
      }
      this.#fragments.push(payload);
      if ((first & 0x80) !== 0) this.#finish(Buffer.concat(this.#fragments));
    }
  }

  #finish(message: Buffer): void {
    const inflate = this.#inflate;
    if (!this.#compressedMessage || inflate === undefined) {
      this.#onMessage(message.toString("utf8"));
      return;
    }
    inflate.write(message);
    inflate.write(Buffer.from([0x00, 0x00, 0xff, 0xff]));
    inflate.flush(NodeZlib.constants.Z_SYNC_FLUSH, () => {
      const text = Buffer.concat(this.#inflated).toString("utf8");
      this.#inflated = [];
      this.#onMessage(text);
    });
  }
}

export interface ObserverOptions {
  readonly authority: LocalAuthority;
  /** Hosts whose requests are opened and recorded. Subdomains are included. */
  readonly inspectHosts: ReadonlyArray<string>;
  readonly onExchange?: (exchange: ObservedExchange) => void;
  /** Where opened requests are sent. Tests point this at a local server. */
  readonly upstream?: (host: string) => {
    readonly host: string;
    readonly port: number;
    readonly tls: boolean;
  };
}

export interface RunningObserver {
  readonly port: number;
  /** Every host a program asked to reach, in order, opened or not. */
  readonly connects: ReadonlyArray<string>;
  readonly exchanges: ReadonlyArray<ObservedExchange>;
  /** Proxy and certificate variables that route a program through the recorder. */
  readonly environment: Readonly<Record<string, string>>;
  readonly close: () => Promise<void>;
}

const SECRET_HEADERS = new Set(["authorization", "x-api-key", "cookie", "proxy-authorization"]);

const hostMatches = (host: string, list: ReadonlyArray<string>): boolean =>
  list.some((entry) => host === entry || host.endsWith(`.${entry}`));

const sha256 = (bytes: Buffer): string =>
  NodeCrypto.createHash("sha256").update(bytes).digest("hex");

const decode = (body: Buffer, encoding: string | undefined): string => {
  try {
    switch ((encoding ?? "identity").trim().toLowerCase()) {
      case "gzip":
      case "x-gzip":
        return NodeZlib.gunzipSync(body).toString("utf8");
      case "deflate":
        return NodeZlib.inflateSync(body).toString("utf8");
      case "br":
        return NodeZlib.brotliDecompressSync(body).toString("utf8");
      case "zstd":
        return NodeZlib.zstdDecompressSync(body).toString("utf8");
      default:
        return body.toString("utf8");
    }
  } catch {
    return "";
  }
};

export const startObserver = (options: ObserverOptions): Promise<RunningObserver> => {
  const connects: Array<string> = [];
  const exchanges: Array<ObservedExchange> = [];
  const hostBySocket = new WeakMap<NodeStream.Duplex, string>();
  const sockets = new Set<NodeStream.Duplex>();
  const track = (socket: NodeStream.Duplex) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  };
  const upstreamFor =
    options.upstream ?? ((host: string) => ({ host, port: 443, tls: true as boolean }));

  const inner = NodeHttp.createServer((request, response) => {
    const host = hostBySocket.get(request.socket) ?? String(request.headers.host ?? "");
    const chunks: Array<Buffer> = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("error", () => response.destroy());
    request.on("end", () => {
      const received = Buffer.concat(chunks);
      const target = upstreamFor(host);
      const transport = target.tls ? NodeHttps : NodeHttp;
      // Raw header pairs keep the names' spelling and order as the program wrote them.
      const forwarded = transport.request(
        {
          host: target.host,
          port: target.port,
          servername: host,
          method: request.method,
          path: request.url,
          headers: request.rawHeaders,
        },
        (reply) => {
          const headers: Record<string, string> = {};
          for (const [name, value] of Object.entries(request.headers)) {
            if (value === undefined) continue;
            const text = Array.isArray(value) ? value.join(", ") : value;
            headers[name] = SECRET_HEADERS.has(name) ? `<${text.length} characters>` : text;
          }
          const exchange: ObservedExchange = {
            at: new Date().toISOString(),
            host,
            method: request.method ?? "",
            path: request.url ?? "/",
            headers,
            body: decode(received, request.headers["content-encoding"]),
            receivedSha256: sha256(received),
            forwardedSha256: sha256(received),
            status: reply.statusCode,
          };
          exchanges.push(exchange);
          options.onExchange?.(exchange);
          response.writeHead(reply.statusCode ?? 502, reply.rawHeaders);
          reply.pipe(response);
        },
      );
      forwarded.on("error", () => response.destroy());
      response.on("close", () => {
        if (!response.writableFinished) forwarded.destroy();
      });
      forwarded.end(received);
    });
  });
  inner.on("clientError", (_error, socket) => socket.destroy());
  // A WebSocket is passed through as bytes: the recorder notes that it happened and no more.
  inner.on("upgrade", (request, socket, head) => {
    const host = hostBySocket.get(request.socket) ?? "";
    const target = upstreamFor(host);
    const note = (method: string, body: string) => {
      const exchange: ObservedExchange = {
        at: new Date().toISOString(),
        host,
        method,
        path: request.url ?? "/",
        headers: {},
        body,
        receivedSha256: "",
        forwardedSha256: "",
        status: undefined,
      };
      exchanges.push(exchange);
      options.onExchange?.(exchange);
    };
    note("UPGRADE", "");
    const reader = new WebSocketReader((text) => note("WS-SEND", text));
    let handshake = "";
    const connected = () => {
      const lines = [`${request.method} ${request.url} HTTP/1.1`];
      for (let index = 0; index < request.rawHeaders.length; index += 2) {
        lines.push(`${request.rawHeaders[index]}: ${request.rawHeaders[index + 1]}`);
      }
      upstream.write(`${lines.join("\r\n")}\r\n\r\n`);
      if (head.length > 0) upstream.write(head);
      // Listeners copy the bytes; the pipes below carry the originals unchanged.
      upstream.on("data", (chunk: Buffer) => {
        if (handshake.includes("\r\n\r\n")) return;
        handshake += chunk.toString("latin1");
        if (/sec-websocket-extensions:[^\r\n]*permessage-deflate/i.test(handshake)) {
          reader.enableCompression();
        }
      });
      socket.on("data", (chunk: Buffer) => reader.push(chunk));
      upstream.pipe(socket);
      socket.pipe(upstream);
    };
    const upstream: NodeStream.Duplex = target.tls
      ? NodeTls.connect({ host: target.host, port: target.port, servername: host }, connected)
      : NodeNet.connect(target.port, target.host, connected);
    track(upstream);
    upstream.on("error", () => socket.destroy());
    socket.on("error", () => upstream.destroy());
    socket.on("close", () => upstream.destroy());
  });

  const outer = NodeHttp.createServer((_request, response) => {
    response.writeHead(400).end();
  });
  outer.on("connect", (request, clientSocket: NodeStream.Duplex, head: Buffer) => {
    track(clientSocket);
    const [host = "", portText = "443"] = (request.url ?? "").split(":");
    connects.push(host);
    clientSocket.on("error", () => clientSocket.destroy());
    if (!hostMatches(host, options.inspectHosts)) {
      const upstream = NodeNet.connect(Number(portText) || 443, host, () => {
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
        reject(new Error("The recorder could not open a local port."));
        return;
      }
      const proxy = `http://127.0.0.1:${address.port}`;
      resolve({
        port: address.port,
        connects,
        exchanges,
        environment: {
          HTTPS_PROXY: proxy,
          https_proxy: proxy,
          NODE_EXTRA_CA_CERTS: options.authority.certificatePath,
          SSL_CERT_FILE: options.authority.bundlePath,
          CODEX_CA_CERTIFICATE: options.authority.bundlePath,
        },
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
