import type {
  ChatAttachment,
  ChatFileAttachment,
  EnvironmentId,
  ScopedThreadRef,
  SnapShotSource,
} from "@t3tools/contracts";
import { formatAttachmentSize } from "@t3tools/client-runtime/state/attachments";
import { T, useGT, useMessages } from "gt-react";
import {
  CircleAlertIcon,
  FileLock2Icon,
  ImageIcon,
  PaperclipIcon,
  PlayIcon,
  XIcon,
} from "lucide-react";
import { type ComponentProps, type Ref, useLayoutEffect, useRef, useState } from "react";

import {
  type ComposerFileAttachment,
  type ComposerImageAttachment,
  type DraftId,
  composerFileNeedsReattach,
} from "../../composerDraftStore";
import { retryAttachmentUpload, useAttachmentUploadStore } from "../../lib/attachmentUploadQueue";
import {
  attachmentUploadFailureText,
  type AttachmentUploadState,
} from "../../lib/attachmentUploadState";
import { useAttachmentUploadProgress } from "../../hooks/useAttachmentUploadProgress";
import { isHeicImageFile } from "../../lib/imageCompression";
import {
  type PendingSnapShotAnimation,
  scheduleSnapShotAnimationDestination,
  setSnapShotAnimationDestination,
  shouldAnimateSnapShotArrival,
} from "../../lib/snapShotAnimation";
import { cn } from "~/lib/utils";
import { getRestingComposerImagePreviewCounts } from "../composerFooterLayout";
import { RefreshIcon } from "~/components/ui/refresh-icon";
import { AttachmentFilePreview } from "../files/AttachmentFilePreview";
import { AttachmentImage } from "../media/AttachmentImage";
import { Button } from "../ui/button";
import { Dialog, DialogPopup, DialogTitle } from "../ui/dialog";
import { ComposerImageThumbnail } from "./ComposerImageThumbnail";
import { composerFloatingLayerProps } from "./composerEventScope";
import type { PreparingComposerImage } from "./preparingComposerImages";
import {
  attachVideoThumbnail,
  buildExpandedImagePreview,
  type ExpandedImagePreview,
} from "./ExpandedImagePreview";
import { PierreEntryIcon } from "./PierreEntryIcon";
import { fileNameOf, sealableImage } from "../privacy/sealedFiles.logic";
import {
  readableForSuggestion,
  type SealSuggestion,
  sealSuggestionFor,
  SUGGESTION_SAMPLE_BYTES,
} from "../privacy/sealSuggestion.logic";
import { useSealSuggestions } from "../privacy/useSealSuggestions";
import { useFileMetadata } from "../../hooks/useFileMetadata";
import { projectEnvironment } from "../../state/projects";
import { useEnvironmentQuery } from "../../state/query";
import {
  SNAP_SHOT_ATTACHMENT_FRAME_CLASS,
  SnapShotAttachmentDetails,
} from "./SnapShotAttachmentDetails";
import { prepareVideoFirstFrame } from "../../lib/videoFirstFrame";
import { SharedTooltipTrigger } from "../ui/shared-tooltip";

function ComposerAttachmentUploadProgress({
  id,
  upload,
  fallback,
}: {
  id: string;
  upload: AttachmentUploadState | undefined;
  fallback?: string;
}) {
  return useAttachmentUploadProgress(id, upload) ?? fallback ?? null;
}

function ComposerImageFallback() {
  const gt = useGT();
  return (
    <span
      role="img"
      aria-label={gt("Image attachment")}
      className="flex size-full items-center justify-center p-3 text-secondary-label"
    >
      <ImageIcon aria-hidden="true" className="size-4" />
    </span>
  );
}

function ComposerVideoThumbnail({ file }: { file: File }) {
  const setVideo = (video: HTMLVideoElement | null) => {
    if (!video) return;
    return attachVideoThumbnail(video, file);
  };

  return (
    <video
      ref={setVideo}
      muted
      playsInline
      preload="metadata"
      aria-hidden="true"
      onLoadedMetadata={(event) => prepareVideoFirstFrame(event.currentTarget)}
      className="pointer-events-none absolute inset-0 size-full object-cover"
    />
  );
}

function SnapShotAttachmentFrame({
  animationId,
  animationSource,
  arrival,
  animateArrival,
  className,
  ...props
}: ComponentProps<"div"> & {
  readonly animationId?: string | undefined;
  readonly animationSource?: SnapShotSource | undefined;
  readonly arrival?: boolean | undefined;
  readonly animateArrival?: boolean | undefined;
}) {
  const frameRef = useRef<HTMLDivElement>(null);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- scrolls the mounted tile into view and registers it as the SnapShot animation destination
  useLayoutEffect(() => {
    const frame = frameRef.current;
    if (!frame || (!animationId && !arrival)) return;
    frame.scrollIntoView({ block: "nearest", inline: "nearest" });
    if (!animationId) return;

    return scheduleSnapShotAnimationDestination(animationId, () =>
      setSnapShotAnimationDestination(animationId, frame, animationSource),
    );
  }, [animationId, animationSource, arrival]);

  return (
    <div
      ref={frameRef}
      className={cn(
        animateArrival &&
          !animationId &&
          "origin-center transition-[opacity,scale] duration-300 ease-drawer starting:scale-95 starting:opacity-0 motion-reduce:transition-none motion-reduce:starting:scale-100 motion-reduce:starting:opacity-100",
        className,
      )}
      {...props}
    />
  );
}

/** Image, SnapShot and video tiles above the composer editor. */
export function ComposerAttachmentMediaRow({
  images,
  expandedImages,
  preparingImages,
  videos,
  pendingSnapShotAnimations,
  pendingSnapShotIds,
  uncommittedSnapShotIds,
  nonPersistedImageIds,
  snapShotAnimations,
  supportsAttachmentUploads,
  maxFileAttachmentBytes,
  environmentId,
  attachmentDraftTarget,
  canOperateThread,
  onExpandImage,
  onCopySnapshot,
  onFileOpen,
  onRemoveImage,
  onRemoveFile,
  onSealImage,
}: {
  /** Present when this folder's files can be sealed: the image is then kept from the AI company. */
  readonly onSealImage?: ((image: ComposerImageAttachment) => void) | undefined;
  readonly images: ReadonlyArray<ComposerImageAttachment>;
  readonly expandedImages: ReadonlyArray<ComposerImageAttachment>;
  readonly preparingImages: ReadonlyArray<PreparingComposerImage>;
  readonly videos: ReadonlyArray<ComposerFileAttachment>;
  readonly pendingSnapShotAnimations: ReadonlyArray<PendingSnapShotAnimation>;
  readonly pendingSnapShotIds: ReadonlyArray<string>;
  readonly uncommittedSnapShotIds: ReadonlyArray<string>;
  readonly nonPersistedImageIds: ReadonlyArray<string>;
  readonly snapShotAnimations: boolean;
  readonly supportsAttachmentUploads: boolean;
  readonly maxFileAttachmentBytes: number | null;
  readonly environmentId: EnvironmentId;
  readonly attachmentDraftTarget: ScopedThreadRef | DraftId;
  readonly canOperateThread: boolean;
  readonly onCopySnapshot: (imageId: string) => Promise<void>;
  readonly onExpandImage: (preview: ExpandedImagePreview) => void;
  readonly onFileOpen: (attachment: ChatFileAttachment) => void;
  readonly onRemoveImage: (imageId: string) => void;
  readonly onRemoveFile: (fileId: string) => void;
}) {
  const gt = useGT();
  const messages = useMessages();
  const uploadsByImageId = useAttachmentUploadStore((state) => state.uploadsByImageId);
  const pendingSnapShotIdSet = new Set(pendingSnapShotIds);
  const nonPersistedImageIdSet = new Set(nonPersistedImageIds);
  return (
    <div
      className={cn(
        "mb-3 flex max-w-full gap-2",
        pendingSnapShotIds.length > 0 ||
          expandedImages.some((image) => image.source?.kind === "snap-shot")
          ? "snap-x snap-proximity overflow-x-auto overscroll-x-contain pb-1 scrollbar-thumb-foreground/18 scrollbar-track-transparent [scrollbar-width:thin] [&::-webkit-scrollbar]:h-2.5 [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:border-3 [&::-webkit-scrollbar-thumb]:border-transparent [&::-webkit-scrollbar-thumb]:bg-foreground/18 [&::-webkit-scrollbar-thumb]:bg-clip-content [&::-webkit-scrollbar-thumb:hover]:bg-foreground/28 [&::-webkit-scrollbar-track]:mx-1 [&::-webkit-scrollbar-track]:bg-transparent"
          : "flex-wrap",
      )}
    >
      {/* A preparing image renders through the same tile, keyed by the id its compressed image
          takes, so the thumbnail element survives the swap. */}
      {[
        ...expandedImages.map((image) => ({ image, ready: image })),
        ...preparingImages.map((image) => ({ image, ready: null })),
      ]
        .map(({ image, ready }) => {
          const upload =
            ready && supportsAttachmentUploads ? uploadsByImageId[image.id] : undefined;
          const source = ready?.source;
          const snapShotAnimationPending =
            source?.kind === "snap-shot" && pendingSnapShotIdSet.has(image.id);
          const snapShotArrival =
            source?.kind === "snap-shot" && shouldAnimateSnapShotArrival(source.capturedAt);
          return (
            <SnapShotAttachmentFrame
              key={image.id}
              data-chat-composer-expanded-image="true"
              aria-hidden={snapShotAnimationPending || undefined}
              inert={snapShotAnimationPending || undefined}
              arrival={snapShotArrival}
              animateArrival={snapShotAnimations && !snapShotAnimationPending && snapShotArrival}
              animationId={snapShotAnimationPending ? image.id : undefined}
              animationSource={snapShotAnimationPending ? source : undefined}
              className={cn(
                "group/attachment shrink-0 snap-start bg-background",
                source?.kind === "snap-shot"
                  ? SNAP_SHOT_ATTACHMENT_FRAME_CLASS
                  : "relative h-16 w-16 overflow-hidden rounded-lg border border-border/80",
                snapShotAnimationPending && "invisible",
              )}
            >
              {!ready || ready.previewUrl ? (
                <button
                  type="button"
                  className={cn("h-full w-full", ready && "cursor-zoom-in")}
                  aria-label={gt("Preview {name}", { name: image.name })}
                  disabled={!ready}
                  onClick={() => {
                    const preview = buildExpandedImagePreview(images, image.id, onCopySnapshot);
                    if (!preview) return;
                    onExpandImage(preview);
                  }}
                >
                  <ComposerImageThumbnail
                    file={image.file}
                    alt={image.name}
                    className="h-full w-full object-cover"
                    fallback={
                      ready && isHeicImageFile({ name: ready.name, type: ready.mimeType }) ? (
                        <AttachmentImage
                          name={ready.name}
                          mimeType={ready.mimeType}
                          src={ready.previewUrl}
                          alt=""
                          className="h-full w-full object-cover"
                        />
                      ) : (
                        <ComposerImageFallback />
                      )
                    }
                  />
                </button>
              ) : (
                <ComposerImageFallback />
              )}
              {source?.kind === "snap-shot" ? (
                <SnapShotAttachmentDetails
                  source={source}
                  onCopySnapshot={ready ? () => onCopySnapshot(ready.id) : undefined}
                  className={cn(
                    upload?.status === "uploading" && "bottom-4",
                    upload?.status === "failed" && "bottom-8",
                  )}
                />
              ) : null}
              {nonPersistedImageIdSet.has(image.id) && (
                <SharedTooltipTrigger
                  render={
                    <span
                      role="img"
                      aria-label={gt("Draft attachment may not persist")}
                      className="absolute left-1 top-1 inline-flex items-center justify-center rounded bg-background/85 p-0.5 text-warning-foreground"
                    >
                      <CircleAlertIcon className="size-3" />
                    </span>
                  }
                  label={
                    <>
                      <T>
                        Draft attachment could not be saved locally and may be lost on navigation.
                      </T>
                    </>
                  }
                />
              )}
              {(!ready || upload?.status === "uploading") && (
                <span className="pointer-events-none absolute inset-x-0 bottom-0 bg-background/85 px-1 text-center text-3xs text-foreground">
                  {upload?.status === "uploading" ? (
                    <ComposerAttachmentUploadProgress id={image.id} upload={upload} />
                  ) : (
                    gt("Preparing", {
                      $context: "attachment status while an image is being processed",
                    })
                  )}
                </span>
              )}
              {/* A thumbnail has room for the label along its lower edge only. */}
              {onSealImage !== undefined &&
              ready &&
              sealableImage(ready.name) &&
              source?.kind !== "snap-shot" &&
              upload?.status !== "uploading" &&
              upload?.status !== "failed" ? (
                <span className="absolute bottom-1 left-1">
                  <SealAttachmentButton onSeal={() => onSealImage(ready)} overlay />
                </span>
              ) : null}
              {ready && upload?.status === "failed" && (
                <SharedTooltipTrigger
                  render={
                    <Button
                      variant="overlay"
                      size="icon-xs"
                      className="absolute bottom-1 left-1"
                      onClick={() =>
                        retryAttachmentUpload({
                          environmentId,
                          image: ready,
                          draftTarget: attachmentDraftTarget,
                        })
                      }
                      disabled={!canOperateThread}
                      aria-label={gt("Retry upload for {name}", { name: image.name })}
                    />
                  }
                  label={attachmentUploadFailureText(upload, messages)}
                >
                  <RefreshIcon />
                </SharedTooltipTrigger>
              )}
              <span
                className={cn(
                  "absolute right-1 top-1 flex gap-1",
                  source?.kind === "snap-shot" &&
                    "opacity-0 transition-opacity pointer-coarse:opacity-100 group-hover/attachment:opacity-100 group-focus-within/attachment:opacity-100",
                )}
              >
                {onSealImage !== undefined &&
                ready &&
                sealableImage(ready.name) &&
                source?.kind === "snap-shot" ? (
                  <SealAttachmentButton onSeal={() => onSealImage(ready)} overlay />
                ) : null}
                <Button
                  variant="media-close"
                  size="icon-xs"
                  onClick={() => onRemoveImage(image.id)}
                  aria-label={gt("Remove {name}", { name: image.name })}
                >
                  <XIcon />
                </Button>
              </span>
            </SnapShotAttachmentFrame>
          );
        })
        .concat(
          uncommittedSnapShotIds.map((captureId) => (
            <SnapShotAttachmentFrame
              key={captureId}
              aria-hidden="true"
              animationId={captureId}
              animationSource={
                pendingSnapShotAnimations.find((capture) => capture.id === captureId)?.source
              }
              className={cn(
                SNAP_SHOT_ATTACHMENT_FRAME_CLASS,
                "invisible shrink-0 snap-start bg-background",
              )}
            />
          )),
        )}
      {videos.map((file) => {
        const fileCanUpload =
          supportsAttachmentUploads &&
          maxFileAttachmentBytes !== null &&
          file.sizeBytes <= maxFileAttachmentBytes;
        const upload = fileCanUpload ? uploadsByImageId[file.id] : undefined;
        return (
          <div
            key={file.id}
            className="relative h-16 w-16 shrink-0 snap-start overflow-hidden rounded-lg border border-border/80 bg-black"
          >
            <button
              type="button"
              className="flex h-full w-full cursor-zoom-in flex-col items-center justify-center gap-1 px-1 text-white"
              aria-label={gt("Play {name}", { name: file.name })}
              onClick={() => {
                if (file.file !== null) {
                  const preview = buildExpandedImagePreview([file], file.id);
                  if (preview) onExpandImage(preview);
                  return;
                }
                if (!file.uploadedAttachmentId) return;
                onFileOpen({ ...file, id: file.uploadedAttachmentId });
              }}
            >
              {file.file && (
                <>
                  <ComposerVideoThumbnail file={file.file} />
                  <span className="pointer-events-none absolute inset-0 bg-gradient-to-t from-black/70 via-black/10 to-black/10" />
                </>
              )}
              <PlayIcon className="relative z-10 size-4 fill-current drop-shadow-md" />
            </button>
            {upload?.status === "uploading" && (
              <span className="pointer-events-none absolute inset-x-0 bottom-0 bg-background/85 px-1 text-center text-3xs text-foreground">
                <ComposerAttachmentUploadProgress id={file.id} upload={upload} />
              </span>
            )}
            {upload?.status === "failed" && (
              <SharedTooltipTrigger
                render={
                  <Button
                    variant="overlay"
                    size="icon-xs"
                    className="absolute bottom-1 left-1"
                    onClick={() =>
                      retryAttachmentUpload({
                        environmentId,
                        image: file,
                        draftTarget: attachmentDraftTarget,
                      })
                    }
                    disabled={!canOperateThread}
                    aria-label={gt("Retry upload for {name}", { name: file.name })}
                  />
                }
                label={attachmentUploadFailureText(upload, messages)}
              >
                <RefreshIcon />
              </SharedTooltipTrigger>
            )}
            <Button
              variant="media-close"
              size="icon-xs"
              className="absolute right-1 top-1"
              onClick={() => onRemoveFile(file.id)}
              aria-label={gt("Remove {name}", { name: file.name })}
            >
              <XIcon />
            </Button>
          </div>
        );
      })}
    </div>
  );
}

/** Non-media file attachments, listed under the media row. */
export function ComposerAttachmentFileList({
  files,
  resolvedTheme,
  supportsAttachmentUploads,
  maxFileAttachmentBytes,
  fileStagingLimit,
  environmentId,
  attachmentDraftTarget,
  canOperateThread,
  onPreviewFile,
  onRemoveFile,
  onSealFile,
}: {
  readonly files: ReadonlyArray<ComposerFileAttachment>;
  /** Present when this folder's files can be sealed: the file is then kept from the AI company. */
  readonly onSealFile?: ((file: ComposerFileAttachment) => void) | undefined;
  readonly resolvedTheme: "light" | "dark";
  readonly supportsAttachmentUploads: boolean;
  readonly maxFileAttachmentBytes: number | null;
  readonly fileStagingLimit: number | null;
  readonly environmentId: EnvironmentId;
  readonly attachmentDraftTarget: ScopedThreadRef | DraftId;
  readonly canOperateThread: boolean;
  readonly onPreviewFile: (fileId: string) => void;
  readonly onRemoveFile: (fileId: string) => void;
}) {
  const gt = useGT();
  const messages = useMessages();
  const uploadsByImageId = useAttachmentUploadStore((state) => state.uploadsByImageId);
  // Offered only where the file can be sealed from here.
  const suggestions = useSealSuggestions(onSealFile === undefined ? NO_FILES : files);
  const [dismissedSuggestions, setDismissedSuggestions] = useState<ReadonlySet<string>>(new Set());
  return (
    <div className="mb-3 flex flex-col gap-1">
      {files.map((file) => {
        const suggestion = dismissedSuggestions.has(file.id) ? undefined : suggestions.get(file.id);
        const fileCanUpload =
          supportsAttachmentUploads &&
          maxFileAttachmentBytes !== null &&
          file.sizeBytes <= maxFileAttachmentBytes;
        const upload = fileCanUpload ? uploadsByImageId[file.id] : undefined;
        const needsReattach = composerFileNeedsReattach(file);
        const canReattachFile = fileStagingLimit !== null && file.sizeBytes <= fileStagingLimit;
        return (
          <div key={file.id} className="flex min-w-0 flex-col">
            <div className="flex min-w-0 items-center gap-2 py-1 text-sm text-foreground">
              <PierreEntryIcon pathValue={file.name} kind="file" theme={resolvedTheme} />
              <button
                type="button"
                disabled={needsReattach}
                dir="auto"
                className="file-name min-w-0 flex-1 truncate text-start hover:underline focus-visible:outline-2"
                onClick={() => onPreviewFile(file.id)}
              >
                {file.name}
              </button>
              <span className="shrink-0 text-xs text-secondary-label">
                {needsReattach ? (
                  canReattachFile ? (
                    gt("Attach again")
                  ) : (
                    gt("Remove to send")
                  )
                ) : upload?.status === "uploading" ? (
                  <ComposerAttachmentUploadProgress
                    id={file.id}
                    upload={upload}
                    fallback={formatAttachmentSize(file.sizeBytes, messages)}
                  />
                ) : (
                  formatAttachmentSize(file.sizeBytes, messages)
                )}
              </span>
              {!needsReattach && upload?.status === "failed" ? (
                <SharedTooltipTrigger
                  render={
                    <Button
                      variant="ghost"
                      size="icon-xs"
                      onClick={() =>
                        retryAttachmentUpload({
                          environmentId,
                          image: file,
                          draftTarget: attachmentDraftTarget,
                        })
                      }
                      disabled={!canOperateThread}
                      aria-label={gt("Retry upload for {name}", { name: file.name })}
                    />
                  }
                  label={attachmentUploadFailureText(upload, messages)}
                >
                  <RefreshIcon />
                </SharedTooltipTrigger>
              ) : null}
              {onSealFile !== undefined && file.file !== null ? (
                <SealAttachmentButton onSeal={() => onSealFile(file)} />
              ) : null}
              <Button
                variant="ghost"
                size="icon-xs"
                onClick={() => onRemoveFile(file.id)}
                aria-label={gt("Remove {name}", { name: file.name })}
              >
                <XIcon />
              </Button>
            </div>
            {suggestion !== undefined && onSealFile !== undefined && file.file !== null ? (
              <SealSuggestionNote
                suggestion={suggestion}
                onSeal={() => onSealFile(file)}
                onDismiss={() => setDismissedSuggestions((before) => new Set(before).add(file.id))}
              />
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

const NO_FILES: ReadonlyArray<ComposerFileAttachment> = [];

/** Why a file looks like one to seal, with Seal beside it. Shown under the file's row. */
function SealSuggestionNote({
  suggestion,
  onSeal,
  onDismiss,
}: {
  readonly suggestion: SealSuggestion;
  readonly onSeal: () => void;
  readonly onDismiss: () => void;
}) {
  const gt = useGT();
  return (
    <p
      role="note"
      className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 pb-1 ps-6 text-xs text-muted-foreground"
    >
      <span className="min-w-0">
        {suggestion.reason === "columns"
          ? gt("This file has payroll or identity columns. Seal it instead?")
          : gt("This file has {count} ID numbers, IBANs or phone numbers. Seal it instead?", {
              count: suggestion.count,
            })}{" "}
        {gt("Checked on this computer; nothing was sent.")}
      </span>
      <Button variant="outline" size="xs" onClick={onSeal}>
        {gt("Seal", { $context: "button on an attached file: seal it instead of sending it" })}
      </Button>
      <Button variant="ghost" size="xs" onClick={onDismiss}>
        {gt("Dismiss")}
      </Button>
    </p>
  );
}

/** Larger than this, a mentioned file is not read to decide: Seal is offered without a reason. */
const MENTION_SUGGESTION_MAX_BYTES = 2 * SUGGESTION_SAMPLE_BYTES;

/**
 * The folder's files that the message mentions, each with Seal. A mention sends the path and the
 * agent reads the file, so it is offered what an attached file is: Seal, and the same suggestion.
 */
export function ComposerMentionSealList({
  pathList,
  environmentId,
  cwd,
  resolvedTheme,
  onSeal,
}: {
  /** As written in the message, from the folder or absolute; one to a line, so typing keeps it equal. */
  readonly pathList: string;
  readonly environmentId: EnvironmentId;
  readonly cwd: string;
  readonly resolvedTheme: "light" | "dark";
  readonly onSeal: (path: string) => void;
}) {
  return (
    <div className="mb-3 flex flex-col gap-1">
      {pathList.split("\n").map((path) => (
        <MentionSealRow
          key={path}
          path={path}
          environmentId={environmentId}
          cwd={cwd}
          resolvedTheme={resolvedTheme}
          onSeal={() => onSeal(path)}
        />
      ))}
    </div>
  );
}

function MentionSealRow({
  path,
  environmentId,
  cwd,
  resolvedTheme,
  onSeal,
}: {
  readonly path: string;
  readonly environmentId: EnvironmentId;
  readonly cwd: string;
  readonly resolvedTheme: "light" | "dark";
  readonly onSeal: () => void;
}) {
  const messages = useMessages();
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
  const suggestion =
    contents === undefined
      ? null
      : sealSuggestionFor(name, contents.slice(0, SUGGESTION_SAMPLE_BYTES));
  const [dismissed, setDismissed] = useState(false);
  // A folder, or a path that is not there: a sealed file's mention among them.
  if (!isFile) return null;
  return (
    <div className="flex min-w-0 flex-col">
      <div className="flex min-w-0 items-center gap-2 py-1 text-sm text-foreground">
        <PierreEntryIcon pathValue={name} kind="file" theme={resolvedTheme} />
        <bdi className="file-name min-w-0 flex-1 truncate text-start">{name}</bdi>
        {metadata.byteLength === undefined ? null : (
          <span className="shrink-0 text-xs text-secondary-label">
            {formatAttachmentSize(metadata.byteLength, messages)}
          </span>
        )}
        <SealAttachmentButton onSeal={onSeal} />
      </div>
      {suggestion !== null && !dismissed ? (
        <SealSuggestionNote
          suggestion={suggestion}
          onSeal={onSeal}
          onDismiss={() => setDismissed(true)}
        />
      ) : null}
    </div>
  );
}

/**
 * Seal on an attached file, with its name written out: a bare lock reads as "this is locked",
 * not as something to press.
 */
function SealAttachmentButton({
  onSeal,
  overlay = false,
}: {
  readonly onSeal: () => void;
  /** On top of a thumbnail. */
  readonly overlay?: boolean;
}) {
  const gt = useGT();
  return (
    <SharedTooltipTrigger
      render={<Button variant={overlay ? "overlay" : "ghost"} size="xs" onClick={onSeal} />}
      label={gt("Keep this file from your AI company. Your AI can still ask about it.")}
    >
      <FileLock2Icon />
      {gt("Seal", { $context: "button on an attached file: seal it instead of sending it" })}
    </SharedTooltipTrigger>
  );
}

export function ComposerFilePreviewDialog({
  file,
  onRemove,
  onPreviewFileIdChange,
}: {
  readonly file: ComposerFileAttachment;
  readonly onRemove: (fileId: string) => void;
  readonly onPreviewFileIdChange: (fileId: string | null) => void;
}) {
  const gt = useGT();
  const onClose = () => onPreviewFileIdChange(null);
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogPopup
        {...composerFloatingLayerProps}
        className="h-[min(85vh,52rem)] max-w-4xl overflow-hidden"
        showCloseButton={false}
      >
        <DialogTitle className="sr-only">{file.name}</DialogTitle>
        <AttachmentFilePreview
          key={file.id}
          name={file.name}
          mimeType={file.mimeType}
          sizeBytes={file.sizeBytes}
          file={file.file}
          origin={gt("Draft", { $context: "where an attachment comes from: the unsent message" })}
          {...(file.uploadedAttachmentId && file.uploadEnvironmentId
            ? {
                asset: {
                  environmentId: file.uploadEnvironmentId,
                  attachmentId: file.uploadedAttachmentId,
                },
              }
            : {})}
          onRemove={() => {
            onRemove(file.id);
            onClose();
          }}
          onClose={onClose}
        />
      </DialogPopup>
    </Dialog>
  );
}

/** Thumbnails beside the single-line prompt while the composer rests. */
export function ComposerRestingImagePreviews({
  images,
  allImages,
  resolvedTheme,
  onExpandImage,
  onCopySnapshot,
  onShowMore,
}: {
  readonly images: ReadonlyArray<ComposerImageAttachment>;
  readonly allImages: ReadonlyArray<ComposerImageAttachment>;
  readonly resolvedTheme: "light" | "dark";
  readonly onCopySnapshot: (imageId: string) => Promise<void>;
  readonly onExpandImage: (preview: ExpandedImagePreview) => void;
  readonly onShowMore: () => void;
}) {
  const gt = useGT();
  const counts = getRestingComposerImagePreviewCounts(images.length);
  const visibleImages = images.slice(0, counts.visibleCount);
  return (
    <div data-chat-composer-resting-images="true" className="flex shrink-0 items-center gap-1 ps-1">
      {visibleImages.map((image) => (
        <button
          key={image.id}
          type="button"
          className="relative size-7 shrink-0 cursor-zoom-in overflow-hidden rounded-md border border-border/70 bg-muted/60"
          aria-label={gt("Preview {name}", { name: image.name })}
          onPointerDown={(event) => event.preventDefault()}
          onClick={() => {
            const preview = buildExpandedImagePreview(allImages, image.id, onCopySnapshot);
            if (preview) onExpandImage(preview);
          }}
        >
          {image.previewUrl ? (
            <ComposerImageThumbnail
              file={image.file}
              alt=""
              className="size-full object-cover"
              fallback={
                isHeicImageFile({ name: image.name, type: image.mimeType }) ? (
                  <AttachmentImage
                    name={image.name}
                    mimeType={image.mimeType}
                    src={image.previewUrl}
                    alt=""
                    className="size-full object-cover"
                  />
                ) : (
                  <PierreEntryIcon
                    pathValue={image.name}
                    kind="file"
                    theme={resolvedTheme}
                    className="m-auto size-3.5"
                  />
                )
              }
            />
          ) : (
            <PierreEntryIcon
              pathValue={image.name}
              kind="file"
              theme={resolvedTheme}
              className="m-auto size-3.5"
            />
          )}
        </button>
      ))}
      {counts.overflowCount > 0 ? (
        <button
          type="button"
          className="flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-md border border-border/70 bg-muted/60 font-medium text-secondary-label text-xs tabular-nums outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background"
          aria-label={gt(
            "{count, plural, one {Show {count} more image attachment} other {Show {count} more image attachments}}",
            {
              count: counts.overflowCount,
            },
          )}
          onPointerDown={(event) => event.preventDefault()}
          onClick={onShowMore}
        >
          +{counts.overflowCount}
        </button>
      ) : null}
    </div>
  );
}

/** Attachments of the queued message being edited; they are already uploaded. */
export function ComposerQueuedAttachmentRow({
  attachments,
  onRemove,
}: {
  readonly attachments: ReadonlyArray<{
    readonly attachment: ChatAttachment;
    readonly url: string | null;
  }>;
  readonly onRemove: (attachmentId: string) => void;
}) {
  const gt = useGT();
  return (
    <div className="mb-3 flex flex-wrap gap-2">
      {attachments.map(({ attachment, url }) => (
        <div
          key={attachment.id}
          className="relative h-16 w-16 overflow-hidden rounded-lg border border-border/80 bg-background"
        >
          {attachment.type === "image" && url ? (
            <img src={url} alt={attachment.name} className="h-full w-full object-cover" />
          ) : (
            <div className="flex h-full w-full items-center justify-center px-1 text-center text-3xs text-secondary-label">
              <bdi>{attachment.name}</bdi>
            </div>
          )}
          <Button
            variant="media-close"
            size="icon-xs"
            className="absolute right-1 top-1"
            onClick={() => onRemove(attachment.id)}
            aria-label={gt("Remove {name}", { name: attachment.name })}
          >
            <XIcon />
          </Button>
        </div>
      ))}
    </div>
  );
}

// Kept outside the composer footer: on mobile the picker blurs the editor and the
// footer unmounts, and a detached input never delivers its change event.
export function ComposerAttachInput({
  ref,
  addComposerAttachments,
  focusComposer,
}: {
  readonly ref: Ref<HTMLInputElement>;
  readonly addComposerAttachments: (files: File[]) => Promise<boolean>;
  readonly focusComposer: () => void;
}) {
  return (
    <input
      ref={ref}
      type="file"
      multiple
      className="hidden"
      onChange={(event) => {
        const files = Array.from(event.currentTarget.files ?? []);
        event.currentTarget.value = "";
        // Inserting a chip refocuses the editor after the draft renders;
        // focusing synchronously here would report the editor's stale text
        // over the prompt that was just written.
        void addComposerAttachments(files).then((inserted) => {
          if (!inserted) focusComposer();
        });
      }}
    />
  );
}

export function ComposerAttachButton({ onOpenPicker }: { readonly onOpenPicker: () => void }) {
  const gt = useGT();
  return (
    <SharedTooltipTrigger
      render={
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          onPointerDown={(event) => event.preventDefault()}
          onClick={onOpenPicker}
          aria-label={gt("Attach files")}
        />
      }
      label={
        <>
          <T>Attach files</T>
        </>
      }
    >
      {/* The clip's weight sits in its upper loop; 1px down reads as centered on the row. */}
      <PaperclipIcon className="translate-y-px" />
    </SharedTooltipTrigger>
  );
}
