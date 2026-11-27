import type { DeidentifyFileRef, DeidentifyPolicy, EnvironmentId } from "@t3tools/contracts";
import { useEffect, useRef, useState } from "react";

import { type DeidentifyClient, liveDeidentifyClient } from "~/privacy/deidentifyClient";

import type { StudioQueue } from "./DeidentifyStudioDialog";
import { canDeidentify, hiddenCount } from "./deidentifyModel";
import { useDeidentificationOffered } from "./useDeidentificationOffered";

/** A file attached to a message that has not been sent: its bytes, or where they were uploaded. */
export interface PreSendAttachment {
  readonly id: string;
  readonly name: string;
  readonly file?: File | null | undefined;
  readonly uploadedAttachmentId?: string | undefined;
}

/** `ready`: checked and waiting for a look. `stale`: changed since it was reviewed. */
export type PreSendStatus = "scanning" | "ready" | "stale" | "reviewed" | "failed";

interface Checked {
  readonly ref: DeidentifyFileRef | null;
  readonly status: PreSendStatus;
  readonly itemCount: number;
}

export interface PreSendEntry {
  readonly id: string;
  readonly name: string;
  readonly status: PreSendStatus;
  /** How many values the copy would hide. */
  readonly itemCount: number;
  readonly openStudio: () => void;
}

export interface PreSendController {
  readonly deidentify: DeidentifyClient;
  /** The attachments that can be de-identified, in the order they were attached. */
  readonly entries: ReadonlyArray<PreSendEntry>;
  /**
   * Call before sending. True: send now. False: the message waits for a review, and `send` is
   * called once the person has given it and asks to send.
   */
  readonly guardSend: (send: () => void) => boolean;
  /** The attachments a held message is waiting on. Null when no message is held. */
  readonly waitingOn: ReadonlyArray<PreSendEntry> | null;
  readonly sendHeld: () => void;
  readonly releaseHeld: () => void;
  readonly reviewWaiting: () => void;
  readonly studio: {
    readonly file: DeidentifyFileRef;
    readonly queue: StudioQueue | undefined;
    readonly onReviewed: () => void;
    readonly onClose: () => void;
  } | null;
}

const SCANNING: Checked = { ref: null, status: "scanning", itemCount: 0 };

/**
 * Checks every file attached to a message as soon as it is attached, and says where each one
 * stands. Where the folder asks for a review before sending, Send waits until each has had one.
 */
export function usePreSendDeidentification({
  client = liveDeidentifyClient,
  environmentId,
  projectId,
  attachments,
}: {
  readonly client?: DeidentifyClient;
  /** Where the message will run. Files are checked on this computer, so only its own chats are. */
  readonly environmentId: EnvironmentId | null;
  readonly projectId: string | null | undefined;
  readonly attachments: ReadonlyArray<PreSendAttachment>;
}): PreSendController {
  const enabled = useDeidentificationOffered(environmentId, projectId);
  const [checked, setChecked] = useState<Readonly<Record<string, Checked>>>({});
  const [policy, setPolicy] = useState<DeidentifyPolicy | null>(null);
  const [held, setHeld] = useState<{ readonly send: () => void } | null>(null);
  const [reviewing, setReviewing] = useState<{
    readonly ids: ReadonlyArray<string>;
    readonly index: number;
  } | null>(null);
  const started = useRef(new Set<string>());
  const passing = useRef(false);

  const supported = enabled
    ? attachments.filter((attachment) => canDeidentify(attachment.name))
    : [];
  const check = async (attachment: PreSendAttachment, known: DeidentifyFileRef | null) => {
    let ref = known;
    if (ref === null && attachment.uploadedAttachmentId !== undefined) {
      ref = {
        kind: "attachment",
        attachmentId: attachment.uploadedAttachmentId,
        name: attachment.name,
      };
    }
    if (ref === null && attachment.file !== null && attachment.file !== undefined) {
      const staged = await client.stage(attachment.file);
      if (staged.ok) ref = { kind: "staged", stagedId: staged.stagedId, name: attachment.name };
    }
    const result = ref === null ? null : await client.inspect(ref);
    const next: Checked =
      result === null || !result.ok
        ? { ref, status: "failed", itemCount: 0 }
        : {
            ref,
            status:
              result.layer.reviewState === "reviewed"
                ? "reviewed"
                : result.layer.reviewState === "stale"
                  ? "stale"
                  : "ready",
            itemCount: hiddenCount(result.layer.items),
          };
    setChecked((current) => ({ ...current, [attachment.id]: next }));
  };

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- reads the folder's review policy from the server
  useEffect(() => {
    if (!enabled || projectId === null || projectId === undefined) return;
    let live = true;
    void client.policy({ projectId }).then((next) => {
      if (live) setPolicy(next);
    });
    return () => {
      live = false;
    };
  }, [client, enabled, projectId]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- starts the server's check of a file the moment it is attached
  useEffect(() => {
    for (const attachment of supported) {
      if (started.current.has(attachment.id)) continue;
      started.current.add(attachment.id);
      void check(attachment, null);
    }
    // Runs again whenever the attachments do: a file already started is passed over.
  }, [supported, check]);

  const openStudio = (ids: ReadonlyArray<string>, id: string) => {
    const withRef = ids.filter((candidate) => checked[candidate]?.ref != null);
    const index = withRef.indexOf(id);
    if (index !== -1) setReviewing({ ids: withRef, index });
  };

  const entries = supported.map((attachment): PreSendEntry => {
    const state = checked[attachment.id] ?? SCANNING;
    return {
      id: attachment.id,
      name: attachment.name,
      status: state.status,
      itemCount: state.itemCount,
      openStudio: () =>
        openStudio(
          supported.map((entry) => entry.id),
          attachment.id,
        ),
    };
  });
  const unreviewed = entries.filter((entry) => entry.status !== "reviewed");

  const guardSend = (send: () => void): boolean => {
    if (passing.current) {
      passing.current = false;
      return true;
    }
    if (policy?.alwaysReviewBeforeSend !== true || unreviewed.length === 0) return true;
    setHeld({ send });
    return false;
  };

  const reviewedId = reviewing?.ids[reviewing.index];
  const reviewedRef = reviewedId === undefined ? null : (checked[reviewedId]?.ref ?? null);

  return {
    deidentify: client,
    entries,
    guardSend,
    waitingOn: held === null ? null : unreviewed,
    sendHeld: () => {
      if (held === null || unreviewed.length > 0) return;
      setHeld(null);
      passing.current = true;
      held.send();
    },
    releaseHeld: () => setHeld(null),
    reviewWaiting: () => {
      const first = unreviewed.find((entry) => checked[entry.id]?.ref != null);
      if (first === undefined) return;
      openStudio(
        unreviewed.map((entry) => entry.id),
        first.id,
      );
    },
    studio:
      reviewing === null || reviewedId === undefined || reviewedRef === null
        ? null
        : {
            file: reviewedRef,
            queue:
              reviewing.ids.length > 1
                ? {
                    position: reviewing.index + 1,
                    total: reviewing.ids.length,
                    onPrevious:
                      reviewing.index > 0
                        ? () => setReviewing({ ...reviewing, index: reviewing.index - 1 })
                        : null,
                    onNext:
                      reviewing.index < reviewing.ids.length - 1
                        ? () => setReviewing({ ...reviewing, index: reviewing.index + 1 })
                        : null,
                  }
                : undefined,
            onReviewed: () =>
              setChecked((current) => {
                const state = current[reviewedId];
                return state === undefined
                  ? current
                  : { ...current, [reviewedId]: { ...state, status: "reviewed" } };
              }),
            onClose: () => {
              setReviewing(null);
              // What was decided in the studio may have changed the counts and the state.
              for (const attachment of supported) {
                const state = checked[attachment.id];
                if (state?.ref != null) void check(attachment, state.ref);
              }
            },
          },
  };
}
