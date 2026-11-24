import { neutralLabel } from "../sealedLabels.ts";
import type { RecordedClearAnswer, SealedStore, SealedTurnActivity } from "./store.ts";

/**
 * What each turn asked of sealed documents, kept for the person: which files, and every answer
 * that reached the agent's model as it is. Kept in the sealed store, because it names the files.
 */
const MAX_KEPT_TURNS = 500;
const MAX_OPEN_THREADS = 64;
const MAX_ANSWERS_PER_TURN = 200;

/** The newest entries of a record, which keeps the order its keys were added in. */
const newest = <T>(record: Record<string, T>, most: number): Record<string, T> =>
  Object.fromEntries(Object.entries(record).slice(-most));

/** Adds one `ask_documents` call to the turn the thread is in. */
export const noteSealedAsk = (
  store: SealedStore,
  project: string,
  thread: string,
  handles: ReadonlyArray<string>,
  answers: ReadonlyArray<RecordedClearAnswer>,
): void => {
  const activities = store.turnActivities();
  const { [thread]: before, ...others } = activities.open;
  const documents = new Map(store.list(project).map((info) => [info.handle, info]));
  const seen = new Set(before?.asked.map((document) => document.handle));
  const asked = [
    ...(before?.asked ?? []),
    ...handles
      .filter((handle) => !seen.has(handle))
      .map((handle) => {
        const info = documents.get(handle);
        if (info === undefined) return { handle, name: "" };
        // What the provider is told the file is called now, as `sealedForAgents` gives it.
        const label =
          info.neutralLabel !== true && info.label !== undefined
            ? info.label
            : neutralLabel(handle, info.name);
        return { handle, name: info.name, label };
      }),
  ];
  store.saveTurnActivities({
    ...activities,
    open: newest(
      {
        ...others,
        [thread]: {
          asked,
          answers: [...(before?.answers ?? []), ...answers].slice(-MAX_ANSWERS_PER_TURN),
        },
      },
      MAX_OPEN_THREADS,
    ),
  });
};

/** Ends a turn: what its thread asked since the turn before is kept under the run. */
export const takeSealedTurn = (
  store: SealedStore,
  thread: string,
  runId: string,
): SealedTurnActivity | undefined => {
  const activities = store.turnActivities();
  const { [thread]: activity, ...open } = activities.open;
  if (activity === undefined) return undefined;
  store.saveTurnActivities({
    open,
    kept: newest({ ...activities.kept, [runId]: activity }, MAX_KEPT_TURNS),
  });
  return activity;
};

/** A turn's activity, or undefined when it asked nothing or is no longer kept. */
export const sealedTurn = (store: SealedStore, runId: string): SealedTurnActivity | undefined =>
  store.turnActivities().kept[runId];
