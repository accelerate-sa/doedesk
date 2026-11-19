import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { startPrivacyController } from "@t3tools/privacy-gateway";
import {
  mergeProviderInstanceEnvironment,
  setProviderEnvironmentOverlay,
} from "@t3tools/provider-core/server/instanceEnvironment";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { codexAppServerArgs } from "../provider/codexLaunchArgs.ts";
import { mergeClaudeProcessEnvironment } from "../provider/Drivers/ClaudeHome.ts";
import { evaluationOptionsFromEnvironment } from "./PrivacyGateway.ts";

describe("evaluationOptionsFromEnvironment", () => {
  it("is off unless a DOEDESK_EVAL variable asks for it", () => {
    expect(evaluationOptionsFromEnvironment({})).toBeUndefined();
    expect(
      evaluationOptionsFromEnvironment({
        DOEDESK_EVAL_OCR_ONLY: "0",
        DOEDESK_EVAL_SENT_BODIES_FILE: "  ",
        DOEDESK_CLOUD_URL: "https://example.test",
      }),
    ).toBeUndefined();
    expect(
      evaluationOptionsFromEnvironment({
        DOEDESK_EVAL_OCR_ONLY: "1",
        DOEDESK_EVAL_SENT_BODIES_FILE: "/tmp/sent.ndjson",
      }),
    ).toEqual({ attachmentsOnly: true, sentBodiesPath: "/tmp/sent.ndjson", eventsPath: undefined });
  });
});

/** The controller as the server starts it, with the choice already stored on disk. */
const withController = Effect.fn("test.withController")(function* (
  stored: Record<string, unknown>,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "doedesk-privacy-" });
  yield* fileSystem.writeFileString(path.join(directory, "config.json"), JSON.stringify(stored));
  const controller = yield* Effect.acquireRelease(
    Effect.promise(() =>
      startPrivacyController({ dataDirectory: directory, cloudUrl: "http://127.0.0.1:9" }),
    ),
    (running) =>
      Effect.promise(() => {
        setProviderEnvironmentOverlay(undefined);
        return running.close();
      }),
  );
  setProviderEnvironmentOverlay(controller.environmentFor);
  return { controller };
});

const HOST = { PATH: "/usr/bin", HOME: "/home/ada", LANG: "en_GB.UTF-8" };
/** Any variable that would put something between the vendor's tool and the vendor. */
const ROUTING = /PROXY|_CA_|CERT|BASE_URL|DISABLE_|DO_NOT_TRACK/i;

it.layer(NodeServices.layer)("what the vendor's tool is started with", (it) => {
  it.effect("with masking off: exactly what it gets without the gateway", () =>
    Effect.gen(function* () {
      // Without DoeDesk's gateway: no overlay is installed at all.
      setProviderEnvironmentOverlay(undefined);
      const claudeWithout = yield* mergeClaudeProcessEnvironment(undefined, HOST);
      const codexWithout = yield* mergeProviderInstanceEnvironment(undefined, HOST, "codex");

      yield* withController({ mode: "off" });
      const claude = yield* mergeClaudeProcessEnvironment(undefined, HOST);
      const codex = yield* mergeProviderInstanceEnvironment(undefined, HOST, "codex");

      expect(claude).toEqual(claudeWithout);
      expect(codex).toEqual(HOST);
      expect(codex).toEqual(codexWithout);
      // Claude is given one variable beyond the host's: the documented app name.
      expect(Object.keys(claude).filter((name) => !(name in HOST))).toEqual([
        "CLAUDE_AGENT_SDK_CLIENT_APP",
      ]);
      for (const environment of [claude, codex]) {
        expect(Object.keys(environment).filter((name) => ROUTING.test(name))).toEqual([]);
      }
      // The gateway never changed how Codex is started: no base URL or provider override.
      expect(codexAppServerArgs().join(" ")).not.toMatch(/base_url|model_provider|proxy|ca_/i);
    }).pipe(Effect.scoped),
  );

  it.effect("with masking on: the gateway, for the providers the user did not switch off", () =>
    Effect.gen(function* () {
      const { controller } = yield* withController({ mode: "unconfigured" });
      const claude = yield* mergeClaudeProcessEnvironment(undefined, HOST);
      expect(claude.HTTPS_PROXY).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
      expect(claude.NODE_EXTRA_CA_CERTS).toBeDefined();

      controller.setPreference({ kind: "providerRoute", provider: "claudeAgent", direct: true });
      expect(yield* mergeClaudeProcessEnvironment(undefined, HOST)).toEqual({
        ...HOST,
        CLAUDE_AGENT_SDK_CLIENT_APP: claude.CLAUDE_AGENT_SDK_CLIENT_APP,
      });
      expect(
        (yield* mergeProviderInstanceEnvironment(undefined, HOST, "codex")).HTTPS_PROXY,
      ).toBeDefined();
    }).pipe(Effect.scoped),
  );
});
