import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { startPrivacyController } from "@t3tools/privacy-gateway";
import {
  mergeProviderInstanceEnvironment,
  providerRequestsMasked,
  setProviderEnvironmentOverlay,
} from "@t3tools/provider-core/server/instanceEnvironment";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";

import { codexAppServerArgs } from "../provider/codexLaunchArgs.ts";
import { mergeClaudeProcessEnvironment } from "../provider/Drivers/ClaudeHome.ts";
import {
  evaluationOptionsFromEnvironment,
  makeSealedChanges,
  recordTurnWith,
  turnRecordOf,
  sealedAskFreelyFromEnvironment,
} from "./PrivacyGateway.ts";

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
    ).toEqual({
      attachmentsOnly: true,
      sentBodiesPath: "/tmp/sent.ndjson",
      eventsPath: undefined,
      workerPath: undefined,
      otherHostsPath: undefined,
      workerUnchecked: false,
      workerFreeText: false,
    });
    // A switch that weakens the worker is enough to turn evaluation on, and "0" is not.
    expect(
      evaluationOptionsFromEnvironment({ DOEDESK_EVAL_WORKER_UNCHECKED: "0" }),
    ).toBeUndefined();
    expect(evaluationOptionsFromEnvironment({ DOEDESK_EVAL_WORKER_FREETEXT: "1" })).toMatchObject({
      workerFreeText: true,
      workerUnchecked: false,
    });
    expect(sealedAskFreelyFromEnvironment({})).toBe(false);
    expect(sealedAskFreelyFromEnvironment({ DOEDESK_EVAL_SEALED_ASK_FREELY: " 1 " })).toBe(true);
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
      // Nor what its agents are told.
      expect(providerRequestsMasked("claudeAgent")).toBe(false);
      expect(providerRequestsMasked("codex")).toBe(false);
    }).pipe(Effect.scoped),
  );

  it.effect("with masking on: the gateway, for the providers the user did not switch off", () =>
    Effect.gen(function* () {
      const { controller } = yield* withController({ mode: "unconfigured" });
      const claude = yield* mergeClaudeProcessEnvironment(undefined, HOST);
      expect(claude.HTTPS_PROXY).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
      expect(claude.NODE_EXTRA_CA_CERTS).toBeDefined();

      // Agents are told what stand-ins are where the gateway rewrites their requests: not
      // Cursor's, which it blocks, nor Kiro's, which go to a host it does not open.
      expect(providerRequestsMasked("claudeAgent")).toBe(true);
      expect(providerRequestsMasked("cursor")).toBe(false);
      expect(providerRequestsMasked("kiro")).toBe(false);

      controller.setPreference({ kind: "providerRoute", provider: "claudeAgent", direct: true });
      expect(yield* mergeClaudeProcessEnvironment(undefined, HOST)).toEqual({
        ...HOST,
        CLAUDE_AGENT_SDK_CLIENT_APP: claude.CLAUDE_AGENT_SDK_CLIENT_APP,
      });
      expect(providerRequestsMasked("claudeAgent")).toBe(false);
      expect(
        (yield* mergeProviderInstanceEnvironment(undefined, HOST, "codex")).HTTPS_PROXY,
      ).toBeDefined();
      expect(providerRequestsMasked("codex")).toBe(true);
      yield* Effect.promise(() => controller.configure({ mode: "off" }));
      expect(providerRequestsMasked("codex")).toBe(false);
    }).pipe(Effect.scoped),
  );
});

it.layer(NodeServices.layer)("what is kept on a turn", (it) => {
  const turn = (driver: string, completed = true) => ({
    runId: "run-1",
    threadId: "thread-1",
    driver,
    sessions: ["session-1"],
    completed,
  });

  it.effect("says the turn was not masked only when its provider was not routed", () =>
    Effect.gen(function* () {
      const { controller } = yield* withController({
        mode: "unconfigured",
        directProviders: ["codex"],
      });
      expect(recordTurnWith(controller, turn("codex"))).toEqual({
        state: "unmasked",
        reason: "direct",
      });
      // Routed, and the gateway saw no request of this chat: a completed turn sent something
      // the gateway did not mask; one that stopped early may have sent nothing.
      expect(recordTurnWith(controller, turn("claudeAgent"))).toEqual({ state: "unseen" });
      expect(recordTurnWith(controller, turn("claudeAgent", false))).toBeUndefined();
      yield* Effect.promise(() => controller.configure({ mode: "off" }));
      expect(recordTurnWith(controller, turn("claudeAgent"))).toEqual({
        state: "unmasked",
        reason: "off",
      });
    }).pipe(Effect.scoped),
  );

  it.effect("adds the sealed files the turn asked about, by handle and count, without a name", () =>
    Effect.gen(function* () {
      const { controller } = yield* withController({ mode: "unconfigured" });
      const asked = {
        asked: [
          { handle: "DOC_1", name: "lease.pdf" },
          { handle: "DOC_2", name: "payroll.csv" },
        ],
        answers: [
          {
            at: "2026-11-24T09:00:00.000Z",
            handle: "DOC_1",
            document: "lease.pdf",
            asked: "overdue: is the rent overdue?",
            kind: "yes" as const,
            value: null,
          },
        ],
      };
      const taken: Array<ReadonlyArray<string>> = [];
      const withSealed = {
        ...controller,
        takeSealedTurn: (id: string, thread: string) => {
          taken.push([id, thread]);
          return asked;
        },
      };
      const sealedFiles = { asked: ["DOC_1", "DOC_2"], askedCount: 2, clear: 1 };
      const record = recordTurnWith(withSealed, turn("claudeAgent"));
      expect(record).toEqual({ state: "unseen", sealedFiles });
      expect(JSON.stringify(record)).not.toContain("lease");
      // The sealed files were asked in the thread's name, and the record is kept under the run.
      expect(taken).toEqual([["run-1", "thread-1"]]);
      // A turn that stopped early still says what it asked.
      expect(recordTurnWith(withSealed, turn("claudeAgent", false))).toEqual({
        state: "unseen",
        sealedFiles,
      });
    }).pipe(Effect.scoped),
  );

  it("keeps counts by kind and no stand-in", () => {
    const record = turnRecordOf({
      rewritten: 3,
      refused: 0,
      replaced: ["[PERSON_AAAAA]", "[PERSON_BBBBB]", "[IBAN_CCCCC]"],
      redacted: 1,
      read: 0,
      withheld: 0,
      sealed: 2,
      attribution: "session",
    });
    expect(record).toMatchObject({
      state: "masked",
      replaced: [
        { kind: "PERSON", count: 2 },
        { kind: "IBAN", count: 1 },
      ],
      sealed: 2,
    });
    expect(JSON.stringify(record)).not.toContain("AAAAA");
  });
});

describe("the count of sealed changes a client subscribes to", () => {
  it.effect("starts with the count as it stands, then gives each new count", () =>
    Effect.gen(function* () {
      const sealed = yield* makeSealedChanges;
      sealed.changed();
      // A client that connects later still learns something changed before it did.
      expect(yield* sealed.stream.pipe(Stream.take(1), Stream.runCollect)).toEqual([1]);

      const pull = yield* Stream.toPull(sealed.stream);
      expect(yield* pull).toEqual([1]);
      sealed.changed();
      expect(yield* pull).toEqual([2]);
    }).pipe(Effect.scoped),
  );
});
