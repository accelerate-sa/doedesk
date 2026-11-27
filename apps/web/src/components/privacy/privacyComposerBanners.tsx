import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";
import { useGT } from "gt-react";
import { FileLock2Icon, GlobeLockIcon } from "lucide-react";
import { useEffect } from "react";

import {
  reloadPrivacyStatus,
  setPrivacyPreference,
  usePrivacyStatus,
} from "~/privacy/privacyClient";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { usePrimaryEnvironmentId } from "~/state/environments";
import type { ComposerBannerStackItem } from "../chat/ComposerBannerStack";
import { Button } from "../ui/button";
import { toastManager } from "../ui/toast";
import { refusedHostsToShow, watchesRefusedHosts } from "./privacyComposerBanners.logic";
import { useFolderSealing } from "./useFolderSealing";

const EMPTY: ReadonlyArray<ComposerBannerStackItem> = [];

// Refusals by host and time that the person waved away.
const dismissedAtom = Atom.make<ReadonlySet<string>>(new Set<string>()).pipe(
  Atom.keepAlive,
  Atom.withLabel("privacy:dismissed-composer-notes"),
);

/**
 * What privacy has to say beside the composer. Privacy settings are the primary environment's,
 * so a chat on another machine gets nothing from here.
 */
export function usePrivacyComposerBanners(
  environmentId: EnvironmentId | null,
  projectId: string | null,
  /** The chat's turn has been sent and its AI has not started yet. */
  turnStarting = false,
): ReadonlyArray<ComposerBannerStackItem> {
  const gt = useGT();
  const primary = usePrimaryEnvironmentId();
  const privacy = usePrivacyStatus();
  const dismissed = useAtomValue(dismissedAtom);
  const sealing = useFolderSealing(environmentId, projectId);
  // A turn that waits for a file still arriving in a sealed folder says so only in the status.
  const awaitsSealedFolder = turnStarting && (sealing.listing?.folders?.length ?? 0) > 0;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- the server holds a turn while a file settles and pushes nothing, so its status is read again while the turn has not started
  useEffect(() => {
    if (!awaitsSealedFolder) return;
    const timer = setInterval(() => void reloadPrivacyStatus().catch(() => undefined), 1_500);
    return () => clearInterval(timer);
  }, [awaitsSealedFolder]);
  if (environmentId === null || environmentId !== primary || privacy.kind !== "ready") return EMPTY;
  const dismiss = (key: string) => appAtomRegistry.set(dismissedAtom, new Set([...dismissed, key]));
  const refused = refusedHostsToShow(privacy.status, dismissed);
  const hold = turnStarting
    ? privacy.status.sealingBeforeTurn?.find((entry) => entry.project === projectId)
    : undefined;
  const holdNote: ReadonlyArray<ComposerBannerStackItem> =
    hold === undefined
      ? EMPTY
      : [
          {
            id: "privacy-sealing-before-turn",
            variant: "info",
            icon: <FileLock2Icon />,
            title: gt(
              "{count, plural, one {Sealing {count} new file in {folder}…} other {Sealing {count} new files in {folder}…}}",
              { count: hold.files, folder: hold.folder },
            ),
          },
        ];
  if (refused.length === 0) return holdNote;
  const allow = (host: string, lasting: boolean) =>
    void setPrivacyPreference({ kind: "allowHost", host, lasting }).then(
      () =>
        toastManager.add({
          type: "success",
          title: lasting
            ? gt("{host} is now always allowed.", { host })
            : gt("{host} is allowed until DoeDesk is closed.", { host }),
        }),
      () => toastManager.add({ type: "error", title: gt("The host could not be allowed.") }),
    );
  const refusedItems = refused.map((entry): ComposerBannerStackItem => ({
    id: `privacy-refused-host:${entry.host}`,
    variant: "warning",
    icon: <GlobeLockIcon />,
    title: gt("{host} was blocked", { host: entry.host }),
    actions: (
      <>
        <Button size="xs" variant="ghost" onClick={() => allow(entry.host, false)}>
          {gt("Allow for now")}
        </Button>
        {entry.canAllowAlways ? (
          <Button size="xs" variant="ghost" onClick={() => allow(entry.host, true)}>
            {gt("Always allow")}
          </Button>
        ) : null}
      </>
    ),
    dismissLabel: gt("Keep {host} blocked", { host: entry.host }),
    onDismiss: () => dismiss(entry.key),
  }));
  return [...holdNote, ...refusedItems];
}

/**
 * Asks the server which hosts it refused each time the chat moves on: a command that was refused
 * has just ended, so its notice shows then and not at the next timer in `PrivacyPrompts`.
 */
export function useRefusedHostCheck(
  environmentId: EnvironmentId | null,
  /** Changes when the agent starts a step or the turn ends. Null: no chat has started here. */
  progress: string | null,
): void {
  const primary = usePrimaryEnvironmentId();
  const privacy = usePrivacyStatus();
  const watched =
    environmentId !== null &&
    environmentId === primary &&
    privacy.kind === "ready" &&
    watchesRefusedHosts(privacy.status);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- the gateway refuses a host on the server and pushes nothing, so the status is read again when the chat moves on
  useEffect(() => {
    if (watched && progress !== null) void reloadPrivacyStatus().catch(() => undefined);
  }, [watched, progress]);
}
