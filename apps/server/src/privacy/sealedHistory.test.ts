import { expect, it } from "@effect/vitest";
import { VcsProcessMissingExitCodeError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as CheckpointStore from "../checkpointing/CheckpointStore.ts";
import { sealChanged, sealedFoldersBeforeTurn, setSealChangeHandler } from "./agentWorkspaces.ts";
import * as SealedHistory from "./sealedHistory.ts";

it.effect("tries a failed removal again before each turn, and starts none while it fails", () =>
  Effect.gen(function* () {
    const asked: Array<ReadonlyArray<string>> = [];
    let failing = true;
    const checkpointStore = Layer.mock(CheckpointStore.CheckpointStore)({
      sealChanged: (change) =>
        Effect.suspend(() => {
          asked.push(change.paths);
          return failing
            ? Effect.fail(
                new VcsProcessMissingExitCodeError({
                  operation: "test",
                  command: "git gc",
                  cwd: "/case",
                }),
              )
            : Effect.void;
        }),
    });
    yield* Layer.build(SealedHistory.layer.pipe(Layer.provide(checkpointStore)));
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => setSealChangeHandler(() => Promise.resolve(true))),
    );

    // The gateway is not failed by it: the file is sealed, its copies are owed.
    yield* Effect.promise(() => sealChanged({ kind: "sealed", paths: ["/case/lease.md"] }));
    const refused = yield* Effect.promise(() => sealedFoldersBeforeTurn("thread", "project"));
    expect(refused?.title).toBe("Earlier copies of a sealed file could not be removed");

    failing = false;
    expect(yield* Effect.promise(() => sealedFoldersBeforeTurn("thread", "project"))).toBeNull();
    expect(yield* Effect.promise(() => sealedFoldersBeforeTurn("thread", "project"))).toBeNull();
    // Each turn start asked for the file that was left, until it was gone.
    expect(asked).toEqual([["/case/lease.md"], ["/case/lease.md"], ["/case/lease.md"]]);
  }).pipe(Effect.scoped),
);
