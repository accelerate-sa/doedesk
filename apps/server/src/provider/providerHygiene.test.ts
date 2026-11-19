import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

/**
 * Signs of the app acting as a vendor's client: that client's name in a header, the vendor's
 * stored login, or an endpoint only the vendor's client calls. T3 Code has had each of these,
 * so a merge from upstream can bring them back.
 */
const FORBIDDEN: ReadonlyArray<readonly [RegExp, string]> = [
  [/claude-cli\/|claude-code\/\d/, "Claude Code's user agent"],
  [/grok-cli|x-xai-token-auth|x-grok-client/, "the Grok CLI's client headers"],
  [/antigravity\/hub/, "Antigravity's user agent"],
  [/x-cursor-client-type/, "Cursor's client type header"],
  [/oauth-2025-04-20/, "the beta value of Claude Code's subscription login"],
  [/\.credentials\.json/, "Claude Code's stored login"],
  [/api\/oauth\/usage|reset_rate_limits/, "Anthropic endpoints only Claude Code calls"],
  [/v1internal:/, "Google endpoints only Antigravity calls"],
];

const isSource = (file: string): boolean =>
  file.endsWith(".ts") &&
  !/\.(test|fixture|testFixtures)\.ts$/.test(file) &&
  !/(^|\/)(node_modules|dist|testFixtures|testkit|_generated)\//.test(file);

it.layer(NodeServices.layer)("the app does not act as a vendor's client", (it) => {
  it.effect("names no vendor client and reads no vendor login in server or provider code", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const repository = path.resolve(import.meta.dirname, "../../../..");
      const packages = yield* fileSystem.readDirectory(path.join(repository, "packages"));
      const roots = [
        "apps/server/src",
        ...packages
          .filter((name) => name.startsWith("provider-"))
          .map((name) => `packages/${name}/src`),
      ];
      const found: Array<string> = [];
      for (const root of roots) {
        const files = yield* fileSystem.readDirectory(path.join(repository, root), {
          recursive: true,
        });
        for (const file of files.filter(isSource)) {
          const text = yield* fileSystem.readFileString(path.join(repository, root, file));
          for (const [pattern, what] of FORBIDDEN) {
            if (pattern.test(text)) found.push(`${root}/${file}: ${what}`);
          }
        }
      }
      expect(found).toEqual([]);
    }),
  );
});
