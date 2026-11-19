import type {
  ProviderFind,
  ProviderVolume,
  ServerProvider,
  ServerSettings,
} from "@t3tools/contracts";

/** The program an instance is set to run: its `binaryPath`, or null for the default lookup. */
function configuredProgram(
  provider: ServerProvider,
  settings: Pick<ServerSettings, "providerInstances"> | null | undefined,
): string | null {
  const config = settings?.providerInstances[provider.instanceId]?.config;
  const binaryPath =
    config !== null && typeof config === "object" && "binaryPath" in config
      ? config.binaryPath
      : undefined;
  // A bare name such as "claude" is the default: PATH decides.
  return typeof binaryPath === "string" && binaryPath.includes("/") ? binaryPath : null;
}

export interface ProviderPrograms {
  readonly provider: ServerProvider;
  readonly finds: ReadonlyArray<ProviderFind>;
  /** The find the provider runs now, if it is one of them. */
  readonly inUse: string | null;
}

/**
 * Each provider with the programs found for it, one entry per path, in the order found. The one
 * in use is the configured path, or with none configured the first one on PATH, which is what
 * the provider runs by default.
 */
export function groupProviderPrograms(input: {
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly finds: ReadonlyArray<ProviderFind>;
  readonly settings: Pick<ServerSettings, "providerInstances"> | null | undefined;
}): ReadonlyArray<ProviderPrograms> {
  const groups: ProviderPrograms[] = [];
  const claimed = new Set<string>();
  for (const provider of input.providers) {
    // A second instance of the same provider, such as a work account, shares the first's finds.
    if (claimed.has(provider.driver)) continue;
    claimed.add(provider.driver);
    const seen = new Set<string>();
    const finds = input.finds.filter((find) => {
      if (find.driver !== provider.driver || seen.has(find.path)) return false;
      seen.add(find.path);
      return true;
    });
    if (finds.length === 0) continue;
    const configured = configuredProgram(provider, input.settings);
    const inUse =
      configured !== null
        ? (finds.find((find) => find.path === configured)?.path ?? null)
        : provider.installed
          ? (finds.find((find) => find.source === "path")?.path ?? null)
          : null;
    groups.push({ provider, finds, inUse });
  }
  return groups;
}

/** Drives offered for the search: local ones, and network drives and disk images only on request. */
export const volumesToOffer = (
  volumes: ReadonlyArray<ProviderVolume>,
  showAll: boolean,
): ReadonlyArray<ProviderVolume> =>
  showAll ? volumes : volumes.filter((volume) => volume.kind === "local");
