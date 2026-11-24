import { useAtomValue } from "@effect/atom-react";
import { useEffect } from "react";

import { reloadPrivacyStatus, reloadSealedDocuments } from "~/privacy/privacyClient";
import { primarySealedRevisionAtom } from "~/state/server";

/**
 * Keeps what the app shows of sealed files current: the server says when it changed, whoever
 * changed it (a sealed folder's sweep, an agent's turn, another window), and the lists and the
 * status that carries the count are read again. Mounted once for the whole app.
 */
export function SealedChangesFromServer() {
  const revision = useAtomValue(primarySealedRevisionAtom);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- the server pushed a new count of sealed changes, so the lists read over HTTP are fetched again
  useEffect(() => {
    if (revision === null) return;
    reloadSealedDocuments();
    void reloadPrivacyStatus().catch(() => undefined);
  }, [revision]);
  return null;
}
