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
 * The providers whose notice has not been read: masking is working, the user is signed in to the
 * provider and its requests go through the gateway.
 */
export const unreadNotices = (
  status: PrivacyStatus,
  providers: ReadonlyArray<ServerProvider>,
): ReadonlyArray<MaskedProvider> => {
  if (status.mode !== "cloud" && status.mode !== "selfHosted") return [];
  // An older server does not record who read the notice, so it cannot be shown only once.
  const read = status.noticesRead;
  if (read === undefined) return [];
  const direct = status.directProviders ?? [];
  return maskedProviders(providers).filter(
    (provider) =>
      provider.signedIn && !direct.includes(provider.driver) && !read.includes(provider.driver),
  );
};

/** The providers this computer has sent a chat to. A chat with no run yet has sent nothing. */
export const driversInUse = (
  chats: ReadonlyArray<{
    readonly environmentId: string;
    readonly providerInstanceId: string;
    readonly latestRun: unknown;
  }>,
  providers: ReadonlyArray<ServerProvider>,
  primaryEnvironmentId: string | null,
): ReadonlySet<string> => {
  const driverOf = new Map<string, string>(
    providers.map((provider) => [provider.instanceId, provider.driver]),
  );
  return new Set(
    chats.flatMap((chat) => {
      const driver =
        chat.environmentId === primaryEnvironmentId && chat.latestRun !== null
          ? driverOf.get(chat.providerInstanceId)
          : undefined;
      return driver === undefined ? [] : [driver];
    }),
  );
};

/**
 * The notice to show now. A provider's notice is shown when a chat with it starts, not for
 * every signed-in provider at once: the one a message is about to be sent to (`asked`) first,
 * then one that already has a chat here, such as a chat an agent or a schedule started.
 */
export const pendingNotice = (
  status: PrivacyStatus,
  providers: ReadonlyArray<ServerProvider>,
  inUse: ReadonlySet<string>,
  asked: string | null,
): MaskedProvider | undefined => {
  const unread = unreadNotices(status, providers);
  return (
    unread.find((provider) => provider.driver === asked) ??
    unread.find((provider) => inUse.has(provider.driver))
  );
};
