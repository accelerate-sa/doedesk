import { describe, expect, it } from "@effect/vitest";
import {
  EventId,
  MessageId,
  NodeId,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2Run,
  type PrivacyTurnRecord,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";

import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as PrivacyGateway from "./PrivacyGateway.ts";
import * as PrivacyTurnRecorder from "./PrivacyTurnRecorder.ts";

const at = DateTime.makeUnsafe(Date.parse("2026-11-23T08:00:00.000Z"));
const threadId = ThreadId.make("thread-1");
const instanceId = ProviderInstanceId.make("claudeAgent");
const driver = ProviderDriverKind.make("claudeAgent");
const providerThreadId = ProviderThreadId.make("provider-thread-1");

const run = (id: string, fields: Partial<OrchestrationV2Run> = {}): OrchestrationV2Run => ({
  id: RunId.make(id),
  threadId,
  ordinal: 1,
  providerInstanceId: instanceId,
  modelSelection: { instanceId, model: "claude-haiku-5-5" },
  providerThreadId,
  userMessageId: MessageId.make(`message-${id}`),
  rootNodeId: NodeId.make("node-1"),
  activeAttemptId: null,
  status: "completed",
  requestedAt: at,
  startedAt: at,
  completedAt: at,
  checkpointId: null,
  contextHandoffId: null,
  ...fields,
});

const providerThread = (id: string, nativeId: string | null): OrchestrationV2ProviderThread => ({
  id: ProviderThreadId.make(id),
  driver,
  providerInstanceId: instanceId,
  providerSessionId: null,
  appThreadId: threadId,
  ownerNodeId: null,
  nativeThreadRef: nativeId === null ? null : { driver, nativeId, strength: "strong" },
  nativeConversationHeadRef: null,
  status: "idle",
  firstRunOrdinal: 1,
  lastRunOrdinal: 1,
  handoffIds: [],
  forkedFrom: null,
  createdAt: at,
  updatedAt: at,
});

const ended = (payload: OrchestrationV2Run): OrchestrationV2DomainEvent => ({
  id: EventId.make(`event-${payload.id}-${payload.status}`),
  type: "run.updated",
  threadId,
  runId: payload.id,
  occurredAt: at,
  payload,
});

const MASKED: PrivacyTurnRecord = {
  state: "masked",
  replaced: [{ kind: "PERSON", count: 2 }],
  rewritten: 3,
  refused: 0,
  redacted: 0,
  read: 0,
  withheld: 0,
  sealed: 0,
  attribution: "session",
};

describe("PrivacyTurnRecorder", () => {
  it.effect("writes what the gateway did onto each run that ended, once", () =>
    Effect.gen(function* () {
      const stored = [
        run("run-masked"),
        // A run recorded before: a later lifecycle write repeats it.
        run("run-recorded", { privacy: { state: "unseen" } }),
        run("run-quiet", { status: "interrupted" }),
      ];
      const asked: Array<Parameters<PrivacyGateway.PrivacyGateway["Service"]["recordTurn"]>[0]> =
        [];
      const written = yield* Queue.unbounded<OrchestrationV2DomainEvent>();
      const dependencies = Layer.mergeAll(
        IdAllocator.layer,
        Layer.mock(Orchestrator.OrchestratorV2)({
          streamDomainEvents: Stream.make(
            // Still running, and never started: neither has sent anything to count.
            ended(run("run-masked", { status: "running", completedAt: null })),
            ended(run("run-unstarted", { status: "cancelled", startedAt: null })),
            ended(stored[1]!),
            ended(stored[2]!),
            ended(stored[0]!),
          ),
        }),
        Layer.mock(ProjectionStore.ProjectionStoreV2)({
          getThreadRecords: ((
            _thread: ThreadId,
            _fields: unknown,
            filter: { readonly runIds: ReadonlyArray<string> },
          ) =>
            Effect.succeed({
              runs: stored.filter((candidate) => filter.runIds.includes(candidate.id)),
              providerThreads: [
                providerThread("provider-thread-1", "session-main"),
                providerThread("provider-thread-2", "session-helper"),
                providerThread("provider-thread-3", null),
              ],
            })) as never,
        }),
        Layer.mock(EventSink.EventSinkV2)({
          write: ({ events }) => Queue.offerAll(written, events).pipe(Effect.as([])),
        }),
        Layer.mock(PrivacyGateway.PrivacyGateway)({
          recordTurn: (input) =>
            Effect.sync(() => {
              asked.push(input);
              // The gateway has nothing to say about a turn that stopped early.
              return input.completed ? MASKED : undefined;
            }),
        }),
      );
      const event = yield* Effect.gen(function* () {
        const recorder = yield* PrivacyTurnRecorder.make;
        yield* recorder.start();
        return yield* Queue.take(written);
      }).pipe(Effect.provide(dependencies));

      expect(event).toMatchObject({
        type: "run.privacy-recorded",
        threadId,
        runId: "run-masked",
        payload: { runId: "run-masked", privacy: MASKED },
      });
      // Every conversation the provider holds for this chat is asked about, by its own name.
      expect(asked).toEqual([
        {
          runId: "run-quiet",
          threadId,
          driver,
          sessions: ["session-main", "session-helper"],
          completed: false,
        },
        {
          runId: "run-masked",
          threadId,
          driver,
          sessions: ["session-main", "session-helper"],
          completed: true,
        },
      ]);
      expect(yield* Queue.size(written)).toBe(0);
    }),
  );
});
