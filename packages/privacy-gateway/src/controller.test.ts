import * as NodeFS from "node:fs";
import * as NodeHttp from "node:http";
import * as NodeHttps from "node:https";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeTls from "node:tls";

import { describe, expect, it } from "vite-plus/test";

import { startPrivacyController } from "./controller.ts";
import { MASKED_SESSION_SWITCHES } from "./index.ts";

const makeController = async (stored: Record<string, unknown>) => {
  const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "doedesk-controller-"));
  NodeFS.writeFileSync(NodePath.join(directory, "config.json"), JSON.stringify(stored));
  let routingChanges = 0;
  const controller = await startPrivacyController({
    dataDirectory: directory,
    cloudUrl: "http://127.0.0.1:9",
    onRoutingChange: () => (routingChanges += 1),
  });
  return {
    controller,
    routingChanges: () => routingChanges,
    [Symbol.asyncDispose]: async () => {
      await controller.close();
      NodeFS.rmSync(directory, { recursive: true, force: true });
    },
  };
};

const GATEWAY_VARIABLES = [
  "HTTPS_PROXY",
  "https_proxy",
  "HTTP_PROXY",
  "http_proxy",
  "NO_PROXY",
  "no_proxy",
  "NODE_EXTRA_CA_CERTS",
  "NODE_USE_ENV_PROXY",
  "SSL_CERT_FILE",
  "REQUESTS_CA_BUNDLE",
  "CURL_CA_BUNDLE",
  "CODEX_CA_CERTIFICATE",
];

describe("what a provider's process is given", () => {
  it("is nothing at all while masking is off", async () => {
    await using harness = await makeController({ mode: "off" });
    for (const provider of ["claudeAgent", "codex", "cursor", undefined]) {
      expect(harness.controller.environmentFor(provider)).toBeUndefined();
    }
  });

  it("is the gateway and the documented switches, and nothing else, while masking is on", async () => {
    await using harness = await makeController({ mode: "unconfigured" });
    const environment = harness.controller.environmentFor("claudeAgent") ?? {};
    expect(Object.keys(environment).toSorted()).toEqual(
      [...GATEWAY_VARIABLES, ...Object.keys(MASKED_SESSION_SWITCHES)].toSorted(),
    );
    // Usage reports stay on: no switch that turns Claude Code's metrics off.
    expect(environment).not.toHaveProperty("DISABLE_TELEMETRY");
    expect(environment).not.toHaveProperty("DO_NOT_TRACK");
    expect(harness.controller.status().sessionSwitches).toEqual(MASKED_SESSION_SWITCHES);
  });

  it("turns Claude Code's usage reports off only when the user says so", async () => {
    await using harness = await makeController({ mode: "unconfigured" });
    harness.controller.setPreference({ kind: "usageReports", send: false });
    expect(harness.controller.environmentFor("claudeAgent")).toMatchObject({
      DISABLE_TELEMETRY: "1",
    });
    expect(harness.controller.status()).toMatchObject({
      usageReports: false,
      sessionSwitches: { ...MASKED_SESSION_SWITCHES, DISABLE_TELEMETRY: "1" },
    });
    expect(harness.routingChanges()).toBe(1);
  });

  it("takes the gateway away from one provider and tells the caller to restart agents", async () => {
    await using harness = await makeController({ mode: "unconfigured" });
    harness.controller.setPreference({ kind: "providerRoute", provider: "codex", direct: true });
    expect(harness.controller.environmentFor("codex")).toBeUndefined();
    expect(harness.controller.environmentFor("claudeAgent")).toHaveProperty("HTTPS_PROXY");
    expect(harness.controller.status().directProviders).toEqual(["codex"]);
    expect(harness.routingChanges()).toBe(1);

    harness.controller.setPreference({ kind: "providerRoute", provider: "codex", direct: false });
    expect(harness.controller.environmentFor("codex")).toHaveProperty("HTTPS_PROXY");
    expect(harness.routingChanges()).toBe(2);
  });

  it("keeps a provider's choices when masking is turned off and on again", async () => {
    await using harness = await makeController({ mode: "unconfigured" });
    harness.controller.setPreference({ kind: "providerRoute", provider: "codex", direct: true });
    harness.controller.setPreference({ kind: "noticeRead", provider: "claudeAgent" });
    await harness.controller.configure({ mode: "off" });
    expect(harness.controller.environmentFor("claudeAgent")).toBeUndefined();
    await harness.controller.configure({ mode: "unconfigured" });
    expect(harness.controller.status()).toMatchObject({
      directProviders: ["codex"],
      noticesRead: ["claudeAgent"],
    });
    // Reading a notice changes no route.
    expect(harness.routingChanges()).toBe(3);
  });
});

describe("how images are sent, and the reading tool", () => {
  it("sends images redacted and offers the tool until the user says otherwise, and remembers", async () => {
    await using harness = await makeController({ mode: "unconfigured" });
    expect(harness.controller.status()).toMatchObject({
      imageHandling: "redacted",
      readingTool: true,
    });
    harness.controller.setPreference({ kind: "imageHandling", handling: "text" });
    harness.controller.setPreference({ kind: "readingTool", offered: false });
    expect(harness.controller.status()).toMatchObject({
      imageHandling: "text",
      readingTool: false,
    });
    // Neither choice changes how an agent's process is started.
    expect(harness.routingChanges()).toBe(0);
    await harness.controller.configure({ mode: "off" });
    await harness.controller.configure({ mode: "unconfigured" });
    expect(harness.controller.status()).toMatchObject({
      imageHandling: "text",
      readingTool: false,
    });
  });

  it("the tool returns masked text, records it for download, and nothing when it cannot mask", async () => {
    const calls: Array<string> = [];
    const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "doedesk-controller-"));
    NodeFS.writeFileSync(
      NodePath.join(directory, "config.json"),
      JSON.stringify({ mode: "selfHosted", endpoint: "http://detector.test" }),
    );
    let detectorUp = true;
    const controller = await startPrivacyController({
      dataDirectory: directory,
      cloudUrl: "http://127.0.0.1:9",
      fetch: ((input: string | URL | Request) => {
        const url = String(input);
        calls.push(url);
        if (url.endsWith("/v1/ocr")) {
          // A second page with other words: what was checked once is not asked about again.
          const text = detectorUp
            ? "Owner Khalid Al-Otaibi, 0551234567"
            : "Tenant Khalid Al-Otaibi, 0551234567";
          return Promise.resolve(Response.json({ text, pages: 1 }));
        }
        if (!detectorUp) return Promise.resolve(new Response("down", { status: 503 }));
        return Promise.resolve(
          Response.json({ results: [{ entities: [{ start: 6, end: 22, kind: "PERSON" }] }] }),
        );
      }) as typeof fetch,
    });
    try {
      const file = Buffer.from("a scanned page");
      const read = await controller.readMasked(file, "image/png");
      expect(read).toMatchObject({ ok: true });
      expect(read.ok && read.text).toMatch(/^Owner \[PERSON_\w{5}\], \[PHONE_\w{5}\]$/);
      const [record] = controller.redactions();
      expect(record).toMatchObject({
        kind: "image",
        outcome: "text",
        hasText: true,
        hasImage: false,
      });
      expect(controller.redactionFile(record?.id ?? "", "text")?.bytes.toString()).toBe(
        read.ok && read.text,
      );
      expect(controller.redactionFile(record?.id ?? "", "image")).toBeUndefined();

      // Text that cannot be checked is not returned, in whole or in part.
      detectorUp = false;
      const refused = await controller.readMasked(Buffer.from("another page"), "application/pdf");
      expect(refused.ok).toBe(false);
      expect(JSON.stringify(refused)).not.toContain("Khalid");
      expect(JSON.stringify(refused)).not.toContain("0551234567");

      controller.setPreference({ kind: "readingTool", offered: false });
      expect(await controller.readMasked(file, "image/png")).toEqual({
        ok: false,
        message: "The reading tool is turned off in Settings, under Privacy.",
      });
      controller.clearRedactions();
      expect(controller.redactions()).toEqual([]);
    } finally {
      await controller.close();
      NodeFS.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("the tool reads nothing while masking is off", async () => {
    await using harness = await makeController({ mode: "off" });
    expect(await harness.controller.readMasked(Buffer.from("x"), "image/png")).toEqual({
      ok: false,
      message: "DoeDesk privacy is not active, so nothing was read.",
    });
  });
});

const LEGAL = {
  terms: {
    version: "1.1",
    requiredVersion: "1.1",
    url: { en: "https://doedesk.com/terms", ar: "https://doedesk.com/ar/terms" },
  },
  privacy: {
    version: "1.1",
    url: { en: "https://doedesk.com/privacy", ar: "https://doedesk.com/ar/privacy" },
  },
};
const LEGAL_SHOWN = {
  terms: { version: "1.1", url: LEGAL.terms.url },
  privacy: { version: "1.1", url: LEGAL.privacy.url },
};
const ACCEPTED = {
  outstanding: false,
  blocked: false,
  termsVersion: "1.1",
  privacyVersion: "1.1",
  acceptedAt: "2026-11-18T18:00:00.000Z",
};
const NOT_ACCEPTED = {
  outstanding: true,
  blocked: false,
  termsVersion: null,
  privacyVersion: null,
  acceptedAt: null,
};
const TICKED = {
  termsVersion: "1.1",
  privacyVersion: "1.1",
  locale: "ar",
  wordingId: "signup-2026-11",
} as const;

interface CloudCall {
  readonly method: string;
  readonly path: string;
  readonly token: string | null;
  readonly body: Record<string, unknown> | null;
}
type CloudReply = { readonly status?: number; readonly body: unknown };

/**
 * Stands in for DoeDesk Cloud, speaking the shapes in the service's contract. `routes` maps
 * "METHOD /path" to an answer; anything else answers 404.
 */
const makeCloud = async (
  routes: Record<string, (call: CloudCall) => CloudReply>,
  stored: Record<string, unknown> = { mode: "unconfigured" },
) => {
  const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "doedesk-controller-"));
  NodeFS.writeFileSync(NodePath.join(directory, "config.json"), JSON.stringify(stored));
  const calls: Array<CloudCall> = [];
  const controller = await startPrivacyController({
    dataDirectory: directory,
    cloudUrl: "http://cloud.test",
    appVersion: "0.2.0",
    fetch: async (input, init) => {
      const url = new URL(String(input));
      const call: CloudCall = {
        method: init?.method ?? "GET",
        path: url.pathname,
        token: new Headers(init?.headers).get("authorization")?.replace("Bearer ", "") ?? null,
        body: typeof init?.body === "string" ? JSON.parse(init.body) : null,
      };
      calls.push(call);
      const reply = routes[`${call.method} ${call.path}`]?.(call) ?? {
        status: 404,
        body: { error: { code: "not_found", message: "No such route." } },
      };
      return Response.json(reply.body, { status: reply.status ?? 200 });
    },
  });
  return {
    controller,
    calls,
    stored: () => JSON.parse(NodeFS.readFileSync(NodePath.join(directory, "config.json"), "utf8")),
    callsTo: (route: string) => calls.filter((call) => `${call.method} ${call.path}` === route),
    [Symbol.asyncDispose]: async () => {
      await controller.close();
      NodeFS.rmSync(directory, { recursive: true, force: true });
    },
  };
};

const refusal = (
  status: number,
  code: string,
  extra: Record<string, unknown> = {},
): CloudReply => ({
  status,
  body: { error: { code, message: `The service said ${code}.`, ...extra } },
});

const signedInAnswer = (token: string, id: string, acceptance: unknown = ACCEPTED): CloudReply => ({
  body: {
    token,
    account: { id, email: "sara@example.com", phone: null, profileAnswered: false },
    created: false,
    acceptance,
    legal: LEGAL,
  },
});

const me = (id: string, acceptance: unknown): CloudReply => ({
  body: {
    id,
    email: "sara@example.com",
    phone: null,
    profileAnswered: true,
    field: "legal",
    workplace: "self",
    acceptance,
    legal: LEGAL,
  },
});

const SIGNED_IN = { mode: "cloud", token: "dd_old", accountLabel: "sara@example.com" };

describe("accepting the Terms of Use", () => {
  it("sends what the screen showed with the request for a code or a link", async () => {
    await using cloud = await makeCloud({
      "POST /v1/auth/phone/start": () => ({ body: { requestId: "r1", resendIn: 60 } }),
      "POST /v1/auth/email/start": () => ({ body: { requestId: "r2", pollSecret: "s" } }),
    });
    await cloud.controller.signIn({ step: "phoneStart", phone: "0551234567", acceptance: TICKED });
    await cloud.controller.signIn({
      step: "emailStart",
      email: "sara@example.com",
      locale: "ar",
      acceptance: { ...TICKED, locale: "en" },
    });
    expect(cloud.callsTo("POST /v1/auth/phone/start")[0]?.body).toMatchObject({
      phone: "0551234567",
      client: "desktop",
      acceptance: { ...TICKED, appVersion: "0.2.0", method: "checkbox+button" },
    });
    expect(cloud.callsTo("POST /v1/auth/email/start")[0]?.body?.acceptance).toEqual({
      ...TICKED,
      locale: "en",
      appVersion: "0.2.0",
      method: "checkbox+button",
    });
  });

  it("passes each refusal on by its code, and takes the documents a refusal names", async () => {
    const newer = { ...LEGAL, terms: { ...LEGAL.terms, version: "1.2", requiredVersion: "1.2" } };
    const answers: Record<string, CloudReply> = {
      terms_required: refusal(400, "terms_required", { legal: LEGAL }),
      invalid_acceptance: refusal(400, "invalid_acceptance"),
      terms_outdated: refusal(409, "terms_outdated", { legal: newer }),
      too_many_requests: refusal(429, "too_many_requests"),
    };
    for (const [code, answer] of Object.entries(answers)) {
      await using cloud = await makeCloud({ "POST /v1/auth/email/start": () => answer });
      const result = await cloud.controller.signIn({ step: "emailStart", email: "a@b.co" });
      expect(result).toMatchObject({ ok: false, code, requestId: null });
      expect(cloud.controller.status().legal?.terms.version ?? null).toBe(
        code === "terms_outdated" ? "1.2" : code === "terms_required" ? "1.1" : null,
      );
    }
  });

  it("says where sign-up is refused, before and after the code is verified", async () => {
    await using cloud = await makeCloud({
      "GET /v1/auth/options": () => ({
        body: {
          methods: ["email"],
          default: "email",
          usageData: "ask",
          usageDataConsentRegions: ["DE", "CA-QC"],
          signUp: { available: false, code: "signup_unavailable", message: "Not here." },
          legal: LEGAL,
        },
      }),
      "POST /v1/auth/phone/verify": () => refusal(403, "signup_unavailable"),
    });
    expect(await cloud.controller.signIn({ step: "options" })).toMatchObject({
      ok: true,
      methods: ["email"],
      signUpAvailable: false,
    });
    expect(cloud.controller.status().legal).toEqual(LEGAL_SHOWN);
    // The options request names no account and no device.
    expect(cloud.callsTo("GET /v1/auth/options")[0]).toMatchObject({ token: null, body: null });
    expect(
      await cloud.controller.signIn({ step: "phoneVerify", requestId: "r1", code: "123456" }),
    ).toMatchObject({ ok: false, code: "signup_unavailable", signedIn: false });
    expect(cloud.controller.status().mode).toBe("unconfigured");
  });

  it("shows an account from before the checkbox as outstanding, and records its acceptance", async () => {
    await using cloud = await makeCloud({
      "POST /v1/auth/phone/verify": () => signedInAnswer("dd_new", "acct-1", NOT_ACCEPTED),
      "POST /v1/me/acceptance": () => ({ body: { acceptance: ACCEPTED, legal: LEGAL } }),
    });
    await cloud.controller.signIn({ step: "phoneVerify", requestId: "r1", code: "123456" });
    expect(cloud.controller.status()).toMatchObject({
      mode: "cloud",
      accountId: "acct-1",
      acceptance: NOT_ACCEPTED,
      legal: LEGAL_SHOWN,
    });

    const result = await cloud.controller.account({ action: "accept", acceptance: TICKED });
    expect(result.ok).toBe(true);
    expect(cloud.callsTo("POST /v1/me/acceptance")[0]).toMatchObject({
      token: "dd_new",
      body: { acceptance: { ...TICKED, appVersion: "0.2.0", method: "checkbox+button" } },
    });
    expect(cloud.controller.status().acceptance).toEqual(ACCEPTED);
    // The record is DoeDesk Cloud's; this computer keeps only what it was told.
    expect(cloud.stored().acceptance).toEqual(ACCEPTED);
  });

  it("reads where the account stands at every start", async () => {
    await using cloud = await makeCloud(
      { "GET /v1/me": () => me("acct-1", NOT_ACCEPTED) },
      SIGNED_IN,
    );
    await expect.poll(() => cloud.controller.status().acceptance).toEqual(NOT_ACCEPTED);
    expect(cloud.controller.status()).toMatchObject({
      accountId: "acct-1",
      profile: { field: "legal", workplace: "self" },
    });
  });

  it("marks the account when detection is refused for the Terms, and tells the person what to do", async () => {
    await using cloud = await makeCloud(
      {
        "GET /v1/me": () => me("acct-1", ACCEPTED),
        "POST /v1/detect": () => refusal(403, "terms_update_required", { legal: LEGAL }),
      },
      SIGNED_IN,
    );
    await expect.poll(() => cloud.controller.status().acceptance).toEqual(ACCEPTED);
    const environment = cloud.controller.environmentFor("claudeAgent") ?? {};
    const answer = await postThroughGateway(environment, {
      model: "claude",
      messages: [{ role: "user", content: "Write to Jane Doe about the lease." }],
    });

    // Nothing was sent to the model, and the reason is in the person's words.
    expect(answer.status).toBeGreaterThanOrEqual(400);
    expect(cloud.controller.status().acceptance).toMatchObject({
      outstanding: true,
      blocked: true,
    });
    expect(cloud.controller.activity()[0]).toMatchObject({ outcome: "refused" });
    expect(cloud.controller.activity()[0]?.reason).toContain("has not accepted the current Terms");
    // One refusal, one request to the service: no retry behind the person's back.
    expect(cloud.callsTo("POST /v1/detect")).toHaveLength(1);
  });
});

/** Sends one model request through the controller's gateway, as an agent process would. */
const postThroughGateway = (environment: Readonly<Record<string, string>>, body: unknown) =>
  new Promise<{ status: number; text: string }>((resolve, reject) => {
    const proxy = new URL(environment.HTTPS_PROXY ?? "");
    const trusted = NodeFS.readFileSync(environment.NODE_EXTRA_CA_CERTS ?? "", "utf8");
    const connect = NodeHttp.request({
      host: proxy.hostname,
      port: proxy.port,
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
          path: "/v1/messages",
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

describe("the account's rights", () => {
  it("returns everything the service holds as text for a file", async () => {
    const held = { account: { id: "acct-1" }, termsAcceptance: { status: ACCEPTED, history: [] } };
    await using cloud = await makeCloud(
      { "GET /v1/me": () => me("acct-1", ACCEPTED), "GET /v1/me/export": () => ({ body: held }) },
      SIGNED_IN,
    );
    const result = await cloud.controller.account({ action: "export" });
    expect(JSON.parse(result.exported ?? "null")).toEqual(held);
    expect(cloud.callsTo("GET /v1/me/export")[0]?.token).toBe("dd_old");
  });

  it("says when the service allows no more copies this hour", async () => {
    await using cloud = await makeCloud(
      {
        "GET /v1/me": () => me("acct-1", ACCEPTED),
        "GET /v1/me/export": () => refusal(429, "too_many_requests"),
      },
      SIGNED_IN,
    );
    expect(await cloud.controller.account({ action: "export" })).toMatchObject({
      ok: false,
      code: "too_many_requests",
      exported: null,
    });
    expect(cloud.controller.status().mode).toBe("cloud");
  });

  const DELETED = {
    deleted: true,
    accountId: "acct-1",
    deletedAt: "2026-11-18T19:00:00.000Z",
    kept: [{ record: "terms_acceptance", until: "2031-11-18T19:00:00.000Z", reason: "Proof." }],
    notCovered: [],
  };

  it("asks for a new sign-in when this one is too old to delete the account", async () => {
    await using cloud = await makeCloud(
      {
        "GET /v1/me": () => me("acct-1", ACCEPTED),
        "DELETE /v1/me": () => refusal(403, "recent_sign_in_required", { maxAgeSeconds: 600 }),
      },
      SIGNED_IN,
    );
    expect(await cloud.controller.account({ action: "delete" })).toMatchObject({
      ok: false,
      code: "recent_sign_in_required",
      deleted: null,
    });
    expect(cloud.controller.status()).toMatchObject({
      mode: "cloud",
      accountLabel: "sara@example.com",
    });
  });

  it("deletes with the new sign-in, then forgets the account on this computer", async () => {
    await using cloud = await makeCloud(
      {
        "GET /v1/me": () => me("acct-1", ACCEPTED),
        "POST /v1/auth/phone/start": () => ({ body: { requestId: "r9", resendIn: 60 } }),
        "POST /v1/auth/phone/verify": () => signedInAnswer("dd_fresh", "acct-1"),
        "DELETE /v1/me": (call) =>
          call.token === "dd_fresh" ? { body: DELETED } : refusal(403, "recent_sign_in_required"),
      },
      { ...SIGNED_IN, profileAnswered: true, directProviders: ["codex"] },
    );
    await expect.poll(() => cloud.controller.status().accountId).toBe("acct-1");
    // No acceptance is sent: deleting an account does not ask anyone to agree to anything.
    await cloud.controller.signIn({
      step: "phoneStart",
      phone: "0551234567",
      purpose: "deleteAccount",
    });
    expect(cloud.callsTo("POST /v1/auth/phone/start")[0]?.body).not.toHaveProperty("acceptance");
    const result = await cloud.controller.signIn({
      step: "phoneVerify",
      requestId: "r9",
      code: "123456",
    });

    expect(result).toMatchObject({
      ok: true,
      signedIn: false,
      deleted: {
        accountId: "acct-1",
        kept: [{ record: "terms_acceptance", until: "2031-11-18T19:00:00.000Z" }],
      },
    });
    expect(cloud.callsTo("DELETE /v1/me").map((call) => call.token)).toEqual(["dd_fresh"]);
    expect(cloud.controller.status()).toMatchObject({
      mode: "unconfigured",
      accountLabel: null,
      accountId: null,
      acceptance: null,
      profile: null,
      profileAnswered: false,
      directProviders: ["codex"],
    });
    expect(cloud.stored()).not.toHaveProperty("token");
  });

  it("deletes nothing of this account when another number or address was verified", async () => {
    await using cloud = await makeCloud(
      {
        "GET /v1/me": () => me("acct-1", ACCEPTED),
        "POST /v1/auth/phone/start": () => ({ body: { requestId: "r9", resendIn: 60 } }),
        "POST /v1/auth/phone/verify": () => ({
          body: {
            token: "dd_other",
            account: { id: "acct-2", email: null, phone: "+96655•••999", profileAnswered: false },
            created: true,
            acceptance: NOT_ACCEPTED,
            legal: LEGAL,
          },
        }),
        "DELETE /v1/me": () => ({ body: { ...DELETED, accountId: "acct-2" } }),
      },
      SIGNED_IN,
    );
    await expect.poll(() => cloud.controller.status().accountId).toBe("acct-1");
    await cloud.controller.signIn({
      step: "phoneStart",
      phone: "0559999999",
      purpose: "deleteAccount",
    });
    const result = await cloud.controller.signIn({
      step: "phoneVerify",
      requestId: "r9",
      code: "123456",
    });

    expect(result).toMatchObject({ ok: false, code: "different_account", deleted: null });
    // The account that mistake created is removed again; the signed-in one is untouched.
    expect(cloud.callsTo("DELETE /v1/me").map((call) => call.token)).toEqual(["dd_other"]);
    expect(cloud.controller.status()).toMatchObject({ mode: "cloud", accountId: "acct-1" });
    expect(cloud.stored().token).toBe("dd_old");
  });
});
