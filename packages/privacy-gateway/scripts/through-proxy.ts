/**
 * Checks, in whatever runtime runs it, that the gateway sends through the person's proxy and
 * through nothing else. The packaged app runs the server in Electron's Node, so run it there
 * too: `ELECTRON_RUN_AS_NODE=1 <Electron binary> scripts/through-proxy.ts`. It starts a proxy
 * that counts, a TLS host only that proxy can reach, and the gateway, and exits 1 on any miss.
 */
import * as NodeFS from "node:fs";
import * as NodeHttp from "node:http";
import * as NodeHttps from "node:https";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeTls from "node:tls";

import { loadLocalAuthority } from "../src/certificates.ts";
import { patternDetector } from "../src/detect.ts";
import { startGateway } from "../src/gateway.ts";
import { makeProxy } from "../src/proxy.testkit.ts";
import { Pseudonymizer } from "../src/pseudonymizer.ts";
import { fetchThrough, readHostNetwork } from "../src/upstream.ts";
import { Vault } from "../src/vault.ts";

const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "doedesk-through-proxy-"));
const hostAuthority = loadLocalAuthority(NodePath.join(directory, "host"));
const received: Array<string> = [];
const host = NodeHttps.createServer(
  { SNICallback: (name, done) => done(null, hostAuthority.contextFor(name)) },
  (request, response) => {
    let body = "";
    request.on("data", (chunk) => (body += chunk));
    request.on("end", () => {
      received.push(`${request.method} ${request.url}`);
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ results: [{ entities: [] }], got: body.length }));
    });
  },
);
await new Promise<void>((resolve) => host.listen(0, "127.0.0.1", resolve));
const hostAddress = host.address();
if (hostAddress === null || typeof hostAddress === "string") throw new Error("no port");

const proxy = await makeProxy();
// Names that resolve nowhere: only the proxy knows where they lead.
proxy.routes.set("model.test:443", hostAddress.port);
proxy.routes.set("detect.test:443", hostAddress.port);
const hostCa = NodeFS.readFileSync(hostAuthority.certificatePath, "utf8");

const authority = loadLocalAuthority(NodePath.join(directory, "gateway"));
const gateway = await startGateway({
  authority,
  pseudonymizer: new Pseudonymizer(new Vault(), patternDetector),
  upstream: () => ({ host: "model.test", port: 443, tls: true }),
  upstreamProxy: () => proxy.url,
  upstreamCertificates: [hostCa],
});

/** One request as an agent's program makes it: a tunnel to the gateway, TLS, then HTTP. */
const ask = (method: string, path: string, body?: unknown): Promise<number> =>
  new Promise((resolve, reject) => {
    const connect = NodeHttp.request({
      host: "127.0.0.1",
      port: gateway.port,
      method: "CONNECT",
      path: "api.anthropic.com:443",
    });
    connect.on("error", reject);
    connect.on("connect", (_response, socket) => {
      const secure = NodeTls.connect({
        socket,
        servername: "api.anthropic.com",
        ca: NodeFS.readFileSync(authority.certificatePath, "utf8"),
      });
      const payload = body === undefined ? undefined : JSON.stringify(body);
      const request = NodeHttp.request(
        {
          createConnection: () => secure,
          method,
          path,
          headers: {
            host: "api.anthropic.com",
            ...(payload === undefined
              ? {}
              : {
                  "content-type": "application/json",
                  "content-length": Buffer.byteLength(payload),
                }),
          },
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
      request.end(payload);
    });
    connect.end();
  });

const statuses = [
  await ask("POST", "/v1/messages", { messages: [{ role: "user", content: "ID 1098765432" }] }),
  await ask("POST", "/api/eval/sdk-abc", { attributes: {} }),
  await ask("GET", "/api/claude_cli/bootstrap"),
];
// The gateway's own calls (detection, reading, the worker, DoeDesk Cloud) use this `fetch`.
const network = readHostNetwork({ HTTPS_PROXY: proxy.url.href, NO_PROXY: "exempt.test" });
const proxied = fetchThrough({ ...network, certificates: [hostCa] }, () =>
  Promise.resolve(new Response("direct", { status: 599 })),
);
const detection = await proxied("https://detect.test/v1/detect", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ texts: ["hello"] }),
});
const exempt = await proxied("https://exempt.test/v1/detect");
await proxy.idle();

const facts = {
  runtime: `node ${process.versions.node}${process.versions.electron ? `, electron ${process.versions.electron}` : ""}`,
  statuses,
  receivedByHost: received,
  tunnels: proxy.tunnels.map((tunnel) => tunnel.target),
  detectionStatus: detection.status,
  exemptWentDirect: exempt.status === 599,
};
const good =
  statuses.every((status) => status === 200) &&
  received.length === 4 &&
  proxy.tunnels.length === 4 &&
  detection.status === 200 &&
  facts.exemptWentDirect;
console.log(JSON.stringify(facts, null, 1));
console.log(good ? "PASS: every request went through the proxy" : "FAIL");
await gateway.close();
await proxy[Symbol.asyncDispose]();
host.closeAllConnections();
host.close();
NodeFS.rmSync(directory, { recursive: true, force: true });
process.exit(good ? 0 : 1);
