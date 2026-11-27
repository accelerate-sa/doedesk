import {
  DEIDENTIFY_REDACTED_LABEL,
  type DeidentifyAction,
  type DeidentifyItem,
  type DeidentifyLayer,
  type DeidentifyLayerChange,
  type DeidentifyOfficeMedia,
  type DeidentifyPagePreview,
  type DeidentifyPoint,
  type DeidentifyTarget,
} from "@t3tools/contracts";
import { useGT, useMessages } from "gt-react";
import { MinusIcon, PlusIcon, QrCodeIcon } from "lucide-react";
import {
  type KeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  useEffect,
  useRef,
  useState,
} from "react";

import { Button } from "~/components/ui/button";
import { SharedTooltipTrigger } from "~/components/ui/shared-tooltip";
import { Spinner } from "~/components/ui/spinner";
import { cn } from "~/lib/utils";
import type { DeidentifyClient } from "~/privacy/deidentifyClient";

import { ActionControl, useDeidentifyPicture } from "./DeidentifyControls";
import { itemLabel } from "./deidentifyLabels";
import {
  type Box,
  type BoxCorner,
  boxBetween,
  boxOfPolygon,
  isBoxLargeEnough,
  moveBox,
  polygonOfBox,
  resizeBox,
  standInOf,
} from "./deidentifyModel";

/** One page or picture the canvas shows, and how items and new boxes relate to it. */
export interface CanvasPicture {
  readonly key: string;
  readonly width: number;
  readonly height: number;
  readonly urls: { readonly original: string; readonly deidentified: string };
  /** Where an item is on this picture, or nothing when it is somewhere else. */
  readonly outlineOf: (item: DeidentifyItem) => ReadonlyArray<DeidentifyPoint> | undefined;
  readonly targetOf: (polygon: ReadonlyArray<DeidentifyPoint>) => DeidentifyTarget;
}

export const pagePicture = (page: DeidentifyPagePreview): CanvasPicture => ({
  key: `page:${page.index}`,
  width: page.width,
  height: page.height,
  urls: page.urls,
  outlineOf: (item) =>
    item.target.type === "region" && item.target.page === page.index
      ? item.target.polygon
      : undefined,
  targetOf: (polygon) => ({ type: "region", page: page.index, polygon }),
});

/** A picture inside a Word or PowerPoint file. Nothing for a drawing that cannot be opened. */
export const mediaPicture = (media: DeidentifyOfficeMedia): CanvasPicture | undefined =>
  media.size === null
    ? undefined
    : {
        key: `media:${media.part}`,
        width: media.size.width,
        height: media.size.height,
        urls: media.urls,
        outlineOf: (item) =>
          item.target.type === "media" && item.target.part === media.part
            ? item.target.polygon
            : undefined,
        targetOf: (polygon) => ({ type: "media", part: media.part, polygon }),
      };

type Drag =
  | { readonly kind: "draw"; readonly from: DeidentifyPoint; readonly to: DeidentifyPoint }
  | {
      readonly kind: "move";
      readonly id: string;
      readonly origin: Box;
      readonly from: DeidentifyPoint;
      readonly to: DeidentifyPoint;
    }
  | {
      readonly kind: "resize";
      readonly id: string;
      readonly origin: Box;
      readonly corner: BoxCorner;
      readonly to: DeidentifyPoint;
    };

const ZOOM_STEPS: ReadonlyArray<number> = [0.5, 0.75, 1, 1.25, 1.5, 2, 3];
const CORNERS: ReadonlyArray<BoxCorner> = ["nw", "ne", "sw", "se"];
const CORNER_CLASS: Readonly<Record<BoxCorner, string>> = {
  nw: "-top-1.5 -left-1.5 cursor-nwse-resize",
  ne: "-top-1.5 -right-1.5 cursor-nesw-resize",
  sw: "-bottom-1.5 -left-1.5 cursor-nesw-resize",
  se: "-right-1.5 -bottom-1.5 cursor-nwse-resize",
};

const percent = (value: number): string => `${value * 100}%`;

const placed = (box: Box) => ({
  left: percent(box.x),
  top: percent(box.y),
  width: percent(box.width),
  height: percent(box.height),
});

const boxTone = (action: DeidentifyAction): string =>
  action === "mask"
    ? "border-2 border-warning bg-warning/20"
    : action === "redact"
      ? "border border-black bg-black/90 hover:bg-black/35 data-[selected=true]:bg-black/35"
      : "border border-dashed border-muted-foreground/70";

function ItemBox({
  item,
  box,
  selected,
  editable,
  onPointerDown,
  onCornerDown,
}: {
  readonly item: DeidentifyItem;
  readonly box: Box;
  readonly selected: boolean;
  readonly editable: boolean;
  readonly onPointerDown: (event: ReactPointerEvent<HTMLDivElement>) => void;
  readonly onCornerDown: (corner: BoxCorner, event: ReactPointerEvent<HTMLSpanElement>) => void;
}) {
  const m = useMessages();
  const element = useRef<HTMLDivElement | null>(null);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- brings a box chosen from the list into the scrolled page's view
  useEffect(() => {
    if (selected) element.current?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [selected]);
  const movable = editable && item.source === "manual";
  return (
    <div
      aria-label={itemLabel(item, m)}
      aria-pressed={selected}
      className={cn(
        "absolute rounded-xs transition-colors data-[selected=true]:ring-2 data-[selected=true]:ring-ring data-[selected=true]:ring-inset",
        boxTone(item.action),
        movable ? "cursor-move" : "cursor-pointer",
      )}
      data-action={item.action}
      data-item-id={item.id}
      data-selected={selected}
      data-source={item.source}
      onPointerDown={onPointerDown}
      ref={element}
      role="button"
      style={placed(box)}
      tabIndex={-1}
    >
      {item.action === "keep" ? null : (
        <span
          className={cn(
            "pointer-events-none absolute start-0 top-0 flex max-w-full items-center gap-0.5 truncate rounded-br-xs px-1 font-mono text-3xs leading-4",
            item.action === "mask" ? "bg-warning text-black" : "text-white",
          )}
          dir="ltr"
        >
          {item.origin === "code" ? <QrCodeIcon className="size-3 shrink-0" /> : null}
          {item.action === "mask"
            ? (standInOf(item) ?? itemLabel(item, m))
            : DEIDENTIFY_REDACTED_LABEL}
        </span>
      )}
      {item.action === "keep" && item.origin === "code" ? (
        <QrCodeIcon className="pointer-events-none absolute start-0.5 top-0.5 size-3 text-muted-foreground" />
      ) : null}
      {movable && selected
        ? CORNERS.map((corner) => (
            <span
              className={cn(
                "absolute size-3 rounded-full border-2 border-ring bg-background",
                CORNER_CLASS[corner],
              )}
              data-corner={corner}
              key={corner}
              onPointerDown={(event) => onCornerDown(corner, event)}
            />
          ))
        : null}
    </div>
  );
}

function PageThumbnail({
  client,
  picture,
  fileRevision,
  number,
  count,
  current,
  onChoose,
}: {
  readonly client: DeidentifyClient;
  readonly picture: CanvasPicture;
  readonly fileRevision: string;
  readonly number: number;
  readonly count: number;
  readonly current: boolean;
  readonly onChoose: () => void;
}) {
  const gt = useGT();
  const element = useRef<HTMLButtonElement | null>(null);
  const [seen, setSeen] = useState(false);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- a page of a long document is drawn only once its thumbnail scrolls into view
  useEffect(() => {
    const target = element.current;
    if (target === null || seen) return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) setSeen(true);
    });
    observer.observe(target);
    return () => observer.disconnect();
  }, [seen]);
  const { address } = useDeidentifyPicture(
    client,
    seen ? picture.urls.original : null,
    fileRevision,
  );
  return (
    <button
      aria-current={current ? "page" : undefined}
      aria-label={gt("Page {number}", { number })}
      className={cn(
        "relative w-full shrink-0 overflow-hidden rounded-md border bg-background outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
        current ? "border-ring ring-1 ring-ring" : "border-border hover:border-foreground/30",
      )}
      onClick={onChoose}
      ref={element}
      style={{ aspectRatio: `${picture.width} / ${picture.height}` }}
      type="button"
    >
      {address === null ? null : (
        <img alt="" className="size-full object-cover" draggable={false} src={address} />
      )}
      <span className="absolute start-1 bottom-1 rounded bg-background/85 px-1 text-3xs text-muted-foreground tabular-nums">
        {number}
      </span>
      {count > 0 ? (
        <span className="absolute end-1 top-1 rounded-full bg-warning px-1 text-3xs font-medium text-black tabular-nums">
          {count}
        </span>
      ) : null}
    </button>
  );
}

/**
 * A page or picture with everything marked on it. Dragging on the page draws a box; a box a
 * person drew can be moved and resized; choosing any box opens what to do with it.
 */
export function VisualDeidentifyCanvas({
  client,
  pictures,
  current,
  onCurrent,
  layer,
  view,
  selectedId,
  onSelect,
  onChanges,
}: {
  readonly client: DeidentifyClient;
  readonly pictures: ReadonlyArray<CanvasPicture>;
  readonly current: number;
  readonly onCurrent: (index: number) => void;
  readonly layer: DeidentifyLayer;
  readonly view: "original" | "deidentified";
  readonly selectedId: string | null;
  readonly onSelect: (id: string | null) => void;
  readonly onChanges: (changes: ReadonlyArray<DeidentifyLayerChange>) => void;
}) {
  const gt = useGT();
  const page = useRef<HTMLDivElement | null>(null);
  const [zoom, setZoom] = useState(1);
  const [drag, setDrag] = useState<Drag | null>(null);
  const picture = pictures[Math.min(current, pictures.length - 1)];
  const editable = view === "original";
  const { address, loading } = useDeidentifyPicture(
    client,
    picture === undefined ? null : picture.urls[view],
    view === "original" ? layer.fileRevision : layer.revision,
  );
  if (picture === undefined) return null;

  const onPage = layer.items.flatMap((item) => {
    const outline = picture.outlineOf(item);
    return outline === undefined ? [] : [{ item, box: boxOfPolygon(outline) }];
  });
  const selected = onPage.find((entry) => entry.item.id === selectedId);

  const pointOf = (event: { readonly clientX: number; readonly clientY: number }) => {
    const bounds = page.current?.getBoundingClientRect();
    if (bounds === undefined || bounds.width === 0 || bounds.height === 0) return { x: 0, y: 0 };
    return {
      x: Math.min(1, Math.max(0, (event.clientX - bounds.left) / bounds.width)),
      y: Math.min(1, Math.max(0, (event.clientY - bounds.top) / bounds.height)),
    };
  };

  const boxDuring = (item: DeidentifyItem, box: Box): Box => {
    if (drag === null || drag.kind === "draw" || drag.id !== item.id) return box;
    return drag.kind === "move"
      ? moveBox(drag.origin, drag.to.x - drag.from.x, drag.to.y - drag.from.y)
      : resizeBox(drag.origin, drag.corner, drag.to);
  };

  const begin = (event: ReactPointerEvent<HTMLElement>, next: Drag) => {
    try {
      // Keeps the drag coming here once the pointer leaves the page.
      page.current?.setPointerCapture(event.pointerId);
    } catch {
      // A pointer that is already gone cannot be held; the drag ends with its next event.
    }
    page.current?.focus({ preventScroll: true });
    setDrag(next);
  };

  const finish = () => {
    if (drag === null) return;
    setDrag(null);
    if (drag.kind === "draw") {
      const box = boxBetween(drag.from, drag.to);
      if (!isBoxLargeEnough(box)) return;
      onChanges([
        {
          type: "addItem",
          action: layer.defaultMode,
          target: picture.targetOf(polygonOfBox(box)),
        },
      ]);
      return;
    }
    const entry = onPage.find((candidate) => candidate.item.id === drag.id);
    if (entry === undefined) return;
    const box = boxDuring(entry.item, entry.box);
    const moved =
      Math.abs(box.x - entry.box.x) +
        Math.abs(box.y - entry.box.y) +
        Math.abs(box.width - entry.box.width) +
        Math.abs(box.height - entry.box.height) >
      0.002;
    if (moved && isBoxLargeEnough(box)) {
      onChanges([{ type: "moveItem", id: drag.id, target: picture.targetOf(polygonOfBox(box)) }]);
    }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (selected === undefined) return;
    if (event.key === "Escape") {
      event.stopPropagation();
      onSelect(null);
      return;
    }
    if (
      (event.key === "Delete" || event.key === "Backspace") &&
      selected.item.source === "manual"
    ) {
      event.preventDefault();
      onSelect(null);
      onChanges([{ type: "removeItem", id: selected.item.id }]);
    }
  };

  const draft = drag?.kind === "draw" ? boxBetween(drag.from, drag.to) : null;
  const zoomIndex = ZOOM_STEPS.indexOf(zoom);
  const zoomOut = gt("Zoom out");
  const zoomIn = gt("Zoom in");
  const zoomReset = gt("Fit to width");
  const selectedBox = selected === undefined ? null : boxDuring(selected.item, selected.box);

  return (
    <div className="flex min-h-0 min-w-0 flex-1" data-slot="deidentify-canvas">
      {pictures.length > 1 ? (
        <div
          aria-label={gt("Pages")}
          className="flex w-24 shrink-0 flex-col gap-2 overflow-y-auto border-e bg-muted/30 p-2"
          role="navigation"
        >
          {pictures.map((entry, index) => (
            <PageThumbnail
              client={client}
              count={
                layer.items.filter(
                  (item) => item.action !== "keep" && entry.outlineOf(item) !== undefined,
                ).length
              }
              current={index === current}
              fileRevision={layer.fileRevision}
              key={entry.key}
              number={index + 1}
              onChoose={() => {
                onSelect(null);
                onCurrent(index);
              }}
              picture={entry}
            />
          ))}
        </div>
      ) : null}
      <div className="relative min-h-0 min-w-0 flex-1 bg-muted/40">
        <div className="size-full overflow-auto p-4 scrollbar-gutter-both">
          <div
            aria-label={gt("Page")}
            className={cn(
              "relative mx-auto touch-none bg-white shadow-sm outline-none ring-1 ring-border select-none",
              editable && "cursor-crosshair",
            )}
            data-testid="deidentify-page"
            dir="ltr"
            onKeyDown={onKeyDown}
            onPointerCancel={() => setDrag(null)}
            onPointerDown={(event) => {
              if (!editable || event.button !== 0) return;
              onSelect(null);
              const at = pointOf(event);
              begin(event, { kind: "draw", from: at, to: at });
            }}
            onPointerMove={(event) => {
              if (drag !== null) setDrag({ ...drag, to: pointOf(event) });
            }}
            onPointerUp={finish}
            ref={page}
            role="group"
            style={{
              width: `calc(min(100%, 56rem) * ${zoom})`,
              aspectRatio: `${picture.width} / ${picture.height}`,
            }}
            tabIndex={0}
          >
            {address === null ? null : (
              <img
                alt=""
                className="pointer-events-none size-full"
                draggable={false}
                src={address}
              />
            )}
            {editable
              ? onPage.map(({ item, box }) => (
                  <ItemBox
                    box={boxDuring(item, box)}
                    editable={editable}
                    item={item}
                    key={item.id}
                    onCornerDown={(corner, event) => {
                      event.stopPropagation();
                      begin(event, {
                        kind: "resize",
                        id: item.id,
                        origin: box,
                        corner,
                        to: pointOf(event),
                      });
                    }}
                    onPointerDown={(event) => {
                      event.stopPropagation();
                      if (event.button !== 0) return;
                      onSelect(item.id);
                      const at = pointOf(event);
                      if (item.source === "manual") {
                        begin(event, { kind: "move", id: item.id, origin: box, from: at, to: at });
                      } else {
                        page.current?.focus({ preventScroll: true });
                      }
                    }}
                    selected={item.id === selectedId}
                  />
                ))
              : null}
            {draft === null || !editable ? null : (
              <div
                className="pointer-events-none absolute rounded-xs border-2 border-dashed border-ring bg-ring/10"
                data-testid="deidentify-draft"
                style={placed(draft)}
              />
            )}
            {editable && selected !== undefined && selectedBox !== null && drag === null ? (
              <div
                className="absolute z-10 rounded-lg border bg-popover p-1 shadow-md"
                data-testid="deidentify-box-actions"
                onPointerDown={(event) => event.stopPropagation()}
                style={{
                  left: percent(Math.min(selectedBox.x, 0.7)),
                  ...(selectedBox.y + selectedBox.height > 0.85
                    ? { bottom: `calc(${percent(1 - selectedBox.y)} + 6px)` }
                    : { top: `calc(${percent(selectedBox.y + selectedBox.height)} + 6px)` }),
                }}
              >
                <ActionControl
                  action={selected.item.action}
                  onAction={(action) =>
                    onChanges([{ type: "setItemAction", id: selected.item.id, action }])
                  }
                  {...(selected.item.source === "manual"
                    ? {
                        remove: {
                          kind: "delete" as const,
                          onRemove: () => {
                            onSelect(null);
                            onChanges([{ type: "removeItem", id: selected.item.id }]);
                          },
                        },
                      }
                    : {})}
                />
              </div>
            ) : null}
          </div>
        </div>
        {loading ? (
          <div className="pointer-events-none absolute end-3 top-3 rounded-full bg-background/80 p-1.5 shadow-sm">
            <Spinner />
          </div>
        ) : null}
        <div className="absolute start-1/2 bottom-3 flex -translate-x-1/2 items-center gap-0.5 rounded-lg border bg-popover p-0.5 shadow-md rtl:translate-x-1/2">
          <SharedTooltipTrigger
            label={zoomOut}
            render={
              <Button
                aria-label={zoomOut}
                disabled={zoomIndex <= 0}
                onClick={() => setZoom(ZOOM_STEPS[zoomIndex - 1] ?? zoom)}
                size="icon-xs"
                variant="ghost"
              />
            }
          >
            <MinusIcon />
          </SharedTooltipTrigger>
          <SharedTooltipTrigger
            label={zoomReset}
            render={
              <Button aria-label={zoomReset} onClick={() => setZoom(1)} size="xs" variant="ghost" />
            }
          >
            <span className="w-9 text-center tabular-nums">{`${Math.round(zoom * 100)}%`}</span>
          </SharedTooltipTrigger>
          <SharedTooltipTrigger
            label={zoomIn}
            render={
              <Button
                aria-label={zoomIn}
                disabled={zoomIndex >= ZOOM_STEPS.length - 1}
                onClick={() => setZoom(ZOOM_STEPS[zoomIndex + 1] ?? zoom)}
                size="icon-xs"
                variant="ghost"
              />
            }
          >
            <PlusIcon />
          </SharedTooltipTrigger>
        </div>
      </div>
    </div>
  );
}
