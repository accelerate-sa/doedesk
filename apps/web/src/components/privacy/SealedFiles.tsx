import type {
  EnvironmentId,
  PrivacySealedDocument,
  PrivacySealedListing,
} from "@t3tools/contracts";
import { formatCommaList } from "@t3tools/client-runtime/list-format";
import { useGT, useMessages } from "gt-react";
import { ChevronRightIcon, FileLock2Icon, FileWarningIcon, FolderLockIcon } from "lucide-react";
import { useState } from "react";

import { cn } from "~/lib/utils";
import { changeSealedDocuments } from "~/privacy/privacyClient";
import { requestSealFolder, requestUnseal, requestUnsealFolder } from "~/privacy/sealPrompt";
import { useEnvironment } from "~/state/environments";
import { Button } from "../ui/button";
import { toastManager } from "../ui/toast";
import { groupSealedListing, type SealedFolderGroup, worthReadingAgain } from "./sealedFiles.logic";
import { SentLabel } from "./SentLabel";

type Translate = ReturnType<typeof useGT>;

/** Why a sealed file cannot be asked about yet, in the person's language. */
export const unreadReason = (
  unread: NonNullable<PrivacySealedDocument["unread"]>,
  gt: Translate,
): string => {
  switch (unread.kind) {
    case "unsupported":
      return gt("DoeDesk cannot read this kind of file.");
    case "noText":
      return gt("No text was found in it.");
    case "tooLarge":
      return gt("It is too large to be read.");
    case "service":
      return gt("The reading service did not answer when it was sealed.");
  }
};

/**
 * Under a sealed file that has no text yet: it is sealed like any other, and says why nothing can
 * be asked about it, with another try where one can turn out differently.
 */
function UnreadNote({
  projectId,
  document,
}: {
  readonly projectId: string;
  readonly document: PrivacySealedDocument;
}) {
  const gt = useGT();
  const [reading, setReading] = useState(false);
  const { unread } = document;
  if (unread === undefined) return null;
  const readAgain = () => {
    setReading(true);
    void changeSealedDocuments({ action: "read", projectId, handle: document.handle })
      .then((result) =>
        toastManager.add(
          result.ok
            ? {
                type: "success",
                title: gt("Your AI can now ask about {name}", { name: document.name }),
              }
            : {
                type: "warning",
                title: gt("{name} still cannot be asked about", { name: document.name }),
                description: result.message ?? undefined,
              },
        ),
      )
      .catch(() =>
        toastManager.add({ type: "error", title: gt("The file could not be read again.") }),
      )
      .finally(() => setReading(false));
  };
  return (
    <span className="flex min-w-0 flex-wrap items-center gap-x-2 ps-5.5 text-2xs text-muted-foreground">
      <span className="min-w-0">
        {gt("Sealed, but cannot be asked about yet.")} {unreadReason(unread, gt)}
      </span>
      {worthReadingAgain(unread) ? (
        <Button variant="ghost" size="xs" disabled={reading} onClick={readAgain}>
          {reading ? gt("Reading…") : gt("Try reading again")}
        </Button>
      ) : null}
    </span>
  );
}

const unseal = (projectId: string, document: PrivacySealedDocument) =>
  requestUnseal({
    projectId,
    handle: document.handle,
    name: document.name,
    movedOut: document.origin !== undefined,
  });

/** One sealed file: its name, the handle the AI calls it by, and what can be done with it. */
function SealedFileRow({
  projectId,
  label,
  document,
  onOpen,
  action,
}: {
  readonly projectId: string;
  readonly label: string;
  readonly document: PrivacySealedDocument;
  readonly onOpen?: ((origin: string) => void) | undefined;
  readonly action?: React.ReactNode;
}) {
  const origin = document.origin;
  return (
    <li className="grid gap-0.5 text-xs">
      <span className="flex min-w-0 items-center gap-2">
        <FileLock2Icon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
        {origin !== undefined && onOpen !== undefined ? (
          <button
            type="button"
            dir="auto"
            className="file-name min-w-0 flex-1 truncate text-start hover:underline focus-visible:outline-2"
            onClick={() => onOpen(origin)}
          >
            {label}
          </button>
        ) : (
          <bdi className="file-name min-w-0 flex-1 truncate">{label}</bdi>
        )}
        <span dir="ltr" className="shrink-0 font-mono text-2xs text-muted-foreground">
          {document.handle}
        </span>
        {action}
      </span>
      <SentLabelRow projectId={projectId} document={document} />
      <UnreadNote projectId={projectId} document={document} />
    </li>
  );
}

/**
 * What the AI company is told a sealed file is called, with the way to change it: the name with
 * the values in it masked, or a neutral label.
 */
function SentLabelRow({
  projectId,
  document,
}: {
  readonly projectId: string;
  readonly document: PrivacySealedDocument;
}) {
  const gt = useGT();
  const [busy, setBusy] = useState(false);
  // An older server does not say.
  if (document.label === undefined) return null;
  const neutral = document.neutralLabel === true;
  return (
    <span className="flex min-w-0 flex-wrap items-center gap-x-2 ps-5.5 text-2xs text-muted-foreground">
      {/* Shown whole: cut short, a right-to-left row keeps only the label's end, its file type. */}
      <span className="min-w-0 wrap-anywhere">
        {gt("Your AI company is told:")} <SentLabel label={document.label} />
      </span>
      <Button
        variant="link"
        size="xs"
        disabled={busy}
        onClick={() => {
          setBusy(true);
          void changeSealedDocuments({
            action: "setLabel",
            projectId,
            handle: document.handle,
            neutral: !neutral,
          })
            .catch(() =>
              toastManager.add({ type: "error", title: gt("The label could not be changed.") }),
            )
            .finally(() => setBusy(false));
        }}
      >
        {neutral ? gt("Send the name, masked") : gt("Send a neutral label")}
      </Button>
    </span>
  );
}

/**
 * A sealed folder as one row with its count, which opens to its files and their handles. Its
 * files go back together: one put back alone would be sealed again as it arrived.
 */
function SealedFolderRows({
  projectId,
  group,
  onOpen,
}: {
  readonly projectId: string;
  readonly group: SealedFolderGroup;
  readonly onOpen?: ((origin: string) => void) | undefined;
}) {
  const gt = useGT();
  const resolve = useMessages();
  const [open, setOpen] = useState(false);
  const sealed = group.documents.length;
  const unasked = group.documents.filter(({ document }) => document.unread !== undefined).length;
  const folder = { projectId, name: group.name, path: group.folder.path };
  return (
    <li className="grid gap-0.5">
      {/* When the name and count leave no room beside them, the button goes under them. */}
      <div className="flex min-w-0 flex-wrap items-center justify-end gap-x-2 text-xs">
        <button
          type="button"
          aria-expanded={open}
          className="flex min-w-0 flex-auto items-center gap-2 text-start focus-visible:outline-2"
          onClick={() => setOpen(!open)}
        >
          <ChevronRightIcon
            className={cn(
              "size-3.5 shrink-0 text-muted-foreground rtl:-scale-x-100",
              open && "rotate-90 rtl:rotate-90",
            )}
            aria-hidden
          />
          <FolderLockIcon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
          <bdi className="file-name min-w-0 truncate">{group.name}</bdi>
          <span className="min-w-0 truncate text-muted-foreground">
            {formatCommaList(
              [
                gt("{count, plural, one {{count} sealed} other {{count} sealed}}", {
                  count: sealed,
                  $context: "after a folder's name: how many of its files are sealed",
                }),
                ...(unasked === 0
                  ? []
                  : [
                      gt(
                        "{count, plural, one {{count} cannot be asked about yet} other {{count} cannot be asked about yet}}",
                        {
                          count: unasked,
                          $context:
                            "after a folder's name: how many of its sealed files have no text yet",
                        },
                      ),
                    ]),
                ...(group.left.length === 0
                  ? []
                  : [
                      gt("{count, plural, one {{count} not sealed} other {{count} not sealed}}", {
                        count: group.left.length,
                        $context:
                          "after a folder's name: how many of its files could not be sealed and stay readable",
                      }),
                    ]),
              ],
              resolve,
            )}
          </span>
        </button>
        <Button
          variant="ghost"
          size="xs"
          onClick={() => requestUnsealFolder({ ...folder, files: sealed })}
        >
          {gt("Unseal folder")}
        </Button>
      </div>
      {open ? (
        <ul className="grid gap-0.5 ps-5">
          {group.documents.map(({ document, path }) => (
            <SealedFileRow
              key={document.handle}
              projectId={projectId}
              label={path}
              document={document}
              onOpen={onOpen}
            />
          ))}
          {group.left.map((file) => (
            <li key={file.path} className="grid gap-0.5 text-xs">
              <span className="flex min-w-0 items-center gap-2">
                <FileWarningIcon
                  className="size-3.5 shrink-0 text-warning-foreground"
                  aria-hidden
                />
                <bdi dir="ltr" className="file-name min-w-0 flex-1 truncate">
                  {file.path}
                </bdi>
                <span className="shrink-0 text-warning-foreground">{gt("Not sealed")}</span>
              </span>
              <span className="ps-5.5 text-2xs text-muted-foreground">{file.message}</span>
            </li>
          ))}
          {sealed === 0 && group.left.length === 0 ? (
            <li className="text-2xs text-muted-foreground">
              {gt("No file yet. One that appears in this folder is sealed.")}
            </li>
          ) : null}
          {group.left.length === 0 ? null : (
            <li>
              <Button variant="ghost" size="xs" onClick={() => requestSealFolder(folder)}>
                {gt("Try sealing these again")}
              </Button>
            </li>
          )}
        </ul>
      ) : null}
    </li>
  );
}

/**
 * A folder's sealed files, each with the way back: sealed folders first, one row each, then the
 * files sealed one by one. The handle is what the AI calls the file.
 */
export function SealedFilesList({
  projectId,
  listing,
  onOpen,
}: {
  readonly projectId: string;
  readonly listing: PrivacySealedListing;
  /** Opens the place a file was moved out of, where its sealed state is shown. */
  readonly onOpen?: (origin: string) => void;
}) {
  const gt = useGT();
  const { folders, loose } = groupSealedListing(listing);
  return (
    <ul className="grid gap-0.5">
      {folders.map((group) => (
        <SealedFolderRows
          key={group.folder.path}
          projectId={projectId}
          group={group}
          onOpen={onOpen}
        />
      ))}
      {loose.map((document) => (
        <SealedFileRow
          key={document.handle}
          projectId={projectId}
          label={document.name}
          document={document}
          onOpen={onOpen}
          action={
            <Button variant="ghost" size="xs" onClick={() => unseal(projectId, document)}>
              {gt("Unseal")}
            </Button>
          }
        />
      ))}
    </ul>
  );
}

/** Shown in place of a file's contents while the file is sealed. */
export function SealedFilePlaceholder({
  projectId,
  document,
  folder,
}: {
  readonly projectId: string;
  readonly document: PrivacySealedDocument;
  /** The sealed folder the file lies in: its files go back together. */
  readonly folder?: { readonly name: string; readonly path: string; readonly files: number };
}) {
  const gt = useGT();
  return (
    <div
      role="status"
      className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 px-6 text-center text-sm text-muted-foreground"
    >
      <FileLock2Icon className="size-6" aria-hidden />
      <p>
        {document.unread !== undefined
          ? `${gt("This file is sealed. Your AI cannot open it, and cannot ask about it yet.")} ${unreadReason(document.unread, gt)}`
          : folder === undefined
            ? gt("This file is sealed. Your AI can ask about it, but cannot open it.")
            : gt(
                "This file is sealed with its folder, {name}. Your AI can ask about it, but cannot open it.",
                { name: folder.name },
              )}
      </p>
      {folder === undefined ? (
        <Button variant="outline" size="sm" onClick={() => unseal(projectId, document)}>
          {gt("Unseal")}
        </Button>
      ) : (
        <Button
          variant="outline"
          size="sm"
          onClick={() => requestUnsealFolder({ projectId, ...folder })}
        >
          {gt("Unseal folder")}
        </Button>
      )}
    </div>
  );
}

/**
 * Under the file list of a folder on another connected computer, where Seal and the sealed files
 * would be: says where they are, so their absence here is not taken for "nothing is sealed".
 */
export function SealingElsewhereNote({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const gt = useGT();
  const computer = useEnvironment(environmentId)?.label;
  return (
    <p className="shrink-0 border-t border-border/60 px-3 py-2 text-2xs text-muted-foreground">
      {computer === undefined
        ? gt(
            "This folder is on another computer. To seal its files or see what is sealed, open DoeDesk on that computer.",
          )
        : gt(
            "This folder is on {computer}. To seal its files or see what is sealed, open DoeDesk on that computer.",
            { computer },
          )}
    </p>
  );
}
