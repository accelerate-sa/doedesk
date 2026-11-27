import {
  DEIDENTIFY_REDACTED_LABEL,
  type DeidentifyAction,
  type DeidentifyItem,
} from "@t3tools/contracts";
import { useGT, useMessages } from "gt-react";
import { EraserIcon, EyeIcon, Trash2Icon, VenetianMaskIcon } from "lucide-react";
import { type ComponentProps, useEffect, useRef, useState } from "react";

import { Button } from "~/components/ui/button";
import { SharedTooltipTrigger } from "~/components/ui/shared-tooltip";
import { Toggle, ToggleGroup } from "~/components/ui/toggle-group";
import { cn } from "~/lib/utils";
import type { DeidentifyClient } from "~/privacy/deidentifyClient";

import { itemLabel } from "./deidentifyLabels";
import { ACTIONS, standInOf } from "./deidentifyModel";

/** A redaction bar: what a redacted value looks like on the page. */
function RedactIcon(props: ComponentProps<"svg">) {
  return (
    <svg aria-hidden="true" fill="none" viewBox="0 0 24 24" {...props}>
      <rect fill="currentColor" height="8" rx="1.5" width="18" x="3" y="8" />
    </svg>
  );
}

const ACTION_ICONS = { mask: VenetianMaskIcon, redact: RedactIcon, keep: EyeIcon } as const;

/**
 * The one control that decides what happens to an item, wherever items are shown: the list, a
 * box on a page, a stretch of text, a column. `remove` adds the way to take a mark away.
 */
export function ActionControl({
  action,
  actions = ACTIONS,
  onAction,
  remove,
  scope,
}: {
  readonly action: DeidentifyAction | null;
  readonly actions?: ReadonlyArray<DeidentifyAction>;
  readonly onAction: (action: DeidentifyAction) => void;
  readonly remove?: { readonly kind: "delete" | "clear"; readonly onRemove: () => void };
  /** What the control acts on, where "Mask" alone would not say: a column, a row. */
  readonly scope?: "column" | "row" | "cells";
}) {
  const gt = useGT();
  const labels: Readonly<Record<DeidentifyAction, string>> =
    scope === "column"
      ? { mask: gt("Mask column"), redact: gt("Redact column"), keep: gt("Keep column") }
      : scope === "row"
        ? { mask: gt("Mask row"), redact: gt("Redact row"), keep: gt("Keep row") }
        : scope === "cells"
          ? { mask: gt("Mask cells"), redact: gt("Redact cells"), keep: gt("Keep cells") }
          : {
              mask: gt("Mask", { $context: "verb, replaces a value with a stand-in" }),
              redact: gt("Redact", { $context: "verb, removes a value for good" }),
              keep: gt("Keep", { $context: "verb, leaves a value as it is" }),
            };
  const removeLabel =
    remove === undefined
      ? ""
      : remove.kind === "delete"
        ? gt("Delete", { $context: "verb, removes a mark a person made" })
        : scope === "column"
          ? gt("Clear column")
          : scope === "row"
            ? gt("Clear row")
            : gt("Clear", { $context: "verb, removes marks from cells" });
  return (
    <div className="flex items-center gap-1" data-slot="deidentify-action-control">
      <ToggleGroup
        aria-label={gt("Action", { $context: "what is done with a value" })}
        value={action === null ? [] : [action]}
        onValueChange={(next) => {
          const chosen = next[0];
          if (chosen === "mask" || chosen === "redact" || chosen === "keep") onAction(chosen);
        }}
      >
        {actions.map((option) => {
          const Icon = ACTION_ICONS[option];
          return (
            <SharedTooltipTrigger
              key={option}
              label={labels[option]}
              render={<Toggle aria-label={labels[option]} value={option} />}
            >
              <Icon />
            </SharedTooltipTrigger>
          );
        })}
      </ToggleGroup>
      {remove === undefined ? null : (
        <SharedTooltipTrigger
          label={removeLabel}
          render={
            <Button
              aria-label={removeLabel}
              onClick={remove.onRemove}
              size="icon-xs"
              variant="ghost-destructive"
            />
          }
        >
          {remove.kind === "delete" ? <Trash2Icon /> : <EraserIcon />}
        </SharedTooltipTrigger>
      )}
    </div>
  );
}

/** How a marked stretch looks where the file is shown as it is. */
export const markTone = (action: DeidentifyAction): string =>
  action === "mask"
    ? "bg-warning/20 decoration-warning underline decoration-2 underline-offset-2"
    : action === "redact"
      ? "bg-foreground/85 text-background"
      : "underline decoration-dashed decoration-muted-foreground/70 underline-offset-2";

/** What stands in an item's place where the copy is shown. A kept item is shown as it is. */
export function StandIn({ item, className }: { item: DeidentifyItem; className?: string }) {
  const m = useMessages();
  if (item.action === "redact") {
    return (
      <span
        className={cn("rounded-xs bg-black px-1 font-mono text-white", className)}
        data-stand-in="redact"
      >
        {DEIDENTIFY_REDACTED_LABEL}
      </span>
    );
  }
  return (
    <span
      className={cn(
        "rounded-xs border border-warning/50 bg-warning/15 px-1 font-mono text-warning-foreground",
        className,
      )}
      data-stand-in="mask"
    >
      {standInOf(item) ?? (item.source === "manual" ? "•••" : itemLabel(item, m))}
    </span>
  );
}

/**
 * A page or picture from the server as an address an `<img>` can show. It is fetched with the
 * session's credentials, and the picture before it stays up until the new one has arrived.
 */
export function useDeidentifyPicture(
  client: DeidentifyClient,
  url: string | null,
  revision: string,
): { readonly address: string | null; readonly loading: boolean } {
  const [shown, setShown] = useState<{
    readonly url: string;
    readonly revision: string;
    readonly address: string | null;
  } | null>(null);
  const held = useRef<string | null>(null);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- fetches the picture with the session's credentials, which an <img> address cannot carry
  useEffect(() => {
    if (url === null) return;
    let live = true;
    void client.picture(url, revision).then((address) => {
      if (!live) {
        if (address !== null) URL.revokeObjectURL(address);
        return;
      }
      if (held.current !== null) URL.revokeObjectURL(held.current);
      held.current = address;
      setShown({ url, revision, address });
    });
    return () => {
      live = false;
    };
  }, [client, url, revision]);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- releases the last picture's memory when the view goes away
  useEffect(
    () => () => {
      if (held.current !== null) URL.revokeObjectURL(held.current);
      held.current = null;
    },
    [],
  );
  const current = shown !== null && shown.url === url ? shown : null;
  return {
    // An older state of the same picture stays up while the new one is drawn.
    address: current?.address ?? null,
    loading: url !== null && current?.revision !== revision,
  };
}
