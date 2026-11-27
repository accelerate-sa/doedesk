import type { EnvironmentId } from "@t3tools/contracts";

import { usePrivacyStatus } from "~/privacy/privacyClient";
import { usePrimaryEnvironmentId } from "~/state/environments";

/**
 * Whether files of this folder can be de-identified from here. Files are checked on this
 * computer with the detection the person set up, so a folder on another machine is not offered,
 * and neither is one while detection is off.
 */
export function useDeidentificationOffered(
  environmentId: EnvironmentId | null,
  projectId: string | null | undefined,
): boolean {
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const privacy = usePrivacyStatus();
  return (
    projectId !== null &&
    projectId !== undefined &&
    environmentId !== null &&
    environmentId === primaryEnvironmentId &&
    privacy.kind === "ready" &&
    (privacy.status.mode === "cloud" || privacy.status.mode === "selfHosted")
  );
}
