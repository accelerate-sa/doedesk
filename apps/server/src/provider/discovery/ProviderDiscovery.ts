// @effect-diagnostics nodeBuiltinImport:off - discovery needs entry kinds and the execute bit, which Effect's FileSystem does not report.
import * as NodeFSP from "node:fs/promises";

import {
  type ProviderDiscoveryScanResult,
  ProviderDiscoveryError,
  ProviderDriverKind,
  type ProviderInspectInput,
  type ProviderInspectResult,
  type ProviderVolumeList,
  type ProviderVolumeSearchInput,
  type ProviderVolumeSearchProgress,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import {
  parseCliVersionResult,
  spawnAndCollect,
} from "@t3tools/provider-core/server/snapshotProbe";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import { refreshPathFromLoginShell } from "../../os-jank.ts";
import { specFor } from "./catalog.ts";
import {
  DEFAULT_SEARCH_BOUNDS,
  type DiscoveryEntryKind,
  type DiscoveryFileSystem,
  type DiscoveryHost,
  scanAutomatic,
  searchVolumes,
} from "./discoveryLogic.ts";
import {
  listVolumesFromMounts,
  parseDarwinMount,
  parseDiskImageMountPoints,
  parseLinuxMounts,
} from "./volumes.ts";

const VERSION_TIMEOUT = Duration.seconds(5);
const LIST_TIMEOUT = Duration.seconds(5);

const nodeDiscoveryFileSystem: DiscoveryFileSystem = {
  kindOf: (path) =>
    Effect.promise(async () => {
      try {
        const stat = await NodeFSP.stat(path);
        if (stat.isDirectory()) return "directory" as const;
        if (!stat.isFile()) return null;
        try {
          await NodeFSP.access(path, NodeFSP.constants.X_OK);
          return "executable" as const;
        } catch {
          return "file" as const;
        }
      } catch {
        return null;
      }
    }),
  list: (path) =>
    Effect.promise(async () => {
      try {
        const entries = await NodeFSP.readdir(path, { withFileTypes: true });
        return entries.map((entry) => ({
          name: entry.name,
          kind: (entry.isDirectory()
            ? "directory"
            : entry.isFile()
              ? "file"
              : entry.isSymbolicLink()
                ? "symlink"
                : "other") satisfies DiscoveryEntryKind,
        }));
      } catch {
        return null;
      }
    }),
  realPath: (path) => Effect.promise(() => NodeFSP.realpath(path).catch(() => path)),
};

export class ProviderDiscovery extends Context.Service<
  ProviderDiscovery,
  {
    /** Checks the login shell's PATH and the usual install places. Never searches a drive. */
    readonly scan: Effect.Effect<ProviderDiscoveryScanResult>;
    readonly listVolumes: Effect.Effect<ProviderVolumeList>;
    /** Searches only the drives named, and only ones `listVolumes` returns. */
    readonly searchVolumes: (
      input: ProviderVolumeSearchInput,
    ) => Stream.Stream<ProviderVolumeSearchProgress, ProviderDiscoveryError>;
    /** Checks a program the user pointed to by hand. */
    readonly inspect: (input: ProviderInspectInput) => Effect.Effect<ProviderInspectResult>;
  }
>()("t3/provider/discovery/ProviderDiscovery") {}

const make = Effect.fn("ProviderDiscovery.make")(function* () {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const fs = nodeDiscoveryFileSystem;
  const bounds = DEFAULT_SEARCH_BOUNDS;
  // The same login shell PATH every provider spawn uses, re-read so a fresh install counts.
  const refreshPath = yield* refreshPathFromLoginShell().pipe(
    Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
    Effect.ignore,
    Effect.cachedWithTTL(Duration.seconds(10)),
  );

  const host = Effect.gen(function* () {
    const env = yield* HostProcess.Environment;
    return {
      platform: yield* HostProcess.Platform,
      home: env.HOME?.trim() || env.USERPROFILE?.trim() || null,
      env,
    } satisfies DiscoveryHost;
  });

  // A program that hangs or fails reports nothing, rather than failing the whole check.
  const run = Effect.fn("ProviderDiscovery.run")(
    function* (command: string, args: ReadonlyArray<string>) {
      const env = yield* HostProcess.Environment;
      return yield* spawnAndCollect(command, ChildProcess.make(command, args, { env }));
    },
    Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
    Effect.timeoutOption(VERSION_TIMEOUT),
    Effect.map(Option.getOrNull),
    Effect.catchCause(() => Effect.succeed(null)),
  );

  const readVersion = (path: string) =>
    run(path, ["--version"]).pipe(
      Effect.map((result) => (result === null ? null : parseCliVersionResult(result))),
    );

  const listVolumes = Effect.gen(function* () {
    const { platform } = yield* host;
    if (platform === "darwin") {
      const [mount, images] = yield* Effect.all(
        [run("/sbin/mount", []), run("/usr/bin/hdiutil", ["info", "-plist"])],
        { concurrency: 2 },
      ).pipe(Effect.timeoutOption(LIST_TIMEOUT), Effect.map(Option.getOrElse(() => [null, null])));
      return {
        supported: mount !== null,
        volumes: listVolumesFromMounts({
          platform,
          mounts: parseDarwinMount(mount?.stdout ?? ""),
          diskImages: parseDiskImageMountPoints(images?.stdout ?? ""),
        }),
      } satisfies ProviderVolumeList;
    }
    if (platform === "linux") {
      const mounts = yield* Effect.promise(() =>
        NodeFSP.readFile("/proc/mounts", "utf8").catch(() => null),
      );
      return {
        supported: mounts !== null,
        volumes: listVolumesFromMounts({
          platform,
          mounts: parseLinuxMounts(mounts ?? ""),
          diskImages: new Set(),
        }),
      } satisfies ProviderVolumeList;
    }
    return { supported: false, volumes: [] } satisfies ProviderVolumeList;
  });

  const searchVolumesStream = (input: ProviderVolumeSearchInput) =>
    Stream.callback<ProviderVolumeSearchProgress, ProviderDiscoveryError>((queue) =>
      Effect.gen(function* () {
        const listed = new Set((yield* listVolumes).volumes.map((volume) => volume.path));
        const unknown = input.volumes.filter((volume) => !listed.has(volume));
        if (unknown.length > 0) {
          return yield* new ProviderDiscoveryError({
            detail: `Not a drive DoeDesk can search: ${unknown.join(", ")}`,
          });
        }
        yield* searchVolumes({
          volumes: [...new Set(input.volumes)],
          fs,
          readVersion,
          bounds,
          report: (progress) => Queue.offer(queue, progress).pipe(Effect.asVoid),
        });
      }).pipe(
        Effect.matchCauseEffect({
          onFailure: (cause) => Queue.failCause(queue, cause),
          onSuccess: () => Queue.end(queue),
        }),
      ),
    );

  const inspect = Effect.fn("ProviderDiscovery.inspect")(function* (input: ProviderInspectInput) {
    const { platform } = yield* host;
    const absolute =
      platform === "win32" ? /^[A-Za-z]:[\\/]/.test(input.path) : input.path.startsWith("/");
    if (!absolute) return { ok: false, reason: "notAbsolute" } satisfies ProviderInspectResult;
    let path = input.path.replace(/\/+$/, "");
    let app: string | undefined;
    let kind = yield* fs.kindOf(path);
    if (kind === "directory" && path.endsWith(".app")) {
      // An app chosen by hand stands for the provider's program inside it.
      app = path.slice(path.lastIndexOf("/") + 1);
      const spec = specFor(input.driver);
      const inner = [
        ...(spec?.appBundles.filter((bundle) => bundle.app === app).map((bundle) => bundle.inner) ??
          []),
        ...(spec?.executables.map((name) => `Contents/MacOS/${name}`) ?? []),
      ];
      for (const candidate of inner) {
        if ((yield* fs.kindOf(`${path}/${candidate}`)) === "executable") {
          path = `${path}/${candidate}`;
          kind = "executable";
          break;
        }
      }
    }
    if (kind === null || kind === "directory") {
      return { ok: false, reason: "notFound" } satisfies ProviderInspectResult;
    }
    if (kind !== "executable") {
      return { ok: false, reason: "notExecutable" } satisfies ProviderInspectResult;
    }
    return {
      ok: true,
      find: {
        driver: ProviderDriverKind.make(input.driver),
        path,
        source: "manual",
        version: yield* readVersion(path),
        ...(app === undefined ? {} : { app }),
      },
    } satisfies ProviderInspectResult;
  });

  return ProviderDiscovery.of({
    scan: refreshPath.pipe(
      Effect.andThen(host),
      Effect.flatMap((current) => scanAutomatic(current, fs, readVersion)),
    ),
    listVolumes,
    searchVolumes: searchVolumesStream,
    inspect,
  });
});

export const layer = Layer.effect(ProviderDiscovery, make());
