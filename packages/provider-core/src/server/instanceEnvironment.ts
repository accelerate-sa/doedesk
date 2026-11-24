import type { ProviderInstanceEnvironment } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";

import { expandHomeVariable } from "./pathExpansion.ts";

/** Variables to add to one provider's processes, or `undefined` to add none. */
export type ProviderEnvironmentOverlay = (
  provider: string | undefined,
) => Readonly<Record<string, string>> | undefined;

let environmentOverlay: ProviderEnvironmentOverlay | undefined;

/**
 * Sets what is added to a provider process after its own configuration. The privacy gateway
 * uses it to route a masked provider's agents through itself; it wins over instance
 * configuration so that a provider setting cannot route around masking.
 */
export const setProviderEnvironmentOverlay = (
  overlay: ProviderEnvironmentOverlay | undefined,
): void => {
  environmentOverlay = overlay;
};

/**
 * Providers whose model requests the privacy gateway rewrites when it is in their path. Cursor's
 * model hosts are blocked; Kiro, Muse Code and fx send to hosts the gateway does not open; an ACP
 * registry agent may send anywhere.
 */
const REWRITTEN_PROVIDERS: ReadonlySet<string> = new Set([
  "claudeAgent",
  "codex",
  "opencode",
  "grok",
  "antigravity",
  "pi",
]);

/** Whether this provider's processes start routed through the privacy gateway, which masks them. */
export const providerRequestsMasked = (provider: string): boolean =>
  REWRITTEN_PROVIDERS.has(provider) && environmentOverlay?.(provider) !== undefined;

let sealedValues: () => boolean = () => false;

/** Set by the privacy gateway: whether a worker reads sealed files, whose values agents then get as stand-ins. */
export const setSealedValuesInUse = (inUse: () => boolean): void => {
  sealedValues = inUse;
};

export const sealedValuesInUse = (): boolean => sealedValues();

let sealedFolderOf: (path: string) => string | undefined = () => undefined;

/** Set by the privacy gateway: tells which sealed folder, if any, holds a path. */
export const setSealedFolderLookup = (lookup: (path: string) => string | undefined): void => {
  sealedFolderOf = lookup;
};

const lastPart = (path: string): string =>
  path.split(/[\\/]/).findLast((part) => part !== "") ?? path;
const isAbsolutePath = (path: string): boolean => /^(?:[\\/]|[A-Za-z]:[\\/])/.test(path);

/**
 * Why an agent's file may not be written at this path, or undefined when it may: every file of a
 * sealed folder is sealed as it arrives, so one written there could never be read back. Told to
 * the agent in place of the write.
 */
export const sealedFolderWriteRefusal = (path: string, cwd: string | null): string | undefined => {
  const absolute = isAbsolutePath(path) || cwd === null ? path : `${cwd}/${path}`;
  const folder = sealedFolderOf(absolute);
  return folder === undefined
    ? undefined
    : `The folder "${lastPart(folder)}" is sealed: every file in it is kept from you, so nothing can be written there. Write the file somewhere else in the workspace, or finish it with fill_sealed if it needs sealed values.`;
};

const withOverlay = (
  environment: NodeJS.ProcessEnv,
  provider: string | undefined,
): NodeJS.ProcessEnv => {
  const overlay = environmentOverlay?.(provider);
  return overlay === undefined ? environment : { ...environment, ...overlay };
};

/**
 * `provider` is the driver kind the process belongs to. Without it the process is treated as
 * one of a masked provider whenever masking is on.
 */
export const mergeProviderInstanceEnvironment = Effect.fn(function* (
  environment: ProviderInstanceEnvironment | undefined,
  baseEnv: NodeJS.ProcessEnv = process.env,
  provider?: string,
) {
  if (!environment || environment.length === 0) {
    return withOverlay(baseEnv, provider);
  }

  const home = yield* HostProcess.HomeDirectory;
  const windows = (yield* HostProcess.Platform) === "win32";
  const next: NodeJS.ProcessEnv = { ...baseEnv };
  for (const variable of environment) {
    // An unresolved secret reference carries no value; the registry resolves it for the provider.
    if (typeof variable.value !== "string") continue;
    // Windows reads names without regard to case, and a child gets the first spelling in sort
    // order. Upper case sorts first, so the configured value wins even where a spawn merges the
    // parent environment back in.
    const name = windows ? variable.name.toUpperCase() : variable.name;
    if (windows) {
      for (const inherited of Object.keys(next)) {
        if (inherited.toUpperCase() === name) delete next[inherited];
      }
    }
    next[name] = expandHomeVariable(name, variable.value, home);
  }
  return withOverlay(next, provider);
});
