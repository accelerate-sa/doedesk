import type { OrchestrationV2DomainEvent, OrchestrationV2Run } from "@t3tools/contracts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import { forkParked } from "../serverActivation.ts";
import * as PrivacyGateway from "./PrivacyGateway.ts";

const ENDED: ReadonlySet<OrchestrationV2Run["status"]> = new Set([
  "completed",
  "failed",
  "interrupted",
  "cancelled",
]);

/** A run that reached a provider and has ended. One that never started sent nothing. */
const runEnded = (run: Pick<OrchestrationV2Run, "status" | "startedAt">): boolean =>
  ENDED.has(run.status) && run.startedAt !== null;

/**
 * When a run ends, asks the gateway what it did for that chat since the run before, and writes
 * the answer onto the run. The gateway adds nothing to a request for this: it already counts.
 */
export const make = Effect.gen(function* () {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const eventSink = yield* EventSink.EventSinkV2;
  const idAllocator = yield* IdAllocator.IdAllocatorV2;
  const privacy = yield* PrivacyGateway.PrivacyGateway;

  const record = Effect.fn("PrivacyTurnRecorder.record")(function* (ended: OrchestrationV2Run) {
    const records = yield* projections.getThreadRecords(
      ended.threadId,
      ["runs", "providerThreads"],
      { runIds: [ended.id] },
    );
    // A later lifecycle write repeats the ended run; its record is written once.
    const run = records.runs.find((candidate) => candidate.id === ended.id);
    if (run === undefined || run.privacy !== undefined) return;
    const providerThread =
      records.providerThreads.find((thread) => thread.id === run.providerThreadId) ??
      records.providerThreads.find(
        (thread) => thread.providerInstanceId === run.providerInstanceId,
      );
    if (providerThread === undefined) return;
    const turn = yield* privacy.recordTurn({
      runId: run.id,
      threadId: run.threadId,
      driver: providerThread.driver,
      completed: run.status === "completed",
      // Every provider conversation of this chat, so a helper the provider started is counted.
      sessions: records.providerThreads.flatMap((thread) =>
        thread.nativeThreadRef?.nativeId == null ? [] : [thread.nativeThreadRef.nativeId],
      ),
    });
    if (turn === undefined) return;
    const event: OrchestrationV2DomainEvent = {
      id: yield* idAllocator.allocate.event({ threadId: run.threadId }),
      type: "run.privacy-recorded",
      threadId: run.threadId,
      runId: run.id,
      providerInstanceId: run.providerInstanceId,
      occurredAt: yield* DateTime.now,
      payload: { runId: run.id, privacy: turn },
    };
    yield* eventSink.write({ events: [event] });
  });

  const start = Effect.fn("PrivacyTurnRecorder.start")(function* () {
    yield* forkParked(
      Stream.runForEach(orchestrator.streamDomainEvents, (event) =>
        event.type === "run.updated" && runEnded(event.payload)
          ? record(event.payload).pipe(
              Effect.catchCause((cause) =>
                Effect.logWarning("privacy turn record skipped", {
                  runId: event.payload.id,
                  cause,
                }),
              ),
            )
          : Effect.void,
      ),
    );
  });
  return { start };
});
