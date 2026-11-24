import { useAtomValue } from "@effect/atom-react";
import type { PrivacyKnownValues } from "@t3tools/contracts";
import { makeKnownValueMatcher, type KnownValueMatcher } from "@t3tools/shared/privacyKnownValues";
import * as Effect from "effect/Effect";
import { AsyncResult, Atom } from "effect/reactivity";

import type { FileValueMatcherState } from "~/components/privacy/FileValueMarkSurface";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { fetchKnownValues } from "./privacyClient";

type KnownValue = PrivacyKnownValues["values"][number];

/** Where two values share a spelling the matcher finds the later one: the gateway's choice. */
const ordinaryLast = (values: ReadonlyArray<KnownValue>): ReadonlyArray<KnownValue> => [
  ...values.filter((value) => value.sealed),
  ...values.filter((value) => !value.sealed),
];

// One read per opened file while the highlight is on: the atom is dropped when the file closes
// or the highlight is switched off, so the next one reads what the vault holds then.
const fileMatcherAtom = Atom.family((key: string) =>
  Atom.make(
    Effect.promise(() => fetchKnownValues({ scope: "vault" })).pipe(
      Effect.map((known) => makeKnownValueMatcher(ordinaryLast(known.values))),
    ),
  ).pipe(Atom.setIdleTTL(0), Atom.withLabel(`privacy:file-values:${key}`)),
);

const IDLE_FILE_MATCHER = Atom.make<AsyncResult.AsyncResult<KnownValueMatcher | null>>(
  AsyncResult.initial(),
).pipe(Atom.withLabel("privacy:file-values:idle"));

/** The values to highlight in the open file. Null `key` reads nothing. */
export function useFileValueMatcher(key: string | null): FileValueMatcherState | null {
  const result = useAtomValue(key === null ? IDLE_FILE_MATCHER : fileMatcherAtom(key));
  if (key === null) return null;
  if (AsyncResult.isSuccess(result)) return { kind: "ready", matcher: result.value };
  return AsyncResult.isFailure(result) ? { kind: "failed" } : { kind: "loading" };
}

/**
 * The stand-ins of the chat's turns, kept for the session: a turn's list never changes once the
 * turn has ended. `epoch` is what the lists were read under; a new one drops them all.
 */
const turns = {
  epoch: "",
  /** Null: asked, and the turn is no longer kept. */
  tokens: new Map<string, ReadonlyArray<string> | null>(),
  values: new Map<string, KnownValue>(),
  matchers: new Map<string, KnownValueMatcher | null>(),
  asked: new Set<string>(),
};

const turnValuesRevisionAtom = Atom.make(0).pipe(
  Atom.keepAlive,
  Atom.withLabel("privacy:turn-values-revision"),
);

/** Changes whenever `turnValueMatcher` may answer differently. */
export function useTurnValuesRevision(): number {
  return useAtomValue(turnValuesRevisionAtom);
}

const MAX_RUNS_PER_READ = 1000;

/**
 * Reads the stand-ins of the turns not read yet, in one request. `epoch` names the state of the
 * vault and of masking the lists belong to: when it changes, everything is read again.
 */
export const loadTurnValues = (runIds: ReadonlyArray<string>, epoch: string): void => {
  if (turns.epoch !== epoch) {
    turns.epoch = epoch;
    turns.tokens.clear();
    turns.values.clear();
    turns.matchers.clear();
    turns.asked.clear();
    appAtomRegistry.set(turnValuesRevisionAtom, appAtomRegistry.get(turnValuesRevisionAtom) + 1);
  }
  // The ledger keeps recent turns only, so the newest are the ones worth asking for.
  const missing = runIds.filter((runId) => !turns.asked.has(runId)).slice(-MAX_RUNS_PER_READ);
  if (missing.length === 0) return;
  for (const runId of missing) turns.asked.add(runId);
  void fetchKnownValues({ scope: "turns", runIds: missing }).then(
    (known) => {
      if (turns.epoch !== epoch) return;
      for (const value of known.values) turns.values.set(value.token, value);
      for (const runId of missing) turns.tokens.set(runId, null);
      for (const turn of known.turns) turns.tokens.set(turn.runId, turn.tokens);
      appAtomRegistry.set(turnValuesRevisionAtom, appAtomRegistry.get(turnValuesRevisionAtom) + 1);
    },
    () => {
      // Left unread: asked again when the chat's turns next change.
      if (turns.epoch === epoch) for (const runId of missing) turns.asked.delete(runId);
    },
  );
};

/** Finds what one turn replaced. Null until the turn is read, and when it replaced nothing. */
export const turnValueMatcher = (runId: string): KnownValueMatcher | null => {
  const cached = turns.matchers.get(runId);
  if (cached !== undefined) return cached;
  const tokens = turns.tokens.get(runId);
  if (tokens === undefined || tokens === null) return null;
  const matcher = makeKnownValueMatcher(
    ordinaryLast(
      tokens.flatMap((token) => {
        const value = turns.values.get(token);
        return value === undefined ? [] : [value];
      }),
    ),
  );
  turns.matchers.set(runId, matcher);
  return matcher;
};
