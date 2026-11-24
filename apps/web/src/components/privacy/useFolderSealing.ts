import type { EnvironmentId, PrivacySealedListing } from "@t3tools/contracts";

import { usePrivacyStatus, useSealedDocuments } from "~/privacy/privacyClient";
import { usePrimaryEnvironmentId } from "~/state/environments";
import { folderSealing } from "./sealedFiles.logic";

/**
 * Whether files of this folder can be sealed from here, and what is sealed for it. Privacy is
 * the primary environment's, so a folder on another machine is sealed there: `elsewhere`.
 */
export function useFolderSealing(
  environmentId: EnvironmentId | null,
  projectId: string | null | undefined,
): {
  readonly offered: boolean;
  readonly elsewhere: boolean;
  readonly listing: PrivacySealedListing | null;
} {
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const privacy = usePrivacyStatus();
  const where = folderSealing({
    environmentId,
    primaryEnvironmentId,
    projectId,
    status: privacy.kind === "ready" ? privacy.status : null,
  });
  const offered = where === "here";
  const listing = useSealedDocuments(offered && projectId != null ? projectId : null);
  return { offered, elsewhere: where === "elsewhere", listing };
}
