import * as NodeOS from "node:os";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import {
  makeClaudeCapabilitiesCacheKey,
  makeClaudeContinuationGroupKey,
  makeClaudeEnvironment,
  mergeClaudeProcessEnvironment,
  resolveClaudeHomePath,
} from "./ClaudeHome.ts";

it.layer(NodeServices.layer)("ClaudeHome", (it) => {
  describe("Claude home resolution", () => {
    it.effect("resolves configured Claude HOME and stamps continuation/cache keys with it", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const homePath = "~/.claude-work";
        const resolved = path.resolve(NodeOS.homedir(), ".claude-work");

        expect(yield* resolveClaudeHomePath({ homePath })).toBe(resolved);
        expect((yield* makeClaudeEnvironment({ homePath })).CLAUDE_CONFIG_DIR).toBe(resolved);
        expect(yield* makeClaudeContinuationGroupKey({ homePath })).toBe(`claude:home:${resolved}`);
        expect(yield* makeClaudeCapabilitiesCacheKey({ binaryPath: "claude", homePath })).toBe(
          `claude\0${resolved}\0`,
        );
      }),
    );

    it.effect("uses inherited CLAUDE_CONFIG_DIR when homePath is empty", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const inherited = path.resolve("/tmp/claude-inherited");
        const environment = { CLAUDE_CONFIG_DIR: inherited };

        expect(yield* resolveClaudeHomePath({ homePath: "" }, environment)).toBe(inherited);
        expect(yield* makeClaudeContinuationGroupKey({ homePath: "" }, environment)).toBe(
          `claude:home:${inherited}`,
        );

        const explicit = path.resolve(NodeOS.homedir(), ".claude-work");
        expect(yield* resolveClaudeHomePath({ homePath: "~/.claude-work" }, environment)).toBe(
          explicit,
        );
      }),
    );

    it.effect("gives a symlinked Claude home the continuation key of its target", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fileSystem.realPath(yield* fileSystem.makeTempDirectoryScoped());
        const target = path.join(root, ".claude");
        const link = path.join(root, ".claude-second-account");
        yield* fileSystem.makeDirectory(target);
        yield* fileSystem.symlink(target, link);

        const direct = yield* makeClaudeContinuationGroupKey({ homePath: target });
        expect(yield* makeClaudeContinuationGroupKey({ homePath: link })).toBe(direct);
        expect(
          yield* makeClaudeContinuationGroupKey({ homePath: "" }, { CLAUDE_CONFIG_DIR: link }),
        ).toBe(direct);
        // The spawned process keeps the literal path, because Claude keys its login by that path.
        expect((yield* makeClaudeEnvironment({ homePath: link })).CLAUDE_CONFIG_DIR).toBe(link);
      }).pipe(Effect.scoped),
    );

    it.effect("separates capability probes by cwd", () =>
      Effect.gen(function* () {
        const config = { binaryPath: "claude", homePath: "" };
        const first = yield* makeClaudeCapabilitiesCacheKey(config, "/repo-a");
        const second = yield* makeClaudeCapabilitiesCacheKey(config, "/repo-b");
        expect(first).not.toBe(second);
      }),
    );
  });

  it.effect(
    "drops the launching Claude session and Electron's run-as-Node flag, and names DoeDesk the documented way",
    () =>
      Effect.gen(function* () {
        const host = {
          CLAUDE_CODE_ENTRYPOINT: "claude-desktop",
          CLAUDECODE: "1",
          CLAUDE_CODE_SESSION_ID: "host-session",
          CLAUDE_CODE_MESSAGING_SOCKET: "/tmp/host-claude.sock",
          CLAUDE_EFFORT: "high",
          ELECTRON_RUN_AS_NODE: "1",
          KEEP: "1",
        };
        const instance = [{ name: "CLAUDE_EFFORT", value: "low", sensitive: false }];
        const clientApp = expect.stringMatching(/^doedesk\/\d/);

        // No entry point label: Claude Code reports the one the Agent SDK gives it.
        expect(yield* mergeClaudeProcessEnvironment(undefined, host)).toEqual({
          CLAUDE_AGENT_SDK_CLIENT_APP: clientApp,
          KEEP: "1",
        });
        expect(yield* mergeClaudeProcessEnvironment(instance, host)).toEqual({
          CLAUDE_AGENT_SDK_CLIENT_APP: clientApp,
          CLAUDE_EFFORT: "low",
          KEEP: "1",
        });
      }),
  );
});
