import type { DeidentifyLayer, DeidentifyLayerChange } from "@t3tools/contracts";

import { occurrencesOf, spansIn } from "./deidentifyModel";
import { MarkedText } from "./MarkedText";

/** A text or Markdown file as it is written, with what is marked in it. */
export function TextDeidentifyView({
  text,
  layer,
  view,
  selectedId,
  onSelect,
  onChanges,
}: {
  readonly text: string;
  readonly layer: DeidentifyLayer;
  readonly view: "original" | "deidentified";
  readonly selectedId: string | null;
  readonly onSelect: (id: string | null) => void;
  readonly onChanges: (changes: ReadonlyArray<DeidentifyLayerChange>) => void;
}) {
  const spans = spansIn(layer.items, text.length, (item) =>
    item.target.type === "text" ? item.target : undefined,
  );
  return (
    <div className="min-h-0 min-w-0 flex-1 overflow-auto bg-muted/40 p-4 scrollbar-gutter-both">
      <div className="mx-auto max-w-3xl rounded-lg border bg-background p-6 shadow-sm">
        <MarkedText
          className="font-mono text-sm leading-6"
          onAction={(id, action) => onChanges([{ type: "setItemAction", id, action }])}
          onMark={(range, action, everywhere) => {
            const places = everywhere
              ? occurrencesOf(text, text.slice(range.start, range.end))
              : [range];
            onChanges(
              places
                .filter(
                  (place) =>
                    !spans.some(
                      (span) =>
                        span.item.source === "manual" &&
                        span.start === place.start &&
                        span.end === place.end,
                    ),
                )
                .map((place) => ({
                  type: "addItem" as const,
                  action,
                  target: { type: "text" as const, start: place.start, end: place.end },
                })),
            );
          }}
          onRemove={(id) => onChanges([{ type: "removeItem", id }])}
          onSelect={onSelect}
          selectedId={selectedId}
          spans={spans}
          text={text}
          view={view}
        />
      </div>
    </div>
  );
}
