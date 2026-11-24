import { markedRunIds } from "@t3tools/client-runtime/state/thread-privacy";
import type { EnvironmentId, ScopedThreadRef } from "@t3tools/contracts";
import { useEffect } from "react";

import { loadTurnValues, turnValueMatcher, useTurnValuesRevision } from "~/privacy/knownValues";
import { usePrivacyStatus } from "~/privacy/privacyClient";
import { useThreadRunPrivacy } from "~/state/entities";
import { usePrimaryEnvironmentId } from "~/state/environments";
import { CHAT_VALUE_MARK } from "./valueMarkRanges";
import { ValueMarks } from "./ValueMarks";

/** The attribute a timeline row names its turn with. */
const TIMELINE_ROW_RUN_ATTRIBUTE = "data-run-id";

const ROW_ATTRIBUTES = [TIMELINE_ROW_RUN_ATTRIBUTE] as const;

/**
 * Marks, in the person's messages and the assistant's replies, the values a turn sent as
 * stand-ins. A turn is marked once its record has arrived, never while it streams, and only on
 * the computer that holds the vault: a chat on another computer and a guest get no marks.
 */
export function ChatValueMarks(props: {
  readonly container: HTMLElement | null;
  readonly threadRef: ScopedThreadRef | null;
  readonly environmentId: EnvironmentId;
}) {
  const local = usePrimaryEnvironmentId() === props.environmentId;
  // A guest's page and a chat on another computer ask this computer's privacy service nothing.
  return local ? <LocalChatValueMarks {...props} /> : null;
}

function LocalChatValueMarks({
  container,
  threadRef,
}: {
  readonly container: HTMLElement | null;
  readonly threadRef: ScopedThreadRef | null;
}) {
  const privacy = usePrivacyStatus();
  const turns = useThreadRunPrivacy(threadRef);
  const revision = useTurnValuesRevision();
  const status = privacy.kind === "ready" ? privacy.status : null;
  const masking = status !== null && (status.mode === "cloud" || status.mode === "selfHosted");
  const marked = masking ? markedRunIds(turns) : [];
  const markedKey = marked.join("\n");
  // A deleted vault entry and a change of mode both change what the marks may claim.
  const epoch = status === null ? "" : `${status.mode}:${status.vaultSize}`;

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- reads the stand-ins of newly recorded turns from the server, one request for all of them
  useEffect(() => {
    if (markedKey !== "") loadTurnValues(markedKey.split("\n"), epoch);
  }, [markedKey, epoch]);

  if (marked.length === 0) return null;
  const markedRuns = new Set<string>(marked);
  return (
    <ValueMarks
      host={container}
      highlight={CHAT_VALUE_MARK}
      unitSelector={`[${TIMELINE_ROW_RUN_ATTRIBUTE}]`}
      scopeSelector="[data-thread-find-text]"
      unitAttributes={ROW_ATTRIBUTES}
      matcherFor={(row: Element) => {
        const runId = row.getAttribute(TIMELINE_ROW_RUN_ATTRIBUTE);
        return runId !== null && markedRuns.has(runId) ? turnValueMatcher(runId) : null;
      }}
      revision={`${revision}:${markedKey}`}
      tense="sent"
    />
  );
}
