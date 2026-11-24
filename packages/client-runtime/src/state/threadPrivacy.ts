import type {
  OrchestrationV2ThreadProjection,
  PrivacyStatus,
  PrivacyTurnRecord,
  RunId,
} from "@t3tools/contracts";

/** A run and what the privacy gateway did for it. */
export interface ThreadRunPrivacy {
  readonly runId: RunId;
  readonly privacy: PrivacyTurnRecord;
}

const NONE: ReadonlyArray<ThreadRunPrivacy> = Object.freeze([]);

/** The runs that carry a privacy record, oldest first. */
export const threadRunPrivacy = (
  runs: OrchestrationV2ThreadProjection["runs"],
): ReadonlyArray<ThreadRunPrivacy> => {
  const recorded = runs.filter((run) => run.privacy !== undefined);
  if (recorded.length === 0) return NONE;
  return [...recorded]
    .sort((left, right) => left.ordinal - right.ordinal)
    .flatMap((run) => (run.privacy === undefined ? [] : [{ runId: run.id, privacy: run.privacy }]));
};

/**
 * Drivers whose requests were measured going through the gateway rewritten, and the one whose
 * model hosts the gateway refuses. See docs/operations/provider-connections.md. Every other
 * driver counts as masked only once a turn of the chat shows a rewritten request.
 */
const MEASURED_DRIVERS: ReadonlySet<string> = new Set(["claudeAgent", "codex"]);
const BLOCKED_DRIVERS: ReadonlySet<string> = new Set(["cursor"]);

/** What can be said about one chat's protection, from what is known and nothing more. */
export type ChatMaskingState =
  /** `sealed`: sealed documents in the chat's folder. */
  | { readonly kind: "masked"; readonly sealed: number }
  | { readonly kind: "notMasked"; readonly reason: "off" | "direct" }
  /**
   * `unmeasured`: this AI tool was never checked with the gateway and no turn here shows a
   * rewritten request. `unseen`: the last finished turn went by without one.
   */
  | { readonly kind: "unconfirmed"; readonly reason: "unmeasured" | "unseen" }
  | {
      readonly kind: "notSending";
      readonly reason: "notSetUp" | "terms" | "stopped" | "blocked";
    };

export interface ChatMaskingInput {
  /** The privacy status of the computer the chat runs on. Null when it is not known here. */
  readonly status: PrivacyStatus | null;
  /** The driver kind of the provider the chat uses now. */
  readonly driver: string;
  /** The chat's privacy records, oldest first. */
  readonly turns: ReadonlyArray<ThreadRunPrivacy>;
  /** Sealed documents in the chat's folder. */
  readonly sealed: number;
}

/**
 * The state of one chat. With no status (a chat on another computer), only the chat's own last
 * record speaks; with neither, nothing is said.
 */
export const chatMaskingState = (input: ChatMaskingInput): ChatMaskingState | null => {
  const last = input.turns.at(-1)?.privacy;
  const { status } = input;
  if (status === null) {
    if (last?.state === "masked" && last.rewritten > 0) return { kind: "masked", sealed: 0 };
    if (last?.state === "unmasked") return { kind: "notMasked", reason: last.reason };
    if (last?.state === "unseen") return { kind: "unconfirmed", reason: "unseen" };
    return null;
  }
  if (status.mode === "off") return { kind: "notMasked", reason: "off" };
  if (status.directProviders?.includes(input.driver) === true) {
    return { kind: "notMasked", reason: "direct" };
  }
  if (status.mode === "unconfigured") return { kind: "notSending", reason: "notSetUp" };
  if (!status.active) return { kind: "notSending", reason: "stopped" };
  if (status.acceptance?.blocked === true) return { kind: "notSending", reason: "terms" };
  if (BLOCKED_DRIVERS.has(input.driver)) return { kind: "notSending", reason: "blocked" };
  // The chat's own last turn outranks what was measured for the tool in general.
  if (last?.state === "masked" && last.rewritten > 0) {
    return { kind: "masked", sealed: input.sealed };
  }
  if (last?.state === "unseen") return { kind: "unconfirmed", reason: "unseen" };
  return MEASURED_DRIVERS.has(input.driver)
    ? { kind: "masked", sealed: input.sealed }
    : { kind: "unconfirmed", reason: "unmeasured" };
};

/** The one fact a turn's line leads with. */
export type TurnPrivacyHeadline =
  | { readonly kind: "replaced"; readonly count: number }
  | { readonly kind: "nothingFound" }
  | { readonly kind: "notSent"; readonly count: number }
  | { readonly kind: "unmasked" }
  | { readonly kind: "unseen" };

/** Distinct values the gateway replaced in what was sent during the turn. */
export const replacedValueCount = (record: PrivacyTurnRecord): number =>
  record.state === "masked" ? record.replaced.reduce((total, kind) => total + kind.count, 0) : 0;

/**
 * The turns whose replaced values are marked in the chat: those recorded with a replacement, and
 * only after the last turn sent without masking. That turn resent the earlier messages as
 * written, so a mark on them would no longer be true.
 */
export const markedRunIds = (turns: ReadonlyArray<ThreadRunPrivacy>): ReadonlyArray<RunId> => {
  const lastUnmasked = turns.findLastIndex((turn) => turn.privacy.state === "unmasked");
  return turns
    .slice(lastUnmasked + 1)
    .filter((turn) => replacedValueCount(turn.privacy) > 0)
    .map((turn) => turn.runId);
};

export const turnPrivacyHeadline = (record: PrivacyTurnRecord): TurnPrivacyHeadline => {
  if (record.state === "unmasked") return { kind: "unmasked" };
  if (record.state === "unseen") return { kind: "unseen" };
  const count = replacedValueCount(record);
  if (count > 0) return { kind: "replaced", count };
  // Nothing went out rewritten: what there is to say is that requests were held back.
  if (record.rewritten === 0) return { kind: "notSent", count: record.refused };
  return { kind: "nothingFound" };
};
