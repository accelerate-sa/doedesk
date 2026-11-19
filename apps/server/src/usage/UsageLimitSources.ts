import {
  UsageLimitSourceError,
  type UsageLimitSourceConsumeResetCreditInput,
  type ProviderConsumeResetCreditResult,
  type ProviderDriverKind,
  type UsageLimitSourceSnapshot,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

/**
 * T3 Code read usage limits from account hubs by having the hub call each AI company with the
 * stored login and that company's own client name. DoeDesk does not: this service reports no
 * sources, and the shape stays so that clients built for it keep working.
 */
export class UsageLimitSources extends Context.Service<
  UsageLimitSources,
  {
    readonly current: Effect.Effect<ReadonlyArray<UsageLimitSourceSnapshot>>;
    readonly streamChanges: Stream.Stream<ReadonlyArray<UsageLimitSourceSnapshot>>;
    readonly refresh: Effect.Effect<void>;
    readonly consumeResetCredit: (
      input: UsageLimitSourceConsumeResetCreditInput,
    ) => Effect.Effect<ProviderConsumeResetCreditResult, UsageLimitSourceError>;
  }
>()("t3/usage/UsageLimitSources") {}

export const layer = Layer.succeed(
  UsageLimitSources,
  UsageLimitSources.of({
    current: Effect.succeed([]),
    streamChanges: Stream.make([]),
    refresh: Effect.void,
    consumeResetCredit: Effect.fn("UsageLimitSources.consumeResetCredit")(function* () {
      return yield* new UsageLimitSourceError({ detail: "DoeDesk does not read usage from hubs." });
    }),
  }),
);

export class UsageLimitResetFallback extends Context.Reference<{
  readonly resetAt: (
    driver: ProviderDriverKind,
    endpoint: string,
    model: string | null,
  ) => Effect.Effect<string | null>;
}>("t3/usage/UsageLimitResetFallback", {
  defaultValue: () => ({ resetAt: () => Effect.succeed(null) }),
}) {}
