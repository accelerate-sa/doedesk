import type { DeidentifyItem, DeidentifyLayerChange } from "@t3tools/contracts";
import { T, useGT, useMessages } from "gt-react";
import { QrCodeIcon, ShieldCheckIcon } from "lucide-react";

import { cn } from "~/lib/utils";

import { ActionControl } from "./DeidentifyControls";
import { itemLabel } from "./deidentifyLabels";
import { groupItems, type ItemPlace } from "./deidentifyModel";

const ACTION_DOTS = {
  mask: "bg-warning",
  redact: "bg-foreground",
  keep: "border border-dashed border-muted-foreground bg-transparent",
} as const;

/**
 * Everything found in the file and everything a person marked, by where it is. Choosing a row
 * shows the item in the file; the control beside it decides what happens to it.
 */
export function DeidentifyItemRail({
  items,
  pageCount,
  placeLabel,
  selectedId,
  onSelect,
  onChanges,
}: {
  readonly items: ReadonlyArray<DeidentifyItem>;
  readonly pageCount: number;
  /** What a group of items is called. Nothing for a file that is one place. */
  readonly placeLabel: (place: ItemPlace) => string | null;
  readonly selectedId: string | null;
  readonly onSelect: (item: DeidentifyItem) => void;
  readonly onChanges: (changes: ReadonlyArray<DeidentifyLayerChange>) => void;
}) {
  const gt = useGT();
  const m = useMessages();
  if (items.length === 0) {
    return (
      <aside
        aria-label={gt("Items")}
        className="flex w-80 shrink-0 flex-col items-center justify-center gap-2 border-s bg-background text-muted-foreground"
      >
        <ShieldCheckIcon className="size-6 opacity-60" />
        <p className="text-xs">
          <T>Nothing found</T>
        </p>
      </aside>
    );
  }
  return (
    <aside
      aria-label={gt("Items")}
      className="flex w-80 shrink-0 flex-col overflow-y-auto border-s bg-background"
    >
      {groupItems(items, pageCount).map((group) => {
        const caption = placeLabel(group.place);
        return (
          <section key={group.key}>
            {caption === null ? null : (
              <h3
                className="sticky top-0 z-[1] truncate border-b bg-muted/80 px-3 py-1 text-muted-foreground text-xs backdrop-blur"
                dir="auto"
              >
                {caption}
              </h3>
            )}
            <ul>
              {group.items.map((item) => {
                const label = itemLabel(item, m);
                const value = item.preview ?? "";
                return (
                  <li
                    className={cn(
                      "flex items-center gap-1 border-b ps-1 pe-2",
                      item.id === selectedId && "bg-accent",
                    )}
                    data-action={item.action}
                    data-item-id={item.id}
                    key={item.id}
                  >
                    <button
                      aria-current={item.id === selectedId ? "true" : undefined}
                      className="flex min-w-0 flex-1 items-center gap-2 rounded-md px-2 py-1.5 text-start outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                      onClick={() => onSelect(item)}
                      type="button"
                    >
                      <span
                        className={cn("size-2 shrink-0 rounded-full", ACTION_DOTS[item.action])}
                      />
                      <span className="min-w-0 flex-1">
                        <span className="flex items-center gap-1 truncate text-muted-foreground text-2xs leading-4">
                          {item.origin === "code" ? (
                            <QrCodeIcon className="size-3 shrink-0" />
                          ) : null}
                          <span className="truncate">{label}</span>
                        </span>
                        {value === "" ? null : (
                          <span
                            className={cn(
                              "block truncate text-xs leading-4",
                              item.action === "redact" && "line-through decoration-foreground/60",
                            )}
                          >
                            <bdi>{value}</bdi>
                          </span>
                        )}
                      </span>
                    </button>
                    <ActionControl
                      action={item.action}
                      onAction={(action) =>
                        onChanges([{ type: "setItemAction", id: item.id, action }])
                      }
                      {...(item.source === "manual"
                        ? {
                            remove: {
                              kind: "delete" as const,
                              onRemove: () => onChanges([{ type: "removeItem", id: item.id }]),
                            },
                          }
                        : {})}
                    />
                  </li>
                );
              })}
            </ul>
          </section>
        );
      })}
    </aside>
  );
}
