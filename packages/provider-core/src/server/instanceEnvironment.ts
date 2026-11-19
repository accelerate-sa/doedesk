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
