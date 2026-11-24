import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeTls from "node:tls";

import { expect, it } from "vite-plus/test";

import * as NodeHttps from "node:https";

import { loadLocalAuthority } from "./certificates.ts";
import { makeProxy } from "./proxy.testkit.ts";
import { fetchThrough, ProxyError, readHostNetwork } from "./upstream.ts";

const scratch = () => NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "doedesk-upstream-"));

it("reads the person's proxy, and the hosts they keep off it", () => {
  const network = readHostNetwork({
    https_proxy: "http://ada:s%40cret@proxy.corp:3128",
    HTTP_PROXY: "proxy.corp:8080",
    NO_PROXY: "localhost, .internal.corp,build.corp:8443,10.0.0.5",
  });
  expect(network.proxyFor("api.anthropic.com", 443, true)?.href).toBe(
    "http://ada:s%40cret@proxy.corp:3128/",
  );
  expect(network.proxyFor("example.com", 80, false)?.href).toBe("http://proxy.corp:8080/");
  const direct: ReadonlyArray<readonly [string, number]> = [
    ["localhost", 3000],
    ["wiki.internal.corp", 443],
    ["internal.corp", 443],
    ["build.corp", 8443],
    ["10.0.0.5", 443],
  ];
  for (const [host, port] of direct) {
    expect(network.proxyFor(host, port, true), host).toBeUndefined();
  }
  // Another port of an exempted `host:port`, and a name that only ends the same way.
  expect(network.proxyFor("build.corp", 443, true)).toBeDefined();
  expect(network.proxyFor("notinternal.corp", 443, true)).toBeDefined();

  expect(readHostNetwork({}).proxyFor("example.com", 443, true)).toBeUndefined();
  expect(readHostNetwork({ ALL_PROXY: "socks5://127.0.0.1:1080" }).proxyFor("a.b", 443, true)).toBe(
    undefined,
  );
  expect(
    readHostNetwork({ HTTPS_PROXY: "http://p:1", NO_PROXY: "*" }).proxyFor("a.b", 443, true),
  ).toBeUndefined();
});

it("adds the person's own certificates to the bundle agents are given", () => {
  const directory = scratch();
  // Any certificate serves as the person's corporate root: here another authority's.
  const corporate = NodeFS.readFileSync(
    loadLocalAuthority(NodePath.join(directory, "corporate")).certificatePath,
    "utf8",
  ).trim();
  const theirBundle = NodePath.join(directory, "corporate-bundle.pem");
  NodeFS.writeFileSync(theirBundle, `${NodeTls.rootCertificates[0]}\n${corporate}\n`);

  const network = readHostNetwork({
    SSL_CERT_FILE: theirBundle,
    NODE_EXTRA_CA_CERTS: theirBundle,
    CURL_CA_BUNDLE: NodePath.join(directory, "missing.pem"),
  });
  // A public root they repeat is not carried twice.
  expect(network.certificates).toEqual([corporate]);

  const authority = loadLocalAuthority(NodePath.join(directory, "authority"), network);
  const own = NodeFS.readFileSync(
    NodePath.join(directory, "authority", "authority.pem"),
    "utf8",
  ).trim();
  const bundle = NodeFS.readFileSync(authority.bundlePath, "utf8");
  for (const certificate of [NodeTls.rootCertificates[0] ?? "", corporate, own]) {
    expect(bundle).toContain(certificate);
  }
  // Node adds this file to its defaults: theirs and the gateway's, nothing replaced.
  const added = NodeFS.readFileSync(authority.certificatePath, "utf8");
  expect(added).toContain(corporate);
  expect(added).toContain(own);

  // Without anything of their own, the file is the gateway's certificate alone, as before.
  const plain = loadLocalAuthority(NodePath.join(directory, "plain"));
  expect(
    NodeFS.readFileSync(plain.certificatePath, "utf8").match(/BEGIN CERTIFICATE/g),
  ).toHaveLength(1);
  NodeFS.rmSync(directory, { recursive: true, force: true });
});

it("sends the gateway's own calls through the person's proxy, and nowhere else", async () => {
  const directory = scratch();
  const authority = loadLocalAuthority(directory);
  const received: Array<string> = [];
  const service = NodeHttps.createServer(
    { SNICallback: (name, done) => done(null, authority.contextFor(name)) },
    (request, response) => {
      let body = "";
      request.on("data", (chunk) => (body += chunk));
      request.on("end", () => {
        received.push(`${request.method} ${request.headers.host}${request.url} ${body}`);
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ results: [{ entities: [] }] }));
      });
    },
  );
  await new Promise<void>((resolve) => service.listen(0, "127.0.0.1", resolve));
  const address = service.address();
  if (address === null || typeof address === "string") throw new Error("no port");
  await using proxy = await makeProxy();
  // The service's name resolves nowhere: only the proxy leads to it.
  proxy.routes.set("detect.test:443", address.port);

  const direct: Array<string> = [];
  const viaProxy = fetchThrough(
    readHostNetwork({
      HTTPS_PROXY: proxy.url.href,
      NO_PROXY: "exempt.test",
      NODE_EXTRA_CA_CERTS: authority.certificatePath,
    }),
    (input) => {
      direct.push(String(input));
      return Promise.resolve(new Response("{}"));
    },
  );
  const reply = await viaProxy("https://detect.test/v1/detect?layout=1", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer t" },
    body: JSON.stringify({ texts: ["Khalid asked."] }),
  });
  expect(reply.ok).toBe(true);
  expect(await reply.json()).toEqual({ results: [{ entities: [] }] });
  expect(received).toEqual(['POST detect.test/v1/detect?layout=1 {"texts":["Khalid asked."]}']);
  expect(proxy.tunnels.map((tunnel) => tunnel.target)).toEqual(["detect.test:443"]);
  await proxy.idle();

  // Kept off the proxy by the person, or on this computer: asked directly, as before.
  await viaProxy("https://exempt.test/v1/detect");
  await viaProxy("http://localhost:8000/v1/detect");
  await viaProxy("http://127.0.0.1:8000/v1/detect");
  expect(direct).toEqual([
    "https://exempt.test/v1/detect",
    "http://localhost:8000/v1/detect",
    "http://127.0.0.1:8000/v1/detect",
  ]);
  expect(proxy.tunnels).toHaveLength(1);

  // A call given up on is given up on here too, with the reason its caller set.
  const stopped = new AbortController();
  stopped.abort(new DOMException("The operation timed out.", "TimeoutError"));
  await expect(
    viaProxy("https://detect.test/v1/detect", { signal: stopped.signal }),
  ).rejects.toMatchObject({ name: "TimeoutError" });

  service.closeAllConnections();
  await new Promise((resolve) => service.close(resolve));
});

it("says in plain words what the person's proxy did when it turns a call away", async () => {
  await using signIn = await makeProxy({ answer: 407, credentials: "" });
  const asks = fetchThrough(readHostNetwork({ HTTPS_PROXY: `http://127.0.0.1:${signIn.port}` }));
  const refused = await asks("https://detect.test/v1/detect").catch((cause: unknown) => cause);
  expect(refused).toBeInstanceOf(ProxyError);
  expect(refused).toMatchObject({
    kind: "signIn",
    message: `The proxy this computer is set to use (127.0.0.1:${signIn.port}) asks for a user name and password, and DoeDesk was given none. Put them in the proxy address, as in http://name:password@127.0.0.1:${signIn.port}, and start DoeDesk again.`,
  });

  await using forbids = await makeProxy({ answer: 403 });
  const blocked = await fetchThrough(readHostNetwork({ HTTPS_PROXY: forbids.url.href }))(
    "https://detect.test/v1/detect",
  ).catch((cause: unknown) => cause);
  expect(blocked).toMatchObject({
    kind: "refused",
    message: `The proxy this computer is set to use (127.0.0.1:${forbids.port}) refused the connection to detect.test (it answered 403).`,
  });
});
