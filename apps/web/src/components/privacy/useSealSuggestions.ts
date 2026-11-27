import { useEffect, useState } from "react";

import {
  readableForSuggestion,
  type SealSuggestion,
  sealSuggestionFor,
  SUGGESTION_SAMPLE_BYTES,
} from "./sealSuggestion.logic";

interface AttachedFile {
  readonly id: string;
  readonly name: string;
  readonly file: File | null;
}

// One reading per attached file, however often the composer renders.
const decided = new WeakMap<File, Promise<SealSuggestion | null>>();

const decide = (name: string, file: File): Promise<SealSuggestion | null> => {
  const known = decided.get(file);
  if (known !== undefined) return known;
  const reading = file
    .slice(0, SUGGESTION_SAMPLE_BYTES)
    .text()
    .then(
      (text) => sealSuggestionFor(name, text),
      () => null,
    );
  decided.set(file, reading);
  return reading;
};

/**
 * Which attached files look like ones to seal, by attachment id. The files are read in this
 * browser and judged by the fixed-format rules; nothing is sent anywhere to decide.
 */
export function useSealSuggestions(
  files: ReadonlyArray<AttachedFile>,
): ReadonlyMap<string, SealSuggestion> {
  const [suggestions, setSuggestions] = useState<ReadonlyMap<string, SealSuggestion>>(new Map());
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- an attached file's text comes from the browser's File API, which answers later
  useEffect(() => {
    let current = true;
    for (const attached of files) {
      const { file } = attached;
      if (file === null || !readableForSuggestion(attached.name)) continue;
      void decide(attached.name, file).then((suggestion) => {
        if (!current || suggestion === null) return;
        setSuggestions((before) =>
          before.has(attached.id) ? before : new Map(before).set(attached.id, suggestion),
        );
      });
    }
    return () => {
      current = false;
    };
  }, [files]);
  return suggestions;
}

/** Whether one attached file looks like one to seal. Null until it is read, and where it does not. */
export function useSealSuggestion(name: string, file: File | null): SealSuggestion | null {
  const [found, setFound] = useState<{ file: File; suggestion: SealSuggestion } | null>(null);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- an attached file's text comes from the browser's File API, which answers later
  useEffect(() => {
    if (file === null || !readableForSuggestion(name)) return;
    let current = true;
    void decide(name, file).then((suggestion) => {
      if (current && suggestion !== null) setFound({ file, suggestion });
    });
    return () => {
      current = false;
    };
  }, [name, file]);
  return found !== null && found.file === file ? found.suggestion : null;
}
