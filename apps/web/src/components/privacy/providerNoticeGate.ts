import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId } from "@t3tools/contracts";
import { create } from "zustand";

import { usePrivacyStatus } from "~/privacy/privacyClient";
import { usePrimaryEnvironmentId } from "~/state/environments";
import { primaryServerProvidersAtom } from "~/state/server";
import { unreadNotices } from "./ProviderMasking.logic";

interface AskedNotice {
  readonly driver: string;
  /** True once the person has read the notice and that was recorded. */
  readonly settle: (read: boolean) => void;
}

/** The provider a message is waiting to be sent to, until its notice has been read. */
export const useProviderNoticeGate = create<{ asked: AskedNotice | null }>(() => ({
  asked: null,
}));

const askProviderNotice = (driver: string): Promise<boolean> =>
  new Promise((resolve) => {
    useProviderNoticeGate.getState().asked?.settle(false);
    useProviderNoticeGate.setState({ asked: { driver, settle: resolve } });
  });

/** Ends the wait of the message that asked for this provider's notice, if one did. */
export const settleProviderNotice = (driver: string, read: boolean): void => {
  const { asked } = useProviderNoticeGate.getState();
  if (asked?.driver !== driver) return;
  useProviderNoticeGate.setState({ asked: null });
  asked.settle(read);
};

/**
 * For the Send of a chat on this computer: null when the provider's notice was read or is not
 * owed, so the message goes at once. Otherwise the notice opens, and the promise says whether
 * the person read it; the message is sent only then.
 */
export function useProviderNoticeBeforeSend(
  environmentId: EnvironmentId | null,
): (driver: string | undefined) => Promise<boolean> | null {
  const primary = usePrimaryEnvironmentId();
  const privacy = usePrivacyStatus();
  const providers = useAtomValue(primaryServerProvidersAtom);
  return (driver) => {
    if (driver === undefined || environmentId === null || environmentId !== primary) return null;
    if (privacy.kind !== "ready") return null;
    return unreadNotices(privacy.status, providers).some((provider) => provider.driver === driver)
      ? askProviderNotice(driver)
      : null;
  };
}
