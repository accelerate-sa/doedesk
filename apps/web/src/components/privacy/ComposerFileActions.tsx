import type { EnvironmentId } from "@t3tools/contracts";
import { useGT } from "gt-react";
import { CheckIcon, FileLock2Icon, ScanEyeIcon, XIcon } from "lucide-react";
import { use } from "react";

import { type ComposerFileAttachment, composerFileNeedsReattach } from "~/composerDraftStore";
import { useFileMetadata } from "~/hooks/useFileMetadata";
import { cn } from "~/lib/utils";
import { projectEnvironment } from "~/state/projects";
import { useEnvironmentQuery } from "~/state/query";
import { ComposerContextActionsContext } from "../composerContextActions";
import { ContextChipAction } from "../ContextChip";
import { SharedTooltipTrigger } from "../ui/shared-tooltip";
import { Spinner } from "../ui/spinner";
import { fileNameOf } from "./sealedFiles.logic";
import {
  readableForSuggestion,
  type SealSuggestion,
  sealSuggestionFor,
  SUGGESTION_SAMPLE_BYTES,
} from "./sealSuggestion.logic";
import { useSealSuggestion } from "./useSealSuggestions";

type Translate = ReturnType<typeof useGT>;

/** What Seal does, or why this file looks like one to seal. Said on hover, never beside the file. */
export const sealTooltip = (suggestion: SealSuggestion | null, gt: Translate): string =>
  suggestion === null
    ? gt("Keep this file from your AI company. Your AI can still ask about it.")
    : `${
        suggestion.reason === "columns"
          ? gt("This file has payroll or identity columns. Seal it instead?")
          : gt("This file has {count} ID numbers, IBANs or phone numbers. Seal it instead?", {
              count: suggestion.count,
            })
      } ${gt("Checked on this computer; nothing was sent.")}`;

// Sized in em: these sit in the message's own line of text, beside the chip they act on.
const CHIP_ACTION_CLASS =
  "ms-0 size-[1.3em] text-muted-foreground hover:text-foreground [&_svg]:size-[0.95em]";

/** Seal beside a chip. A file that looks like one to seal gets the word and a tint. */
function ChipSealAction({
  name,
  suggestion,
  onSeal,
}: {
  readonly name: string;
  readonly suggestion: SealSuggestion | null;
  readonly onSeal: () => void;
}) {
  const gt = useGT();
  return (
    <SharedTooltipTrigger
      render={
        <ContextChipAction
          data-seal-action={suggestion === null ? "offered" : "suggested"}
          aria-label={gt("Seal {name}", { name })}
          className={cn(
            CHIP_ACTION_CLASS,
            suggestion !== null &&
              "w-auto gap-[0.2em] rounded-full bg-warning/12 px-1.5 text-warning-foreground hover:bg-warning/20 hover:text-warning-foreground",
          )}
          onClick={onSeal}
        />
      }
      label={sealTooltip(suggestion, gt)}
    >
      <FileLock2Icon aria-hidden />
      {suggestion === null ? null : (
        <span className="text-xs leading-none">
          {gt("Seal", { $context: "button on an attached file: seal it instead of sending it" })}
        </span>
      )}
    </SharedTooltipTrigger>
  );
}

/**
 * Seal, Review and Remove beside an attached file's chip. The chip is the only place the file
 * shows in the composer, so what can be done to the file is done from here.
 */
export function ComposerFileChipActions({ file }: { readonly file: ComposerFileAttachment }) {
  const gt = useGT();
  const actions = use(ComposerContextActionsContext);
  const { removeFile } = actions;
  // Only a file whose bytes are held here can be sealed from here.
  const seal = file.file === null ? undefined : actions.sealFile;
  // A file that has to be attached again has nothing to open.
  const reviewFile = composerFileNeedsReattach(file) ? undefined : actions.reviewFile;
  const review = composerFileNeedsReattach(file) ? undefined : actions.reviewStatus?.(file.id);
  const suggestion = useSealSuggestion(file.name, seal === undefined ? null : file.file);
  if (seal === undefined && reviewFile === undefined && removeFile === undefined) return null;
  const reviewLabel =
    review?.status === "scanning"
      ? gt("Checking…")
      : review?.status === "reviewed"
        ? gt("Reviewed")
        : gt("Review before sending");
  return (
    <span data-composer-file-actions className="inline-flex shrink-0 items-center gap-0.5">
      {seal === undefined ? null : (
        <ChipSealAction name={file.name} suggestion={suggestion} onSeal={() => seal(file.id)} />
      )}
      {reviewFile === undefined ? null : (
        <SharedTooltipTrigger
          render={
            <ContextChipAction
              aria-label={gt("Review {name}", { name: file.name })}
              data-review-status={review?.status}
              className={cn(
                CHIP_ACTION_CLASS,
                review?.status === "reviewed" && "text-success hover:text-success",
                review !== undefined &&
                  review.status !== "reviewed" &&
                  review.itemCount > 0 &&
                  "w-auto gap-[0.2em] rounded-full bg-warning/12 px-1.5 text-warning-foreground hover:bg-warning/20 hover:text-warning-foreground",
              )}
              onClick={() => reviewFile(file.id)}
            />
          }
          label={reviewLabel}
        >
          {review?.status === "scanning" ? (
            <Spinner className="size-[0.9em]" />
          ) : review?.status === "reviewed" ? (
            <CheckIcon aria-hidden />
          ) : (
            <ScanEyeIcon aria-hidden />
          )}
          {review !== undefined && review.status !== "reviewed" && review.itemCount > 0 ? (
            <span className="text-xs leading-none tabular-nums">{review.itemCount}</span>
          ) : null}
        </SharedTooltipTrigger>
      )}
      {removeFile === undefined ? null : (
        <SharedTooltipTrigger
          render={
            <ContextChipAction
              aria-label={gt("Remove {name}", { name: file.name })}
              className={CHIP_ACTION_CLASS}
              onClick={() => removeFile(file.id)}
            />
          }
          label={gt("Remove")}
        >
          <XIcon aria-hidden />
        </SharedTooltipTrigger>
      )}
    </span>
  );
}

/** Larger than this, a mentioned file is not read to decide: Seal is offered without a reason. */
const MENTION_SUGGESTION_MAX_BYTES = 2 * SUGGESTION_SAMPLE_BYTES;

/**
 * Seal beside a mentioned file's chip. A mention sends the path and the agent reads the file, so
 * it is offered what an attached file is. Nothing for a folder, or a path that is not there.
 */
export function ComposerMentionSealAction({ path }: { readonly path: string }) {
  const { sealMention, environmentId, cwd } = use(ComposerContextActionsContext);
  if (sealMention === undefined || environmentId === null || cwd === undefined) return null;
  return (
    <MentionSeal
      path={path}
      environmentId={environmentId}
      cwd={cwd}
      onSeal={() => sealMention(path)}
    />
  );
}

function MentionSeal({
  path,
  environmentId,
  cwd,
  onSeal,
}: {
  readonly path: string;
  readonly environmentId: EnvironmentId;
  readonly cwd: string;
  readonly onSeal: () => void;
}) {
  const metadata = useFileMetadata(environmentId, path, cwd);
  const name = fileNameOf(path);
  const isFile = metadata?.kind === "file";
  const read =
    isFile &&
    readableForSuggestion(name) &&
    metadata.byteLength !== undefined &&
    metadata.byteLength <= MENTION_SUGGESTION_MAX_BYTES;
  const contents = useEnvironmentQuery(
    read
      ? projectEnvironment.readFile({ environmentId, input: { cwd, relativePath: path } })
      : null,
  ).data?.contents;
  if (!isFile) return null;
  const suggestion =
    contents === undefined
      ? null
      : sealSuggestionFor(name, contents.slice(0, SUGGESTION_SAMPLE_BYTES));
  return <ChipSealAction name={name} suggestion={suggestion} onSeal={onSeal} />;
}
