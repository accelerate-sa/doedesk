/**
 * Where each provider's program is usually installed. The automatic check looks only at these
 * exact places and at the login shell's PATH; it never walks a folder tree.
 */

export interface AppBundleExecutable {
  /** The app's folder name, such as "ChatGPT.app". */
  readonly app: string;
  /** The program inside the app, relative to the app's folder. */
  readonly inner: string;
}

export interface ProviderDiscoverySpec {
  readonly driver: string;
  /** File names of the provider's program. */
  readonly executables: ReadonlyArray<string>;
  /** Programs shipped inside an app, looked for in /Applications and ~/Applications. */
  readonly appBundles: ReadonlyArray<AppBundleExecutable>;
  /** Install folders of this provider only, relative to the home folder. `*` matches one name. */
  readonly homeLocations: ReadonlyArray<string>;
  /** Programs a provider's desktop app keeps in its data folder, relative to home. */
  readonly homeAppData: ReadonlyArray<{ readonly app: string; readonly path: string }>;
  /** The provider's settings and data folders, relative to home. */
  readonly dataFolders: ReadonlyArray<string>;
  /** Environment variables that point at a data folder. */
  readonly dataFolderEnv: ReadonlyArray<string>;
}

// Antigravity and ACP Registry agents install and pick their own programs, so they are not here.
export const PROVIDER_DISCOVERY_SPECS: ReadonlyArray<ProviderDiscoverySpec> = [
  {
    driver: "claudeAgent",
    executables: ["claude"],
    appBundles: [],
    homeLocations: [".claude/local", ".claude/local/node_modules/.bin"],
    homeAppData: [
      {
        app: "Claude.app",
        path: "Library/Application Support/Claude/claude-code/*/*/claude.app/Contents/MacOS/claude",
      },
    ],
    dataFolders: [".claude"],
    dataFolderEnv: ["CLAUDE_CONFIG_DIR"],
  },
  {
    driver: "codex",
    executables: ["codex"],
    appBundles: [
      { app: "Codex.app", inner: "Contents/Resources/codex" },
      { app: "ChatGPT.app", inner: "Contents/Resources/codex-cli/bin/codex" },
    ],
    homeLocations: [],
    homeAppData: [],
    dataFolders: [".codex"],
    dataFolderEnv: ["CODEX_HOME"],
  },
  {
    driver: "cursor",
    executables: ["cursor-agent"],
    appBundles: [],
    homeLocations: [],
    homeAppData: [],
    dataFolders: [".cursor"],
    dataFolderEnv: [],
  },
  {
    driver: "grok",
    executables: ["grok"],
    appBundles: [],
    homeLocations: [],
    homeAppData: [],
    dataFolders: [".grok"],
    dataFolderEnv: [],
  },
  {
    driver: "opencode",
    executables: ["opencode"],
    appBundles: [],
    homeLocations: [".opencode/bin"],
    homeAppData: [],
    dataFolders: [".config/opencode", ".local/share/opencode"],
    dataFolderEnv: [],
  },
  {
    driver: "kiro",
    executables: ["kiro-cli"],
    appBundles: [],
    homeLocations: [],
    homeAppData: [],
    dataFolders: [".kiro"],
    dataFolderEnv: [],
  },
  {
    driver: "pi",
    executables: ["pi"],
    appBundles: [],
    homeLocations: [],
    homeAppData: [],
    dataFolders: [".pi"],
    dataFolderEnv: [],
  },
  {
    driver: "muse",
    executables: ["muse"],
    appBundles: [],
    homeLocations: [],
    homeAppData: [],
    dataFolders: [],
    dataFolderEnv: [],
  },
  {
    driver: "fx",
    executables: ["fx"],
    appBundles: [],
    homeLocations: [],
    homeAppData: [],
    dataFolders: [],
    dataFolderEnv: [],
  },
];

/**
 * Folders that package managers and version managers put programs in, for any provider.
 * Absolute ones first, then ones under home. `*` matches one folder name, such as a Node version.
 */
export const SHARED_ABSOLUTE_LOCATIONS: ReadonlyArray<string> = [
  "/opt/homebrew/bin",
  "/usr/local/bin",
  "/home/linuxbrew/.linuxbrew/bin",
  "/opt/local/bin",
  "/snap/bin",
];

export const SHARED_HOME_LOCATIONS: ReadonlyArray<string> = [
  ".local/bin",
  "bin",
  ".npm-global/bin",
  ".npm/bin",
  ".yarn/bin",
  ".config/yarn/global/node_modules/.bin",
  "Library/pnpm",
  ".local/share/pnpm",
  ".bun/bin",
  ".volta/bin",
  ".asdf/shims",
  ".local/share/mise/shims",
  ".cargo/bin",
  ".deno/bin",
  ".nvm/versions/node/*/bin",
  ".local/share/fnm/node-versions/*/installation/bin",
  ".fnm/node-versions/*/installation/bin",
  "Library/Application Support/fnm/node-versions/*/installation/bin",
];

/** Environment variables that move a manager's folder, and where its programs sit inside it. */
export const SHARED_ENV_LOCATIONS: ReadonlyArray<{ readonly env: string; readonly sub: string }> = [
  { env: "NVM_DIR", sub: "versions/node/*/bin" },
  { env: "FNM_DIR", sub: "node-versions/*/installation/bin" },
  { env: "VOLTA_HOME", sub: "bin" },
  { env: "BUN_INSTALL", sub: "bin" },
  { env: "PNPM_HOME", sub: "" },
  { env: "ASDF_DATA_DIR", sub: "shims" },
  { env: "MISE_DATA_DIR", sub: "shims" },
  { env: "NPM_CONFIG_PREFIX", sub: "bin" },
  { env: "npm_config_prefix", sub: "bin" },
];

export const APPLICATION_FOLDERS = (home: string): ReadonlyArray<string> => [
  "/Applications",
  `${home}/Applications`,
];

/** Every program name the drive search looks for, with the provider it belongs to. */
export const executableNames = (): ReadonlyMap<string, string> =>
  new Map(
    PROVIDER_DISCOVERY_SPECS.flatMap((spec) =>
      spec.executables.map((name) => [name, spec.driver] as const),
    ),
  );

/** App folder names the drive search looks for, with the program inside and its provider. */
export const appBundleNames = (): ReadonlyMap<
  string,
  { readonly driver: string; readonly inner: string }
> =>
  new Map(
    PROVIDER_DISCOVERY_SPECS.flatMap((spec) =>
      spec.appBundles.map(
        (bundle) => [bundle.app, { driver: spec.driver, inner: bundle.inner }] as const,
      ),
    ),
  );

export const specFor = (driver: string): ProviderDiscoverySpec | undefined =>
  PROVIDER_DISCOVERY_SPECS.find((spec) => spec.driver === driver);
