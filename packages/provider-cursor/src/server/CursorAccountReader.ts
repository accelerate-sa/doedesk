import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import type { CursorCredentialSource } from "./accountCache.ts";
import type { CursorAccountUsageReadResult } from "./accountUsage.ts";

export class CursorAccountReader extends Context.Service<
  CursorAccountReader,
  {
    readonly read: (
      credentialSource: CursorCredentialSource,
      sinceMs: number,
      untilMs: number,
    ) => Effect.Effect<CursorAccountUsageReadResult>;
  }
>()("@t3tools/provider-cursor/server/CursorAccountReader") {}

/**
 * T3 Code traded the user's Cursor key for a session and read Cursor's dashboard service with
 * it. DoeDesk does not call Cursor itself, so there is no account history to report.
 */
export const layer = Layer.succeed(
  CursorAccountReader,
  CursorAccountReader.of({
    read: Effect.fn("CursorAccountReader.read")(function* () {
      return yield* Effect.succeed({ accountKey: null, records: [], missing: true, error: null });
    }),
  }),
);
