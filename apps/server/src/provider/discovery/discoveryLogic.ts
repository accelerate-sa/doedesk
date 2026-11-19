import type {
  ProviderDataFolder,
  ProviderFind,
  ProviderFindSource,
  ProviderVolumeSearchProgress,
  ProviderVolumeSearchStop,
} from "@t3tools/contracts";
import { ProviderDriverKind } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";

import {
  APPLICATION_FOLDERS,
  appBundleNames,
  executableNames,
  PROVIDER_DISCOVERY_SPECS,
  SHARED_ABSOLUTE_LOCATIONS,
  SHARED_ENV_LOCATIONS,
  SHARED_HOME_LOCATIONS,
} from "./catalog.ts";

export type DiscoveryEntryKind = "file" | "directory" | "symlink" | "other";

/** What discovery may do with the disk: look at names and kinds, never read a file. */
export interface DiscoveryFileSystem {
  /** Follows links. Null when nothing is there or it cannot be read. */
  readonly kindOf: (path: string) => Effect.Effect<"executable" | "file" | "directory" | null>;
  /** A folder's entries without following links. Null when it cannot be read. */
  readonly list: (path: string) => Effect.Effect<ReadonlyArray<{
    readonly name: string;
    readonly kind: DiscoveryEntryKind;
  }> | null>;
  /** The path with links resolved, to tell two finds of one program apart. */
  readonly realPath: (path: string) => Effect.Effect<string>;
}

export type VersionReader = (path: string) => Effect.Effect<string | null>;

export interface DiscoveryHost {
  readonly platform: NodeJS.Platform;
  readonly home: string | null;
  readonly env: Readonly<Record<string, string | undefined>>;
}

const join = (base: string, rest: string) =>
  rest.length === 0 ? base : base.endsWith("/") ? `${base}${rest}` : `${base}/${rest}`;

/** Expands `*` segments against the disk, one folder level at a time. */
const expand = Effect.fn("ProviderDiscovery.expand")(function* (
  fs: DiscoveryFileSystem,
  pattern: string,
) {
  const segments = pattern.split("/");
  let paths = [segments[0] === "" ? "/" : segments[0]!];
  for (const segment of segments.slice(1)) {
    if (segment === "") continue;
    if (segment !== "*") {
      paths = paths.map((path) => join(path, segment));
      continue;
    }
    const next: string[] = [];
    for (const path of paths) {
      const entries = (yield* fs.list(path)) ?? [];
      for (const entry of entries) {
        if (entry.kind === "directory" || entry.kind === "symlink")
          next.push(join(path, entry.name));
      }
    }
    paths = next.toSorted();
  }
  return paths;
});

interface Candidate {
  readonly driver: string;
  readonly path: string;
  readonly source: ProviderFindSource;
  readonly app?: string;
}

const pathEntries = (host: DiscoveryHost): ReadonlyArray<string> => {
  const separator = host.platform === "win32" ? ";" : ":";
  return (host.env.PATH ?? host.env.Path ?? "")
    .split(separator)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
};

const executableFileNames = (name: string, platform: NodeJS.Platform) =>
  platform === "win32" ? [`${name}.exe`, `${name}.cmd`] : [name];

/**
 * The places the automatic check looks, in order of preference: the login shell's PATH, then
 * install folders, then programs inside apps. Never a drive the user did not choose.
 */
const automaticCandidates = Effect.fn("ProviderDiscovery.automaticCandidates")(function* (
  host: DiscoveryHost,
  fs: DiscoveryFileSystem,
) {
  const candidates: Candidate[] = [];
  const pathDirs = pathEntries(host);
  const sharedDirs: string[] = [];
  if (host.platform !== "win32") {
    sharedDirs.push(...SHARED_ABSOLUTE_LOCATIONS);
    if (host.home !== null) {
      for (const location of SHARED_HOME_LOCATIONS) {
        sharedDirs.push(...(yield* expand(fs, join(host.home, location))));
      }
    }
    for (const { env, sub } of SHARED_ENV_LOCATIONS) {
      const base = host.env[env]?.trim();
      if (base) sharedDirs.push(...(yield* expand(fs, join(base, sub))));
    }
  } else {
    const appData = host.env.APPDATA?.trim();
    if (appData) sharedDirs.push(`${appData}\\npm`);
  }

  for (const spec of PROVIDER_DISCOVERY_SPECS) {
    const ownDirs: string[] = [];
    if (host.home !== null && host.platform !== "win32") {
      for (const location of spec.homeLocations) {
        ownDirs.push(...(yield* expand(fs, join(host.home, location))));
      }
    }
    const separator = host.platform === "win32" ? "\\" : "/";
    for (const name of spec.executables) {
      for (const file of executableFileNames(name, host.platform)) {
        for (const dir of pathDirs) {
          candidates.push({
            driver: spec.driver,
            path: `${dir}${separator}${file}`,
            source: "path",
          });
        }
        for (const dir of [...ownDirs, ...sharedDirs]) {
          candidates.push({
            driver: spec.driver,
            path: `${dir}${separator}${file}`,
            source: "knownLocation",
          });
        }
      }
    }
    if (host.platform === "darwin" && host.home !== null) {
      for (const folder of APPLICATION_FOLDERS(host.home)) {
        for (const bundle of spec.appBundles) {
          candidates.push({
            driver: spec.driver,
            path: join(join(folder, bundle.app), bundle.inner),
            source: "appBundle",
            app: bundle.app,
          });
        }
      }
      for (const data of spec.homeAppData) {
        for (const path of (yield* expand(fs, join(host.home, data.path))).toReversed()) {
          candidates.push({ driver: spec.driver, path, source: "appBundle", app: data.app });
        }
      }
    }
  }
  return candidates;
});

/** Keeps the candidates that are programs, one per real file and provider, in the given order. */
const keepPrograms = Effect.fn("ProviderDiscovery.keepPrograms")(function* (
  fs: DiscoveryFileSystem,
  candidates: ReadonlyArray<Candidate>,
) {
  const checked = new Set<string>();
  const realFiles = new Set<string>();
  const kept: Candidate[] = [];
  for (const candidate of candidates) {
    const key = `${candidate.driver}\0${candidate.path}`;
    if (checked.has(key)) continue;
    checked.add(key);
    if ((yield* fs.kindOf(candidate.path)) !== "executable") continue;
    const real = `${candidate.driver}\0${yield* fs.realPath(candidate.path)}`;
    if (realFiles.has(real)) continue;
    realFiles.add(real);
    kept.push(candidate);
  }
  return kept;
});

const withVersions = (candidates: ReadonlyArray<Candidate>, readVersion: VersionReader) =>
  Effect.forEach(
    candidates,
    (candidate) =>
      readVersion(candidate.path).pipe(
        Effect.map((version): ProviderFind => ({
          driver: ProviderDriverKind.make(candidate.driver),
          path: candidate.path,
          source: candidate.source,
          version,
          ...(candidate.app === undefined ? {} : { app: candidate.app }),
        })),
      ),
    { concurrency: 4 },
  );

const dataFolders = Effect.fn("ProviderDiscovery.dataFolders")(function* (
  host: DiscoveryHost,
  fs: DiscoveryFileSystem,
) {
  const folders: ProviderDataFolder[] = [];
  for (const spec of PROVIDER_DISCOVERY_SPECS) {
    const paths = [
      ...spec.dataFolderEnv.flatMap((name) => host.env[name]?.trim() || []),
      ...(host.home === null ? [] : spec.dataFolders.map((folder) => join(host.home!, folder))),
    ];
    for (const path of new Set(paths)) {
      if ((yield* fs.kindOf(path)) === "directory") {
        folders.push({ driver: ProviderDriverKind.make(spec.driver), path });
        break;
      }
    }
  }
  return folders;
});

/** The check that runs without asking: exact places only, then `--version` on each program. */
export const scanAutomatic = Effect.fn("ProviderDiscovery.scanAutomatic")(function* (
  host: DiscoveryHost,
  fs: DiscoveryFileSystem,
  readVersion: VersionReader,
) {
  const programs = yield* keepPrograms(fs, yield* automaticCandidates(host, fs));
  return {
    finds: yield* withVersions(programs, readVersion),
    dataFolders: yield* dataFolders(host, fs),
  };
});

export interface SearchBounds {
  /** Folder levels below a drive's top. */
  readonly maxDepth: number;
  readonly maxFolders: number;
  readonly timeLimitMs: number;
}

export const DEFAULT_SEARCH_BOUNDS: SearchBounds = {
  maxDepth: 8,
  maxFolders: 300_000,
  timeLimitMs: 120_000,
};

/** Folders never entered: caches, version control, package stores, virtual machines, backups. */
const SKIPPED_NAMES = new Set([
  "node_modules",
  ".git",
  ".hg",
  ".svn",
  ".cache",
  "__pycache__",
  ".venv",
  ".Trash",
  ".Trashes",
  ".Spotlight-V100",
  ".fseventsd",
  ".DocumentRevisions-V100",
  ".TemporaryItems",
  ".MobileBackups",
  "Backups.backupdb",
  "DerivedData",
  "CoreSimulator",
  "VMs",
  "Virtual Machines",
  "Virtual Machines.localized",
  "VirtualBox VMs",
  "Parallels",
  "OrbStack",
  "Docker",
]);
const SKIPPED_SUFFIXES = [
  ".vmwarevm",
  ".pvm",
  ".utm",
  ".vbox",
  ".sparsebundle",
  ".photoslibrary",
  ".musiclibrary",
  ".xcarchive",
];
const SKIPPED_LIBRARY_FOLDERS = new Set([
  "Caches",
  "Containers",
  "Group Containers",
  "Developer",
  "Mail",
  "Logs",
]);
// A program counts only where programs are kept, so a file that happens to be called `pi` in a
// document folder is never run.
const PROGRAM_FOLDERS = new Set(["bin", ".bin", "shims", "MacOS"]);

const isSkippedFolder = (parentName: string, name: string): boolean =>
  SKIPPED_NAMES.has(name) ||
  SKIPPED_SUFFIXES.some((suffix) => name.endsWith(suffix)) ||
  (parentName === "Library" && SKIPPED_LIBRARY_FOLDERS.has(name));

const lastSegment = (path: string) => path.slice(path.lastIndexOf("/") + 1);

/**
 * Searches the drives the user ticked, by file and folder name only, within the bounds. Reports
 * progress as it goes; stopping the stream that runs it stops the search.
 */
export const searchVolumes = Effect.fn("ProviderDiscovery.searchVolumes")(function* (input: {
  readonly volumes: ReadonlyArray<string>;
  readonly fs: DiscoveryFileSystem;
  readonly readVersion: VersionReader;
  readonly bounds: SearchBounds;
  readonly report: (progress: ProviderVolumeSearchProgress) => Effect.Effect<void>;
}) {
  const { fs, bounds } = input;
  const programs = executableNames();
  const apps = appBundleNames();
  const startedAt = yield* Clock.currentTimeMillis;
  const finds: ProviderFind[] = [];
  const seen = new Set<string>();
  let foldersChecked = 0;
  let stoppedBy: ProviderVolumeSearchStop | null = null;
  let currentVolume: string | null = null;

  const progress = (
    state: "searching" | "done",
    volume: string | null,
  ): ProviderVolumeSearchProgress => ({
    state,
    volume,
    foldersChecked,
    finds: [...finds],
    stoppedBy,
  });

  const addFind = Effect.fn("ProviderDiscovery.addFind")(function* (
    driver: string,
    path: string,
    app: string | undefined,
  ) {
    const key = `${driver}\0${yield* fs.realPath(path)}`;
    if (seen.has(key)) return;
    seen.add(key);
    finds.push({
      driver: ProviderDriverKind.make(driver),
      path,
      source: "volume",
      version: yield* input.readVersion(path),
      ...(app === undefined ? {} : { app }),
    });
    yield* input.report(progress("searching", currentVolume));
  });

  for (const volume of input.volumes) {
    if (stoppedBy !== null) break;
    currentVolume = volume;
    yield* input.report(progress("searching", volume));
    // Breadth first, so a time or folder limit leaves the shallow, likelier places searched.
    let level: ReadonlyArray<string> = [volume];
    for (let depth = 0; depth <= bounds.maxDepth && level.length > 0; depth += 1) {
      const nextLevel: string[] = [];
      for (const folder of level) {
        if (foldersChecked >= bounds.maxFolders) {
          stoppedBy = "folders";
          break;
        }
        if ((yield* Clock.currentTimeMillis) - startedAt >= bounds.timeLimitMs) {
          stoppedBy = "time";
          break;
        }
        foldersChecked += 1;
        const entries = (yield* fs.list(folder)) ?? [];
        const folderName = lastSegment(folder);
        for (const entry of entries) {
          const path = join(folder, entry.name);
          if (entry.kind === "directory") {
            const bundle = apps.get(entry.name);
            if (bundle !== undefined) {
              const inner = join(path, bundle.inner);
              if ((yield* fs.kindOf(inner)) === "executable") {
                yield* addFind(bundle.driver, inner, entry.name);
              }
              continue;
            }
            // Apps carry thousands of files and never a provider's own program loose inside.
            if (entry.name.endsWith(".app") || isSkippedFolder(folderName, entry.name)) continue;
            nextLevel.push(path);
            continue;
          }
          const driver = programs.get(entry.name);
          if (driver === undefined || !PROGRAM_FOLDERS.has(folderName)) continue;
          if ((yield* fs.kindOf(path)) === "executable") yield* addFind(driver, path, undefined);
        }
        if (foldersChecked % 500 === 0) yield* input.report(progress("searching", volume));
      }
      if (stoppedBy !== null) break;
      level = nextLevel;
    }
  }
  const done = progress("done", null);
  yield* input.report(done);
  return done;
});
