import type {
  DeidentifyFailureReason,
  DeidentifyFileRef,
  DeidentifyInspection,
  DeidentifyInspectResult,
  DeidentifyLayer,
  DeidentifyLayerChange,
} from "@t3tools/contracts";
import { useEffect, useRef, useState } from "react";

import type { DeidentifyClient } from "~/privacy/deidentifyClient";

import { applyChangeLocally, LOCAL_ITEM_PREFIX } from "./deidentifyModel";

export type StudioState =
  | { readonly phase: "loading" }
  | { readonly phase: "failed"; readonly reason: DeidentifyFailureReason }
  | { readonly phase: "ready"; readonly inspection: DeidentifyInspection };

const stateOf = (result: DeidentifyInspectResult): StudioState =>
  result.ok ? { phase: "ready", inspection: result } : { phase: "failed", reason: result.reason };

const withLayer = (
  state: StudioState,
  next: (layer: DeidentifyLayer) => DeidentifyLayer,
): StudioState =>
  state.phase === "ready"
    ? { ...state, inspection: { ...state.inspection, layer: next(state.inspection.layer) } }
    : state;

const namesLocalItem = (change: DeidentifyLayerChange): boolean =>
  "id" in change && change.id.startsWith(LOCAL_ITEM_PREFIX);

/**
 * One file open in the studio: its layer as the server has it, shown ahead of the server's
 * answer for the changes whose outcome is known. Mount it once for each file (give the
 * component the file as its `key`).
 */
export function useDeidentifyStudio(client: DeidentifyClient, file: DeidentifyFileRef) {
  const [opened] = useState(file);
  const [state, setState] = useState<StudioState>({ phase: "loading" });
  const [scanning, setScanning] = useState(false);
  const unanswered = useRef(0);
  const inOrder = useRef<Promise<unknown>>(Promise.resolve());

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- reads the file's layer from the server when the studio opens it
  useEffect(() => {
    let live = true;
    void client.inspect(opened).then((result) => {
      if (live) setState(stateOf(result));
    });
    return () => {
      live = false;
    };
  }, [client, opened]);

  /** Makes changes. Answers with the layer once the server has made them, or null if it refused. */
  const change = (
    requested: ReadonlyArray<DeidentifyLayerChange>,
  ): Promise<DeidentifyLayer | null> => {
    const changes = requested.filter((entry) => !namesLocalItem(entry));
    if (changes.length === 0) return Promise.resolve(null);
    setState((current) => withLayer(current, (layer) => changes.reduce(applyChangeLocally, layer)));
    unanswered.current += 1;
    const answered = inOrder.current
      .then(() => client.update(opened, changes))
      .then(async (result) => {
        unanswered.current -= 1;
        if (!result.ok) {
          // What is shown may be ahead of the server: read what it really holds.
          setState(stateOf(await client.inspect(opened)));
          return null;
        }
        // An answer to an earlier change would undo what later ones already show.
        if (unanswered.current === 0) setState((current) => withLayer(current, () => result.layer));
        return result.layer;
      });
    inOrder.current = answered.catch(() => undefined);
    return answered;
  };

  const rescan = async (): Promise<void> => {
    setScanning(true);
    setState(stateOf(await client.inspect(opened, { rescan: true })));
    setScanning(false);
  };

  return { state, scanning, change, rescan };
}
