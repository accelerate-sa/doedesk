import { assert, it } from "@effect/vitest";
import { ProviderInstanceId, TextGenerationError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { decodeJsonReply, fromRunner } from "./textGenerationOperations.ts";

// regression: #23726 a reply that echoes the schema key replaced the seed title with "title"
it.effect("fails a thread title reply that is only the schema key", () =>
  Effect.gen(function* () {
    const textGeneration = fromRunner("Stub", (request) =>
      decodeJsonReply(request, "Stub", '{"title":"title","needsRefinement":false}'),
    );

    const outcome = yield* textGeneration
      .generateThreadTitle({
        cwd: process.cwd(),
        message: "$implement Issue #140",
        modelSelection: {
          instanceId: ProviderInstanceId.make("pi"),
          model: "anthropic/claude-haiku-4-5",
        },
      })
      .pipe(Effect.match({ onFailure: (error) => error, onSuccess: (result) => result }));

    assert.instanceOf(outcome, TextGenerationError);
    assert.strictEqual(outcome.operation, "generateThreadTitle");
  }),
);

// Packaged-app pass, 24 November 2026: two chats that began "Reply with the single word OK. Do not
// use any tools." were titled "Thread Title Generation".
it.effect("fails a title about titling for a thread that never mentions titles", () =>
  Effect.gen(function* () {
    const titled = (message: string, title: string) =>
      fromRunner("Stub", (request) =>
        decodeJsonReply(request, "Stub", JSON.stringify({ title, needsRefinement: false })),
      )
        .generateThreadTitle({
          cwd: process.cwd(),
          message,
          modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-6-luna" },
        })
        .pipe(Effect.match({ onFailure: (error) => error, onSuccess: (result) => result.title }));

    const trivial = "Reply with the single word OK. Do not use any tools.";
    for (const leaked of [
      "Thread Title Generation",
      "Generate Thread Title",
      "Chat Title Request",
    ]) {
      assert.instanceOf(yield* titled(trivial, leaked), TextGenerationError, leaked);
    }
    // A thread that is about titles keeps such a title, in any language that names them.
    assert.strictEqual(
      yield* titled("How can we improve title generation in T3 Code?", "Thread Title Generation"),
      "Thread Title Generation",
    );
    assert.strictEqual(
      yield* titled("لماذا لم يتغير عنوان المحادثة؟", "Thread Title Generation"),
      "Thread Title Generation",
    );
    // Any other title of a trivial message stands.
    assert.strictEqual(yield* titled(trivial, "Single-Word OK Reply"), "Single-Word OK Reply");
  }),
);
