import type {
  DeidentifyAction,
  DeidentifyLayer,
  DeidentifyLayerChange,
  DeidentifyOfficeMedia,
  DeidentifyOfficePart,
} from "@t3tools/contracts";
import { msg, useGT, useMessages } from "gt-react";
import { ArrowLeftIcon, ImageIcon } from "lucide-react";

import { Button } from "~/components/ui/button";
import { SharedTooltipTrigger } from "~/components/ui/shared-tooltip";
import { cn } from "~/lib/utils";
import type { DeidentifyClient } from "~/privacy/deidentifyClient";

import { useDeidentifyPicture } from "./DeidentifyControls";
import { hiddenCount, occurrencesOf, spansIn } from "./deidentifyModel";
import { MarkedText } from "./MarkedText";
import { mediaPicture, VisualDeidentifyCanvas } from "./VisualDeidentifyCanvas";

const ROLE_LABELS = {
  body: null,
  slide: null,
  header: msg("Header", { $context: "the header of a document's pages" }),
  footer: msg("Footer", { $context: "the footer of a document's pages" }),
  footnotes: msg("Footnotes"),
  endnotes: msg("Endnotes"),
  comments: msg("Comments", { $context: "comments in the margin of a document" }),
  notes: msg("Notes", { $context: "the speaker's notes under a slide" }),
} as const;

function MediaThumbnail({
  client,
  media,
  fileRevision,
  count,
  current,
  onOpen,
}: {
  readonly client: DeidentifyClient;
  readonly media: DeidentifyOfficeMedia;
  readonly fileRevision: string;
  readonly count: number;
  readonly current: boolean;
  readonly onOpen: () => void;
}) {
  const gt = useGT();
  const { address } = useDeidentifyPicture(
    client,
    media.size === null ? null : media.urls.original,
    fileRevision,
  );
  const label =
    media.size === null
      ? gt("{name} cannot be opened", { name: media.name })
      : gt("Open {name}", { name: media.name });
  return (
    <SharedTooltipTrigger
      label={label}
      render={
        <button
          aria-current={current ? "true" : undefined}
          aria-label={label}
          className={cn(
            "relative flex size-12 shrink-0 items-center justify-center overflow-hidden rounded-md border bg-muted outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring disabled:opacity-50",
            current ? "border-ring ring-1 ring-ring" : "border-border hover:border-foreground/30",
          )}
          data-media={media.part}
          disabled={media.size === null}
          onClick={onOpen}
          type="button"
        />
      }
    >
      {address === null ? (
        <ImageIcon className="size-4 text-muted-foreground" />
      ) : (
        <img alt="" className="size-full object-cover" draggable={false} src={address} />
      )}
      {count > 0 ? (
        <span className="absolute end-0.5 top-0.5 rounded-full bg-warning px-1 text-3xs font-medium text-black tabular-nums">
          {count}
        </span>
      ) : null}
    </SharedTooltipTrigger>
  );
}

/**
 * A Word document as its text, or a PowerPoint file slide by slide, with the pictures it holds
 * in a strip underneath. A picture opens on the same canvas a PDF page does.
 */
export function OfficeDeidentifyView({
  client,
  parts,
  media,
  layer,
  view,
  slide,
  onSlide,
  openMedia,
  onOpenMedia,
  selectedId,
  onSelect,
  onChanges,
}: {
  readonly client: DeidentifyClient;
  readonly parts: ReadonlyArray<DeidentifyOfficePart>;
  readonly media: ReadonlyArray<DeidentifyOfficeMedia>;
  /** The slide that is shown, counted from 1. A Word document has none. */
  readonly slide: number;
  readonly onSlide: (slide: number) => void;
  /** The embedded picture that is open on the canvas, by its part. */
  readonly openMedia: string | null;
  readonly onOpenMedia: (part: string | null) => void;
  readonly layer: DeidentifyLayer;
  readonly view: "original" | "deidentified";
  readonly selectedId: string | null;
  readonly onSelect: (id: string | null) => void;
  readonly onChanges: (changes: ReadonlyArray<DeidentifyLayerChange>) => void;
}) {
  const gt = useGT();
  const m = useMessages();
  const slides = parts.filter((part) => part.role === "slide");
  const isDeck = slides.length > 0;
  const shown = isDeck
    ? parts.filter(
        (part) => (part.role === "slide" || part.role === "notes") && part.number === slide,
      )
    : parts;
  const opened = media.find((entry) => entry.part === openMedia);
  const picture = opened === undefined ? undefined : mediaPicture(opened);

  const itemsOn = (part: string) =>
    hiddenCount(
      layer.items.filter(
        (item) =>
          (item.target.type === "xml" || item.target.type === "media") && item.target.part === part,
      ),
    );

  const mark = (
    part: DeidentifyOfficePart,
    range: { readonly start: number; readonly end: number },
    action: DeidentifyAction,
    everywhere: boolean,
  ) => {
    const words = part.text.slice(range.start, range.end);
    const places = everywhere
      ? parts.flatMap((other) =>
          occurrencesOf(other.text, words).map((place) => ({ part: other.name, ...place })),
        )
      : [{ part: part.name, ...range }];
    onChanges(
      places
        .filter(
          (place) =>
            !layer.items.some(
              (item) =>
                item.source === "manual" &&
                item.target.type === "xml" &&
                item.target.part === place.part &&
                item.target.start === place.start &&
                item.target.end === place.end,
            ),
        )
        .map((place) => ({
          type: "addItem" as const,
          action,
          target: { type: "xml" as const, part: place.part, start: place.start, end: place.end },
        })),
    );
  };

  const backLabel = gt("Back to the document");

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div className="flex min-h-0 flex-1">
        {picture !== undefined ? (
          <VisualDeidentifyCanvas
            client={client}
            current={0}
            layer={layer}
            onChanges={onChanges}
            onCurrent={() => undefined}
            onSelect={onSelect}
            pictures={[picture]}
            selectedId={selectedId}
            view={view}
          />
        ) : (
          <>
            {isDeck && slides.length > 1 ? (
              <div
                aria-label={gt("Slides")}
                className="flex w-24 shrink-0 flex-col gap-2 overflow-y-auto border-e bg-muted/30 p-2"
                role="navigation"
              >
                {slides.map((part) => {
                  const count = itemsOn(part.name);
                  return (
                    <button
                      aria-current={part.number === slide ? "page" : undefined}
                      aria-label={gt("Slide {number}", { number: part.number })}
                      className={cn(
                        "relative aspect-video w-full shrink-0 rounded-md border bg-background text-muted-foreground text-xs tabular-nums outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
                        part.number === slide
                          ? "border-ring ring-1 ring-ring"
                          : "border-border hover:border-foreground/30",
                      )}
                      key={part.name}
                      onClick={() => {
                        onSelect(null);
                        onSlide(part.number);
                      }}
                      type="button"
                    >
                      {part.number}
                      {count > 0 ? (
                        <span className="absolute end-1 top-1 rounded-full bg-warning px-1 text-3xs font-medium text-black">
                          {count}
                        </span>
                      ) : null}
                    </button>
                  );
                })}
              </div>
            ) : null}
            <div className="min-h-0 min-w-0 flex-1 overflow-auto bg-muted/40 p-4 scrollbar-gutter-both">
              <div className="mx-auto flex max-w-3xl flex-col gap-3">
                {shown.map((part) => {
                  const caption = ROLE_LABELS[part.role];
                  return (
                    <section
                      className={cn(
                        "rounded-lg border bg-background shadow-sm",
                        part.role === "slide" ? "min-h-64 p-8" : "p-6",
                        caption !== null && "bg-background/70",
                      )}
                      data-part={part.name}
                      key={part.name}
                    >
                      {caption === null ? null : (
                        <h3 className="mb-2 text-muted-foreground text-xs">{m(caption)}</h3>
                      )}
                      <MarkedText
                        className="text-sm leading-7"
                        onAction={(id, action) =>
                          onChanges([{ type: "setItemAction", id, action }])
                        }
                        onMark={(range, action, everywhere) =>
                          mark(part, range, action, everywhere)
                        }
                        onRemove={(id) => onChanges([{ type: "removeItem", id }])}
                        onSelect={onSelect}
                        selectedId={selectedId}
                        spans={spansIn(layer.items, part.text.length, (item) =>
                          item.target.type === "xml" && item.target.part === part.name
                            ? item.target
                            : undefined,
                        )}
                        text={part.text}
                        view={view}
                      />
                    </section>
                  );
                })}
              </div>
            </div>
          </>
        )}
      </div>
      {media.length > 0 ? (
        <div
          aria-label={gt("Pictures in this file")}
          className="flex h-16 shrink-0 items-center gap-2 overflow-x-auto border-t bg-background px-2"
          role="group"
        >
          {picture !== undefined ? (
            <SharedTooltipTrigger
              label={backLabel}
              render={
                <Button
                  aria-label={backLabel}
                  onClick={() => {
                    onSelect(null);
                    onOpenMedia(null);
                  }}
                  size="icon-sm"
                  variant="ghost"
                />
              }
            >
              <ArrowLeftIcon className="rtl:rotate-180" />
            </SharedTooltipTrigger>
          ) : null}
          {media.map((entry) => (
            <MediaThumbnail
              client={client}
              count={itemsOn(entry.part)}
              current={entry.part === openMedia}
              fileRevision={layer.fileRevision}
              key={entry.part}
              media={entry}
              onOpen={() => {
                onSelect(null);
                onOpenMedia(entry.part);
              }}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}
