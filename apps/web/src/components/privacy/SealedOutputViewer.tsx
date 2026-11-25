import type { PrivacySealedProvenanceSpan } from "@t3tools/contracts";
import { useGT } from "gt-react";
import {
  ChevronLeftIcon,
  ChevronRightIcon,
  DownloadIcon,
  PencilLineIcon,
  XIcon,
} from "lucide-react";
import { useRef, useState } from "react";

import { cn } from "~/lib/utils";
import { AttachmentFilePreview } from "../files/AttachmentFilePreview";
import { FILE_SURFACE_SUBHEADER_CLASS, FileSurfaceAction } from "../files/fileSurfaceChrome";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { ScrollArea } from "../ui/scroll-area";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import { highlightValueInQuote, segmentOutputWithProvenance } from "./SealedOutputViewer.logic";

type Mode = "verify" | "preview";

/**
 * A finished file with each sealed value in it marked, so the person can check where it came
 * from: the quote it was read from, or the program that worked it out on this computer.
 */
export function SealedOutputViewer(props: {
  readonly name: string;
  readonly text: string;
  readonly file: File;
  readonly provenance: ReadonlyArray<PrivacySealedProvenanceSpan>;
  readonly hasTemplate?: boolean;
  readonly onRevise?: () => void;
  readonly onSave: () => void;
  readonly onClose: () => void;
}) {
  const gt = useGT();
  const [mode, setMode] = useState<Mode>("verify");
  const [selected, setSelected] = useState<number | null>(null);
  const documentRef = useRef<HTMLDivElement>(null);
  const segments = segmentOutputWithProvenance(props.text, props.provenance);
  const spans = segments.flatMap((segment) => (segment.kind === "span" ? [segment.span] : []));
  const origin = gt("Finished file");

  if (spans.length === 0) {
    return (
      <AttachmentFilePreview
        name={props.name}
        mimeType={props.file.type}
        sizeBytes={props.file.size}
        file={props.file}
        origin={origin}
        onClose={props.onClose}
      />
    );
  }

  const select = (index: number) => {
    setSelected(index);
    documentRef.current
      ?.querySelector(`[data-span-index="${index}"]`)
      ?.scrollIntoView({ block: "nearest" });
  };
  const step = (by: 1 | -1) =>
    select(
      selected === null
        ? by === 1
          ? 0
          : spans.length - 1
        : (selected + by + spans.length) % spans.length,
    );

  const actions = (
    <>
      <ToggleGroup
        aria-label={gt("View")}
        size="sm"
        value={[mode]}
        onValueChange={(next) => {
          const value = next[0];
          if (value === "verify" || value === "preview") setMode(value);
        }}
      >
        <Toggle value="verify">
          {gt("Verify", { $context: "tab, check where values came from" })}
        </Toggle>
        <Toggle value="preview">
          {gt("Preview", { $context: "tab, shows the file as it looks" })}
        </Toggle>
      </ToggleGroup>
      {props.onRevise !== undefined && props.hasTemplate !== false ? (
        <Button variant="outline" size="xs" onClick={props.onRevise}>
          <PencilLineIcon aria-hidden />
          {gt("Revise", { $context: "button, asks the AI to change a finished file" })}
        </Button>
      ) : null}
    </>
  );

  if (mode === "preview") {
    return (
      <AttachmentFilePreview
        name={props.name}
        mimeType={props.file.type}
        sizeBytes={props.file.size}
        file={props.file}
        origin={origin}
        actions={actions}
        onClose={props.onClose}
      />
    );
  }

  const current = selected === null ? undefined : spans[selected];

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden bg-background">
      <div className={FILE_SURFACE_SUBHEADER_CLASS} data-surface-subheader>
        <div className="flex min-w-0 flex-1 items-center text-xs">
          <span className="hidden shrink-0 px-0.5 text-muted-foreground sm:inline">{origin}</span>
          <ChevronRightIcon className="mx-1 hidden size-3.5 shrink-0 text-muted-foreground/60 sm:inline rtl:rotate-180" />
          <span aria-current="page" className="min-w-0 truncate px-0.5 font-medium text-foreground">
            <bdi>{props.name}</bdi>
          </span>
          <span className="ms-2 hidden shrink-0 text-muted-foreground md:inline">
            {gt("{count, plural, one {{count} verified value} other {{count} verified values}}", {
              count: spans.length,
            })}
          </span>
        </div>
        {actions}
        <FileSurfaceAction label={gt("Save file")} onPress={props.onSave}>
          <DownloadIcon className="size-3.5" />
        </FileSurfaceAction>
        <FileSurfaceAction
          label={gt("Close", { $context: "button, closes the file preview" })}
          onPress={props.onClose}
        >
          <XIcon className="size-3.5" />
        </FileSurfaceAction>
      </div>
      <div className="flex min-h-0 flex-1 flex-col md:flex-row">
        <ScrollArea className="min-h-0 flex-1">
          <div
            ref={documentRef}
            dir="auto"
            className="mx-auto max-w-3xl px-6 py-5 text-sm leading-7 break-words whitespace-pre-wrap text-foreground"
          >
            {segments.map((segment) =>
              segment.kind === "text" ? (
                <span key={`text-${segment.start}`}>{segment.text}</span>
              ) : (
                <button
                  key={`span-${segment.index}`}
                  type="button"
                  data-span-index={segment.index}
                  aria-pressed={selected === segment.index}
                  onClick={() => select(segment.index)}
                  className={cn(
                    "-mx-px cursor-pointer rounded-xs px-px underline decoration-dotted underline-offset-4 outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
                    segment.span.kind === "document"
                      ? "bg-info/10 decoration-info/60 hover:bg-info/18 aria-pressed:bg-info/24"
                      : "bg-success/10 decoration-success/60 hover:bg-success/18 aria-pressed:bg-success/24",
                    selected === segment.index && "ring-1 ring-foreground/30 ring-inset",
                  )}
                >
                  {segment.text}
                </button>
              ),
            )}
          </div>
        </ScrollArea>
        <aside
          aria-label={gt("Where this value came from")}
          className="flex max-h-[45%] shrink-0 flex-col border-t border-border/60 bg-card md:max-h-none md:w-80 md:border-t-0 md:border-s"
        >
          <div className="flex h-10 shrink-0 items-center gap-1 border-b border-border/60 px-3">
            <p className="flex-1 text-xs text-muted-foreground">
              {selected === null
                ? gt("{count, plural, one {{count} value} other {{count} values}}", {
                    count: spans.length,
                  })
                : gt("{position} / {total}", { position: selected + 1, total: spans.length })}
            </p>
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label={gt("Previous value")}
              onClick={() => step(-1)}
            >
              <ChevronLeftIcon className="rtl:rotate-180" />
            </Button>
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label={gt("Next value")}
              onClick={() => step(1)}
            >
              <ChevronRightIcon className="rtl:rotate-180" />
            </Button>
          </div>
          <ScrollArea className="min-h-0 flex-1">
            {current === undefined ? (
              <div className="grid gap-3 p-4">
                <p className="text-sm text-muted-foreground">
                  {gt("Select any highlighted value to check its source quote or calculation.")}
                </p>
                <Button variant="outline" size="sm" className="w-fit" onClick={() => select(0)}>
                  {gt("Start review")}
                </Button>
              </div>
            ) : (
              <SpanDetails key={selected} span={current} />
            )}
          </ScrollArea>
        </aside>
      </div>
    </div>
  );
}

function SpanDetails({ span }: { readonly span: PrivacySealedProvenanceSpan }) {
  const gt = useGT();
  return (
    <div className="grid gap-4 p-4 text-sm">
      <div className="grid gap-1.5">
        <Badge variant={span.kind === "document" ? "info" : "success"} className="w-fit">
          {span.kind === "document" ? gt("From sealed file") : gt("Calculated locally")}
        </Badge>
        <bdi className="text-base font-medium break-words text-foreground">{span.written}</bdi>
      </div>
      {span.kind === "document" ? (
        <>
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
            <dt className="text-muted-foreground">{gt("File")}</dt>
            <dd className="min-w-0 break-words">
              <bdi>{span.documentName}</bdi>
            </dd>
            {span.line === undefined ? null : (
              <>
                <dt className="text-muted-foreground">{gt("Line")}</dt>
                <dd>{span.line}</dd>
              </>
            )}
            <dt className="text-muted-foreground">{gt("Field")}</dt>
            <dd className="min-w-0 font-mono break-words" dir="ltr">
              {span.field}
            </dd>
          </dl>
          <SourceQuote quote={span.quote} written={span.written} />
        </>
      ) : (
        <>
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
            <dt className="text-muted-foreground">{gt("Field")}</dt>
            <dd className="min-w-0 font-mono break-words" dir="ltr">
              {span.reference ?? span.field}
            </dd>
          </dl>
          {span.program === undefined ? null : (
            <div className="grid gap-1.5">
              <p className="text-xs font-medium text-muted-foreground">{gt("Calculation")}</p>
              <pre
                dir="ltr"
                className="max-h-56 overflow-auto rounded-md border border-border/60 bg-muted/40 p-2.5 font-mono text-xs leading-5 text-foreground"
              >
                {span.program}
              </pre>
            </div>
          )}
          {span.inputs === undefined || span.inputs.length === 0 ? null : (
            <div className="grid gap-1.5">
              <p className="text-xs font-medium text-muted-foreground">{gt("Values it used")}</p>
              <ul className="grid gap-2">
                {span.inputs.map((input) => (
                  <li
                    key={`${input.handle}|${input.field}`}
                    className="grid gap-1.5 rounded-md border border-border/60 p-2.5"
                  >
                    <div className="flex min-w-0 flex-wrap items-baseline gap-x-2 text-xs text-muted-foreground">
                      <bdi className="min-w-0 truncate">{input.documentName}</bdi>
                      {input.line === undefined ? null : (
                        <span>{gt("Line {line}", { line: input.line })}</span>
                      )}
                      <span className="font-mono" dir="ltr">
                        {input.field}
                      </span>
                    </div>
                    <bdi className="font-medium break-words">{input.written}</bdi>
                    <SourceQuote quote={input.quote} written={input.written} />
                  </li>
                ))}
              </ul>
            </div>
          )}
        </>
      )}
    </div>
  );
}

function SourceQuote({
  quote,
  written,
}: {
  readonly quote: string | undefined;
  readonly written: string;
}) {
  const gt = useGT();
  if (quote === undefined) {
    return <p className="text-xs text-muted-foreground">{gt("No source quote was kept.")}</p>;
  }
  const parts = highlightValueInQuote(quote, written);
  return (
    <figure className="grid gap-1.5">
      <figcaption className="text-xs font-medium text-muted-foreground">
        {gt("Source quote")}
      </figcaption>
      <blockquote
        dir="auto"
        className="rounded-md border-s-2 border-info/50 bg-muted/40 px-3 py-2 text-xs leading-5 break-words whitespace-pre-wrap text-foreground"
      >
        {parts === null ? (
          quote
        ) : (
          <>
            {parts.before}
            <mark className="rounded-xs bg-info/20 px-px text-foreground">{parts.match}</mark>
            {parts.after}
          </>
        )}
      </blockquote>
    </figure>
  );
}
