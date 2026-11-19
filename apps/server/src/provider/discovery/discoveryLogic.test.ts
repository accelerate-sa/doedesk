import { describe, expect, it } from "@effect/vitest";
import { ProviderVolumeSearchInput, type ProviderVolumeSearchProgress } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";

import {
  type DiscoveryEntryKind,
  type DiscoveryFileSystem,
  type DiscoveryHost,
  scanAutomatic,
  searchVolumes,
  type SearchBounds,
} from "./discoveryLogic.ts";

type FakeNode = "exe" | "file" | "dir" | { readonly link: string };

const entryKind = (node: FakeNode): DiscoveryEntryKind =>
  typeof node === "object" ? "symlink" : node === "dir" ? "directory" : "file";

/**
 * A disk held in a map of absolute paths. Parent folders exist implicitly. `onList` lets a test
 * act on each folder read, such as moving the test clock.
 */
function fakeDisk(
  nodes: Readonly<Record<string, FakeNode>>,
  onList: (path: string) => Effect.Effect<void> = () => Effect.void,
) {
  const listed: string[] = [];
  const all = new Map<string, FakeNode>(Object.entries(nodes));
  for (const path of Object.keys(nodes)) {
    let parent = path.slice(0, path.lastIndexOf("/"));
    while (parent.length > 0) {
      if (!all.has(parent)) all.set(parent, "dir");
      parent = parent.slice(0, parent.lastIndexOf("/"));
    }
  }
  const resolve = (path: string, depth = 0): string => {
    const node = all.get(path);
    return typeof node === "object" && depth < 8 ? resolve(node.link, depth + 1) : path;
  };
  const fs: DiscoveryFileSystem = {
    kindOf: (path) =>
      Effect.sync(() => {
        const node = all.get(resolve(path));
        if (node === undefined || typeof node === "object") return null;
        return node === "exe" ? "executable" : node === "file" ? "file" : "directory";
      }),
    list: (path) =>
      onList(path).pipe(
        Effect.as(
          all.get(resolve(path)) === "dir"
            ? [...all.entries()]
                .filter(([child]) => child.slice(0, child.lastIndexOf("/")) === resolve(path))
                .map(([child, node]) => ({
                  name: child.slice(child.lastIndexOf("/") + 1),
                  kind: entryKind(node),
                }))
            : null,
        ),
        Effect.tap(() => Effect.sync(() => listed.push(path))),
      ),
    realPath: (path) => Effect.succeed(resolve(path)),
  };
  return { fs, listed };
}

const versionOf = (path: string) => Effect.succeed(path.includes("old") ? null : "1.2.3");

const mac = (env: Record<string, string> = {}): DiscoveryHost => ({
  platform: "darwin",
  home: "/Users/sam",
  env: { PATH: "/usr/bin:/bin", ...env },
});

describe("scanAutomatic", () => {
  it.effect("finds programs on PATH, in install folders and inside apps, once each", () =>
    Effect.gen(function* () {
      const { fs } = fakeDisk({
        "/opt/homebrew/bin/codex": "exe",
        "/Users/sam/.nvm/versions/node/v22.1.0/bin/claude": "exe",
        "/Users/sam/.local/bin/claude": {
          link: "/Users/sam/.local/share/claude/versions/2/claude",
        },
        "/Users/sam/.local/share/claude/versions/2/claude": "exe",
        "/Users/sam/.claude/local/claude": {
          link: "/Users/sam/.local/share/claude/versions/2/claude",
        },
        "/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex": "exe",
        "/Users/sam/Library/Application Support/Claude/claude-code/2.1.0/ab12/claude.app/Contents/MacOS/claude":
          "exe",
        "/usr/local/bin/opencode": "file",
        "/Users/sam/.codex": "dir",
        "/Volumes/work/home/.claude": "dir",
      });
      const result = yield* scanAutomatic(
        mac({ CLAUDE_CONFIG_DIR: "/Volumes/work/home/.claude" }),
        fs,
        versionOf,
      );
      expect(
        result.finds.map(({ driver, path, source, app }) => ({ driver, path, source, app })),
      ).toEqual([
        {
          driver: "claudeAgent",
          path: "/Users/sam/.claude/local/claude",
          source: "knownLocation",
          app: undefined,
        },
        {
          driver: "claudeAgent",
          path: "/Users/sam/.nvm/versions/node/v22.1.0/bin/claude",
          source: "knownLocation",
          app: undefined,
        },
        {
          driver: "claudeAgent",
          path: "/Users/sam/Library/Application Support/Claude/claude-code/2.1.0/ab12/claude.app/Contents/MacOS/claude",
          source: "appBundle",
          app: "Claude.app",
        },
        {
          driver: "codex",
          path: "/opt/homebrew/bin/codex",
          source: "knownLocation",
          app: undefined,
        },
        {
          driver: "codex",
          path: "/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex",
          source: "appBundle",
          app: "ChatGPT.app",
        },
      ]);
      expect(result.finds.every((find) => find.version === "1.2.3")).toBe(true);
      expect(result.dataFolders).toEqual([
        { driver: "claudeAgent", path: "/Volumes/work/home/.claude" },
        { driver: "codex", path: "/Users/sam/.codex" },
      ]);
    }),
  );

  it.effect("finds a program on another drive when the login shell's PATH names it", () =>
    Effect.gen(function* () {
      const { fs } = fakeDisk({ "/Volumes/work/tools/bin/claude": "exe" });
      const result = yield* scanAutomatic(
        mac({ PATH: "/usr/bin:/Volumes/work/tools/bin" }),
        fs,
        versionOf,
      );
      expect(result.finds.map((find) => [find.path, find.source])).toEqual([
        ["/Volumes/work/tools/bin/claude", "path"],
      ]);
    }),
  );

  it.effect("never looks through other drives on its own", () =>
    Effect.gen(function* () {
      const { fs, listed } = fakeDisk({
        "/Volumes/work/tools/bin/claude": "exe",
        "/Volumes/work/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex": "exe",
      });
      const result = yield* scanAutomatic(mac(), fs, versionOf);
      expect(result.finds).toEqual([]);
      expect(listed.filter((path) => path.startsWith("/Volumes"))).toEqual([]);
    }),
  );
});

const BOUNDS: SearchBounds = { maxDepth: 4, maxFolders: 1_000, timeLimitMs: 60_000 };

const search = (
  fs: DiscoveryFileSystem,
  volumes: ReadonlyArray<string>,
  bounds: SearchBounds = BOUNDS,
) => {
  const reports: ProviderVolumeSearchProgress[] = [];
  return searchVolumes({
    volumes,
    fs,
    readVersion: versionOf,
    bounds,
    report: (progress) => Effect.sync(() => reports.push(progress)),
  }).pipe(Effect.map((done) => ({ done, reports })));
};

describe("searchVolumes", () => {
  it.effect("finds programs in program folders and apps, and skips caches and machines", () =>
    Effect.gen(function* () {
      const { fs, listed } = fakeDisk({
        "/Volumes/work/tools/bin/claude": "exe",
        "/Volumes/work/Apps/ChatGPT.app/Contents/Resources/codex-cli/bin/codex": "exe",
        "/Volumes/work/project/node_modules/.bin/claude": "exe",
        "/Volumes/work/repo/.git/hooks/bin/codex": "exe",
        "/Volumes/work/home/Library/Caches/bin/claude": "exe",
        "/Volumes/work/VMs/bin/claude": "exe",
        "/Volumes/work/Mac.vmwarevm/bin/codex": "exe",
        "/Volumes/work/notes/claude": "exe",
        "/Volumes/work/tools/bin/pi": "file",
        "/Volumes/other/bin/claude": "exe",
      });
      const { done, reports } = yield* search(fs, ["/Volumes/work"]);
      expect(done.finds.map(({ driver, path, app }) => ({ driver, path, app }))).toEqual([
        {
          driver: "codex",
          path: "/Volumes/work/Apps/ChatGPT.app/Contents/Resources/codex-cli/bin/codex",
          app: "ChatGPT.app",
        },
        { driver: "claudeAgent", path: "/Volumes/work/tools/bin/claude", app: undefined },
      ]);
      expect(done).toMatchObject({ state: "done", stoppedBy: null });
      expect(reports.at(0)).toMatchObject({ state: "searching", volume: "/Volumes/work" });
      expect(listed.every((path) => path.startsWith("/Volumes/work"))).toBe(true);
      expect(
        listed.filter((path) => /node_modules|\.git|Caches|VMs|vmwarevm|\.app/.test(path)),
      ).toEqual([]);
    }),
  );

  it.effect("goes no deeper than the depth limit", () =>
    Effect.gen(function* () {
      const { fs } = fakeDisk({
        "/Volumes/work/a/b/bin/claude": "exe",
        "/Volumes/work/a/b/c/d/bin/codex": "exe",
      });
      const { done } = yield* search(fs, ["/Volumes/work"], { ...BOUNDS, maxDepth: 3 });
      expect(done.finds.map((find) => find.path)).toEqual(["/Volumes/work/a/b/bin/claude"]);
    }),
  );

  it.effect("stops at the folder limit and says so", () =>
    Effect.gen(function* () {
      const { fs, listed } = fakeDisk({
        "/Volumes/work/a/x": "file",
        "/Volumes/work/b/x": "file",
        "/Volumes/work/c/bin/claude": "exe",
      });
      const { done } = yield* search(fs, ["/Volumes/work"], { ...BOUNDS, maxFolders: 3 });
      expect(done).toMatchObject({ stoppedBy: "folders", foldersChecked: 3, finds: [] });
      expect(listed).toHaveLength(3);
    }),
  );

  it.effect("stops at the time limit and leaves the next drive alone", () =>
    Effect.gen(function* () {
      const { fs, listed } = fakeDisk(
        {
          "/Volumes/work/a/x": "file",
          "/Volumes/work/b/x": "file",
          "/Volumes/other/bin/claude": "exe",
        },
        () => TestClock.adjust("40 seconds"),
      );
      const { done } = yield* search(fs, ["/Volumes/work", "/Volumes/other"]);
      expect(done.stoppedBy).toBe("time");
      expect(done.finds).toEqual([]);
      expect(listed).toEqual(["/Volumes/work", "/Volumes/work/a"]);
    }),
  );

  it("needs at least one drive the person ticked", () => {
    const decode = Schema.decodeUnknownExit(ProviderVolumeSearchInput);
    expect(decode({ volumes: [] })._tag).toBe("Failure");
    expect(decode({ volumes: ["/Volumes/work"] })._tag).toBe("Success");
  });
});
