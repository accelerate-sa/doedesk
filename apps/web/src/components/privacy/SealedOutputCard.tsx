import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { useGT } from "gt-react";
import { FileCheck2Icon } from "lucide-react";
import { useState } from "react";

import { changeSealedDocuments } from "~/privacy/privacyClient";
import { useThreadShell } from "~/state/entities";
import { usePrimaryEnvironmentId } from "~/state/environments";
import { AttachmentFilePreview } from "../files/AttachmentFilePreview";
import { Button } from "../ui/button";
import { Dialog, DialogPopup, DialogTitle } from "../ui/dialog";

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

const save = (file: File): void => {
  const url = URL.createObjectURL(file);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = file.name;
  anchor.click();
  URL.revokeObjectURL(url);
};

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
  const projectId = useThreadShell(scopeThreadRef(environmentId, threadId))?.projectId ?? null;
  // Sealed files are held by the primary environment; a chat on another machine cannot fetch one.
  return <SealedOutputFile projectId={environmentId === primary ? projectId : null} name={name} />;
}

/**
 * A file an agent finished with sealed values put in, in the reply where the person can open and
 * save it. Its text is read from the person's own DoeDesk server when asked for and held in this
 * page only: it is in no message, no attachment and no folder, so no agent can read it back.
 */
export function SealedOutputFile({
  projectId,
  name,
}: {
  /** Null where the file cannot be fetched: it is then named, with nothing to press. */
  readonly projectId: string | null;
  readonly name: string;
}) {
  const gt = useGT();
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [opened, setOpened] = useState<File | null>(null);

  const fetchFile = (then: (file: File) => void) => {
    if (projectId === null) return;
    setBusy(true);
    setProblem(null);
    void changeSealedDocuments({ action: "output", projectId, name })
      .then((result) => {
        if (typeof result.output !== "string") {
          setProblem(gt("This finished file is no longer stored."));
          return;
        }
        then(new File([result.output], name, { type: mimeTypeOf(name) }));
      })
      .catch(() => setProblem(gt("This finished file is no longer stored.")))
      .finally(() => setBusy(false));
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
            <Button variant="outline" size="sm" disabled={busy} onClick={() => fetchFile(save)}>
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
        <Dialog
          open
          onOpenChange={(open) => {
            if (!open) setOpened(null);
          }}
        >
          <DialogPopup
            className="h-[min(85vh,52rem)] max-w-4xl overflow-hidden"
            showCloseButton={false}
          >
            <DialogTitle className="sr-only">{name}</DialogTitle>
            <AttachmentFilePreview
              name={name}
              mimeType={opened.type}
              sizeBytes={opened.size}
              file={opened}
              origin={gt("Finished file")}
              onClose={() => setOpened(null)}
            />
          </DialogPopup>
        </Dialog>
      ) : null}
    </div>
  );
}
