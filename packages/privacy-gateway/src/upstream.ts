import * as NodeFS from "node:fs";
import * as NodeHttp from "node:http";
import type * as NodeNet from "node:net";
import type * as NodeStream from "node:stream";
import * as NodeTls from "node:tls";

/*
 * The gateway puts itself where the person's own proxy and certificate bundle were: an agent's
 * process gets the gateway's address and the gateway's bundle. What the person had configured is
 * read here, from the environment DoeDesk itself was started with, so that the gateway sends
 * through their proxy and trusts what they trust.
 */

/** The person's own network settings, as the gateway uses them. */
export interface HostNetwork {
  /**
   * The proxy to reach `host` through, or undefined to connect directly: none is configured, or
   * the person exempted the host with `NO_PROXY`.
   */
  readonly proxyFor: (host: string, port: number, secure: boolean) => URL | undefined;
  /** Certificates the person trusts beyond the public roots, as PEM blocks. */
  readonly certificates: ReadonlyArray<string>;
  /** The certificates of their `NODE_EXTRA_CA_CERTS`, which Node adds to its defaults. */
  readonly nodeExtraCertificates: ReadonlyArray<string>;
}

const PEM_BLOCK = /-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g;
const pemKey = (block: string): string => block.replace(/\s+/g, "");

const readCertificates = (path: string | undefined): ReadonlyArray<string> => {
  if (path === undefined || path.trim() === "") return [];
  try {
    return NodeFS.readFileSync(path, "utf8").match(PEM_BLOCK) ?? [];
  } catch {
    // A bundle that is not there is one the person's tools could not read either.
    return [];
  }
};

/** A proxy the gateway can tunnel through. SOCKS and other schemes are not chained. */
const readProxy = (value: string | undefined): URL | undefined => {
  if (value === undefined || value.trim() === "") return undefined;
  try {
    const url = new URL(value.includes("://") ? value.trim() : `http://${value.trim()}`);
    return url.protocol === "http:" || url.protocol === "https:" ? url : undefined;
  } catch {
    return undefined;
  }
};

/** `NO_PROXY` as curl reads it: `*`, a host, a domain with or without a leading dot, `host:port`. */
const exemptions = (value: string | undefined) => {
  const entries = (value ?? "")
    .split(/[\s,]+/)
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry.length > 0);
  return (host: string, port: number): boolean =>
    entries.some((entry) => {
      if (entry === "*") return true;
      const [name = "", entryPort] = entry.startsWith("[") ? [entry] : entry.split(":");
      if (entryPort !== undefined && Number(entryPort) !== port) return false;
      const domain = name.replace(/^\*?\./, "");
      return host === domain || host.endsWith(`.${domain}`);
    });
};

const LOOPBACK = /^(?:localhost|127(?:\.\d{1,3}){3}|\[?::1\]?)$/i;

/** Reads the proxy and certificate variables of the environment DoeDesk was started with. */
export const readHostNetwork = (environment: NodeJS.ProcessEnv): HostNetwork => {
  const pick = (...names: ReadonlyArray<string>) =>
    names.map((name) => environment[name]).find((value) => value !== undefined && value !== "");
  const secureProxy = readProxy(pick("HTTPS_PROXY", "https_proxy", "ALL_PROXY", "all_proxy"));
  const plainProxy = readProxy(pick("HTTP_PROXY", "http_proxy", "ALL_PROXY", "all_proxy"));
  const exempt = exemptions(pick("NO_PROXY", "no_proxy"));

  const publicRoots = new Set(NodeTls.rootCertificates.map(pemKey));
  const seen = new Set<string>();
  const beyondPublicRoots = (blocks: ReadonlyArray<string>) =>
    blocks.filter((block) => {
      const key = pemKey(block);
      if (publicRoots.has(key) || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  const nodeExtraCertificates = readCertificates(environment.NODE_EXTRA_CA_CERTS);
  const certificates = beyondPublicRoots([
    ...nodeExtraCertificates,
    ...readCertificates(environment.SSL_CERT_FILE),
    ...readCertificates(environment.REQUESTS_CA_BUNDLE),
    ...readCertificates(environment.CURL_CA_BUNDLE),
  ]);

  return {
    proxyFor: (host, port, secure) => {
      const proxy = secure ? secureProxy : plainProxy;
      // This computer's own address is not behind any proxy, whatever `NO_PROXY` leaves out.
      if (proxy === undefined || LOOPBACK.test(host)) return undefined;
      return exempt(host.toLowerCase(), port) ? undefined : proxy;
    },
    certificates,
    nodeExtraCertificates,
  };
};

const proxyAuthorization = (proxy: URL): Readonly<Record<string, string>> =>
  proxy.username === ""
    ? {}
    : {
        "proxy-authorization": `Basic ${Buffer.from(
          `${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`,
        ).toString("base64")}`,
      };

/**
 * The person's proxy would not carry a connection. The message is written for them: it names
 * the proxy and says what it did, and is shown in Recent requests and in the chat.
 */
export class ProxyError extends Error {
  override readonly name = "ProxyError";
  /** `signIn`: it asked for a name and password. `refused`: anything else. */
  readonly kind: "signIn" | "refused";
  constructor(kind: "signIn" | "refused", message: string) {
    super(message);
    this.kind = kind;
  }
}

/** How long a proxy has to open a tunnel. One that says nothing is a failure, not a wait. */
const PROXY_TIMEOUT_MS = 30_000;

const named = (proxy: URL): string => `The proxy this computer is set to use (${proxy.host})`;

/**
 * Opens a tunnel to `host:port` through the person's proxy. Rejects with a `ProxyError` when
 * the proxy refuses, asks for a sign-in, cannot be reached or does not answer in time.
 */
export const tunnelThrough = (
  proxy: URL,
  host: string,
  port: number,
  timeoutMs = PROXY_TIMEOUT_MS,
): Promise<NodeNet.Socket> =>
  new Promise((resolve, reject) => {
    const request = NodeHttp.request({
      host: proxy.hostname,
      port: proxy.port || (proxy.protocol === "https:" ? 443 : 80),
      method: "CONNECT",
      path: `${host}:${port}`,
      headers: { host: `${host}:${port}`, ...proxyAuthorization(proxy) },
      // A proxy reached over TLS: the tunnel request itself is encrypted.
      ...(proxy.protocol === "https:"
        ? {
            createConnection: () =>
              NodeTls.connect({
                host: proxy.hostname,
                port: Number(proxy.port) || 443,
                servername: proxy.hostname,
              }),
          }
        : {}),
    });
    request.setTimeout(timeoutMs, () => {
      request.destroy(
        new ProxyError(
          "refused",
          `${named(proxy)} did not answer within ${Math.round(timeoutMs / 1000)} seconds.`,
        ),
      );
    });
    request.once("error", (cause: Error & { readonly code?: string }) => {
      reject(
        cause instanceof ProxyError
          ? cause
          : new ProxyError(
              "refused",
              `${named(proxy)} could not be reached (${cause.code ?? cause.message}).`,
            ),
      );
    });
    request.once("connect", (response, socket, head) => {
      request.setTimeout(0);
      if (response.statusCode === 407) {
        socket.destroy();
        const given =
          proxy.username === "" ? "DoeDesk was given none" : "it refused the ones given";
        reject(
          new ProxyError(
            "signIn",
            `${named(proxy)} asks for a user name and password, and ${given}. Put them in the proxy address, as in http://name:password@${proxy.host}, and start DoeDesk again.`,
          ),
        );
        return;
      }
      if (response.statusCode !== 200) {
        socket.destroy();
        reject(
          new ProxyError(
            "refused",
            `${named(proxy)} refused the connection to ${host} (it answered ${response.statusCode}).`,
          ),
        );
        return;
      }
      if (head.length > 0) socket.unshift(head);
      resolve(socket);
    });
    request.end();
  });

/**
 * A connection to `host:port` through the person's proxy, ready for a request: the tunnel, and
 * inside it TLS to the host when `secure`. `certificates` are trusted beside the public roots.
 */
export const connectThrough = async (
  proxy: URL,
  target: { readonly host: string; readonly port: number; readonly secure: boolean },
  options: { readonly servername?: string; readonly ca?: ReadonlyArray<string> | undefined } = {},
): Promise<NodeStream.Duplex> => {
  const tunnel = await tunnelThrough(proxy, target.host, target.port);
  if (!target.secure) return tunnel;
  const servername = options.servername ?? target.host;
  return new Promise((resolve, reject) => {
    const secure = NodeTls.connect({
      socket: tunnel,
      servername,
      ...(options.ca === undefined ? {} : { ca: [...options.ca] }),
    });
    // Closing the secure connection closes the tunnel under it: none is left open and idle.
    secure.once("close", () => tunnel.destroy());
    secure.once("secureConnect", () => {
      secure.removeAllListeners("error");
      resolve(secure);
    });
    secure.once("error", (cause: Error & { readonly code?: string }) => {
      tunnel.destroy();
      reject(
        new ProxyError(
          "refused",
          `${named(proxy)} opened a connection to ${servername} that could not be made secure (${cause.code ?? cause.message}).`,
        ),
      );
    });
  });
};

const bodyBytes = (body: unknown): Buffer | undefined => {
  if (body === undefined || body === null) return undefined;
  if (typeof body === "string") return Buffer.from(body, "utf8");
  if (body instanceof ArrayBuffer) return Buffer.from(body);
  if (ArrayBuffer.isView(body)) return Buffer.from(body.buffer, body.byteOffset, body.byteLength);
  throw new TypeError("A request through the proxy takes its body as text or bytes.");
};

/**
 * `fetch` for the gateway's own calls (detection, the reading service, the worker, DoeDesk
 * Cloud): through the person's proxy when one applies to the address, and through nothing else
 * then. Node's own `fetch` does not look at the proxy variables. The reply is read whole.
 */
export const fetchThrough =
  (network: HostNetwork, direct: typeof fetch = fetch): typeof fetch =>
  async (input, init) => {
    const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
    const secure = url.protocol === "https:";
    const port = Number(url.port) || (secure ? 443 : 80);
    const proxy = network.proxyFor(url.hostname, port, secure);
    if (proxy === undefined) return direct(input, init);
    const signal = init?.signal ?? undefined;
    signal?.throwIfAborted();
    const body = bodyBytes(init?.body);
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((value, name) => (headers[name] = value));
    headers.host = url.host;
    headers["accept-encoding"] = "identity";
    if (body !== undefined) headers["content-length"] = String(body.length);
    // Plain HTTP goes to the proxy with the whole address; HTTPS goes inside a tunnel.
    const connection = secure
      ? await connectThrough(
          proxy,
          { host: url.hostname, port, secure },
          { ca: [...NodeTls.rootCertificates, ...network.certificates] },
        )
      : undefined;
    return new Promise<Response>((resolve, reject) => {
      const request = NodeHttp.request(
        connection === undefined
          ? {
              host: proxy.hostname,
              port: proxy.port || 80,
              method: init?.method ?? "GET",
              path: url.href,
              headers: { ...headers, ...proxyAuthorization(proxy) },
            }
          : {
              createConnection: () => connection,
              method: init?.method ?? "GET",
              path: `${url.pathname}${url.search}`,
              headers,
            },
        (reply) => {
          const chunks: Array<Buffer> = [];
          reply.on("data", (chunk: Buffer) => chunks.push(chunk));
          reply.on("error", reject);
          reply.on("end", () => {
            connection?.destroy();
            const status = reply.statusCode ?? 502;
            const replyHeaders = new Headers();
            for (const [name, value] of Object.entries(reply.headers)) {
              if (value !== undefined) replyHeaders.set(name, [value].flat().join(", "));
            }
            // A plain request the proxy itself turned away, not the service behind it.
            if (connection === undefined && status === 407) {
              reject(
                new ProxyError(
                  "signIn",
                  `${named(proxy)} asks for a user name and password. Put them in the proxy address, as in http://name:password@${proxy.host}, and start DoeDesk again.`,
                ),
              );
              return;
            }
            const empty = status === 204 || status === 304 || status < 200;
            resolve(
              new Response(empty ? null : Buffer.concat(chunks), {
                status: status < 200 ? 502 : status,
                statusText: reply.statusMessage ?? "",
                headers: replyHeaders,
              }),
            );
          });
        },
      );
      const abort = () => request.destroy(signal?.reason as Error | undefined);
      signal?.addEventListener("abort", abort, { once: true });
      request.on("close", () => signal?.removeEventListener("abort", abort));
      request.on("error", (cause) => {
        connection?.destroy();
        reject(cause);
      });
      request.end(body);
    });
  };

/** The headers that send a plain HTTP request by way of the person's proxy. */
export const plainProxyHeaders = proxyAuthorization;
