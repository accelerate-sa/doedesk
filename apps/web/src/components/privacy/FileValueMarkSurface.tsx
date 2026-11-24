import type { KnownValueMatcher } from "@t3tools/shared/privacyKnownValues";
import { createContext, use, useEffect, useState } from "react";

import {
  FILE_VALUE_MARK,
  type ValueMarkStats,
  type ValueMarkSurfaceOptions,
} from "./valueMarkRanges";
import { ValueMarks } from "./ValueMarks";

// What a file viewer needs to show the highlight, and nothing of where the values come from:
// viewers import this, and only the file panel imports the provider behind it.

/** `text`: a viewer whose text can be marked. `textless`: an image, which has none. */
export type FileValueSurfaceKind = "text" | "textless";

/** Where the values come from. `matcher` is null when the vault holds nothing to look for. */
export type FileValueMatcherState =
  | { readonly kind: "loading" }
  | { readonly kind: "failed" }
  | { readonly kind: "ready"; readonly matcher: KnownValueMatcher | null };

export interface FileValueMarksValue {
  readonly on: boolean;
  readonly setOn: (on: boolean) => void;
  /** Viewers mounted for the open file, by kind. The switch shows only while there is one. */
  readonly surfaces: Readonly<Record<FileValueSurfaceKind, number>>;
  readonly mount: (kind: FileValueSurfaceKind) => () => void;
  /** Null while the highlight is off or no viewer can show it. */
  readonly state: FileValueMatcherState | null;
  /** What the mounted viewer has on screen. Null until it has looked. */
  readonly stats: ValueMarkStats | null;
  readonly report: (stats: ValueMarkStats) => void;
}

/** Null where the highlight is not offered: no switch shows and viewers mark nothing. */
export const FileValueMarksContext = createContext<FileValueMarksValue | null>(null);

/**
 * Says a viewer for the open file is mounted, and gives it the values to highlight: null while
 * the highlight is off, loading, or has nothing to look for.
 */
export function useFileValueMarks(kind: FileValueSurfaceKind = "text"): {
  readonly matcher: KnownValueMatcher | null;
  readonly report: ((stats: ValueMarkStats) => void) | undefined;
} {
  const marks = use(FileValueMarksContext);
  const mount = marks?.mount;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- tells the file's header that a viewer the highlight can work on is mounted, and that it is gone on unmount
  useEffect(() => mount?.(kind), [mount, kind]);
  const state = marks?.on === true ? marks.state : null;
  return {
    matcher: state?.kind === "ready" ? state.matcher : null,
    report: marks?.report,
  };
}

/** Marks an image preview: the switch is offered, and says there is no text to highlight. */
export function TextlessFileValueMarkSurface() {
  useFileValueMarks("textless");
  return null;
}

/**
 * Highlights the known values in the viewer it is placed in: its parent element is the text that
 * is marked. For a viewer that renders its text as DOM, in the page or in a shadow tree.
 */
export function FileValueMarkSurface(
  props: Pick<ValueMarkSurfaceOptions, "shadow" | "unitSelector" | "unitAttributes" | "lineBreaks">,
) {
  const { matcher, report } = useFileValueMarks();
  const [anchor, setAnchor] = useState<HTMLSpanElement | null>(null);
  return (
    <>
      <span ref={setAnchor} hidden data-file-value-marks />
      {matcher === null ? null : (
        <ValueMarks
          {...props}
          host={anchor?.parentElement ?? null}
          highlight={FILE_VALUE_MARK}
          matcherFor={() => matcher}
          revision={matcher}
          tense="sends"
          {...(report === undefined ? {} : { onStats: report })}
        />
      )}
    </>
  );
}
