import type { PrivacyStatus } from "@t3tools/contracts";

export interface RefusedHost {
  readonly host: string;
  /** Names this refusal: the same host refused again later is shown again. */
  readonly key: string;
  /** False under "AI hosts only", where one click must not loosen the rule for good. */
  readonly canAllowAlways: boolean;
}

const MAX_SHOWN = 2;

/** The refused hosts worth a line by the composer: the newest, minus the ones waved away. */
export const refusedHostsToShow = (
  status: PrivacyStatus | null,
  dismissed: ReadonlySet<string>,
): ReadonlyArray<RefusedHost> => {
  const egress = status?.egress;
  if (egress === undefined || egress.policy === "open" || status?.mode === "off") return [];
  return (egress.refused ?? [])
    .map((entry) => ({
      host: entry.host,
      key: `${entry.host}@${entry.at}`,
      canAllowAlways: egress.policy === "allowlist",
    }))
    .filter((entry) => !dismissed.has(entry.key))
    .slice(0, MAX_SHOWN);
};

/** Whether the server's status is worth re-reading on a timer for refused hosts. */
export const watchesRefusedHosts = (status: PrivacyStatus | null): boolean =>
  status !== null && status.mode !== "off" && (status.egress?.policy ?? "open") !== "open";
