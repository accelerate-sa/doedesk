import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type {
  EnvironmentId,
  PrivacySealedProvenanceSpan,
  ScopedThreadRef,
  ThreadId,
} from "@t3tools/contracts";
import { useGT } from "gt-react";
import { FileCheck2Icon } from "lucide-react";
import { useState } from "react";

import { useComposerDraftStore } from "~/composerDraftStore";
import { changeSealedDocuments } from "~/privacy/privacyClient";
import { useThreadShell } from "~/state/entities";
import { usePrimaryEnvironmentId } from "~/state/environments";
import { Button } from "../ui/button";
import { Dialog, DialogPopup, DialogTitle } from "../ui/dialog";
import { SealedOutputViewer } from "./SealedOutputViewer";

const TEXT_TYPES: Readonly<Record<string, string>> = {
  md: "text/markdown",
  markdown: "text/markdown",
  csv: "text/csv",
  json: "application/json",
  html: "text/html",
  htm: "text/html",
};

const mimeTypeOf = (name: string): string =>
  TEXT_TYPES[name.split(".").at(-1)?.toLowerCase() ?? ""] ?? "text/plain";

const saveSealedOutput = (file: File): void => {
  const url = URL.createObjectURL(file);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = file.name;
  anchor.click();
  URL.revokeObjectURL(url);
};

/** A finished file read from the person's own server, with where its sealed values came from. */
export interface OpenedSealedOutput {
  readonly file: File;
  readonly text: string;
  readonly provenance: ReadonlyArray<PrivacySealedProvenanceSpan>;
  readonly hasTemplate: boolean | undefined;
}

export const openedSealedOutput = (
  name: string,
  result: {
    readonly output: string | null;
    readonly provenance?: ReadonlyArray<PrivacySealedProvenanceSpan>;
    readonly hasTemplate?: boolean;
  },
): OpenedSealedOutput | null =>
  typeof result.output === "string"
    ? {
        file: new File([result.output], name, { type: mimeTypeOf(name) }),
        text: result.output,
        provenance: result.provenance ?? [],
        hasTemplate: result.hasTemplate,
      }
    : null;

/** The dialog a finished file opens in, from a reply or from Settings. */
export function SealedOutputDialog({
  name,
  opened,
  onRevise,
  onClose,
}: {
  readonly name: string;
  readonly opened: OpenedSealedOutput;
  readonly onRevise?: () => void;
  readonly onClose: () => void;
}) {
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogPopup
        className="h-[min(85vh,52rem)] max-w-5xl overflow-hidden"
        showCloseButton={false}
      >
        <DialogTitle className="sr-only">{name}</DialogTitle>
        <SealedOutputViewer
          name={name}
          text={opened.text}
          file={opened.file}
          provenance={opened.provenance}
          {...(opened.hasTemplate === undefined ? {} : { hasTemplate: opened.hasTemplate })}
          {...(onRevise === undefined
            ? {}
            : {
                onRevise: () => {
                  onRevise();
                  onClose();
                },
              })}
          onSave={() => saveSealedOutput(opened.file)}
          onClose={onClose}
        />
      </DialogPopup>
    </Dialog>
  );
}

/** The card in a chat: finds the chat's folder, and whether its sealed files can be fetched here. */
export function SealedOutputCard({
  environmentId,
  threadId,
  name,
}: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly name: string;
}) {
  const primary = usePrimaryEnvironmentId();
  const threadRef = scopeThreadRef(environmentId, threadId);
  const projectId = useThreadShell(threadRef)?.projectId ?? null;
  // Sealed files are held by the primary environment; a chat on another machine cannot fetch one.
  const fetchable = environmentId === primary && projectId !== null;
  return (
    <SealedOutputFile
      projectId={fetchable ? projectId : null}
      name={name}
      {...(fetchable ? { threadRef } : {})}
    />
  );
}

/**
 * A file an agent finished with sealed values put in, in the reply where the person can open and
 * save it. Its text is read from the person's own DoeDesk server when asked for and held in this
 * page only: it is in no message, no attachment and no folder, so no agent can read it back.
 */
export function SealedOutputFile({
  projectId,
  name,
  threadRef,
}: {
  /** Null where the file cannot be fetched: it is then named, with nothing to press. */
  readonly projectId: string | null;
  readonly name: string;
  /** The chat whose message box Revise writes in. */
  readonly threadRef?: ScopedThreadRef;
}) {
  const gt = useGT();
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [opened, setOpened] = useState<OpenedSealedOutput | null>(null);

  const fetchFile = (then: (opened: OpenedSealedOutput) => void) => {
    if (projectId === null) return;
    setBusy(true);
    setProblem(null);
    void changeSealedDocuments({ action: "output", projectId, name })
      .then((result) => {
        const fetched = openedSealedOutput(name, result);
        if (fetched === null) {
          setProblem(gt("This finished file is no longer stored."));
          return;
        }
        then(fetched);
      })
      .catch(() => setProblem(gt("This finished file is no longer stored.")))
      .finally(() => setBusy(false));
  };

  // Only the file's name goes in the message box: its values stay out of the chat.
  const revise =
    threadRef === undefined
      ? undefined
      : () => {
          const store = useComposerDraftStore.getState();
          const existing = store.getComposerDraft(threadRef)?.prompt ?? "";
          const line = gt("Revise {name}: ", { name });
          store.setPrompt(threadRef, existing.trim().length === 0 ? line : `${existing}\n${line}`);
        };

  return (
    <div
      data-sealed-output={name}
      className="flex min-w-0 flex-col gap-2 rounded-xl border border-border/60 bg-card p-3"
    >
      <div className="flex min-w-0 items-center gap-2.5">
        <FileCheck2Icon className="size-4 shrink-0 text-icon-muted" aria-hidden />
        <div className="min-w-0 flex-1">
          <p className="text-2xs text-muted-foreground">{gt("Finished file")}</p>
          <p className="truncate text-sm font-medium text-foreground">
            <bdi>{name}</bdi>
          </p>
        </div>
        {projectId !== null ? (
          <>
            <Button
              variant="outline"
              size="sm"
              disabled={busy}
              onClick={() => fetchFile(setOpened)}
            >
              {gt("Open", { $context: "verb, opens a file" })}
            </Button>
            {revise === undefined ? null : (
              <Button variant="outline" size="sm" onClick={revise}>
                {gt("Revise", { $context: "button, asks the AI to change a finished file" })}
              </Button>
            )}
            <Button
              variant="outline"
              size="sm"
              disabled={busy}
              onClick={() => fetchFile((fetched) => saveSealedOutput(fetched.file))}
            >
              {gt("Save", { $context: "verb, saves a file to the person's computer" })}
            </Button>
          </>
        ) : null}
      </div>
      <p className="text-xs text-muted-foreground">
        {gt("This file holds the real values. Your AI cannot read it.")}
      </p>
      {problem !== null ? (
        <p role="alert" className="text-xs text-destructive">
          {problem}
        </p>
      ) : null}
      {opened !== null ? (
        <SealedOutputDialog
          name={name}
          opened={opened}
          {...(revise === undefined ? {} : { onRevise: revise })}
          onClose={() => setOpened(null)}
        />
      ) : null}
    </div>
  );
}
