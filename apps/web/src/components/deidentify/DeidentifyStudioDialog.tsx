import type {
  DeidentifyFileRef,
  DeidentifyInspection,
  DeidentifyItem,
  DeidentifyLayerChange,
} from "@t3tools/contracts";
import { T, useGT, useMessages } from "gt-react";
import {
  CheckIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  DownloadIcon,
  FileIcon,
  FolderOpenIcon,
  PanelRightIcon,
  RefreshCwIcon,
  ScanSearchIcon,
  TriangleAlertIcon,
  XIcon,
} from "lucide-react";
import { type ReactElement, type ReactNode, useEffect, useState } from "react";

import { Button } from "~/components/ui/button";
import { Dialog, DialogClose, DialogPopup, DialogTitle } from "~/components/ui/dialog";
import { SharedTooltipTrigger } from "~/components/ui/shared-tooltip";
import { Spinner } from "~/components/ui/spinner";
import { stackedThreadToast, toastManager } from "~/components/ui/toast";
import { Toggle, ToggleGroup } from "~/components/ui/toggle-group";
import { useStableCallback } from "~/hooks/useStableCallback";
import { isMacPlatform } from "~/lib/utils";
import { type DeidentifyClient, liveDeidentifyClient } from "~/privacy/deidentifyClient";

import { DeidentifyItemRail } from "./DeidentifyItemRail";
import { FAILURE_LABELS, FAMILY_ICONS } from "./deidentifyLabels";
import type { ItemPlace } from "./deidentifyModel";
import { OfficeDeidentifyView } from "./OfficeDeidentifyView";
import { SpreadsheetDeidentifyView } from "./SpreadsheetDeidentifyView";
import { TextDeidentifyView } from "./TextDeidentifyView";
import { useDeidentifyStudio } from "./useDeidentifyStudio";
import { pagePicture, VisualDeidentifyCanvas } from "./VisualDeidentifyCanvas";

/** Where the open file stands in a list of files being reviewed one after another. */
export interface StudioQueue {
  /** Counted from 1. */
  readonly position: number;
  readonly total: number;
  readonly onPrevious: (() => void) | null;
  readonly onNext: (() => void) | null;
}

type View = "original" | "deidentified";

/** What part of the file is in front of the person. */
interface Location {
  readonly page: number;
  readonly slide: number;
  readonly media: string | null;
  readonly sheet: string | null;
}

const START: Location = { page: 0, slide: 1, media: null, sheet: null };

const nameOf = (file: DeidentifyFileRef): string => {
  const name =
    file.kind === "workspace"
      ? file.path
      : (file.name ?? (file.kind === "attachment" ? file.attachmentId : file.stagedId));
  return name.slice(name.lastIndexOf("/") + 1);
};

const typingInto = (target: EventTarget): boolean =>
  target instanceof HTMLElement &&
  (target.isContentEditable || target.tagName === "INPUT" || target.tagName === "TEXTAREA");

function IconAction({
  label,
  onClick,
  disabled,
  pressed,
  children,
}: {
  readonly label: string;
  readonly onClick: () => void;
  readonly disabled?: boolean;
  readonly pressed?: boolean;
  readonly children: ReactNode;
}): ReactElement {
  return (
    <SharedTooltipTrigger
      label={label}
      render={
        <Button
          aria-label={label}
          aria-pressed={pressed}
          disabled={disabled}
          onClick={onClick}
          size="icon-sm"
          variant="ghost"
        />
      }
    >
      {children}
    </SharedTooltipTrigger>
  );
}

function StudioBody({
  client,
  file,
  queue,
  selectedId,
  onSelectedId,
  onReviewed,
}: {
  readonly client: DeidentifyClient;
  readonly file: DeidentifyFileRef;
  readonly queue: StudioQueue | undefined;
  readonly selectedId: string | null;
  readonly onSelectedId: (id: string | null) => void;
  readonly onReviewed: (() => void) | undefined;
}) {
  const gt = useGT();
  const m = useMessages();
  const { state, scanning, change, rescan } = useDeidentifyStudio(client, file);
  const [view, setView] = useState<View>("original");
  // Beside the file where there is room for both; a narrow window opens on the file alone.
  const [railOpen, setRailOpen] = useState(
    () => typeof window === "undefined" || window.matchMedia("(min-width: 64rem)").matches,
  );
  const [location, setLocation] = useState<Location>(START);
  const inspection: DeidentifyInspection | null = state.phase === "ready" ? state.inspection : null;
  const layer = inspection?.layer ?? null;
  const preview = inspection?.preview ?? null;
  const name = inspection?.name ?? nameOf(file);
  const reviewed = layer?.reviewState === "reviewed";

  const apply = (changes: ReadonlyArray<DeidentifyLayerChange>) => {
    const adding = changes.length === 1 && changes[0]?.type === "addItem";
    const known = new Set(layer?.items.map((item) => item.id));
    void change(changes).then((next) => {
      // A box or stretch just made is the thing the person is working on: it stays chosen.
      const added = adding ? next?.items.find((item) => !known.has(item.id)) : undefined;
      if (added !== undefined && added.target.type !== "cells") onSelectedId(added.id);
    });
  };

  const markReviewed = () => {
    if (layer === null) return;
    if (reviewed) {
      void change([{ type: "setReviewState", state: "unreviewed" }]);
      return;
    }
    void change([{ type: "setReviewState", state: "reviewed" }]).then((next) => {
      if (next?.reviewState !== "reviewed") return;
      onReviewed?.();
      queue?.onNext?.();
    });
  };

  const show = (item: DeidentifyItem) => {
    onSelectedId(item.id);
    setView("original");
    const { target } = item;
    if (target.type === "region") setLocation({ ...location, page: target.page });
    if (target.type === "cells") setLocation({ ...location, sheet: target.sheet });
    if (target.type === "media") setLocation({ ...location, media: target.part });
    if (target.type === "xml" && preview?.type === "office") {
      const part = preview.parts.find((candidate) => candidate.name === target.part);
      setLocation({ ...location, media: null, slide: part?.number ?? location.slide });
    }
  };

  const placeLabel = (place: ItemPlace): string | null => {
    if (place.type === "page") return gt("Page {number}", { number: place.page + 1 });
    if (place.type === "sheet")
      return preview?.type === "sheets" && preview.sheets.length > 1 ? place.name : null;
    if (place.type === "file" || preview?.type !== "office") return null;
    const part = preview.parts.find((candidate) => candidate.name === place.name);
    if (part?.role === "slide") return gt("Slide {number}", { number: part.number });
    if (part?.role === "notes") return gt("Notes of slide {number}", { number: part.number });
    return part === undefined ? place.name.slice(place.name.lastIndexOf("/") + 1) : null;
  };

  const download = async () => {
    if (await client.download(file)) return;
    toastManager.add(
      stackedThreadToast({ type: "error", title: gt("The copy could not be made.") }),
    );
  };

  const reveal = async () => {
    if (await client.reveal(file)) return;
    toastManager.add(
      stackedThreadToast({ type: "error", title: gt("The file could not be shown.") }),
    );
  };

  const onShortcut = useStableCallback((event: KeyboardEvent) => {
    if (event.defaultPrevented || (event.target !== null && typingInto(event.target))) return;
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      markReviewed();
      return;
    }
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    if (event.key === "]" && queue?.onNext) {
      event.preventDefault();
      queue.onNext();
    }
    if (event.key === "[" && queue?.onPrevious) {
      event.preventDefault();
      queue.onPrevious();
    }
  });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- the studio's shortcuts work wherever the focus is, also after the file under it was swapped for the next
  useEffect(() => {
    window.addEventListener("keydown", onShortcut);
    return () => window.removeEventListener("keydown", onShortcut);
  }, [onShortcut]);

  const FamilyIcon = layer === null ? FileIcon : FAMILY_ICONS[layer.family];
  const pageCount = preview?.type === "pages" ? preview.pages.length : 1;
  const platform = typeof navigator === "undefined" ? "" : navigator.platform;
  const revealLabel = isMacPlatform(platform)
    ? gt("Reveal in Finder")
    : platform.toLowerCase().startsWith("win")
      ? gt("Show in Explorer")
      : gt("Show in folder");
  const stale = layer?.reviewState === "stale";

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex min-h-12 shrink-0 flex-wrap items-center gap-x-2 gap-y-1 border-b px-2 py-1.5">
        {queue === undefined ? null : (
          <div className="flex items-center">
            <IconAction
              disabled={queue.onPrevious === null}
              label={gt("Previous file")}
              onClick={() => queue.onPrevious?.()}
            >
              <ChevronLeftIcon className="rtl:rotate-180" />
            </IconAction>
            <span className="min-w-10 text-center text-muted-foreground text-xs tabular-nums">
              {`${queue.position} / ${queue.total}`}
            </span>
            <IconAction
              disabled={queue.onNext === null}
              label={gt("Next file")}
              onClick={() => queue.onNext?.()}
            >
              <ChevronRightIcon className="rtl:rotate-180" />
            </IconAction>
          </div>
        )}
        <div className="flex min-w-0 flex-1 items-center gap-2 ps-1">
          <FamilyIcon className="size-4 shrink-0 text-muted-foreground" />
          <DialogTitle className="sr-only">{name}</DialogTitle>
          <span aria-hidden="true" className="truncate font-medium text-sm" dir="auto">
            {name}
          </span>
          {layer === null ? null : stale ? (
            <Button
              disabled={scanning}
              onClick={() => void rescan()}
              size="xs"
              variant="warning-outline"
            >
              <RefreshCwIcon />
              <T>File changed</T>
            </Button>
          ) : (
            <SharedTooltipTrigger
              label={gt("Synced", { $context: "the review matches the file as it is now" })}
              render={
                <span
                  aria-label={gt("Synced", {
                    $context: "the review matches the file as it is now",
                  })}
                  className="size-2 shrink-0 rounded-full bg-success"
                  role="img"
                />
              }
            />
          )}
          {layer?.unchecked === true ? (
            <SharedTooltipTrigger
              label={gt("Some parts could not be checked. They stay hidden until you decide.")}
              render={
                <span
                  aria-label={gt("Some parts could not be checked")}
                  className="shrink-0 text-warning-foreground"
                  role="img"
                />
              }
            >
              <TriangleAlertIcon className="size-4" />
            </SharedTooltipTrigger>
          ) : null}
        </div>
        {layer === null ? null : (
          <>
            <ToggleGroup
              aria-label={gt("View", { $context: "which version of the file is shown" })}
              onValueChange={(next) => {
                if (next[0] === "original" || next[0] === "deidentified") setView(next[0]);
              }}
              value={[view]}
            >
              <Toggle value="original">
                <T>Original</T>
              </Toggle>
              <Toggle value="deidentified">
                <T>De-identified</T>
              </Toggle>
            </ToggleGroup>
            <ToggleGroup
              aria-label={gt("Mode", { $context: "what is done with values by default" })}
              onValueChange={(next) => {
                if (next[0] === "mask" || next[0] === "redact") {
                  apply([{ type: "setDefaultMode", mode: next[0] }]);
                }
              }}
              value={[layer.defaultMode]}
            >
              <Toggle value="mask">
                <T>Mask</T>
              </Toggle>
              <Toggle value="redact">
                <T>Redact</T>
              </Toggle>
            </ToggleGroup>
            <div className="flex items-center">
              <IconAction label={gt("Download de-identified copy")} onClick={() => void download()}>
                <DownloadIcon />
              </IconAction>
              {inspection?.canReveal === true ? (
                <IconAction label={revealLabel} onClick={() => void reveal()}>
                  <FolderOpenIcon />
                </IconAction>
              ) : null}
              <IconAction disabled={scanning} label={gt("Re-scan")} onClick={() => void rescan()}>
                {scanning ? <Spinner /> : <ScanSearchIcon />}
              </IconAction>
              <IconAction
                label={railOpen ? gt("Hide items") : gt("Show items")}
                onClick={() => setRailOpen(!railOpen)}
                pressed={railOpen}
              >
                <PanelRightIcon className="rtl:rotate-180" />
              </IconAction>
            </div>
            <Button
              disabled={stale}
              onClick={markReviewed}
              size="sm"
              variant={reviewed ? "outline" : "default"}
            >
              {reviewed ? <CheckIcon /> : null}
              {reviewed ? <T>Reviewed</T> : <T>Mark reviewed</T>}
            </Button>
          </>
        )}
        <DialogClose
          aria-label={gt("Close", { $context: "button, closes the dialog" })}
          render={<Button size="icon-sm" variant="ghost" />}
        >
          <XIcon />
        </DialogClose>
      </header>
      <div className="flex min-h-0 flex-1">
        {state.phase === "loading" ? (
          <div className="flex flex-1 items-center justify-center">
            <Spinner />
          </div>
        ) : null}
        {state.phase === "failed" ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-2 text-muted-foreground">
            <TriangleAlertIcon className="size-6 opacity-60" />
            <p className="text-sm">{m(FAILURE_LABELS[state.reason])}</p>
          </div>
        ) : null}
        {layer !== null && preview !== null ? (
          <>
            {preview.type === "text" ? (
              <TextDeidentifyView
                layer={layer}
                onChanges={apply}
                onSelect={onSelectedId}
                selectedId={selectedId}
                text={preview.text}
                view={view}
              />
            ) : null}
            {preview.type === "pages" ? (
              <VisualDeidentifyCanvas
                client={client}
                current={location.page}
                layer={layer}
                onChanges={apply}
                onCurrent={(page) => setLocation({ ...location, page })}
                onSelect={onSelectedId}
                pictures={preview.pages.map(pagePicture)}
                selectedId={selectedId}
                view={view}
              />
            ) : null}
            {preview.type === "sheets" ? (
              <SpreadsheetDeidentifyView
                layer={layer}
                onChanges={apply}
                onSheet={(sheet) => setLocation({ ...location, sheet })}
                selectedId={selectedId}
                sheetName={location.sheet}
                sheets={preview.sheets}
                view={view}
              />
            ) : null}
            {preview.type === "office" ? (
              <OfficeDeidentifyView
                client={client}
                layer={layer}
                media={preview.media}
                onChanges={apply}
                onOpenMedia={(media) => setLocation({ ...location, media })}
                onSelect={onSelectedId}
                onSlide={(slide) => setLocation({ ...location, slide })}
                openMedia={location.media}
                parts={preview.parts}
                selectedId={selectedId}
                slide={location.slide}
                view={view}
              />
            ) : null}
            {railOpen ? (
              <DeidentifyItemRail
                items={layer.items}
                onChanges={apply}
                onSelect={show}
                pageCount={pageCount}
                placeLabel={placeLabel}
                selectedId={selectedId}
              />
            ) : null}
          </>
        ) : null}
      </div>
    </div>
  );
}

/**
 * The studio: one file, shown as it is and as its de-identified copy would be, with everything
 * found in it and the tools to mark more. The file itself is never changed.
 */
export function DeidentifyStudioDialog({
  client = liveDeidentifyClient,
  file,
  open,
  onOpenChange,
  queue,
  onReviewed,
}: {
  readonly client?: DeidentifyClient;
  /** The file to review. Null while nothing is open. */
  readonly file: DeidentifyFileRef | null;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly queue?: StudioQueue;
  /** Told when the person marks the open file reviewed. */
  readonly onReviewed?: () => void;
}) {
  const fileKey = file === null ? "" : JSON.stringify(file);
  const [selection, setSelection] = useState<{ readonly key: string; readonly id: string } | null>(
    null,
  );
  const selectedId = selection !== null && selection.key === fileKey ? selection.id : null;
  return (
    <Dialog
      onOpenChange={(next, details) => {
        // Escape lets go of what is chosen before it closes the studio.
        if (!next && details.reason === "escape-key" && selectedId !== null) {
          details.cancel();
          setSelection(null);
          return;
        }
        onOpenChange(next);
      }}
      open={open}
    >
      <DialogPopup
        bottomStickOnMobile={false}
        className="flex h-[min(92dvh,64rem)] w-[min(96vw,90rem)] max-w-none flex-col overflow-hidden"
        showCloseButton={false}
      >
        {file === null ? null : (
          <StudioBody
            client={client}
            file={file}
            key={fileKey}
            onReviewed={onReviewed}
            onSelectedId={(id) => setSelection(id === null ? null : { key: fileKey, id })}
            queue={queue}
            selectedId={selectedId}
          />
        )}
      </DialogPopup>
    </Dialog>
  );
}
