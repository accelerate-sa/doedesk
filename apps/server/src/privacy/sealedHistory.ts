import type { SealChange } from "@t3tools/privacy-gateway";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as CheckpointStore from "../checkpointing/CheckpointStore.ts";
import { setSealChangeHandler } from "./agentWorkspaces.ts";

/**
 * Connects the privacy gateway, which seals files, to the checkpoint store, which holds copies
 * of them for undo. A sealed file whose copies could not be removed is tried again with every
 * later change and before every turn, and no turn starts while one is left.
 */
export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const checkpointStore = yield* CheckpointStore.CheckpointStore;
    const context = yield* Effect.context<never>();
    const left = new Set<string>();
    const handle = Effect.fn("SealedHistory.sealChanged")(function* (change: SealChange) {
      const sealed = change.kind === "sealed";
      const paths = sealed ? [...new Set([...left, ...change.paths])] : change.paths;
      if (paths.length === 0) return left.size === 0;
      const done = yield* checkpointStore.sealChanged({ ...change, paths }).pipe(
        Effect.as(true),
        Effect.catchCause((cause) =>
          Effect.logWarning("Could not remove sealed files from the copies kept for undo", {
            files: paths.length,
            cause,
          }).pipe(Effect.as(false)),
        ),
      );
      if (sealed) {
        left.clear();
        if (!done) for (const filePath of paths) left.add(filePath);
      }
      return left.size === 0;
    });
    setSealChangeHandler((change) => Effect.runPromiseWith(context)(handle(change)));
  }),
);
