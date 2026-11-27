import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  PrivacyProviderHealth,
  PrivacyProviderRequest,
  PrivacyProviderResult,
  PrivacyProviders,
  PrivacyStatus,
} from "@t3tools/contracts";
import { startPrivacyController } from "@t3tools/privacy-gateway";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import { serviceOver } from "./PrivacyGateway.ts";

interface Call {
  readonly method: string;
  readonly host: string;
  readonly path: string;
  readonly headers: Headers;
  readonly body: unknown;
}
type Reply = { readonly status?: number; readonly body: unknown };

const SECRETS = ["dd_account_token", "presidio-key-1", "azure-key-1", "sk-legacy", "svc-token"];

// What the endpoints take and answer with, exactly as their schemas put it on the wire.
const decodeRequest = Schema.decodeUnknownSync(PrivacyProviderRequest);
const encodeStatus = Schema.encodeUnknownSync(PrivacyStatus);
const encodeProviders = Schema.encodeUnknownSync(PrivacyProviders);
const encodeResult = Schema.encodeUnknownSync(PrivacyProviderResult);
const encodeHealth = Schema.encodeUnknownSync(PrivacyProviderHealth);

/**
 * The gateway's service as the server builds it, over a controller whose every outgoing request
 * is answered here. `routes` maps "METHOD host/path" to an answer; anything else answers 404.
 */
const makeService = Effect.fn("test.makeService")(function* (
  stored: Record<string, unknown>,
  routes: Record<string, (call: Call) => Reply>,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "doedesk-providers-" });
  const configPath = path.join(directory, "config.json");
  yield* fileSystem.writeFileString(configPath, JSON.stringify(stored));
  // As a file made by hand would be: readable by everyone.
  yield* fileSystem.chmod(configPath, 0o644);
  const calls: Array<Call> = [];
  const controller = yield* Effect.acquireRelease(
    Effect.promise(() =>
      startPrivacyController({
        dataDirectory: directory,
        cloudUrl: "http://cloud.test",
        sleep: () => Promise.resolve(),
        fetch: (async (input: string | URL | Request, init?: RequestInit) => {
          const url = new URL(String(input));
          const call: Call = {
            method: init?.method ?? "GET",
            host: url.host,
            path: url.pathname,
            headers: new Headers(init?.headers),
            body: typeof init?.body === "string" ? JSON.parse(init.body) : null,
          };
          calls.push(call);
          const reply = routes[`${call.method} ${call.host}${call.path}`]?.(call) ?? {
            status: 404,
            body: { error: { code: "not_found", message: "No such route." } },
          };
          return Response.json(reply.body, { status: reply.status ?? 200 });
        }) as typeof fetch,
      }),
    ),
    (running) => Effect.promise(() => running.close()),
  );
  const service = serviceOver(controller, {
    routingChanges: Stream.empty,
    sealedChanges: Stream.empty,
  });
  return {
    controller,
    calls,
    callsTo: (host: string) => calls.filter((call) => call.host === host),
    configPath,
    stored: fileSystem
      .readFileString(configPath)
      .pipe(Effect.map((text): Record<string, any> => JSON.parse(text))),
    status: Effect.map(service.status, encodeStatus),
    providers: Effect.map(service.providers, encodeProviders),
    /** What `POST /api/privacy/providers` answers. */
    configure: (payload: unknown) =>
      Effect.gen(function* () {
        const result = yield* service.configureProvider(decodeRequest(payload));
        return encodeResult({
          ...result,
          providers: yield* service.providers,
          status: yield* service.status,
        });
      }),
    /** What `POST /api/privacy/providers/test` answers. */
    test: (payload: unknown) =>
      Effect.map(service.testProvider(decodeRequest(payload)), encodeHealth),
  };
});

const SIGNED_IN = {
  mode: "cloud",
  token: "dd_account_token",
  accountId: "acct_1",
  accountLabel: "sara@example.com",
};

const CLOUD_ACCOUNT = {
  "GET cloud.test/v1/me": () => ({
    body: { account: { id: "acct_1", email: "sara@example.com" } },
  }),
};

/** A worker that answers the connection test's one question. */
const WORKER_ANSWER = {
  body: {
    choices: [
      {
        finish_reason: "stop",
        message: { content: '{"word":{"quote":"is heron","value":"heron"}}' },
      },
    ],
  },
};

it.layer(NodeServices.layer)("the three services, each chosen on its own", (it) => {
  it.effect(
    "uses Presidio for detection and an own worker while DoeDesk Cloud still reads documents",
    () =>
      Effect.gen(function* () {
        const harness = yield* makeService(SIGNED_IN, {
          ...CLOUD_ACCOUNT,
          "POST cloud.test/v1/ocr": () => ({ body: { text: "Owner Khalid Alharbi", pages: 1 } }),
          "POST presidio.test/analyze": (call) => {
            const text = String((call.body as { text?: unknown }).text ?? "");
            const start = text.indexOf("Khalid Alharbi");
            return {
              body:
                start < 0 ? [] : [{ entity_type: "PERSON", start, end: start + 14, score: 0.9 }],
            };
          },
          "POST llm.test/v1/chat/completions": () => WORKER_ANSWER,
        });

        const before = yield* harness.status;
        expect(before.providers).toEqual({
          ocr: { provider: "doedeskCloud", ready: true },
          detect: { provider: "doedeskCloud", ready: true },
          worker: { provider: "off", ready: true },
        });

        const detect = yield* harness.configure({
          service: "detect",
          provider: "presidio",
          settings: { endpoint: "http://presidio.test", language: "en" },
          secrets: { apiKey: "presidio-key-1" },
        });
        expect(detect).toMatchObject({ ok: true, message: null, health: { ok: true, kind: "ok" } });
        const worker = yield* harness.configure({
          service: "worker",
          provider: "openaiCompatible",
          settings: { baseUrl: "http://llm.test/v1", model: "small-model" },
        });
        expect(worker).toMatchObject({ ok: true, message: null });

        // The account is still signed in, and each service is the one chosen for it.
        expect(worker.status).toMatchObject({
          mode: "cloud",
          accountLabel: "sara@example.com",
          providers: {
            ocr: { provider: "doedeskCloud", ready: true },
            detect: { provider: "presidio", ready: true },
            worker: { provider: "openaiCompatible", ready: true },
          },
          worker: { kind: "custom", address: "http://llm.test/v1", model: "small-model" },
        });
        expect(yield* harness.stored).toMatchObject({ mode: "cloud", token: "dd_account_token" });

        // One file: read by DoeDesk Cloud with the account's token, checked by Presidio with its key.
        harness.calls.length = 0;
        const read = yield* Effect.promise(() =>
          harness.controller.readMasked(Buffer.from("a scanned page"), "image/png"),
        );
        expect(read.ok && read.text).toMatch(/^Owner \[PERSON_\w{5}\]$/);
        const [ocr] = harness.callsTo("cloud.test").filter((call) => call.path === "/v1/ocr");
        expect(ocr?.headers.get("authorization")).toBe("Bearer dd_account_token");
        expect(harness.calls.some((call) => call.path === "/v1/detect")).toBe(false);
        const analyzed = harness.callsTo("presidio.test");
        expect(analyzed.length).toBeGreaterThan(0);
        expect(
          analyzed.every((call) => call.headers.get("authorization") === "Bearer presidio-key-1"),
        ).toBe(true);
        // The account's token goes to DoeDesk Cloud and nowhere else.
        expect(
          harness.calls
            .filter((call) => call.host !== "cloud.test")
            .some((call) => JSON.stringify([...call.headers]).includes("dd_account_token")),
        ).toBe(false);
      }).pipe(Effect.scoped),
  );

  it.effect("needs no account: signed out, own services turn masking on", () =>
    Effect.gen(function* () {
      const harness = yield* makeService(
        { mode: "unconfigured" },
        { "POST presidio.test/analyze": () => ({ body: [] }) },
      );
      expect(yield* harness.status).toMatchObject({
        mode: "unconfigured",
        providers: { detect: { provider: "doedeskCloud", ready: false } },
      });

      const result = yield* harness.configure({
        service: "detect",
        provider: "presidio",
        settings: { endpoint: "http://presidio.test" },
      });
      expect(result).toMatchObject({ ok: true });
      expect(result.status).toMatchObject({
        mode: "selfHosted",
        accountLabel: null,
        endpoint: "http://presidio.test",
        providers: {
          ocr: { provider: "doedeskCloud", ready: false },
          detect: { provider: "presidio", ready: true },
        },
      });
      // Rules that run on this computer need nothing at all, and nothing is asked of anyone.
      harness.calls.length = 0;
      expect(yield* harness.configure({ service: "detect", provider: "localOnly" })).toMatchObject({
        ok: true,
        status: { mode: "selfHosted" },
      });
      expect(harness.calls).toEqual([]);
    }).pipe(Effect.scoped),
  );

  it.effect("does not store a service that does not answer, and keeps the one in use", () =>
    Effect.gen(function* () {
      const harness = yield* makeService(SIGNED_IN, {
        ...CLOUD_ACCOUNT,
        "POST presidio.test/analyze": () => ({ status: 401, body: { error: "bad key" } }),
      });
      const result = yield* harness.configure({
        service: "detect",
        provider: "presidio",
        settings: { endpoint: "http://presidio.test" },
        secrets: { apiKey: "presidio-key-1" },
      });
      expect(result).toMatchObject({ ok: false, health: { ok: false, kind: "auth", status: 401 } });
      expect(result.status.providers?.detect).toEqual({ provider: "doedeskCloud", ready: true });
      expect((yield* harness.stored).providers).toBeUndefined();

      expect(
        yield* harness.configure({ service: "ocr", provider: "azureDocumentIntelligence" }),
      ).toMatchObject({ ok: false, message: "Enter Resource endpoint." });
      expect(yield* harness.configure({ service: "ocr", provider: "noSuchService" })).toMatchObject(
        {
          ok: false,
        },
      );
      // DoeDesk Cloud's worker is still refused to an account that does not have it.
      expect(
        yield* harness.configure({ service: "worker", provider: "doedeskCloud" }),
      ).toMatchObject({
        ok: false,
        message: expect.stringContaining("not included in this account"),
      });
    }).pipe(Effect.scoped),
  );
});

it.layer(NodeServices.layer)("one's own service in place of an account", (it) => {
  it.effect("signs the account out, as the welcome page and the Terms sheet expect", () =>
    Effect.gen(function* () {
      const harness = yield* makeService(SIGNED_IN, {
        ...CLOUD_ACCOUNT,
        "POST cloud.test/v1/auth/sign-out": () => ({ body: {} }),
        "POST detector.test/v1/detect": (call) => ({
          body: {
            results: (call.body as { texts: ReadonlyArray<string> }).texts.map(() => ({
              entities: [],
            })),
          },
        }),
        "POST llm.test/v1/chat/completions": () => WORKER_ANSWER,
      });
      yield* harness.configure({
        service: "worker",
        provider: "openaiCompatible",
        settings: { baseUrl: "http://llm.test/v1", model: "small-model" },
      });
      const outcome = yield* Effect.promise(() =>
        harness.controller.configure({ mode: "selfHosted", endpoint: "http://detector.test/" }),
      );
      expect(outcome).toEqual({ ok: true, message: null });
      expect(harness.callsTo("cloud.test").some((call) => call.path === "/v1/auth/sign-out")).toBe(
        true,
      );
      expect(yield* harness.status).toMatchObject({
        mode: "selfHosted",
        accountLabel: null,
        acceptance: null,
        endpoint: "http://detector.test",
        providers: {
          ocr: { provider: "custom", ready: true },
          detect: { provider: "custom", ready: true },
          // The worker was chosen on its own, and stays.
          worker: { provider: "openaiCompatible", ready: true },
        },
      });
      expect(yield* harness.stored).not.toHaveProperty("token");

      // Disconnecting it leaves nothing to detect with, and the worker as it was.
      yield* Effect.promise(() => harness.controller.configure({ mode: "unconfigured" }));
      expect(yield* harness.status).toMatchObject({
        mode: "unconfigured",
        providers: {
          ocr: { provider: "doedeskCloud", ready: false },
          detect: { provider: "doedeskCloud", ready: false },
          worker: { provider: "openaiCompatible", ready: true },
        },
      });
    }).pipe(Effect.scoped),
  );
});

it.layer(NodeServices.layer)("a service's secrets", (it) => {
  it.effect("are kept in config.json alone: never in the status, the providers or an answer", () =>
    Effect.gen(function* () {
      const harness = yield* makeService(SIGNED_IN, {
        ...CLOUD_ACCOUNT,
        "POST azure.test/language/:analyze-text": () => ({
          body: { results: { documents: [{ id: "0", entities: [] }], errors: [] } },
        }),
        "POST presidio.test/analyze": () => ({ body: [] }),
      });
      const saved = yield* harness.configure({
        service: "detect",
        provider: "azureLanguagePii",
        settings: { endpoint: "http://azure.test", language: "ar" },
        secrets: { apiKey: "azure-key-1" },
      });
      expect(saved).toMatchObject({ ok: true });
      expect(saved.providers.detect.config).toEqual({
        provider: "azureLanguagePii",
        settings: { endpoint: "http://azure.test", language: "ar" },
        secretsSet: { apiKey: true },
      });

      const sent = JSON.stringify([saved, yield* harness.status, yield* harness.providers]);
      for (const secret of SECRETS) expect(sent).not.toContain(secret);
      // DoeDesk Cloud asks for nothing to be typed: its one secret is the sign-in.
      expect(saved.providers.ocr.config).toEqual({
        provider: "doedeskCloud",
        settings: {},
        secretsSet: {},
      });

      expect((yield* harness.stored).providers.detect.secrets).toEqual({ apiKey: "azure-key-1" });
      if ((yield* HostProcess.Platform) !== "win32") {
        // The file was readable by everyone before it held a key.
        const fileSystem = yield* FileSystem.FileSystem;
        expect((yield* fileSystem.stat(harness.configPath)).mode & 0o777).toBe(0o600);
      }

      // Changing a setting without typing the key again keeps the key.
      const changed = yield* harness.configure({
        service: "detect",
        provider: "azureLanguagePii",
        settings: { endpoint: "http://azure.test", language: "en", domain: "phi" },
      });
      expect(changed).toMatchObject({ ok: true });
      expect(changed.providers.detect.config).toMatchObject({
        settings: { language: "en", domain: "phi" },
        secretsSet: { apiKey: true },
      });
      expect((yield* harness.stored).providers.detect.secrets).toEqual({ apiKey: "azure-key-1" });
      const last = harness.callsTo("azure.test").at(-1);
      expect(last?.headers.get("ocp-apim-subscription-key")).toBe("azure-key-1");

      // Another provider does not inherit it, and null removes a key that was stored.
      yield* harness.configure({
        service: "detect",
        provider: "presidio",
        settings: { endpoint: "http://presidio.test" },
        secrets: { apiKey: "presidio-key-1" },
      });
      expect((yield* harness.stored).providers.detect.secrets).toEqual({
        apiKey: "presidio-key-1",
      });
      const removed = yield* harness.configure({
        service: "detect",
        provider: "presidio",
        settings: { endpoint: "http://presidio.test" },
        secrets: { apiKey: null },
      });
      expect(removed.providers.detect.config.secretsSet).toEqual({ apiKey: false });
      expect((yield* harness.stored).providers.detect.secrets).toEqual({});
      expect(harness.callsTo("presidio.test").at(-1)?.headers.has("authorization")).toBe(false);
    }).pipe(Effect.scoped),
  );
});

it.layer(NodeServices.layer)(
  "a config.json from before the services were chosen one by one",
  (it) => {
    it.effect(
      "reads one's own detection service as detection and reading, and the worker as it was",
      () =>
        Effect.gen(function* () {
          const harness = yield* makeService(
            {
              mode: "selfHosted",
              endpoint: "http://detector.test",
              token: "svc-token",
              worker: {
                kind: "custom",
                baseUrl: "http://llm.test/v1",
                apiKey: "sk-legacy",
                model: "small-model",
                driver: "responses",
                structured: "jsonObject",
              },
              directProviders: ["codex"],
              imageHandling: "text",
            },
            {
              "POST detector.test/v1/ocr": () => ({ body: { text: "Owner Khalid Alharbi" } }),
              "POST detector.test/v1/detect": (call) => ({
                body: {
                  results: (call.body as { texts: ReadonlyArray<string> }).texts.map((text) => {
                    const start = text.indexOf("Khalid Alharbi");
                    return {
                      entities: start < 0 ? [] : [{ start, end: start + 14, kind: "PERSON" }],
                    };
                  }),
                },
              }),
            },
          );
          expect(yield* harness.status).toMatchObject({
            mode: "selfHosted",
            endpoint: "http://detector.test",
            accountLabel: null,
            directProviders: ["codex"],
            imageHandling: "text",
            providers: {
              ocr: { provider: "custom", ready: true },
              detect: { provider: "custom", ready: true },
              worker: { provider: "openaiCompatible", ready: true },
            },
            worker: {
              kind: "custom",
              address: "http://llm.test/v1",
              model: "small-model",
              driver: "responses",
            },
          });
          const providers = yield* harness.providers;
          expect(providers.detect.config).toEqual({
            provider: "custom",
            settings: { endpoint: "http://detector.test" },
            secretsSet: { token: true },
          });
          expect(providers.worker.config).toEqual({
            provider: "openaiCompatible",
            settings: { baseUrl: "http://llm.test/v1", model: "small-model", driver: "responses" },
            secretsSet: { apiKey: true, headers: false },
          });

          // The service still reads and checks, with the token it had.
          const read = yield* Effect.promise(() =>
            harness.controller.readMasked(Buffer.from("a page"), "image/png"),
          );
          expect(read.ok && read.text).toMatch(/^Owner \[PERSON_\w{5}\]$/);
          expect(
            harness
              .callsTo("detector.test")
              .every((call) => call.headers.get("authorization") === "Bearer svc-token"),
          ).toBe(true);

          // The next change writes the file in the new shape, with nothing of the old one left.
          harness.controller.setPreference({ kind: "readingTool", offered: true });
          const stored = yield* harness.stored;
          expect(stored).toMatchObject({
            mode: "unconfigured",
            providers: {
              ocr: {
                provider: "custom",
                settings: { endpoint: "http://detector.test" },
                secrets: { token: "svc-token" },
              },
              detect: { provider: "custom", secrets: { token: "svc-token" } },
              worker: {
                provider: "openaiCompatible",
                settings: { structured: "jsonObject" },
                secrets: { apiKey: "sk-legacy" },
              },
            },
          });
          for (const gone of ["endpoint", "token", "worker", "workerChoice"]) {
            expect(stored).not.toHaveProperty(gone);
          }
        }).pipe(Effect.scoped),
    );

    it.effect("keeps a DoeDesk Cloud sign-in, its worker and sealed files as they were", () =>
      Effect.gen(function* () {
        const hostedWorker = {
          available: true,
          model: "region-model",
          structured: "jsonObject",
          parallel: null,
          maxWaitSeconds: null,
        };
        const harness = yield* makeService(
          {
            ...SIGNED_IN,
            accountRegion: "sa",
            hostedWorkerEntitled: true,
            hostedWorker,
            workerChoice: "cloud",
          },
          {
            "GET cloud.test/v1/me": () => ({
              body: {
                account: { id: "acct_1", email: "sara@example.com", region: "sa" },
                worker: { entitled: true, ...hostedWorker },
              },
            }),
          },
        );
        expect(yield* harness.status).toMatchObject({
          mode: "cloud",
          accountLabel: "sara@example.com",
          accountId: "acct_1",
          hostedWorkerEntitled: true,
          providers: {
            ocr: { provider: "doedeskCloud", ready: true },
            detect: { provider: "doedeskCloud", ready: true },
            worker: { provider: "doedeskCloud", ready: true },
          },
          worker: { kind: "cloud", address: "http://cloud.test/v1/worker", region: "sa" },
        });

        // Signing out leaves the choices, and DoeDesk Cloud's then wait for an account.
        yield* Effect.promise(() => harness.controller.configure({ mode: "unconfigured" }));
        expect(yield* harness.status).toMatchObject({
          mode: "unconfigured",
          accountLabel: null,
          providers: {
            detect: { provider: "doedeskCloud", ready: false },
            worker: { provider: "doedeskCloud", ready: false },
          },
          worker: { kind: "off" },
        });
        expect(yield* harness.stored).not.toHaveProperty("token");
      }).pipe(Effect.scoped),
    );
  },
);

it.layer(NodeServices.layer)("testing a service's connection", (it) => {
  it.effect("says how the service answered, and stores nothing", () =>
    Effect.gen(function* () {
      let key = "presidio-key-1";
      const harness = yield* makeService(
        { mode: "unconfigured" },
        {
          "POST presidio.test/analyze": (call) =>
            call.headers.get("authorization") === `Bearer ${key}`
              ? { body: [] }
              : { status: 401, body: { error: "bad key" } },
          "POST llm.test/v1/chat/completions": () => WORKER_ANSWER,
        },
      );
      const draft = {
        service: "detect",
        provider: "presidio",
        settings: { endpoint: "http://presidio.test" },
        secrets: { apiKey: "presidio-key-1" },
      };
      const ok = yield* harness.test(draft);
      expect(ok).toMatchObject({ ok: true, kind: "ok", host: "presidio.test" });
      expect(Number.isInteger(ok.latencyMs)).toBe(true);
      expect((yield* harness.stored).providers).toBeUndefined();
      expect((yield* harness.status).mode).toBe("unconfigured");

      expect(yield* harness.test({ ...draft, secrets: { apiKey: "wrong" } })).toMatchObject({
        ok: false,
        kind: "auth",
        status: 401,
        host: "presidio.test",
      });
      expect(
        yield* harness.test({ ...draft, settings: { endpoint: "http://nowhere.test" } }),
      ).toMatchObject({ ok: false });
      expect(yield* harness.test({ ...draft, settings: {} })).toMatchObject({
        ok: false,
        kind: "misconfigured",
        message: "Enter Analyzer address.",
      });

      // A stored key is used for a test that does not send one.
      yield* harness.configure(draft);
      expect(yield* harness.test({ ...draft, secrets: {} })).toMatchObject({ ok: true });
      key = "rotated";
      expect(yield* harness.test({ ...draft, secrets: {} })).toMatchObject({
        ok: false,
        kind: "auth",
      });

      // DoeDesk Cloud cannot be tested with nobody signed in, and nothing is sent to find out.
      harness.calls.length = 0;
      expect(yield* harness.test({ service: "ocr", provider: "doedeskCloud" })).toMatchObject({
        ok: false,
        kind: "auth",
      });
      expect(harness.calls).toEqual([]);

      // What a worker's test also learns about the server stays on the server.
      const worker = yield* harness.test({
        service: "worker",
        provider: "openaiCompatible",
        settings: { baseUrl: "http://llm.test/v1", model: "small-model" },
      });
      expect(worker).toMatchObject({ ok: true, kind: "ok" });
      expect(Object.keys(worker).toSorted()).toEqual([
        "host",
        "kind",
        "latencyMs",
        "message",
        "ok",
      ]);
      expect(yield* harness.test({ service: "worker", provider: "off" })).toMatchObject({
        ok: true,
      });
      expect((yield* harness.status).providers?.worker).toEqual({ provider: "off", ready: true });
    }).pipe(Effect.scoped),
  );
});
