import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeHttp from "node:http";
import * as NodeHttps from "node:https";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeTls from "node:tls";

import { describe, expect, it } from "vite-plus/test";

import { startPrivacyController } from "./controller.ts";
import { openName } from "./sealedLabels.ts";
import { MASKED_SESSION_SWITCHES } from "./index.ts";

const makeController = async (stored: Record<string, unknown>) => {
  const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "doedesk-controller-"));
  NodeFS.writeFileSync(NodePath.join(directory, "config.json"), JSON.stringify(stored));
  let routingChanges = 0;
  let rerouted: (provider: string | undefined) => boolean = () => false;
  const controller = await startPrivacyController({
    dataDirectory: directory,
    cloudUrl: "http://127.0.0.1:9",
    onRoutingChange: (changed) => {
      routingChanges += 1;
      rerouted = changed;
    },
  });
  return {
    controller,
    routingChanges: () => routingChanges,
    /** Whether the last change gave this provider's processes a different environment. */
    rerouted: (provider: string | undefined) => rerouted(provider),
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
    // Only that provider's agents: the turns of the others go on.
    expect(["codex", "claudeAgent", undefined].map(harness.rerouted)).toEqual([true, false, false]);

    harness.controller.setPreference({ kind: "providerRoute", provider: "codex", direct: false });
    expect(harness.controller.environmentFor("codex")).toHaveProperty("HTTPS_PROXY");
    expect(harness.routingChanges()).toBe(2);
    expect(["codex", "claudeAgent"].map(harness.rerouted)).toEqual([true, false]);

    // Turning masking off reroutes the masked providers, and not one that was already direct.
    harness.controller.setPreference({ kind: "providerRoute", provider: "cursor", direct: true });
    await harness.controller.configure({ mode: "off" });
    expect(["codex", "claudeAgent", "cursor"].map(harness.rerouted)).toEqual([true, true, false]);
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
      // Public web pages are not searched for new names until the person asks for it.
      webResultsChecked: false,
    });
    harness.controller.setPreference({ kind: "imageHandling", handling: "text" });
    harness.controller.setPreference({ kind: "readingTool", offered: false });
    harness.controller.setPreference({ kind: "webResults", check: true });
    expect(harness.controller.status()).toMatchObject({
      imageHandling: "text",
      readingTool: false,
      webResultsChecked: true,
    });
    // Neither choice changes how an agent's process is started.
    expect(harness.routingChanges()).toBe(0);
    await harness.controller.configure({ mode: "off" });
    await harness.controller.configure({ mode: "unconfigured" });
    expect(harness.controller.status()).toMatchObject({
      imageHandling: "text",
      readingTool: false,
      webResultsChecked: true,
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
      // The detector goes down below: its retries are not waited for.
      sleep: () => Promise.resolve(),
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

describe("the worker that reads sealed documents", () => {
  const CONTRACT = Buffer.from("The fee is SAR 4,812,650.40 and is due on 3 March 2027.");
  const hostedIn = (region: string, model: string) => ({
    region,
    worker: { region, entitled: true, available: true, model, structured: "jsonObject" },
  });
  const ASK = {
    project: "project-1",
    caller: "thread-1",
    handles: [],
    instruction: "For a register.",
    fields: [{ name: "fee", type: "number" as const, description: "The fee." }],
  };

  it("is DoeDesk Cloud's for a signed-in account with nothing set up, and an own server stored before is left as it was", async () => {
    await using hosted = await makeCloud(
      {
        "GET /v1/me": () => ({
          body: { ...(me("acct-1", ACCEPTED).body as object), ...hostedIn("eu", "eu-model") },
        }),
      },
      SIGNED_IN,
    );
    await hosted.controller.account({ action: "refresh" });
    expect(hosted.controller.status()).toMatchObject({
      accountRegion: "eu",
      hostedWorkerEntitled: true,
      worker: {
        kind: "cloud",
        // Sent to DoeDesk Cloud, which alone knows the region's upstream.
        address: "http://cloud.test/v1/worker",
        model: "eu-model",
        region: "eu",
        available: true,
      },
    });
    // Agents are given the tools once there is something sealed to ask about.
    expect(hosted.controller.workerOffered()).toBe(false);
    expect((await hosted.controller.sealDocument("project-1", "contract.txt", CONTRACT)).ok).toBe(
      true,
    );
    expect(hosted.controller.workerOffered()).toBe(true);
    // None is still a choice, and it holds.
    expect(await hosted.controller.configureWorker({ kind: "off" })).toEqual({
      ok: true,
      message: null,
    });
    expect(hosted.controller.status().worker).toMatchObject({ kind: "off", address: null });
    expect(hosted.stored().workerChoice).toBe("off");

    await using own = await makeController({
      mode: "cloud",
      token: "dd_old",
      worker: {
        kind: "custom",
        baseUrl: "https://own.example/v1",
        apiKey: "key",
        model: "small-model",
        driver: "chatCompletions",
        structured: "jsonObject",
      },
    });
    expect(own.controller.status().worker).toMatchObject({
      kind: "custom",
      address: "https://own.example/v1",
      model: "small-model",
      region: null,
    });
    expect(own.controller.workerOffered()).toBe(true);

    await using signedOut = await makeController({ mode: "selfHosted" });
    expect(signedOut.controller.status().worker).toMatchObject({ kind: "off", region: null });
    expect(await signedOut.controller.configureWorker({ kind: "cloud" })).toEqual({
      ok: false,
      message: "Sign in to DoeDesk Cloud first to use its worker.",
    });

    await using preset = await makeController({
      mode: "selfHosted",
      worker: {
        kind: "groq",
        baseUrl: "https://api.example.com/openai/v1",
        apiKey: "key",
        model: "small-model",
        driver: "chatCompletions",
        reasoningEffort: "none",
      },
    });
    expect(preset.controller.status().worker).toMatchObject({
      kind: "custom",
      address: "https://api.example.com/openai/v1",
      model: "small-model",
      reasoningEffort: "none",
    });
  });

  it("keeps the reasoning setting the person's server took, in place of the one it refused", async () => {
    await using own = await makeCloud({
      "POST /v1/chat/completions": (call) =>
        call.body?.reasoning_effort === "low"
          ? {
              body: {
                choices: [
                  {
                    finish_reason: "stop",
                    message: { content: '{"word":{"quote":"is heron","value":"heron"}}' },
                  },
                ],
              },
            }
          : {
              status: 400,
              body: { error: { message: "reasoning_effort must be one of low, medium, or high" } },
            },
    });
    expect(
      await own.controller.configureWorker({
        kind: "custom",
        baseUrl: "http://own.test/v1",
        model: "gpt-oss-120b",
        driver: "chatCompletions",
        reasoningEffort: "none",
      }),
    ).toEqual({ ok: true, message: null });
    // What Settings shows afterwards is what will be sent, not what was typed.
    expect(own.controller.status().worker).toMatchObject({
      kind: "custom",
      model: "gpt-oss-120b",
      reasoningEffort: "low",
    });
    expect(own.stored().worker).toMatchObject({ reasoningEffort: "low", structured: "jsonSchema" });
  });

  it("changes the account's region at DoeDesk Cloud, and does not hold the last region's failures against the new one", async () => {
    await using harness = await makeCloud(
      {
        "GET /v1/me": () => ({
          body: { ...(me("acct-1", ACCEPTED).body as object), ...hostedIn("sa", "sa-model") },
        }),
        "POST /v1/me/region": (call) => ({
          body: {
            ...hostedIn(String(call.body?.region), "eu-model"),
            regionUpdatedAt: "2026-11-24T00:00:00.000Z",
          },
        }),
        // Saudi Arabia's worker is down. DoeDesk Cloud says so; it sends the file nowhere else.
        "POST /v1/worker/chat/completions": () => refusal(403, "worker_unavailable"),
      },
      SIGNED_IN,
    );
    await harness.controller.account({ action: "refresh" });
    expect((await harness.controller.sealDocument("project-1", "contract.txt", CONTRACT)).ok).toBe(
      true,
    );
    expect((await harness.controller.askDocuments(ASK)).ok).toBe(false);
    expect((await harness.controller.askDocuments({ ...ASK, caller: "thread-2" })).ok).toBe(false);
    const asked = harness.callsTo("POST /v1/worker/chat/completions");
    expect(asked.length).toBeGreaterThan(0);
    // The request carries the account's sign-in and names no region: the account has one.
    expect(asked.every((call) => call.token === "dd_old")).toBe(true);
    expect(JSON.stringify(asked.map((call) => call.body))).not.toMatch(/"region"|sa-model/);
    expect(harness.controller.status().worker).toMatchObject({ region: "sa", available: false });

    expect(await harness.controller.account({ action: "setRegion", region: "eu" })).toMatchObject({
      ok: true,
    });
    expect(harness.callsTo("POST /v1/me/region").map((call) => call.body)).toEqual([
      { region: "eu" },
    ]);
    expect(harness.controller.status()).toMatchObject({
      accountRegion: "eu",
      sealedDocuments: 1,
      worker: { kind: "cloud", region: "eu", model: "eu-model", available: true, servedFrom: null },
    });
    expect(harness.stored().accountRegion).toBe("eu");
  });

  it("asks nothing of a region where DoeDesk Cloud offers no worker yet, and says so without calling it a fault", async () => {
    let offered = false;
    await using harness = await makeCloud(
      {
        "GET /v1/me": () => ({
          body: {
            ...(me("acct-1", ACCEPTED).body as object),
            ...(offered
              ? hostedIn("eu", "eu-model")
              : {
                  region: "eu",
                  // As DoeDesk Cloud describes a region with no worker: no model, and nobody named.
                  worker: { region: "eu", entitled: true, available: false, model: null },
                }),
          },
        }),
        // Never asked while the region has no worker; once it has one, it answers.
        "POST /v1/worker/chat/completions": () =>
          offered
            ? {
                body: {
                  choices: [
                    {
                      finish_reason: "stop",
                      message: {
                        content: JSON.stringify({
                          fee: {
                            quote: "The fee is SAR 4,812,650.40",
                            value: "SAR 4,812,650.40",
                            scale: "none",
                          },
                        }),
                      },
                    },
                  ],
                  usage: { prompt_tokens: 10, completion_tokens: 5 },
                },
              }
            : refusal(403, "worker_unavailable"),
      },
      SIGNED_IN,
    );
    await harness.controller.account({ action: "refresh" });
    expect(harness.controller.status()).toMatchObject({
      accountRegion: "eu",
      hostedWorkerEntitled: true,
      hostedWorkerOffered: false,
      worker: { kind: "cloud", region: "eu", model: null, available: false },
    });
    expect((await harness.controller.sealDocument("project-1", "contract.txt", CONTRACT)).ok).toBe(
      true,
    );
    const answer = await harness.controller.askDocuments(ASK);
    expect(answer.ok).toBe(false);
    const told = answer.ok ? "" : answer.message;
    expect(told).toMatch(/^DoeDesk Cloud's worker is not available in this account's region yet/);
    expect(told).toMatch(/Nothing is wrong and nothing was sent anywhere/);
    expect(told).not.toMatch(/did not answer|unreachable|Wait \d+ seconds/);
    // Neither the region's worker nor another region's was asked.
    expect(harness.callsTo("POST /v1/worker/chat/completions")).toEqual([]);

    // DoeDesk Cloud begins to offer one: once the account is read again, questions go to it.
    offered = true;
    await harness.controller.account({ action: "refresh" });
    expect(harness.controller.status()).toMatchObject({
      hostedWorkerOffered: true,
      worker: { kind: "cloud", region: "eu", model: "eu-model" },
    });
    expect((await harness.controller.askDocuments({ ...ASK, caller: "thread-2" })).ok).toBe(true);
    expect(harness.callsTo("POST /v1/worker/chat/completions")).toHaveLength(1);
  });
});

describe("DoeDesk Cloud's worker for an account that does not have it", () => {
  const FILES = ["one.txt", "two.txt"];
  const ASK = {
    project: "project-1",
    caller: "thread-1",
    handles: [],
    instruction: "For a register.",
    fields: [{ name: "fee", type: "number" as const, description: "The fee." }],
  };
  const NO_WORKER = /^No worker is connected, so sealed documents cannot be asked about\./;

  it("is none by default and cannot be chosen, whether DoeDesk Cloud says so or says nothing of it", async () => {
    for (const worker of [undefined, { region: "sa", entitled: false, available: false }]) {
      await using harness = await makeCloud(
        {
          "GET /v1/me": () => ({
            body: {
              ...(me("acct-1", ACCEPTED).body as object),
              region: "sa",
              ...(worker === undefined ? {} : { worker }),
            },
          }),
        },
        SIGNED_IN,
      );
      await harness.controller.account({ action: "refresh" });
      expect(harness.controller.status()).toMatchObject({
        hostedWorkerEntitled: false,
        hostedWorker: null,
        worker: { kind: "off", address: null, region: null, notIncluded: false },
      });
      expect(await harness.controller.configureWorker({ kind: "cloud" })).toEqual({
        ok: false,
        message:
          "DoeDesk Cloud's worker is not included in this account. Connect your own server to read sealed files.",
      });
      expect(harness.stored().workerChoice).toBeUndefined();
      expect(harness.controller.workerOffered()).toBe(false);
      // A file sealed without a worker stays sealed, and asking about it sends nothing.
      expect(
        (await harness.controller.sealDocument("project-1", "one.txt", Buffer.from("The fee."))).ok,
      ).toBe(true);
      expect(await harness.controller.askDocuments(ASK)).toMatchObject({
        ok: false,
        message: expect.stringMatching(NO_WORKER),
      });
      expect(harness.callsTo("POST /v1/worker/chat/completions")).toHaveLength(0);
    }
  });

  it("keeps the files sealed when the account loses it, sends nothing anywhere else, and says why", async () => {
    let included = true;
    await using harness = await makeCloud(
      {
        "GET /v1/me": () => ({
          body: {
            ...(me("acct-1", ACCEPTED).body as object),
            region: "sa",
            worker: included
              ? { region: "sa", entitled: true, available: true, model: "sa-model", parallel: 1 }
              : { region: "sa", entitled: false, available: false },
          },
        }),
        // Switched off at DoeDesk Cloud while the app still believes it has the worker.
        "POST /v1/worker/chat/completions": () => refusal(403, "worker_not_included"),
      },
      SIGNED_IN,
    );
    const { controller } = harness;
    await controller.account({ action: "refresh" });
    for (const name of FILES) {
      const text = `${name}: the fee is SAR 4,812,650.40 and is due on 3 March 2027.`;
      expect((await controller.sealDocument("project-1", name, Buffer.from(text))).ok).toBe(true);
    }
    expect(controller.status().worker).toMatchObject({ kind: "cloud", notIncluded: false });

    const refused = await controller.askDocuments(ASK);
    expect(refused).toMatchObject({
      ok: false,
      message: expect.stringMatching(
        /^DoeDesk Cloud's worker is not included in this account, so sealed files cannot be asked about now\. They stay sealed/,
      ),
    });
    // Two sealed files and one call: the second was not sent once the first was refused.
    expect(harness.callsTo("POST /v1/worker/chat/completions")).toHaveLength(1);
    const lapsed = {
      hostedWorkerEntitled: false,
      sealedDocuments: 2,
      worker: { kind: "off", address: null, available: false, notIncluded: true },
    };
    expect(controller.status()).toMatchObject(lapsed);
    expect(controller.workerOffered()).toBe(false);
    // Asked again, nothing is sent: not to DoeDesk Cloud, and not to any other address.
    expect(await controller.askDocuments({ ...ASK, caller: "thread-2" })).toMatchObject({
      ok: false,
      message: expect.stringMatching(NO_WORKER),
    });
    expect(harness.callsTo("POST /v1/worker/chat/completions")).toHaveLength(1);
    expect(harness.calls.every((call) => call.path.startsWith("/v1/"))).toBe(true);
    expect(harness.stored().worker).toBeUndefined();

    // DoeDesk Cloud's own word, read with the account, says the same.
    included = false;
    await controller.account({ action: "refresh" });
    expect(controller.status()).toMatchObject(lapsed);
    expect(harness.stored().hostedWorker).toBeUndefined();
    // Switched on again, the same sealed files are asked about where they were.
    included = true;
    await controller.account({ action: "refresh" });
    expect(controller.status()).toMatchObject({
      hostedWorkerEntitled: true,
      sealedDocuments: 2,
      worker: { kind: "cloud", region: "sa", notIncluded: false },
    });
  });
});

describe("answers DoeDesk Cloud's worker gave before the account lost it", () => {
  const ASK = {
    project: "project-1",
    caller: "thread-1",
    handles: [],
    instruction: "For a register.",
    fields: [{ name: "fee", type: "number" as const, description: "The fee." }],
  };
  const NO_WORKER = /^No worker is connected, so sealed documents cannot be asked about\./;

  it("are not given again: asking fails and sends nothing, and the worker is asked afresh when it is back", async () => {
    let included = true;
    let refusing = false;
    await using harness = await makeCloud(
      {
        "GET /v1/me": () => ({
          body: {
            ...(me("acct-1", ACCEPTED).body as object),
            region: "sa",
            worker: included
              ? { region: "sa", entitled: true, available: true, model: "sa-model", parallel: 1 }
              : { region: "sa", entitled: false, available: false },
          },
        }),
        "POST /v1/worker/chat/completions": () =>
          refusing
            ? refusal(403, "worker_not_included")
            : {
                body: {
                  choices: [
                    {
                      finish_reason: "stop",
                      message: {
                        content: JSON.stringify({
                          fee: {
                            quote: "the fee is SAR 4,812,650.40",
                            value: "SAR 4,812,650.40",
                            scale: "none",
                          },
                        }),
                      },
                    },
                  ],
                  usage: { prompt_tokens: 10, completion_tokens: 5 },
                },
              },
      },
      SIGNED_IN,
    );
    const { controller } = harness;
    const asked = () => harness.callsTo("POST /v1/worker/chat/completions").length;
    const ask = (caller: string) => controller.askDocuments({ ...ASK, caller });
    await controller.account({ action: "refresh" });
    const text = "one.txt: the fee is SAR 4,812,650.40 and is due on 3 March 2027.";
    expect((await controller.sealDocument("project-1", "one.txt", Buffer.from(text))).ok).toBe(
      true,
    );
    expect((await ask("thread-1")).ok).toBe(true);
    // While the account has the worker, the same question is answered from what was kept.
    expect((await ask("thread-2")).ok).toBe(true);
    expect(asked()).toBe(1);

    // DoeDesk Cloud refuses the next call: the account has lost the worker.
    refusing = true;
    const refused = await controller.askDocuments({
      ...ASK,
      caller: "thread-3",
      fields: [...ASK.fields, { name: "due", type: "date", description: "When the fee is due." }],
    });
    expect(refused).toMatchObject({
      ok: false,
      message: expect.stringMatching(/^DoeDesk Cloud's worker is not included in this account/),
    });
    expect(asked()).toBe(2);
    // The question it answered before now fails like any other, and nothing is sent.
    expect(await ask("thread-4")).toMatchObject({
      ok: false,
      message: expect.stringMatching(NO_WORKER),
    });
    expect(asked()).toBe(2);

    // Given back, the worker is asked afresh: no answer from before the loss was kept.
    refusing = false;
    await controller.account({ action: "refresh" });
    expect((await ask("thread-5")).ok).toBe(true);
    expect(asked()).toBe(3);
    // Lost by DoeDesk Cloud's own word, read with the account, without any call refused.
    included = false;
    await controller.account({ action: "refresh" });
    expect(await ask("thread-6")).toMatchObject({
      ok: false,
      message: expect.stringMatching(NO_WORKER),
    });
    expect(asked()).toBe(3);
  });
});

describe("DoeDesk Cloud's worker when its region is busy", () => {
  it("sends one call at a time when the server says so, stops at busy, and shows busy without holding it against the worker", async () => {
    await using harness = await makeCloud(
      {
        "GET /v1/me": () => ({
          body: {
            ...(me("acct-1", ACCEPTED).body as object),
            region: "sa",
            // The region takes one call at a time, for everyone, and a call may wait 20 seconds there.
            worker: {
              region: "sa",
              entitled: true,
              available: true,
              model: "sa-model",
              structured: "jsonSchema",
              parallel: 1,
              maxWaitSeconds: 20,
            },
          },
        }),
        "POST /v1/worker/chat/completions": () => ({
          status: 429,
          body: { error: { code: "worker_busy", message: "The worker is busy.", waiting: 5 } },
        }),
      },
      SIGNED_IN,
    );
    await harness.controller.account({ action: "refresh" });
    for (const name of ["one.txt", "two.txt", "three.txt"]) {
      const sealed = await harness.controller.sealDocument(
        "project-1",
        name,
        Buffer.from(`${name}: the fee is SAR 4,812,650.40 and is due on 3 March 2027.`),
      );
      expect(sealed.ok).toBe(true);
    }
    const answer = await harness.controller.askDocuments({
      project: "project-1",
      caller: "thread-1",
      handles: [],
      instruction: "For a register.",
      fields: [{ name: "fee", type: "number", description: "The fee." }],
    });
    expect(answer).toMatchObject({
      ok: false,
      message: expect.stringMatching(/^The worker is busy: 5 calls are waiting for it\./),
    });
    // Three sealed files and one call: the other two were not sent to wait in the same line.
    expect(harness.callsTo("POST /v1/worker/chat/completions")).toHaveLength(1);
    expect(harness.controller.status().worker).toMatchObject({
      kind: "cloud",
      available: true,
      busy: { waiting: 5 },
    });
  });
});

describe("a sealed subfolder", () => {
  it("lists with its files, refuses to give one file back alone, and gives all back together", async () => {
    await using harness = await makeController({ mode: "selfHosted" });
    const project = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "doedesk-project-"));
    const contracts = NodePath.join(project, "contracts");
    NodeFS.mkdirSync(contracts);
    const lease = NodePath.join(contracts, "lease.txt");
    NodeFS.writeFileSync(lease, "Rent is SAR 84,000 a year.");
    const { controller } = harness;

    expect(await controller.inspectSealTargets({ folder: contracts })).toMatchObject({ files: 1 });
    expect(await controller.sealFolder("p", project, contracts)).toMatchObject({
      ok: true,
      sealed: 1,
    });
    const listing = controller.sealedListing("p");
    expect(listing.folders).toMatchObject([{ path: contracts, left: [] }]);
    expect(listing.documents).toMatchObject([{ name: "lease.txt", origin: lease }]);
    expect(controller.sealedFolderContaining(NodePath.join(contracts, "summary.md"))).toBe(
      contracts,
    );

    const handle = listing.documents[0]?.handle ?? "";
    expect(await controller.unsealFile("p", handle)).toMatchObject({
      ok: false,
      message: expect.stringContaining("Unseal the folder"),
    });

    // A scan arrives while no reading service is connected: it is sealed all the same, and
    // says why it cannot be asked about. A turn starts with nothing readable in the folder.
    const scan = NodePath.join(contracts, "scan.pdf");
    NodeFS.writeFileSync(scan, "%PDF-1.7 scanned pages");
    // Last changed long ago: a file that is not still being written.
    const past = new Date("2026-11-01T09:00:00.000Z");
    NodeFS.utimesSync(scan, past, past);
    expect(await controller.sealedFoldersBeforeTurn("p")).toEqual({ ok: true, sealed: 1 });
    expect(NodeFS.existsSync(scan)).toBe(false);
    const held = controller
      .sealedListing("p")
      .documents.find((document) => document.name === "scan.pdf");
    expect(held?.unread).toMatchObject({ kind: "service" });
    // Trying again still finds no reading service, and says so.
    expect(await controller.readSealed("p", held?.handle ?? "")).toMatchObject({
      ok: false,
      message: expect.stringContaining("no reading service is connected"),
    });

    expect(await controller.unsealFolder("p", contracts)).toMatchObject({ ok: true, restored: 2 });
    expect(NodeFS.readFileSync(scan, "utf8")).toBe("%PDF-1.7 scanned pages");
    expect(NodeFS.readFileSync(lease, "utf8")).toBe("Rent is SAR 84,000 a year.");
    expect(controller.sealedListing("p")).toMatchObject({ folders: [], documents: [] });
    NodeFS.rmSync(project, { recursive: true, force: true });
  });
});

describe("hosts that are not AI hosts", () => {
  /** A local server, and a way to ask the controller's gateway for a tunnel to it. */
  const makeTarget = async (controller: Awaited<ReturnType<typeof startPrivacyController>>) => {
    const target = NodeHttp.createServer((_request, response) => response.end("ok"));
    await new Promise<void>((resolve) => target.listen(0, "127.0.0.1", resolve));
    const address = target.address();
    if (address === null || typeof address === "string") throw new Error("no port");
    const proxy = new URL(controller.environmentFor("claudeAgent")?.HTTPS_PROXY ?? "");
    return {
      connect: () =>
        new Promise<number>((resolve, reject) => {
          const request = NodeHttp.request({
            host: proxy.hostname,
            port: proxy.port,
            method: "CONNECT",
            path: `127.0.0.1:${address.port}`,
          });
          request.on("error", reject);
          request.on("connect", (response, socket) => {
            socket.destroy();
            resolve(response.statusCode ?? 0);
          });
          request.end();
        }),
      [Symbol.asyncDispose]: () => new Promise<void>((resolve) => target.close(() => resolve())),
    };
  };

  it("stay reachable after a document is sealed", async () => {
    await using harness = await makeController({ mode: "unconfigured" });
    await using target = await makeTarget(harness.controller);
    const sealed = await harness.controller.sealDocument(
      "project-1",
      "contract.txt",
      Buffer.from("The fee is SAR 4,812,650.40 and is due on 3 March 2027."),
    );
    expect(sealed.ok).toBe(true);
    expect(harness.controller.status()).toMatchObject({
      sealedDocuments: 1,
      egress: { policy: "open" },
    });
    expect(await target.connect()).toBe(200);
  });

  it("names a refused host and lets the person allow it until the app closes, or for good", async () => {
    await using harness = await makeController({
      mode: "unconfigured",
      egress: { policy: "allowlist", hosts: ["github.com"] },
    });
    await using target = await makeTarget(harness.controller);
    expect(await target.connect()).toBe(403);
    expect(harness.controller.status().egress.refused.map((entry) => entry.host)).toEqual([
      "127.0.0.1",
    ]);

    harness.controller.setPreference({ kind: "allowHost", host: "127.0.0.1", lasting: false });
    expect(await target.connect()).toBe(200);
    expect(harness.controller.status().egress).toMatchObject({
      hosts: ["github.com"],
      refused: [],
    });

    harness.controller.setPreference({ kind: "allowHost", host: "127.0.0.1", lasting: true });
    expect(harness.controller.status().egress.hosts).toEqual(["github.com", "127.0.0.1"]);
  });

  it("never adds a host for good while only AI hosts are allowed", async () => {
    await using harness = await makeController({
      mode: "unconfigured",
      egress: { policy: "closed", hosts: [] },
    });
    await using target = await makeTarget(harness.controller);
    expect(await target.connect()).toBe(403);
    harness.controller.setPreference({ kind: "allowHost", host: "127.0.0.1", lasting: true });
    expect(await target.connect()).toBe(200);
    expect(harness.controller.status().egress).toMatchObject({ policy: "closed", hosts: [] });
  });
});

describe("the values a client marks", () => {
  it("gives kept turns their stand-ins in every spelling, the searched vault otherwise, and nothing while masking is off", async () => {
    const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "doedesk-controller-"));
    const entry = (token: string, surfaces: ReadonlyArray<string>, sealed = false) => ({
      token,
      kind: token.slice(1, token.lastIndexOf("_")),
      value: surfaces[0] ?? "60",
      surfaces,
      createdAt: "2026-01-01T00:00:00.000Z",
      ...(sealed ? { sealed: true } : {}),
    });
    const person = entry("[PERSON_AAAAA]", ["Khalid Al-Otaibi", "خالد العتيبي"]);
    const phone = entry("[PHONE_BBBBB]", ["0551234567", "٠٥٥١٢٣٤٥٦٧"]);
    const sealedAmount = entry("[AMOUNT_CCCCC]", ["4,200 SAR"], true);
    // Too common to search for: restored, never looked for, so there is nothing to mark.
    const unsearched = { ...entry("[AMOUNT_DDDDD]", [], true), sealedKey: "lease:rent" };
    const write = (name: string, content: unknown) =>
      NodeFS.writeFileSync(NodePath.join(directory, name), JSON.stringify(content));
    write("config.json", { mode: "selfHosted", endpoint: "http://detector.test" });
    write("vault.json", { version: 1, entries: [person, phone, sealedAmount, unsearched] });
    const firstTurn = [person.token, sealedAmount.token, unsearched.token, "[ORG_GHJKL]"];
    write("turns.json", { "run-1": firstTurn, "run-2": [phone.token] });
    const controller = await startPrivacyController({
      dataDirectory: directory,
      cloudUrl: "http://127.0.0.1:9",
      fetch: (() => Promise.resolve(new Response("down", { status: 503 }))) as typeof fetch,
    });
    const spellings = ({ token, surfaces }: typeof person, sealed = false) => ({
      token,
      surfaces,
      sealed,
    });
    try {
      // A stand-in the vault no longer holds is left out, and an unkept turn is not listed.
      expect(controller.knownValues(["run-1", "run-forgotten"])).toEqual({
        values: [spellings(person), spellings(sealedAmount, true)],
        turns: [{ runId: "run-1", tokens: firstTurn }],
      });
      // In a file, what `Vault.findKnown` looks for: no sealed value. The gateway adds this
      // computer's own names to the vault when it starts, so the list holds more than these.
      const searched = controller.knownValues();
      expect(searched.turns).toEqual([]);
      expect(searched.values).toEqual(
        expect.arrayContaining([spellings(person), spellings(phone)]),
      );
      expect(searched.values.map((value) => value.token)).not.toContain(sealedAmount.token);
      await controller.configure({ mode: "off" });
      expect(controller.knownValues(["run-1", "run-2"])).toEqual({ values: [], turns: [] });
      expect(controller.knownValues()).toEqual({ values: [], turns: [] });
    } finally {
      await controller.close();
      NodeFS.rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe("what a provider is told about a sealed file", () => {
  /** A detection service that finds names as words, as one does, and can be taken down. */
  const makeDetecting = async () => {
    const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "doedesk-controller-"));
    NodeFS.writeFileSync(
      NodePath.join(directory, "config.json"),
      JSON.stringify({ mode: "selfHosted", endpoint: "http://detector.test" }),
    );
    const names = ["Adel Al Amri", "Khalid Al Otaibi", "خالد العتيبي"];
    const service = { up: true };
    const controller = await startPrivacyController({
      dataDirectory: directory,
      cloudUrl: "http://127.0.0.1:9",
      sleep: () => Promise.resolve(),
      fetch: ((_input: string | URL | Request, init?: RequestInit) => {
        if (!service.up) return Promise.resolve(new Response("down", { status: 503 }));
        const { texts } = JSON.parse(String(init?.body ?? "{}")) as { texts?: Array<string> };
        return Promise.resolve(
          Response.json({
            results: (texts ?? []).map((text) => ({
              entities: names.flatMap((name) =>
                [
                  ...text.matchAll(
                    new RegExp(`(?<![\\p{L}\\p{N}_])${name}(?![\\p{L}\\p{N}_])`, "gu"),
                  ),
                ].map((match) => ({
                  start: match.index,
                  end: match.index + name.length,
                  kind: "PERSON",
                })),
              ),
            })),
          }),
        );
      }) as typeof fetch,
    });
    const project = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "doedesk-project-"));
    const write = (path: string) => {
      const filePath = NodePath.join(project, path);
      NodeFS.mkdirSync(NodePath.dirname(filePath), { recursive: true });
      NodeFS.writeFileSync(filePath, "Seen on the ward.");
      // Last changed long ago: a file that is not still being written.
      const past = new Date("2026-11-01T09:00:00.000Z");
      NodeFS.utimesSync(filePath, past, past);
      return filePath;
    };
    return {
      controller,
      project,
      service,
      write,
      told: () => controller.sealedForAgents("p", project),
      [Symbol.asyncDispose]: async () => {
        await controller.close();
        NodeFS.rmSync(directory, { recursive: true, force: true });
        NodeFS.rmSync(project, { recursive: true, force: true });
      },
    };
  };
  const PERSONAL = /adel|amri|khalid|otaibi|خالد|العتيبي|1293040015/i;

  /**
   * A controller whose requests to an AI company reach a local server that keeps each body. Its
   * detection service returns the parts of a name as separate values, and reads words: it finds
   * none inside joined ones.
   */
  const makeRecording = async (parts: ReadonlyArray<string>) => {
    const bodies: Array<string> = [];
    const company = NodeHttp.createServer((request, response) => {
      let body = "";
      request.on("data", (chunk) => (body += chunk));
      request.on("end", () => {
        bodies.push(body);
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({ content: [{ type: "text", text: "Done." }] }));
      });
    });
    await new Promise<void>((resolve) => company.listen(0, "127.0.0.1", resolve));
    const address = company.address();
    if (address === null || typeof address === "string") throw new Error("no port");
    const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "doedesk-controller-"));
    NodeFS.writeFileSync(
      NodePath.join(directory, "config.json"),
      JSON.stringify({ mode: "selfHosted", endpoint: "http://detector.test" }),
    );
    const controller = await startPrivacyController({
      dataDirectory: directory,
      cloudUrl: "http://127.0.0.1:9",
      sleep: () => Promise.resolve(),
      upstream: () => ({ host: "127.0.0.1", port: address.port, tls: false }),
      fetch: ((_input: string | URL | Request, init?: RequestInit) => {
        const { texts } = JSON.parse(String(init?.body ?? "{}")) as { texts?: Array<string> };
        return Promise.resolve(
          Response.json({
            results: (texts ?? []).map((text) => ({
              entities: parts.flatMap((part) =>
                [
                  ...text.matchAll(
                    new RegExp(`(?<![\\p{L}\\p{N}])${part}(?![\\p{L}\\p{N}])`, "gu"),
                  ),
                ].map((match) => ({
                  start: match.index,
                  end: match.index + part.length,
                  kind: "PERSON",
                })),
              ),
            })),
          }),
        );
      }) as typeof fetch,
    });
    const project = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "doedesk-project-"));
    return {
      controller,
      project,
      bodies,
      write: (path: string, contents = "Seen at the branch.") => {
        const filePath = NodePath.join(project, path);
        NodeFS.mkdirSync(NodePath.dirname(filePath), { recursive: true });
        NodeFS.writeFileSync(filePath, contents);
        const past = new Date("2026-11-01T09:00:00.000Z");
        NodeFS.utimesSync(filePath, past, past);
        return filePath;
      },
      send: (body: unknown) =>
        postThroughGateway(controller.environmentFor("claudeAgent") ?? {}, body),
      [Symbol.asyncDispose]: async () => {
        await controller.close();
        await new Promise((resolve) => company.close(resolve));
        NodeFS.rmSync(directory, { recursive: true, force: true });
        NodeFS.rmSync(project, { recursive: true, force: true });
      },
    };
  };

  it("masks the names in a file's name and path, and sends neither when they cannot be checked", async () => {
    await using harness = await makeDetecting();
    const { controller, write, told } = harness;
    await controller.sealFile(
      "p",
      write("patients/Adel_AlAmri/Adel_AlAmri_1293040015_PulmonaryEmbolism.txt"),
    );
    await controller.sealFile("p", write("KhalidAlOtaibi-diabetes.txt"));
    await controller.sealFile("p", write("خالد_العتيبي_تقرير.txt"));
    expect(told().files).toEqual([
      {
        handle: "DOC_1",
        name: expect.stringMatching(/^\[PERSON_\w{5}\]_\[ID_\w{5}\]_PulmonaryEmbolism\.txt$/),
        path: expect.stringMatching(
          /^patients\/\[PERSON_\w{5}\]\/\[PERSON_\w{5}\]_\[ID_\w{5}\]_PulmonaryEmbolism\.txt$/,
        ),
        unread: false,
      },
      {
        handle: "DOC_2",
        name: expect.stringMatching(/^\[PERSON_\w{5}\]-diabetes\.txt$/),
        path: expect.stringMatching(/^\[PERSON_\w{5}\]-diabetes\.txt$/),
        unread: false,
      },
      {
        handle: "DOC_3",
        name: expect.stringMatching(/^\[PERSON_\w{5}\]_تقرير\.txt$/),
        path: expect.stringMatching(/^\[PERSON_\w{5}\]_تقرير\.txt$/),
        unread: false,
      },
    ]);
    expect(JSON.stringify(told())).not.toMatch(PERSONAL);
    // The person still reads the file's own name, beside what is sent for it.
    expect(controller.sealedListing("p").documents[1]).toMatchObject({
      name: "KhalidAlOtaibi-diabetes.txt",
      label: expect.stringMatching(/^\[PERSON_\w{5}\]-diabetes\.txt$/),
    });
    // Before the person confirms, the same label is shown for a name.
    expect(await controller.sealLabels(["KhalidAlOtaibi-notes.txt"])).toEqual([
      expect.stringMatching(/^\[PERSON_\w{5}\]-notes\.txt$/),
    ]);

    // With the detection service down a name cannot be checked: the handle and the type go.
    // (A name checked before needs no service; this one is new.)
    harness.service.up = false;
    expect(await controller.sealLabels(["KhalidAlOtaibi-referral.txt"])).toEqual([null]);
    await controller.sealFile("p", write("Adel_AlAmri_discharge.txt"));
    expect(told().files[3]).toEqual({ handle: "DOC_4", name: "DOC_4.txt", unread: false });
    // Checked before the next turn once the service answers again.
    harness.service.up = true;
    await controller.sealedFoldersBeforeTurn("p");
    expect(told().files[3]?.name).toMatch(/^\[PERSON_\w{5}\]_discharge\.txt$/);
  });

  it("writes a sealed file's stored label wherever its name stands in what is sent", async () => {
    await using harness = await makeRecording(["Sara", "Dossari"]);
    const { controller, write, send, bodies } = harness;
    await controller.sealFile("p", write("Sara_AlDossari_bank_letter.txt"));
    // Its name writes the serial of a record number that only its own text holds.
    await controller.sealFile(
      "p",
      write("amendment_mnt_8042.txt", "Amendment to Agreement No. MNT-2025-8042."),
    );
    const [label = "", amendment = ""] = controller
      .sealedListing("p")
      .documents.map((document) => document.label ?? "");
    expect(label).toMatch(/^\[PERSON_\w{5}\]_Al\[PERSON_\w{5}\]_bank_letter\.txt$/);
    expect(amendment).toMatch(/^amendment_\[ID_\w{5}\]\.txt$/);

    // The reference the composer leaves in the message names the file as the person attached it.
    await send({
      model: "claude",
      messages: [
        {
          role: "user",
          content:
            "User message: [File: Sara_AlDossari_bank_letter.txt; ref=file_1] DOC_1 What does it ask for? And amendment_mnt_8042.txt?",
        },
      ],
    });
    expect(bodies[0]).toContain(`[File: ${label}; ref=file_1] DOC_1`);
    expect(bodies[0]).toContain(`And ${amendment}?`);
    expect(bodies[0]).not.toMatch(/dossari|8042/i);
  });

  /**
   * The words a sealed file's name says and its label does not: the name split where a separator,
   * a capital or a digit starts a word, three characters or more, the file type left out.
   */
  const wordsOnlyInName = (name: string, label: string): ReadonlyArray<string> => {
    const words = (value: string) =>
      openName(value.replace(/\.[A-Za-z0-9]{1,8}$/u, ""))
        .text.toLowerCase()
        .split(/\s+/u)
        .filter((word) => /^[\p{L}\p{N}]{3,}$/u.test(word));
    const said = new Set(words(label.replace(/\[[A-Z]+_[A-Z0-9]{5}\]/gu, " ")));
    return words(name).filter((word) => !said.has(word));
  };

  it("sends no word of a sealed file's name that its label does not say, in any request of a turn", async () => {
    await using harness = await makeRecording(["Sara", "Dossari", "Omar", "Shehri"]);
    const { controller, project, write, send, bodies } = harness;
    await controller.sealFile("p", write("Sara_AlDossari_bank_letter.txt"));
    await controller.sealFile("p", write("clients/Sara_AlDossari/Sara_AlDossari_statement.txt"));
    await controller.sealFile("p", write("Omar_AlShehri_medical_report.txt"), {
      neutralLabel: true,
    });
    const told = controller.sealedForAgents("p", project);

    // A turn as an agent's program sends it: every request carries all that came before.
    const system = `Sealed files of this folder: ${JSON.stringify(told)}`;
    const asked = {
      role: "user",
      content:
        "User message: [File: Sara_AlDossari_bank_letter.txt; ref=file_1] [File: Omar_AlShehri_medical_report.txt; ref=file_2] DOC_1 DOC_3 Summarise both.",
    };
    const call = (id: string, name: string, input: unknown, result: unknown) => [
      { role: "assistant", content: [{ type: "tool_use", id, name, input }] },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: id,
            content: typeof result === "string" ? result : JSON.stringify(result),
          },
        ],
      },
    ];
    // A sealed file has left the folder, and the agent's own tools say so by its name.
    const status = call(
      "t1",
      "Bash",
      { command: "git status --short" },
      " D Sara_AlDossari_bank_letter.txt\n D clients/Sara_AlDossari/Sara_AlDossari_statement.txt\n D Omar_AlShehri_medical_report.txt",
    );
    const listed = call("t2", "list_sealed", {}, { files: told.files, more: false });
    // The agent named the finished file after the label; restored, that is the file's own name.
    const filled = call(
      "t3",
      "fill_sealed",
      { name: "Sara_AlDossari_bank_letter-summary.txt", content: "Asked for: {{DOC_1.request}}" },
      { name: "Sara_AlDossari_bank_letter-summary.txt", finished: true, filled: 1 },
    );
    const refused = call(
      "t4",
      "ask_documents",
      { documents: ["Omar_AlShehri_medical_report.txt"], instruction: "Who signed it?" },
      "Omar_AlShehri_medical_report.txt: this file is sealed. Ask about it by its handle.",
    );
    const messages = [asked, ...status, ...listed, ...filled, ...refused];
    for (const upTo of [1, 3, 5, 7, 9]) {
      await send({ model: "claude", system, messages: messages.slice(0, upTo) });
    }

    expect(bodies).toHaveLength(5);
    for (const document of controller.sealedListing("p").documents) {
      const words = wordsOnlyInName(document.name, document.label ?? "");
      expect(words.length, document.name).toBeGreaterThan(0);
      for (const body of bodies) {
        const lower = body.toLowerCase();
        expect(
          words.filter((word) => lower.includes(word)),
          document.name,
        ).toEqual([]);
      }
    }
    // The same label everywhere a name stood, so the agent can tell it is one file.
    const label = controller.sealedListing("p").documents[0]?.label ?? "";
    expect(bodies[4]?.split(label.replace(/\.txt$/, "")).length).toBeGreaterThan(4);
    expect(bodies[4]).toContain("DOC_3.txt: this file is sealed");
  });

  it("seals an attached file where it lies in the folder, or says which files there stay readable", async () => {
    await using harness = await makeDetecting();
    const { controller, project, write } = harness;
    const letter = (text: string) => Buffer.from(text);
    const sha = (bytes: Buffer) => NodeCrypto.createHash("sha256").update(bytes).digest("hex");

    // One file with the same bytes and the same name: it is the file, and is sealed there.
    const lease = write("contracts/lease.txt");
    const leaseBytes = NodeFS.readFileSync(lease);
    expect(
      await controller.attachedFileInFolder(
        project,
        "lease.txt",
        sha(leaseBytes),
        leaseBytes.length,
      ),
    ).toEqual({ original: lease, readable: [], complete: true });
    const sealed = await controller.sealAttached("p", project, "lease.txt", leaseBytes);
    expect(sealed).toMatchObject({ ok: true, original: lease, readable: [] });
    expect(NodeFS.existsSync(lease)).toBe(false);
    expect(controller.sealedListing("p").documents[0]).toMatchObject({ origin: lease });

    // Two files with the same bytes: which one is meant cannot be told. The copy alone is
    // sealed, and both are named as still readable.
    const first = write("a/report.txt");
    const second = write("b/report.txt");
    const reportBytes = NodeFS.readFileSync(first);
    const copy = await controller.sealAttached("p", project, "report.txt", reportBytes);
    expect(copy).toMatchObject({ ok: true, readable: [first, second] });
    expect(copy.ok && copy.original).toBeUndefined();
    expect(NodeFS.existsSync(first) && NodeFS.existsSync(second)).toBe(true);
    expect(controller.sealedListing("p").documents[1]?.origin).toBeUndefined();

    // The same bytes under another name, and the same name over other bytes, stay readable too.
    NodeFS.writeFileSync(NodePath.join(project, "renamed.txt"), "Budget for the year.");
    NodeFS.writeFileSync(NodePath.join(project, "budget.txt"), "An older budget.");
    const budget = letter("Budget for the year.");
    expect(
      await controller.attachedFileInFolder(project, "budget.txt", sha(budget), budget.length),
    ).toEqual({
      readable: [NodePath.join(project, "budget.txt"), NodePath.join(project, "renamed.txt")],
      complete: true,
    });
    // A file that is nowhere in the folder leaves nothing readable behind.
    const other = letter("Typed elsewhere.");
    expect(
      await controller.attachedFileInFolder(project, "elsewhere.txt", sha(other), other.length),
    ).toEqual({ readable: [], complete: true });
  });

  it("says a turn started while a file that was unsealed could be opened again", async () => {
    await using harness = await makeDetecting();
    const { controller, project, write } = harness;
    const letter = write("letter.txt");
    write("ward/scan.txt");
    const ward = NodePath.join(project, "ward");
    await controller.sealFile("p", letter);
    await controller.sealFolder("p", project, ward);
    await controller.unsealFile("p", "DOC_1");
    await controller.unsealFolder("p", ward);
    // Back in the folder, and no turn has started since: no chat could have opened them.
    expect(controller.openedToTurns("p", { files: [letter] })).toBe(false);
    expect(controller.openedToTurns("p", { folder: ward })).toBe(false);

    await controller.sealedFoldersBeforeTurn("p");
    expect(controller.openedToTurns("p", { files: [letter] })).toBe(true);
    expect(controller.openedToTurns("p", { folder: ward })).toBe(true);
    // Another project's turns say nothing about this one, nor do they about another file.
    expect(controller.openedToTurns("q", { files: [letter] })).toBe(false);
    expect(controller.openedToTurns("p", { files: [NodePath.join(project, "other.txt")] })).toBe(
      false,
    );

    // Sealed and put back again, on the handle it had: the sign starts over.
    await controller.sealFile("p", letter);
    await controller.unsealFile("p", "DOC_1");
    expect(controller.openedToTurns("p", { files: [letter] })).toBe(false);
  });

  it("sends the handle and the type alone when the person chose that, for a file and for a folder's later files", async () => {
    await using harness = await makeDetecting();
    const { controller, project, write, told } = harness;
    await controller.sealFile("p", write("Adel_AlAmri_PulmonaryEmbolism.txt"), {
      neutralLabel: true,
    });
    write("ward/KhalidAlOtaibi-diabetes.txt");
    const ward = NodePath.join(project, "ward");
    await controller.sealFolder("p", project, ward, { neutralLabels: true });
    // A file that arrives later is sealed under the folder's choice.
    write("ward/Adel_AlAmri_scan.pdf");
    await controller.sealedFoldersBeforeTurn("p");
    expect(told()).toEqual({
      files: [
        { handle: "DOC_1", name: "DOC_1.txt", unread: false },
        // In a sealed folder, which is told anyway: the file is listed under it.
        { handle: "DOC_2", name: "DOC_2.txt", path: "ward/DOC_2.txt", unread: false },
        { handle: "DOC_3", name: "DOC_3.pdf", path: "ward/DOC_3.pdf", unread: true },
      ],
      // The folder stays where the agent can list it, so its path is told, masked.
      folders: ["ward"],
    });
    // The choice can be changed afterwards, either way.
    expect(await controller.setSealedLabel("p", "DOC_1", false)).toBe(true);
    expect(told().files[0]?.name).toMatch(/^\[PERSON_\w{5}\]_PulmonaryEmbolism\.txt$/);
    expect(await controller.setSealedLabel("p", "DOC_1", true)).toBe(true);
    expect(told().files[0]).toEqual({ handle: "DOC_1", name: "DOC_1.txt", unread: false });
  });
});
