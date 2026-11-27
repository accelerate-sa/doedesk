import type { DeidentifyAction } from "@t3tools/contracts";
import { T, useMessages } from "gt-react";
import { useEffect, useRef, useState } from "react";

import { Button } from "~/components/ui/button";
import { cn } from "~/lib/utils";

import { ActionControl, markTone, StandIn } from "./DeidentifyControls";
import { itemLabel } from "./deidentifyLabels";
import { segmentsOf, type TextSpan } from "./deidentifyModel";

interface Floating {
  readonly left: number;
  readonly top: number;
}

const SELECTION_ACTIONS: ReadonlyArray<DeidentifyAction> = ["mask", "redact"];

/** Where a point of a selection is in the text, counted the way items count. */
const offsetIn = (container: HTMLElement, node: Node, offset: number): number | undefined => {
  if (node === container) {
    const child = container.children[offset];
    const at = child?.getAttribute("data-offset");
    return at === null || at === undefined ? undefined : Number(at);
  }
  const holder =
    node instanceof Element
      ? node.closest("[data-offset]")
      : node.parentElement?.closest("[data-offset]");
  if (holder === null || holder === undefined || !container.contains(holder)) return undefined;
  const base = Number(holder.getAttribute("data-offset"));
  if (node.nodeType === Node.TEXT_NODE) return base + offset;
  return base + (offset > 0 ? (holder.textContent?.length ?? 0) : 0);
};

const below = (container: HTMLElement, bounds: DOMRect): Floating => {
  const frame = container.getBoundingClientRect();
  return {
    left: Math.max(0, Math.min(bounds.left - frame.left, frame.width - 180)),
    top: bounds.bottom - frame.top + 6,
  };
};

/**
 * A text with its marked stretches. As the file is, a stretch is highlighted and can be chosen,
 * and any words selected with the mouse can be marked; as the copy is, each stretch shows what
 * stands in its place.
 */
export function MarkedText({
  text,
  spans,
  view,
  selectedId,
  onSelect,
  onAction,
  onRemove,
  onMark,
  className,
}: {
  readonly text: string;
  readonly spans: ReadonlyArray<TextSpan>;
  readonly view: "original" | "deidentified";
  readonly selectedId: string | null;
  readonly onSelect: (id: string | null) => void;
  readonly onAction: (id: string, action: DeidentifyAction) => void;
  readonly onRemove: (id: string) => void;
  /** Marks the selected words, or every place they stand when `everywhere`. */
  readonly onMark: (
    range: { readonly start: number; readonly end: number },
    action: DeidentifyAction,
    everywhere: boolean,
  ) => void;
  readonly className?: string;
}) {
  const m = useMessages();
  const container = useRef<HTMLDivElement | null>(null);
  const [picked, setPicked] = useState<
    ({ readonly start: number; readonly end: number } & Floating) | null
  >(null);
  const [chosen, setChosen] = useState<({ readonly id: string } & Floating) | null>(null);
  const editable = view === "original";
  const selected = spans.find((span) => span.item.id === selectedId);
  const selectedHere = selected?.item.id ?? null;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- brings a stretch chosen from the list into the scrolled text's view
  useEffect(() => {
    if (selectedHere === null) return;
    container.current
      ?.querySelector(`[data-item-id="${CSS.escape(selectedHere)}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [selectedHere]);

  const readSelection = () => {
    const frame = container.current;
    const selection = window.getSelection();
    if (frame === null || selection === null || selection.rangeCount === 0 || !editable) return;
    const range = selection.getRangeAt(0);
    if (range.collapsed || !frame.contains(range.commonAncestorContainer)) {
      setPicked(null);
      return;
    }
    const start = offsetIn(frame, range.startContainer, range.startOffset);
    const end = offsetIn(frame, range.endContainer, range.endOffset) ?? text.length;
    if (start === undefined || end <= start || text.slice(start, end).trim() === "") {
      setPicked(null);
      return;
    }
    onSelect(null);
    setChosen(null);
    setPicked({ start, end, ...below(frame, range.getBoundingClientRect()) });
  };

  const mark = (action: DeidentifyAction, everywhere: boolean) => {
    if (picked === null) return;
    onMark({ start: picked.start, end: picked.end }, action, everywhere);
    window.getSelection()?.removeAllRanges();
    setPicked(null);
  };

  return (
    <div
      // Each line takes its direction from its own first letter: an Arabic paragraph and an
      // English one under it are both read the right way round.
      className={cn(
        "relative whitespace-pre-wrap break-words text-start [unicode-bidi:plaintext]",
        className,
      )}
      data-slot="deidentify-marked-text"
      onKeyUp={readSelection}
      onMouseUp={readSelection}
      ref={container}
    >
      {segmentsOf(text.length, spans).map((segment) => {
        const slice = text.slice(segment.start, segment.end);
        const { item } = segment;
        if (item === undefined || (!editable && item.action === "keep")) {
          return (
            <span data-offset={segment.start} key={segment.start}>
              {slice}
            </span>
          );
        }
        if (!editable) return <StandIn item={item} key={segment.start} />;
        return (
          <mark
            aria-label={itemLabel(item, m)}
            aria-pressed={item.id === selectedId}
            className={cn(
              "cursor-pointer rounded-xs bg-transparent text-inherit data-[selected=true]:ring-2 data-[selected=true]:ring-ring data-[selected=true]:ring-inset",
              markTone(item.action),
            )}
            data-action={item.action}
            data-item-id={item.id}
            data-offset={segment.start}
            data-selected={item.id === selectedId}
            key={segment.start}
            onClick={(event) => {
              const frame = container.current;
              if (frame === null || window.getSelection()?.isCollapsed === false) return;
              onSelect(item.id);
              setPicked(null);
              setChosen({
                id: item.id,
                ...below(frame, event.currentTarget.getBoundingClientRect()),
              });
            }}
            onKeyDown={(event) => {
              if (event.key !== "Enter" && event.key !== " ") return;
              event.preventDefault();
              event.currentTarget.click();
            }}
            role="button"
            tabIndex={0}
          >
            {slice}
          </mark>
        );
      })}
      {editable && selected !== undefined && chosen?.id === selected.item.id ? (
        <span
          className="absolute z-10 rounded-lg border bg-popover p-1 font-sans shadow-md"
          contentEditable={false}
          data-testid="deidentify-span-actions"
          dir="ltr"
          style={{ left: chosen.left, top: chosen.top }}
        >
          <ActionControl
            action={selected.item.action}
            onAction={(action) => onAction(selected.item.id, action)}
            {...(selected.item.source === "manual"
              ? {
                  remove: {
                    kind: "delete" as const,
                    onRemove: () => {
                      onSelect(null);
                      onRemove(selected.item.id);
                    },
                  },
                }
              : {})}
          />
        </span>
      ) : null}
      {editable && picked !== null ? (
        <span
          className="absolute z-10 flex items-center gap-1 rounded-lg border bg-popover p-1 font-sans shadow-md"
          data-testid="deidentify-selection-actions"
          dir="ltr"
          onMouseUp={(event) => event.stopPropagation()}
          style={{ left: picked.left, top: picked.top }}
        >
          <ActionControl
            action={null}
            actions={SELECTION_ACTIONS}
            onAction={(action) => mark(action, false)}
          />
          <Button onClick={() => mark("mask", true)} size="xs" variant="ghost">
            <T>Mask all</T>
          </Button>
        </span>
      ) : null}
    </div>
  );
}
