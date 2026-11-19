import type { PrivacyStatus, ServerProvider } from "@t3tools/contracts";

import { type ProviderWords, providerWords } from "~/doedesk/providerConnections";
import { providerClients } from "../settings/providerDriverMeta";

export interface MaskedProvider {
  readonly driver: string;
  readonly words: ProviderWords;
  readonly signedIn: boolean;
  /** Installed and not signed out: there is something to mask. */
  readonly setUp: boolean;
}

/** One entry for each kind of provider that is switched on, in the order the server lists them. */
export const maskedProviders = (
  providers: ReadonlyArray<ServerProvider>,
): ReadonlyArray<MaskedProvider> => {
  const byDriver = new Map<string, MaskedProvider>();
  for (const provider of providers) {
    if (!provider.enabled) continue;
    const signedIn = provider.auth.status === "authenticated";
    const setUp = provider.installed && provider.auth.status !== "unauthenticated";
    const existing = byDriver.get(provider.driver);
    if (existing !== undefined) {
      byDriver.set(provider.driver, {
        ...existing,
        signedIn: existing.signedIn || signedIn,
        setUp: existing.setUp || setUp,
      });
      continue;
    }
    const label =
      providerClients.get(provider.driver)?.label ?? provider.displayName ?? provider.driver;
    byDriver.set(provider.driver, {
      driver: provider.driver,
      words: providerWords(provider.driver, label),
      signedIn,
      setUp,
    });
  }
  return [...byDriver.values()];
};

/**
 * The provider whose notice is due: masking is working, the user is signed in to it, its
 * requests go through the gateway, and its notice has not been read.
 */
export const pendingNotice = (
  status: PrivacyStatus,
  providers: ReadonlyArray<ServerProvider>,
): MaskedProvider | undefined => {
  if (status.mode !== "cloud" && status.mode !== "selfHosted") return undefined;
  // An older server does not record who read the notice, so it cannot be shown only once.
  const read = status.noticesRead;
  if (read === undefined) return undefined;
  const direct = status.directProviders ?? [];
  return maskedProviders(providers).find(
    (provider) =>
      provider.signedIn && !direct.includes(provider.driver) && !read.includes(provider.driver),
  );
};
