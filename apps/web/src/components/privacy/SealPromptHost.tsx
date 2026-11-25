import { formatCommaList } from "@t3tools/client-runtime/list-format";
import type { PrivacyStatus } from "@t3tools/contracts";
import { useGT, useMessages } from "gt-react";
import { useId, useState } from "react";

import {
  changeSealedDocuments,
  configurePrivacyWorker,
  usePrivacyStatus,
} from "~/privacy/privacyClient";
import {
  closeSealPrompt,
  fileToBase64,
  type SealFilesRequest,
  type SealFolderRequest,
  type SealLabels,
  type SealCopy,
  type SealRequest,
  type UnsealFolderRequest,
  type UnsealRequest,
  useSealPrompt,
} from "~/privacy/sealPrompt";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { fileNameInText, pathInText } from "~/lib/fileNameText";

import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { toastManager } from "../ui/toast";
import { AccountRegionNotice, AccountRegionSelect, useAccountRegionChange } from "./AccountRegion";
import { unreadReason } from "./SealedFiles";
import { readByReadingServiceFirst } from "./sealedFiles.logic";
import {
  accountRegionLabel,
  HOSTED_WORKER_NOT_IN_REGION,
  HOSTED_WORKER_NOT_INCLUDED,
  hostedWorkerNotInRegion,
  MANAGED_WORKER_FOOTER,
  sealReader,
  sealReaderLines,
} from "./sealReader";
import { type WorkerForm, workerRequest } from "./SealedWorker.logic";
import { EMPTY_WORKER_FORM, WorkerServerFields } from "./WorkerServerFields";

/**
 * The one place a person seals or unseals a file, several or a folder, whichever screen they
 * asked from: says who will read the files and in which region, asks who should when nobody is
 * connected to read them, and reports the outcome.
 */
export function SealPromptHost() {
  const gt = useGT();
  const resolve = useMessages();
  const { prompt, open } = useSealPrompt();
  const privacy = usePrivacyStatus();
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [server, setServer] = useState<WorkerForm>(EMPTY_WORKER_FORM);
  // The person's choice of what the AI company is told the files are called, for this prompt.
  const [neutral, setNeutral] = useState(false);
  const neutralLabel = neutral ? { neutralLabel: true } : {};
  const status = privacy.kind === "ready" ? privacy.status : null;
  const reader = sealReader(status);
  // The account's region, before a file is read there, in every confirmation of DoeDesk Cloud's worker.
  const region =
    status !== null && reader?.kind === "hosted" ? <SealRegion status={status} /> : undefined;
  const close = () => {
    setProblem(null);
    setNeutral(false);
    closeSealPrompt();
  };

  const seal = (request: SealRequest) => {
    setBusy(true);
    setProblem(null);
    const sent =
      request.path !== undefined
        ? changeSealedDocuments({
            action: "addPath",
            projectId: request.projectId,
            path: request.path,
            move: true,
            ...neutralLabel,
          })
        : request.file === undefined
          ? Promise.reject(new Error("nothing to seal"))
          : fileToBase64(request.file).then((data) =>
              changeSealedDocuments({
                action: "add",
                projectId: request.projectId,
                name: request.name,
                data,
                ...neutralLabel,
              }),
            );
    void sent
      .then((result) => {
        if (!result.ok || result.handle === null) {
          setProblem(result.message ?? gt("The file could not be sealed."));
          return;
        }
        request.onSealed?.(result.handle);
        const unread = result.listing.documents.find(
          (document) => document.handle === result.handle,
        )?.unread;
        // An attached file is a copy. The server says whether it sealed the folder's own file.
        const movedOut = request.path !== undefined || (result.copy?.original ?? null) !== null;
        const staysReadable =
          !movedOut &&
          result.copy !== undefined &&
          (result.copy.readable.length > 0 || !result.copy.complete);
        toastManager.add(
          staysReadable
            ? {
                type: "warning",
                title: gt("Only the attached copy of {name} is sealed", {
                  name: fileNameInText(request.name),
                }),
                description: gt(
                  "The file in the folder stays readable by your AI. To seal it there, open the file list and choose Seal… on the file.",
                ),
              }
            : unread !== undefined
              ? {
                  type: "warning",
                  title: gt("{name} is sealed, but cannot be asked about yet", {
                    name: fileNameInText(request.name),
                  }),
                  description: `${unreadReason(unread, gt)} ${gt(
                    "It moved out of the folder, so your AI cannot open it.",
                  )}`,
                }
              : {
                  type: "success",
                  title: gt("{name} is sealed", { name: fileNameInText(request.name) }),
                  description: movedOut
                    ? gt(
                        "It moved out of the folder. Your AI can ask about it, but cannot open it.",
                      )
                    : gt(
                        "It was removed from your message. Your AI can ask about it, but cannot open it.",
                      ),
                },
        );
        close();
      })
      .catch(() => setProblem(gt("The file could not be sealed.")))
      .finally(() => setBusy(false));
  };

  const unseal = (request: UnsealRequest) => {
    setBusy(true);
    setProblem(null);
    void changeSealedDocuments({
      action: "remove",
      projectId: request.projectId,
      handle: request.handle,
    })
      .then((result) => {
        const unsealed = result.unsealed;
        if (!result.ok || unsealed === undefined) {
          setProblem(result.message ?? gt("The file could not be unsealed."));
          return;
        }
        const name = fileNameInText(unsealed.name);
        toastManager.add(
          unsealed.path === null
            ? {
                type: "success",
                title: gt("{name} is no longer sealed", { name }),
                description: gt(
                  "DoeDesk no longer keeps a copy. The file on your computer is unchanged.",
                ),
              }
            : unsealed.renamed
              ? {
                  type: "warning",
                  title: gt("{name} is no longer sealed", { name }),
                  description: gt(
                    "Another file named {name} is in the folder now, so the unsealed file was saved as {restoredName}.",
                    {
                      name,
                      restoredName: fileNameInText(
                        unsealed.path.split(/[\\/]/).at(-1) ?? unsealed.path,
                      ),
                    },
                  ),
                }
              : { type: "success", title: gt("{name} is back in the folder", { name }) },
        );
        close();
      })
      .catch(() => setProblem(gt("The file could not be unsealed.")))
      .finally(() => setBusy(false));
  };

  /** What is said of a file that came as a copy: what is sealed, and what stays in the folder. */
  const copyLines = (copy: SealCopy): ReadonlyArray<string> => {
    if (copy === "pending") return [gt("Looking for this file in the folder…")];
    const there = gt("To seal a file there, open the file list and choose Seal… on the file.");
    if (copy === "unknown" || (copy.original === null && copy.readable.length === 0)) {
      return copy !== "unknown" && copy.complete
        ? [
            gt(
              "The file is removed from your message. The copy on your computer stays where it is.",
            ),
          ]
        : [
            gt(
              "Only the copy attached to your message is sealed. DoeDesk could not look through the whole folder, so if this file is also there, it stays readable by your AI.",
            ),
            there,
          ];
    }
    if (copy.original !== null) {
      return [
        gt(
          "This file is in the folder, at {path}, and that is the file that is sealed: it moves out of the folder so your AI cannot open it. Unseal puts it back.",
          { path: pathInText(copy.original) },
        ),
      ];
    }
    const shown = copy.readable.slice(0, 3).map(pathInText);
    return [
      gt("Only the copy attached to your message is sealed."),
      gt(
        "{count, plural, one {A file in the folder stays readable by your AI: {files}.} other {{count} files in the folder stay readable by your AI: {files}.}}",
        { count: copy.readable.length, files: formatCommaList(shown, resolve) },
      ),
      there,
    ];
  };

  /** Names a few of the files that were not sealed, for a toast. */
  const namesOf = (failed: ReadonlyArray<{ readonly name: string }>) =>
    formatCommaList(
      failed.slice(0, 3).map((file) => fileNameInText(file.name)),
      resolve,
    );

  const sealFiles = (request: SealFilesRequest) => {
    setBusy(true);
    setProblem(null);
    void changeSealedDocuments({
      action: "addPaths",
      projectId: request.projectId,
      paths: request.paths,
      ...neutralLabel,
    })
      .then((result) => {
        const batch = result.batch;
        if (!result.ok || batch === undefined || batch.sealed === 0) {
          setProblem(
            batch?.failed[0]?.message ?? result.message ?? gt("The files could not be sealed."),
          );
          return;
        }
        const unasked = batch.unread ?? 0;
        toastManager.add(
          batch.failed.length === 0
            ? {
                type: unasked === 0 ? "success" : "warning",
                title: gt(
                  "{count, plural, one {{count} file is sealed} other {{count} files are sealed}}",
                  { count: batch.sealed },
                ),
                description:
                  unasked === 0
                    ? gt(
                        "They moved out of the folder. Your AI can ask about them, but cannot open them.",
                      )
                    : gt(
                        "{count, plural, one {They moved out of the folder, so your AI cannot open them. {count} of them cannot be asked about yet; the list of sealed files says why.} other {They moved out of the folder, so your AI cannot open them. {count} of them cannot be asked about yet; the list of sealed files says why.}}",
                        { count: unasked },
                      ),
              }
            : {
                type: "warning",
                title: gt(
                  "{count, plural, one {{count} file is sealed} other {{count} files are sealed}}",
                  { count: batch.sealed },
                ),
                description: gt(
                  "{count, plural, one {{count} file could not be sealed and stays in the folder: {names}} other {{count} files could not be sealed and stay in the folder: {names}}}",
                  { count: batch.failed.length, names: namesOf(batch.failed) },
                ),
              },
        );
        close();
      })
      .catch(() => setProblem(gt("The files could not be sealed.")))
      .finally(() => setBusy(false));
  };

  const sealFolder = (request: SealFolderRequest) => {
    setBusy(true);
    setProblem(null);
    void changeSealedDocuments({
      action: "sealFolder",
      projectId: request.projectId,
      path: request.path,
      ...neutralLabel,
    })
      .then((result) => {
        const batch = result.batch;
        if (!result.ok || batch === undefined) {
          setProblem(result.message ?? gt("The folder could not be sealed."));
          return;
        }
        const sealed = gt(
          "{count, plural, =0 {No file was sealed yet.} one {{count} file moved out of the folder.} other {{count} files moved out of the folder.}} A file that appears in it later is sealed too.",
          { count: batch.sealed },
        );
        toastManager.add(
          batch.failed.length === 0
            ? {
                type: "success",
                title: gt("The folder {name} is sealed", { name: fileNameInText(request.name) }),
                description: sealed,
              }
            : {
                type: "warning",
                title: gt("The folder {name} is sealed", { name: fileNameInText(request.name) }),
                description: `${sealed} ${gt(
                  "{count, plural, one {{count} file could not be sealed and stays readable there: {names}} other {{count} files could not be sealed and stay readable there: {names}}}",
                  { count: batch.failed.length, names: namesOf(batch.failed) },
                )}`,
              },
        );
        close();
      })
      .catch(() => setProblem(gt("The folder could not be sealed.")))
      .finally(() => setBusy(false));
  };

  const unsealFolder = (request: UnsealFolderRequest) => {
    setBusy(true);
    setProblem(null);
    void changeSealedDocuments({
      action: "unsealFolder",
      projectId: request.projectId,
      path: request.path,
    })
      .then((result) => {
        const unsealed = result.folderUnsealed;
        if (!result.ok || unsealed === undefined) {
          setProblem(result.message ?? gt("The folder could not be unsealed."));
          return;
        }
        const back = gt(
          "{count, plural, =0 {It held no sealed file.} one {{count} file is back in the folder.} other {{count} files are back in the folder.}}",
          { count: unsealed.restored },
        );
        const renamed =
          unsealed.renamed === 0
            ? ""
            : ` ${gt(
                "{count, plural, one {{count} was saved beside a file that had taken its name.} other {{count} were saved beside files that had taken their names.}}",
                { count: unsealed.renamed },
              )}`;
        toastManager.add(
          unsealed.failed.length === 0
            ? {
                type: unsealed.renamed === 0 ? "success" : "warning",
                title: gt("The folder {name} is no longer sealed", {
                  name: fileNameInText(request.name),
                }),
                description: `${back}${renamed}`,
              }
            : {
                type: "warning",
                title: gt("The folder {name} is no longer sealed", {
                  name: fileNameInText(request.name),
                }),
                description: `${back}${renamed} ${gt(
                  "{count, plural, one {{count} file could not be put back and stays sealed: {names}} other {{count} files could not be put back and stay sealed: {names}}}",
                  { count: unsealed.failed.length, names: namesOf(unsealed.failed) },
                )}`,
              },
        );
        close();
      })
      .catch(() => setProblem(gt("The folder could not be unsealed.")))
      .finally(() => setBusy(false));
  };

  const connectServer = () => {
    const made = workerRequest(server);
    if ("problem" in made) {
      setProblem(resolve(made.problem));
      return;
    }
    setBusy(true);
    setProblem(null);
    // On success the status changes, and this dialog goes on to the sealing question.
    void configurePrivacyWorker(made.request)
      .then((result) => {
        if (!result.ok) setProblem(result.message ?? gt("The worker could not be connected."));
        else setServer(EMPTY_WORKER_FORM);
      })
      .catch(() => setProblem(gt("The worker could not be connected.")))
      .finally(() => setBusy(false));
  };

  // A signed-in person who chose nobody to read sealed files can take DoeDesk Cloud's worker here.
  const chooseCloudWorker = () => {
    setBusy(true);
    setProblem(null);
    // On success the status changes, and this dialog goes on to the sealing question.
    void configurePrivacyWorker({ kind: "cloud" })
      .then((result) => {
        if (!result.ok) setProblem(result.message ?? gt("The worker could not be connected."));
      })
      .catch(() => setProblem(gt("The worker could not be connected.")))
      .finally(() => setBusy(false));
  };

  const content = (() => {
    if (prompt === null) return null;
    if (prompt.kind === "unseal") {
      const { request } = prompt;
      return {
        title: gt("Unseal {name}?", { name: fileNameInText(request.name) }),
        lines: [
          request.movedOut
            ? gt("The file goes back to the folder, where your AI can open it.")
            : gt("DoeDesk removes its sealed copy. The file on your computer is unchanged."),
        ],
        action: (
          <Button disabled={busy} onClick={() => unseal(request)}>
            {gt("Unseal")}
          </Button>
        ),
      };
    }
    if (prompt.kind === "unsealFolder") {
      const { request } = prompt;
      return {
        title: gt("Unseal the folder {name}?", { name: fileNameInText(request.name) }),
        lines: [
          gt(
            "{count, plural, =0 {The folder holds no sealed file.} one {{count} file goes back to the folder, where your AI can open it.} other {{count} files go back to the folder, where your AI can open them.}} A file added to it later is no longer sealed.",
            { count: request.files },
          ),
        ],
        action: (
          <Button disabled={busy} onClick={() => unsealFolder(request)}>
            {busy ? gt("Unsealing…") : gt("Unseal")}
          </Button>
        ),
      };
    }
    if (status === null || reader === null) {
      const ownServer = (
        <form
          className="grid gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            connectServer();
          }}
        >
          <WorkerServerFields
            form={server}
            disabled={busy}
            showReasoningEffort={false}
            onChange={(change) => setServer((current) => ({ ...current, ...change }))}
          />
        </form>
      );
      const connect = (
        <Button disabled={busy} onClick={connectServer}>
          {busy ? gt("Checking…") : gt("Connect")}
        </Button>
      );
      // An account that has DoeDesk Cloud's worker: it needs nothing set up, and their own server is the other choice.
      if (
        status?.mode === "cloud" &&
        status.hostedWorkerEntitled === true &&
        !hostedWorkerNotInRegion(status)
      ) {
        return {
          title: gt("Choose who reads sealed files"),
          lines: [
            gt(
              "A sealed file is read by a separate model, in place of your AI company. On your own computer or company server, each file is read on hardware you control.",
            ),
            gt(
              "Any server that supports the Chat Completions or Responses format works; with a hosted service you have a key for, the file goes to that service.",
            ),
          ],
          form: (
            <div className="grid gap-3 text-start">
              {ownServer}
              <p className="text-sm text-muted-foreground">
                {gt(
                  "No model hardware of your own yet? DoeDesk Cloud's worker is managed for your organization and needs nothing set up. The next step says where a file's text is sent, before anything is sealed.",
                )}
              </p>
              <div>
                <Button variant="outline" disabled={busy} onClick={chooseCloudWorker}>
                  {gt("Use DoeDesk Cloud's worker")}
                </Button>
              </div>
            </div>
          ),
          action: connect,
        };
      }
      return {
        title: gt("Connect your own server to seal files"),
        lines: [
          ...(status?.worker?.notIncluded === true ? [resolve(HOSTED_WORKER_NOT_INCLUDED)] : []),
          ...(hostedWorkerNotInRegion(status) ? [resolve(HOSTED_WORKER_NOT_IN_REGION)] : []),
          gt(
            "A sealed file is read by a model on your own computer or company server, in place of your AI company, so each file is read on hardware you control.",
          ),
          gt(
            "Any server that supports the Chat Completions or Responses format works. A hosted service you have a key for works too, and the file then goes to that service.",
          ),
        ],
        form: (
          <div className="grid gap-3 text-start">
            {ownServer}
            <p className="text-xs text-muted-foreground">{resolve(MANAGED_WORKER_FOOTER)}</p>
          </div>
        ),
        action: connect,
      };
    }
    if (prompt.kind === "sealFiles" || prompt.kind === "sealFolder") {
      const { inspected } = prompt;
      const folder = prompt.kind === "sealFolder";
      const title = folder
        ? gt("Seal the folder {name}?", { name: fileNameInText(prompt.request.name) })
        : gt("{count, plural, one {Seal {count} file?} other {Seal {count} files?}}", {
            count: prompt.request.paths.length,
          });
      // The confirmation states the count, so it waits for the count.
      if (inspected === null) {
        return {
          title,
          lines: [gt("Counting the files…")],
          action: (
            <Button disabled>
              {gt("Seal", { $context: "button that confirms sealing a file" })}
            </Button>
          ),
        };
      }
      const confirm =
        prompt.kind === "sealFolder"
          ? () => sealFolder(prompt.request)
          : () => sealFiles(prompt.request);
      return {
        title,
        lines: [
          ...(sealReaderLines(
            status,
            { kind: folder ? "folder" : "files", count: inspected.files },
            inspected.readFirst,
            resolve,
          ) ?? []),
          folder
            ? gt(
                "The files move out of the folder so your AI cannot open them, and a file that appears in it later is sealed too, whoever put it there. Unseal folder puts every file back.",
              )
            : gt(
                "The files move out of the folder so your AI cannot open them. Unseal puts each one back.",
              ),
          ...(inspected.unsupported > 0
            ? [
                gt(
                  "{count, plural, one {{count} file is of a kind DoeDesk cannot read. It is sealed too, so your AI cannot open it, and cannot ask about it.} other {{count} files are of a kind DoeDesk cannot read. They are sealed too, so your AI cannot open them, and cannot ask about them.}}",
                  { count: inspected.unsupported },
                ),
              ]
            : []),
          ...(inspected.inGit > 0
            ? [
                gt(
                  "{count, plural, one {Git still holds earlier versions of {count} of these files, and your AI can read those. Git will also show it as deleted until you unseal it.} other {Git still holds earlier versions of {count} of these files, and your AI can read those. Git will also show them as deleted until you unseal them.}}",
                  { count: inspected.inGit },
                ),
              ]
            : []),
          ...(prompt.seenByChats
            ? [
                gt(
                  "Chats in this folder ran while your AI could open these files. Anything they read from them was already sent to your AI company, and sealing cannot take that back.",
                ),
              ]
            : []),
        ],
        form: (
          <>
            {region}
            <SealLabelChoice
              subject={folder ? "folder" : "files"}
              count={inspected.files + inspected.unsupported}
              labels={prompt.labels}
              neutral={neutral}
              onNeutralChange={setNeutral}
            />
          </>
        ),
        action: (
          <Button disabled={busy} onClick={confirm}>
            {busy
              ? gt("Sealing…")
              : gt("Seal", { $context: "button that confirms sealing a file" })}
          </Button>
        ),
      };
    }
    const { request } = prompt;
    return {
      title: gt("Seal {name}?", { name: fileNameInText(request.name) }),
      lines: [
        // A file DoeDesk cannot read is sealed and sent to nobody, so nothing is said of a reader.
        ...(prompt.unreadable
          ? []
          : (sealReaderLines(
              status,
              { kind: "file" },
              readByReadingServiceFirst(request.name) ? 1 : 0,
              resolve,
            ) ?? [])),
        ...(request.path !== undefined
          ? [gt("The file moves out of the folder so your AI cannot open it. Unseal puts it back.")]
          : copyLines(prompt.copy ?? "unknown")),
        ...(prompt.unreadable
          ? [
              gt(
                "DoeDesk cannot read this kind of file, so your AI will not be able to ask about it. Sealing still moves it out of the folder, so your AI can no longer open it there.",
              ),
            ]
          : []),
        ...(prompt.inGit
          ? [
              gt(
                "Git still holds earlier versions of this file, and your AI can read those. Git will also show the file as deleted until you unseal it.",
              ),
            ]
          : []),
        ...(prompt.seenByChats
          ? [
              gt(
                "Chats in this folder ran while your AI could open this file. Anything they read from it was already sent to your AI company, and sealing cannot take that back.",
              ),
            ]
          : []),
      ],
      form: (
        <>
          {prompt.unreadable ? null : region}
          <SealLabelChoice
            subject="file"
            count={1}
            labels={prompt.labels}
            neutral={neutral}
            onNeutralChange={setNeutral}
          />
        </>
      ),
      action: (
        // Not before the folder was looked through: the words above say what will be sealed.
        <Button disabled={busy || prompt.copy === "pending"} onClick={() => seal(request)}>
          {gt("Seal", { $context: "button that confirms sealing a file" })}
        </Button>
      ),
    };
  })();

  return (
    <AlertDialog
      open={open && content !== null}
      onOpenChange={(next) => {
        if (!next && !busy) close();
      }}
      onOpenChangeComplete={(next) => {
        if (!next && !useSealPrompt.getState().open) useSealPrompt.setState({ prompt: null });
      }}
    >
      <AlertDialogPopup>
        <AlertDialogHeader>
          <AlertDialogTitle>{content?.title}</AlertDialogTitle>
          <AlertDialogDescription>
            {content?.lines.map((line) => (
              <span key={line} className="mt-2 block first:mt-0">
                {line}
              </span>
            ))}
          </AlertDialogDescription>
          {content !== null && "form" in content ? (content.form ?? null) : null}
          {problem !== null ? (
            <p role="alert" className="text-sm text-destructive">
              {problem}
            </p>
          ) : null}
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogClose render={<Button variant="outline" disabled={busy} />}>
            {gt("Cancel")}
          </AlertDialogClose>
          {content?.action}
        </AlertDialogFooter>
      </AlertDialogPopup>
    </AlertDialog>
  );
}

/** The file type a name ends with, as a neutral label keeps it. */
const typeOf = (name: string): string => /\.[A-Za-z0-9]{1,8}$/u.exec(name)?.[0].toLowerCase() ?? "";

/**
 * What the AI company will be told the files are called, shown before the person confirms, with
 * the choice to send a neutral label instead. Masking hides who a name is about, not what the
 * file is about: a diagnosis or a deal's name in a file name is still sent.
 */
function SealLabelChoice({
  subject,
  count,
  labels,
  neutral,
  onNeutralChange,
}: {
  readonly subject: "file" | "files" | "folder";
  /** How many files are sealed now. */
  readonly count: number;
  readonly labels: SealLabels;
  readonly neutral: boolean;
  readonly onNeutralChange: (neutral: boolean) => void;
}) {
  const gt = useGT();
  const checkboxId = useId();
  // A folder with no file yet has no name to show: the choice still holds for what arrives.
  if (labels === null || (labels.length === 0 && subject !== "folder")) return null;
  // A handle reads left to right inside an Arabic sentence.
  const example = `\u2066DOC_1${typeOf(labels[0]?.name ?? "")}\u2069`;
  const more = Math.max(0, count - labels.length);
  return (
    <div className="grid gap-2 text-start text-sm">
      {labels.length === 0 ? null : (
        <>
          <p>
            {subject === "file"
              ? gt(
                  "Your AI company is told what the file is called, so your AI can tell your files apart. This is the name it will receive:",
                )
              : gt(
                  "Your AI company is told what each file is called, so your AI can tell your files apart. These are the names it will receive:",
                )}
          </p>
          <ul className="grid gap-0.5" aria-label={gt("Names your AI company will receive")}>
            {labels.map((entry) => (
              <li key={entry.name} className="min-w-0 truncate font-mono text-xs" dir="ltr">
                <bdi>
                  {/* oxlint-disable-next-line t3code/no-untranslated-copy -- a handle and a file type, written the same in every language */}
                  {neutral || entry.label === null ? `DOC_…${typeOf(entry.name)}` : entry.label}
                </bdi>
              </li>
            ))}
            {more > 0 ? (
              <li className="text-xs text-muted-foreground">
                {gt("{count, plural, one {and {count} more} other {and {count} more}}", {
                  count: more,
                })}
              </li>
            ) : null}
          </ul>
          <p className="text-xs text-muted-foreground">
            {labels.some((entry) => entry.label === null) && !neutral
              ? gt(
                  "A name that cannot be checked now is sent as a neutral label until it has been checked.",
                )
              : gt(
                  "A person's or company's name or an ID number found in the name is replaced with a stand-in. Everything else is sent as it is, such as a date, a diagnosis or the name of a deal.",
                )}
          </p>
        </>
      )}
      <div className="flex items-start gap-2.5">
        <span className="flex h-[1lh] shrink-0 items-center">
          <Checkbox
            id={checkboxId}
            checked={neutral}
            onCheckedChange={(checked) => onNeutralChange(checked === true)}
          />
        </span>
        <label htmlFor={checkboxId}>
          {subject === "folder"
            ? gt(
                "Send only a neutral label for every file in this folder, now and later: a number and the file type, such as {example}",
                { example },
              )
            : subject === "files"
              ? gt(
                  "Send only a neutral label for these files: a number and the file type, such as {example}",
                  { example },
                )
              : gt("Send only a neutral label: a number and the file type, such as {example}", {
                  example,
                })}
        </label>
      </div>
    </div>
  );
}

/**
 * The account's region, before a file is read there: a region guessed from where the account
 * was made can be put right here, without a trip to Settings.
 */
function SealRegion({ status }: { readonly status: PrivacyStatus }) {
  const gt = useGT();
  const resolve = useMessages();
  const change = useAccountRegionChange(status);
  const [changing, setChanging] = useState(false);
  return (
    <div className="grid gap-2 text-start">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        {changing ? (
          <>
            <span>{gt("Account region")}</span>
            <AccountRegionSelect change={change} />
          </>
        ) : (
          <>
            <span>
              {change.region === null
                ? gt("Account region: not known yet")
                : gt("Account region: {regionLabel}", {
                    regionLabel: accountRegionLabel(change.region, resolve),
                  })}
            </span>
            <Button variant="link" size="sm" onClick={() => setChanging(true)}>
              {gt("Change")}
            </Button>
          </>
        )}
      </div>
      <AccountRegionNotice change={change} />
    </div>
  );
}
