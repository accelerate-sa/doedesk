import type {
  DeidentifyAction,
  DeidentifyCellsTarget,
  DeidentifyItem,
  DeidentifyLayer,
  DeidentifyLayerChange,
  DeidentifySheetPreview,
} from "@t3tools/contracts";
import { useGT } from "gt-react";
import { ChevronDownIcon } from "lucide-react";
import { type MouseEvent, type ReactNode, useEffect, useRef, useState } from "react";

import { Button } from "~/components/ui/button";
import { SharedTooltipTrigger } from "~/components/ui/shared-tooltip";
import { Toggle, ToggleGroup } from "~/components/ui/toggle-group";
import { cn } from "~/lib/utils";

import { ActionControl, markTone, StandIn } from "./DeidentifyControls";
import {
  ACTIONS,
  type CellRange,
  columnLetter,
  columnTargetOf,
  isInRange,
  manualMarksOn,
  markAt,
  rangeBetween,
  rangeTargetOf,
  rowTargetOf,
  segmentsOf,
  sheetMarksOf,
  spansIn,
  stretchesAt,
} from "./deidentifyModel";

const ROWS_AT_A_TIME = 200;
const WIDE_ACTIONS: ReadonlyArray<DeidentifyAction> = ["mask", "redact"];

type Pick =
  | { readonly kind: "column"; readonly column: number }
  | { readonly kind: "row"; readonly row: number }
  | {
      readonly kind: "cells";
      readonly anchor: { readonly row: number; readonly column: number };
      readonly range: CellRange;
    };

interface Floating {
  readonly left: number;
  readonly top: number;
}

const cellTone = (action: DeidentifyAction): string =>
  action === "mask"
    ? "bg-warning/20"
    : action === "redact"
      ? "bg-foreground/85 text-background"
      : "";

const headTone = (action: DeidentifyAction | undefined): string =>
  action === "mask"
    ? "bg-warning/30 text-foreground"
    : action === "redact"
      ? "bg-foreground text-background"
      : "bg-muted/60 text-muted-foreground hover:bg-accent hover:text-foreground";

/** One cell's text, with the values found inside it marked or stood in for. */
function CellText({
  text,
  whole,
  stretches,
  view,
}: {
  readonly text: string;
  readonly whole: DeidentifyItem | undefined;
  readonly stretches: ReadonlyArray<DeidentifyItem>;
  readonly view: "original" | "deidentified";
}): ReactNode {
  if (whole !== undefined) {
    return view === "deidentified" && whole.action !== "keep" && text !== "" ? (
      <StandIn item={whole} />
    ) : (
      text
    );
  }
  if (stretches.length === 0) return text;
  const spans = spansIn(stretches, text.length, (item) =>
    item.target.type === "cells" && item.target.start !== undefined && item.target.end !== undefined
      ? { start: item.target.start, end: item.target.end }
      : undefined,
  );
  return segmentsOf(text.length, spans).map((segment) => {
    const slice = text.slice(segment.start, segment.end);
    const { item } = segment;
    if (item === undefined) return <span key={segment.start}>{slice}</span>;
    if (view === "deidentified") {
      return item.action === "keep" ? (
        <span key={segment.start}>{slice}</span>
      ) : (
        <StandIn item={item} key={segment.start} />
      );
    }
    return (
      <mark
        className={cn("rounded-xs bg-transparent text-inherit", markTone(item.action))}
        data-action={item.action}
        data-item-id={item.id}
        key={segment.start}
      >
        {slice}
      </mark>
    );
  });
}

/**
 * A sheet as a grid. A column's header marks the whole column, a row's number the whole row,
 * and a cell (or, with Shift held, a range of them) those cells.
 */
export function SpreadsheetDeidentifyView({
  sheets,
  sheetName,
  onSheet,
  layer,
  view,
  selectedId,
  onChanges,
}: {
  readonly sheets: ReadonlyArray<DeidentifySheetPreview>;
  /** The sheet that is shown. Null shows the first. */
  readonly sheetName: string | null;
  readonly onSheet: (name: string) => void;
  /** The item chosen from the list: its first cell is brought into view. */
  readonly selectedId: string | null;
  readonly layer: DeidentifyLayer;
  readonly view: "original" | "deidentified";
  readonly onChanges: (changes: ReadonlyArray<DeidentifyLayerChange>) => void;
}) {
  const gt = useGT();
  const frame = useRef<HTMLDivElement | null>(null);
  const [extraRows, setExtraRows] = useState(0);
  const [picked, setPicked] = useState<({ readonly pick: Pick } & Floating) | null>(null);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- brings the cells of an item chosen from the list into the scrolled grid's view
  useEffect(() => {
    if (selectedId === null) return;
    frame.current
      ?.querySelector(`[data-item-ids~="${CSS.escape(selectedId)}"]`)
      ?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [selectedId]);
  const sheet = sheets.find((candidate) => candidate.name === sheetName) ?? sheets[0];
  if (sheet === undefined) return null;

  const editable = view === "original";
  const rows = sheet.rows.slice(0, ROWS_AT_A_TIME + extraRows);
  const columns = Array.from({ length: sheet.columnCount }, (_, column) => column);
  const marks = sheetMarksOf(layer.items, sheet.name, {
    rows: sheet.rowCount,
    columns: sheet.columnCount,
  });
  const headers = sheet.rows.find((row) => row.index === 0)?.cells ?? [];
  const pick = editable ? (picked?.pick ?? null) : null;

  const place = (event: MouseEvent<HTMLElement>, next: Pick) => {
    const bounds = event.currentTarget.getBoundingClientRect();
    const within = frame.current?.getBoundingClientRect();
    if (within === undefined) return;
    setPicked({
      pick: next,
      left: Math.max(4, bounds.left - within.left),
      top: bounds.bottom - within.top + 4,
    });
  };

  const targetOf = (chosen: Pick): DeidentifyCellsTarget =>
    chosen.kind === "column"
      ? columnTargetOf(sheet.name, chosen.column)
      : chosen.kind === "row"
        ? rowTargetOf(sheet.name, chosen.row)
        : rangeTargetOf(sheet.name, chosen.range);

  /** What decides the picked cells now: a person's own mark on exactly them, or what was found in one cell. */
  const decidingItem = (chosen: Pick): DeidentifyItem | undefined => {
    const own = manualMarksOn(layer.items, targetOf(chosen))[0];
    if (own !== undefined) return own;
    if (chosen.kind !== "cells") return undefined;
    const { range } = chosen;
    if (range.startRow !== range.endRow || range.startColumn !== range.endColumn) return undefined;
    const found = marks.cells.get(`${range.startRow}:${range.startColumn}`);
    return found?.source === "auto" ? found : undefined;
  };

  const act = (chosen: Pick, action: DeidentifyAction) => {
    const item = decidingItem(chosen);
    onChanges([
      item === undefined
        ? { type: "addItem", action, target: targetOf(chosen) }
        : { type: "setItemAction", id: item.id, action },
    ]);
  };

  const clear = (chosen: Pick) => {
    onChanges(
      manualMarksOn(layer.items, targetOf(chosen)).map((item) => ({
        type: "removeItem" as const,
        id: item.id,
      })),
    );
    setPicked(null);
  };

  const deciding = pick === null ? undefined : decidingItem(pick);
  const moreLabel = gt("More rows");

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-muted/40">
      <div className="min-h-0 flex-1 overflow-auto">
        <div className="relative w-max min-w-full" ref={frame}>
          <table
            className="border-separate border-spacing-0 bg-background text-xs"
            data-slot="deidentify-sheet"
          >
            <thead className="sticky top-0 z-[2]">
              <tr>
                <th className="sticky start-0 z-[3] w-10 border-e border-b bg-muted" />
                {columns.map((column) => {
                  const mark = marks.columns.get(column);
                  const name = headers[column] ?? "";
                  const letter = columnLetter(column);
                  return (
                    <th className="border-e border-b p-0 font-normal" key={column} scope="col">
                      <button
                        aria-label={gt("Column {name}", { name: name === "" ? letter : name })}
                        aria-pressed={pick?.kind === "column" && pick.column === column}
                        className={cn(
                          "flex h-7 w-full min-w-24 items-center gap-1.5 px-2 text-start outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring aria-pressed:ring-2 aria-pressed:ring-inset aria-pressed:ring-ring",
                          headTone(mark?.action),
                        )}
                        data-action={mark?.action}
                        data-column={column}
                        data-item-ids={mark?.id}
                        disabled={!editable}
                        onClick={(event) => place(event, { kind: "column", column })}
                        type="button"
                      >
                        <span className="opacity-60">{letter}</span>
                        <span className="truncate font-medium" dir="auto">
                          {name}
                        </span>
                      </button>
                    </th>
                  );
                })}
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => {
                const rowMark = marks.rows.get(row.index);
                return (
                  <tr key={row.index}>
                    <th
                      className="sticky start-0 z-[1] border-e border-b p-0 font-normal"
                      scope="row"
                    >
                      <button
                        aria-label={gt("Row {number}", { number: row.index + 1 })}
                        aria-pressed={pick?.kind === "row" && pick.row === row.index}
                        className={cn(
                          "h-7 w-10 text-center tabular-nums outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring aria-pressed:ring-2 aria-pressed:ring-inset aria-pressed:ring-ring",
                          headTone(rowMark?.action),
                        )}
                        data-action={rowMark?.action}
                        data-item-ids={rowMark?.id}
                        data-row={row.index}
                        disabled={!editable}
                        onClick={(event) => place(event, { kind: "row", row: row.index })}
                        type="button"
                      >
                        {row.index + 1}
                      </button>
                    </th>
                    {columns.map((column) => {
                      const text = row.cells[column] ?? "";
                      const whole = markAt(marks, row.index, column);
                      const inside = stretchesAt(marks, row.index, column);
                      const chosen =
                        pick?.kind === "cells" && isInRange(pick.range, row.index, column);
                      return (
                        <td
                          aria-selected={chosen}
                          className={cn(
                            "h-7 max-w-64 truncate border-e border-b px-2 aria-selected:outline-2 aria-selected:-outline-offset-2 aria-selected:outline-ring",
                            editable && "cursor-cell",
                            whole !== undefined && view === "original" && cellTone(whole.action),
                          )}
                          data-action={whole?.action}
                          data-cell={`${row.index}:${column}`}
                          data-item-ids={[whole, ...inside].map((item) => item?.id ?? "").join(" ")}
                          dir="auto"
                          key={column}
                          onClick={(event) => {
                            if (!editable) return;
                            const at = { row: row.index, column };
                            const anchor =
                              event.shiftKey && pick?.kind === "cells" ? pick.anchor : at;
                            place(event, {
                              kind: "cells",
                              anchor,
                              range: rangeBetween(anchor, at),
                            });
                          }}
                        >
                          <CellText stretches={inside} text={text} view={view} whole={whole} />
                        </td>
                      );
                    })}
                  </tr>
                );
              })}
            </tbody>
          </table>
          {pick !== null && picked !== null ? (
            <div
              className="absolute z-10 rounded-lg border bg-popover p-1 shadow-md"
              data-testid="deidentify-cells-actions"
              dir="ltr"
              style={{ left: picked.left, top: picked.top }}
            >
              <ActionControl
                action={deciding?.action ?? null}
                actions={deciding?.source === "auto" ? ACTIONS : WIDE_ACTIONS}
                onAction={(action) => act(pick, action)}
                scope={pick.kind === "cells" ? "cells" : pick.kind}
                {...(deciding?.source === "manual"
                  ? { remove: { kind: "clear" as const, onRemove: () => clear(pick) } }
                  : {})}
              />
            </div>
          ) : null}
        </div>
      </div>
      <div className="flex h-9 shrink-0 items-center gap-2 border-t bg-background px-2">
        {sheets.length > 1 ? (
          <ToggleGroup
            aria-label={gt("Sheets")}
            onValueChange={(next) => {
              const chosen = next[0];
              if (typeof chosen !== "string") return;
              onSheet(chosen);
              setExtraRows(0);
              setPicked(null);
            }}
            value={[sheet.name]}
          >
            {sheets.map((candidate) => (
              <Toggle key={candidate.name} value={candidate.name}>
                <span className="max-w-40 truncate" dir="auto">
                  {candidate.name}
                </span>
              </Toggle>
            ))}
          </ToggleGroup>
        ) : null}
        <span className="ms-auto text-muted-foreground text-xs tabular-nums">
          {`${rows.length} / ${sheet.rowCount}`}
        </span>
        {rows.length < sheet.rows.length ? (
          <SharedTooltipTrigger
            label={moreLabel}
            render={
              <Button
                aria-label={moreLabel}
                onClick={() => setExtraRows(extraRows + ROWS_AT_A_TIME * 2)}
                size="icon-xs"
                variant="ghost"
              />
            }
          >
            <ChevronDownIcon />
          </SharedTooltipTrigger>
        ) : null}
      </div>
    </div>
  );
}
