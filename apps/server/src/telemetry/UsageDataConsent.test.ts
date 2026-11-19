import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import type { ManagedPolicyDocument } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";

import * as ServerConfig from "../config.ts";
import * as ManagedPolicy from "../policy/ManagedPolicy.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as UsageDataConsent from "./UsageDataConsent.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const CHOICE = { wordingId: "usage-data-2026-11", locale: "en" } as const;
const NOTICE = { wordingId: "usage-data-notice-2026-11", locale: "ar" } as const;
const SAUDI = { locale: "ar-SA", timeZone: "Asia/Riyadh" };

interface Installation {
  /** What DoeDesk Cloud answers for the country of the connection. "down": it does not answer. */
  network: "ask" | "notice" | "down" | "unreadable";
  /** Whether the address the choice is reported to answers. */
  ingestUp: boolean;
  readonly choices: Array<Record<string, unknown>>;
  readonly asked: Array<{ readonly url: string; readonly headers: Record<string, string> }>;
}

/** One installation: its folder, and stand-ins for DoeDesk Cloud's two addresses. */
const installation = (network: Installation["network"] = "notice"): Installation => ({
  network,
  ingestUp: true,
  choices: [],
  asked: [],
});

const layerFor = (
  on: Installation,
  baseDir: string,
  options: {
    readonly setting?: boolean;
    readonly policy?: ManagedPolicyDocument;
    readonly environment?: NodeJS.ProcessEnv;
    readonly hostTimeZone?: string | null;
  } = {},
) => {
  const client = HttpClient.make((request) =>
    Effect.sync(() => {
      const answer = (status: number, body: unknown = {}) =>
        HttpClientResponse.fromWeb(request, Response.json(body, { status }));
      if (request.url.endsWith("/v1/auth/options")) {
        on.asked.push({ url: request.url, headers: { ...request.headers } });
        if (on.network === "down") return answer(503);
        if (on.network === "unreadable") return answer(200, { usageData: "sometimes" });
        return answer(200, { usageData: on.network, usageDataConsentRegions: ["DE", "CA-QC"] });
      }
      if (!on.ingestUp) return answer(503);
      if (request.body._tag === "Uint8Array") {
        on.choices.push(JSON.parse(new TextDecoder().decode(request.body.body)));
      }
      return answer(200, { ok: true });
    }),
  );
  return UsageDataConsent.layer.pipe(
    Layer.provide(ServerConfig.ServerConfig.layerTest(process.cwd(), baseDir)),
    Layer.provide(
      ConfigProvider.layer(
        ConfigProvider.fromUnknown({
          T3CODE_POSTHOG_HOST: "http://ingest.test",
          DOEDESK_CLOUD_URL: "http://cloud.test",
        }),
      ),
    ),
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(HttpClient.HttpClient, client),
        Layer.succeed(HostProcess.Environment, options.environment ?? {}),
        Layer.succeed(UsageDataConsent.HostTimeZone, options.hostTimeZone ?? "Asia/Riyadh"),
        ManagedPolicy.layerTest(options.policy),
        ServerSettings.ServerSettingsService.layerTest({
          usageDataEnabled: options.setting ?? true,
        }),
      ),
    ),
  );
};

const folder = Effect.flatMap(FileSystem.FileSystem, (fileSystem) =>
  fileSystem.makeTempDirectoryScoped({ prefix: "t3-usage-data-" }),
);

/** Runs `program` as one run of the app on `baseDir`; a second call is the next start. */
const start = <A, E>(
  on: Installation,
  baseDir: string,
  program: (consent: UsageDataConsent.UsageDataConsent["Service"]) => Effect.Effect<A, E>,
  options?: Parameters<typeof layerFor>[2],
) =>
  Effect.gen(function* () {
    const consent = yield* UsageDataConsent.UsageDataConsent;
    const result = yield* program(consent);
    yield* consent.reported;
    return result;
  }).pipe(Effect.provide(layerFor(on, baseDir, options)), Effect.scoped);

it.layer(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))("usage data", (it) => {
  it.effect("asks first where the law requires it, and sends nothing until the box is ticked", () =>
    Effect.gen(function* () {
      const here = installation("ask");
      const baseDir = yield* folder;
      yield* start(here, baseDir, (consent) =>
        Effect.gen(function* () {
          const decided = yield* consent.decide(SAUDI);
          assert.deepInclude(decided, { state: "unset", basis: "ask", installId: null });
          assert.isTrue(Option.isNone(yield* consent.sending));
          // The request that asks names nobody: no sign-in, no identifier.
          assert.equal(here.asked[0]?.url, "http://cloud.test/v1/auth/options");
          assert.notProperty(here.asked[0]?.headers, "authorization");

          const agreed = yield* consent.choose({ on: true, ...CHOICE });
          assert.deepInclude(agreed, { state: "on_consented", basis: "ask", sending: true });
          assert.match(agreed.installId ?? "", UUID);
          const sending = Option.getOrThrow(yield* consent.sending);
          assert.equal(sending.installId, agreed.installId);
          assert.equal(sending.consent?.wordingId, "usage-data-2026-11");
        }),
      );
      assert.lengthOf(here.choices, 1);
      assert.deepInclude(here.choices[0], {
        api_key: "doedesk-client",
        state: "on_consented",
        wordingId: "usage-data-2026-11",
        basis: "ask",
        signal: "network",
        locale: "en",
      });
      assert.match(String(here.choices[0]?.installId), UUID);
      assert.notProperty(here.choices[0], "token");
    }),
  );

  it.effect("treats no answer, and an answer it cannot read, as a place that asks first", () =>
    Effect.gen(function* () {
      for (const network of ["down", "unreadable"] as const) {
        const here = installation(network);
        const decided = yield* start(here, yield* folder, (consent) => consent.decide(SAUDI));
        assert.deepInclude(decided, { state: "unset", basis: "ask", sending: false });
      }
    }),
  );

  it.effect("asks first when the device is in a listed place though the connection is not", () =>
    Effect.gen(function* () {
      const decided = yield* start(installation("notice"), yield* folder, (consent) =>
        consent.decide({ locale: "en-US", timeZone: "Europe/Berlin" }),
      );
      assert.equal(decided.basis, "ask");
      const byServer = yield* start(
        installation("notice"),
        yield* folder,
        (consent) => consent.decide(SAUDI),
        { hostTimeZone: "Europe/Berlin" },
      );
      assert.equal(byServer.basis, "ask");
    }),
  );

  it.effect("is on by default elsewhere, but only once the notice has been shown", () =>
    Effect.gen(function* () {
      const here = installation("notice");
      yield* start(here, yield* folder, (consent) =>
        Effect.gen(function* () {
          const decided = yield* consent.decide(SAUDI);
          assert.deepInclude(decided, { state: "unset", basis: "notice", sending: false });
          assert.isTrue(Option.isNone(yield* consent.sending));

          const shown = yield* consent.noticeShown(NOTICE);
          assert.deepInclude(shown, { state: "on_by_default_notice_shown", sending: true });
          // Nobody agreed to anything, so no event claims that someone did.
          assert.isUndefined(Option.getOrThrow(yield* consent.sending).consent);
        }),
      );
      assert.deepInclude(here.choices[0], {
        state: "on_by_default_notice_shown",
        wordingId: "usage-data-notice-2026-11",
        basis: "notice",
        locale: "ar",
      });
    }),
  );

  it.effect("does not turn itself on from a notice where the rule is to ask", () =>
    Effect.gen(function* () {
      const shown = yield* start(installation("ask"), yield* folder, (consent) =>
        Effect.andThen(consent.decide(SAUDI), consent.noticeShown(NOTICE)),
      );
      assert.deepInclude(shown, { state: "unset", installId: null, sending: false });
    }),
  );

  it.effect(
    "pauses and asks when usage data is on by default and the place now needs agreement",
    () =>
      Effect.gen(function* () {
        const here = installation("notice");
        const baseDir = yield* folder;
        const before = yield* start(here, baseDir, (consent) =>
          Effect.andThen(consent.decide(SAUDI), consent.noticeShown(NOTICE)),
        );
        here.network = "ask";
        const after = yield* start(here, baseDir, (consent) => consent.decide(SAUDI));

        assert.deepInclude(after, {
          state: "unset",
          basis: "ask",
          installId: null,
          sending: false,
        });
        // The old identifier's last word is that it was switched off.
        assert.deepInclude(here.choices.at(-1), { state: "off", installId: before.installId });
      }),
  );

  it.effect("keeps the person's own choice wherever they go", () =>
    Effect.gen(function* () {
      const here = installation("notice");
      const baseDir = yield* folder;
      const agreed = yield* start(here, baseDir, (consent) =>
        Effect.andThen(consent.decide(SAUDI), consent.choose({ on: true, ...CHOICE })),
      );
      here.network = "ask";
      const moved = yield* start(here, baseDir, (consent) => consent.decide(SAUDI));
      assert.deepInclude(moved, { state: "on_consented", installId: agreed.installId });

      const declined = yield* start(here, baseDir, (consent) =>
        consent.choose({ on: false, ...CHOICE }),
      );
      here.network = "notice";
      const back = yield* start(here, baseDir, (consent) =>
        Effect.andThen(consent.decide(SAUDI), consent.noticeShown(NOTICE)),
      );
      assert.deepInclude(declined, { state: "off", installId: null });
      // Off never becomes on by itself, even where on is the default.
      assert.deepInclude(back, { state: "off", installId: null, sending: false });
    }),
  );

  it.effect("stops and discards the identifier when the settings file turns usage data off", () =>
    Effect.gen(function* () {
      const here = installation("notice");
      const baseDir = yield* folder;
      const agreed = yield* start(here, baseDir, (consent) =>
        consent.choose({ on: true, ...CHOICE }),
      );
      const next = yield* start(
        here,
        baseDir,
        (consent) => Effect.all({ status: consent.status, sending: consent.sending }),
        { setting: false },
      );
      assert.deepInclude(next.status, { state: "off", installId: null, sending: false });
      assert.isTrue(Option.isNone(next.sending));
      assert.deepInclude(here.choices.at(-1), { state: "off", installId: agreed.installId });
    }),
  );

  it.effect("leaves an installation that had usage data off as it was, without asking", () =>
    Effect.gen(function* () {
      const status = yield* start(
        installation("notice"),
        yield* folder,
        (consent) => Effect.andThen(consent.decide(SAUDI), consent.noticeShown(NOTICE)),
        { setting: false },
      );
      assert.deepInclude(status, { state: "off", installId: null, sending: false });
    }),
  );

  it.effect("discards the identifier an older app kept, and asks before making a new one", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const here = installation("notice");
      const baseDir = yield* folder;
      // The first start lays out the folder; the old file is put where an older app left it.
      yield* start(here, baseDir, () => Effect.void);
      const { anonymousIdPath } = yield* ServerConfig.ServerConfig.pipe(
        Effect.provide(ServerConfig.ServerConfig.layerTest(process.cwd(), baseDir)),
      );
      yield* fileSystem.writeFileString(anonymousIdPath, "4d0a1f0e-old-identifier");

      const status = yield* start(here, baseDir, (consent) => consent.decide(SAUDI));
      assert.deepInclude(status, { state: "unset", installId: null, sending: false });
      assert.isFalse(yield* fileSystem.exists(anonymousIdPath));
      assert.deepEqual(here.choices, []);
    }),
  );

  it.effect("tells the service about a choice later when it could not be told at once", () =>
    Effect.gen(function* () {
      const here = installation("notice");
      here.ingestUp = false;
      const baseDir = yield* folder;
      const agreed = yield* start(here, baseDir, (consent) =>
        consent.choose({ on: true, ...CHOICE }),
      );
      assert.deepEqual(here.choices, []);

      here.ingestUp = true;
      yield* start(here, baseDir, (consent) => consent.decide(SAUDI));
      assert.lengthOf(here.choices, 1);
      assert.deepInclude(here.choices[0], { state: "on_consented", installId: agreed.installId });
    }),
  );

  it.effect("cannot be turned on while a policy or the environment turns it off", () =>
    Effect.gen(function* () {
      const policy = {
        schemaVersion: 1,
        organization: "Example Corp",
        limits: { telemetry: false },
      } as const;
      const here = installation("notice");
      const byPolicy = yield* start(
        here,
        yield* folder,
        (consent) => consent.choose({ on: true, ...CHOICE }),
        { policy },
      );
      assert.deepInclude(byPolicy, { state: "unset", blockedBy: "policy", sending: false });
      assert.deepEqual(here.choices, []);
    }),
  );
});
