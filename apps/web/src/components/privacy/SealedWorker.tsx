import type { PrivacyEgressPolicy, PrivacyStatus, PrivacyWorkerKind } from "@t3tools/contracts";
import { serverSentence } from "@t3tools/shared/serverSentencesCopy";
import { useClientSettings } from "~/hooks/useSettings";
import { formatRecordTimestamp } from "~/timestampFormat";
import { msg, useGT, useLocale, useMessages } from "gt-react";
import { useState } from "react";

import { SEALED_ARTICLE_URL } from "~/branding";
import {
  changeSealedDocuments,
  configurePrivacyWorker,
  setPrivacyPreference,
  useSealedAnswers,
  useSealedDocuments,
} from "~/privacy/privacyClient";
import { SettingsRow, SettingsSection } from "../settings/settingsLayout";
import { useSearchableSetting } from "../settings/settingsSearch";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { AccountRegionNotice, AccountRegionSelect, useAccountRegionChange } from "./AccountRegion";
import { SealedFilesList } from "./SealedFiles";
import {
  accountRegionLabel,
  answerRouteLabel,
  hostedWorkerNotInRegion,
  managedWorkerNote,
  servedFromLabel,
} from "./sealReader";
import {
  describeClearAnswer,
  EGRESS_CHOICES,
  egressOf,
  parseHosts,
  WORKER_CHOICES,
  workerChoicesFor,
  workerDisclosure,
  type WorkerForm,
  workerOf,
  workerRequest,
} from "./SealedWorker.logic";
import { WorkerServerFields } from "./WorkerServerFields";

const SECOND_CHECK = msg(
  "The worker also reads each message before it is masked, to catch case numbers, districts and other details that point to a person. Messages reach the worker unmasked, and replies start later.",
);

/** Who runs the model that reads sealed documents, and where those documents go. */
export function WorkerSection({ status }: { readonly status: PrivacyStatus }) {
  const gt = useGT();
  const resolve = useMessages();
  const searchableSetting = useSearchableSetting();
  const worker = workerOf(status);
  const [form, setForm] = useState<WorkerForm>({
    kind: worker.kind,
    apiKey: "",
    baseUrl: worker.address ?? "",
    model: worker.model ?? "",
    driver: worker.driver ?? "chatCompletions",
    reasoningEffort: worker.reasoningEffort ?? "",
  });
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const regionChange = useAccountRegionChange(status);
  const signedIn = status.mode === "cloud";
  const choices = workerChoicesFor(status);
  // A choice that stopped being offered while this was open reads as what is in use.
  const kind = choices.some((choice) => choice.value === form.kind) ? form.kind : worker.kind;
  const chosen = WORKER_CHOICES.find((choice) => choice.value === kind);
  const note = managedWorkerNote(status, resolve);
  const set = (change: Partial<WorkerForm>) => setForm((current) => ({ ...current, ...change }));
  // Promise chains rather than try/finally, which React Compiler cannot optimize.
  const connect = () => {
    const made = workerRequest({ ...form, kind });
    if ("problem" in made) {
      setProblem(resolve(made.problem));
      return;
    }
    setBusy(true);
    setProblem(null);
    void configurePrivacyWorker(made.request)
      .then((result) => {
        if (!result.ok) {
          setProblem(
            result.message === null
              ? gt("The worker could not be connected.")
              : serverSentence(result.message, resolve),
          );
          return;
        }
        // A server may refuse the reasoning setting typed and be connected with another.
        set({ apiKey: "", reasoningEffort: result.status.worker?.reasoningEffort ?? "" });
      })
      .catch(() => setProblem(gt("The worker could not be connected.")))
      .finally(() => setBusy(false));
  };
  return (
    <SettingsSection {...searchableSetting("privacy-worker")} title={gt("Who reads sealed files")}>
      <SettingsRow
        title={gt("Reading model", { $context: "the model that reads sealed files" })}
        description={gt(
          "A separate model reads sealed files so DoeDesk does not send them to your AI company; yes-or-no answers and choices from a list still reach it. Run it on your own computer or company server and each file is read on hardware you control.",
        )}
        control={
          <Select
            value={kind}
            disabled={busy}
            onValueChange={(value) => {
              if (value === null) return;
              setProblem(null);
              set({ kind: value as WorkerForm["kind"] });
            }}
          >
            <SelectTrigger aria-label={gt("Who reads sealed files")} className="w-44" size="sm">
              <SelectValue>{chosen === undefined ? null : resolve(chosen.label)}</SelectValue>
            </SelectTrigger>
            <SelectPopup>
              {choices.map((choice) => (
                <SelectItem key={choice.value} value={choice.value}>
                  {resolve(choice.label)}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        }
      />
      <div className="grid gap-2 px-4 py-3">
        <p className="text-sm">{workerDisclosure({ ...worker, kind }, status, resolve)}</p>
        {kind === "custom" ? (
          <form
            className="grid gap-2 sm:max-w-sm"
            onSubmit={(event) => {
              event.preventDefault();
              connect();
            }}
          >
            <p className="text-xs text-muted-foreground">
              {gt(
                "Any server that supports the Chat Completions or Responses format works, including a hosted service you have a key for.",
              )}
            </p>
            <WorkerServerFields form={form} onChange={set} />
            {signedIn ? (
              <p className="text-xs text-muted-foreground">
                {gt(
                  "Your DoeDesk Cloud region is not used while My own server is selected. PDFs and images are still read by DoeDesk Cloud in Saudi Arabia when sealed.",
                )}
              </p>
            ) : null}
          </form>
        ) : null}
        {problem !== null ? <p className="text-sm text-destructive">{problem}</p> : null}
        <div className="flex flex-wrap items-center gap-3">
          {kind === worker.kind && kind !== "custom" ? null : (
            <Button size="sm" disabled={busy} onClick={connect}>
              {busy ? gt("Checking…") : kind === "off" ? gt("Disconnect") : gt("Connect")}
            </Button>
          )}
          {worker.kind !== "off" ? (
            <p className="flex flex-wrap gap-x-1 text-xs text-muted-foreground">
              {worker.kind === "cloud" && worker.region != null ? (
                <span>
                  {gt("Region: {regionLabel}.", {
                    regionLabel: accountRegionLabel(worker.region, resolve),
                  })}
                </span>
              ) : null}
              <span>
                {worker.available && worker.busy != null
                  ? gt(
                      "{count, plural, one {Busy, {count} waiting.} other {Busy, {count} waiting.}}",
                      {
                        count: worker.busy.waiting,
                        $context: "the worker model is answering other people first",
                      },
                    )
                  : worker.available
                    ? gt("Connected.", { $context: "the worker model answers" })
                    : worker.kind === "cloud" && hostedWorkerNotInRegion(status)
                      ? gt("Not available in this region yet.", {
                          $context: "DoeDesk Cloud offers no worker model in the account's region",
                        })
                      : worker.kind === "cloud"
                        ? gt(
                            "Not answering. DoeDesk does not route sealed files to another region.",
                          )
                        : gt("Not answering.", { $context: "the worker model does not answer" })}
              </span>
              {worker.model === null ? null : (
                <span>{gt("Model: {model}.", { model: worker.model })}</span>
              )}
              {worker.servedFrom === null ? null : worker.kind === "cloud" ? (
                <span>
                  {gt("Last answer came from {servedFrom}.", {
                    servedFrom: servedFromLabel(worker.servedFrom, resolve),
                  })}
                </span>
              ) : (
                <span>
                  {gt("Its last answer came from region {region}.", { region: worker.servedFrom })}
                </span>
              )}
            </p>
          ) : null}
        </div>
        {worker.kind === "cloud" && kind === "cloud" ? (
          <div className="grid gap-2">
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <span>{gt("Account region")}</span>
              <AccountRegionSelect change={regionChange} />
            </div>
            <AccountRegionNotice change={regionChange} />
          </div>
        ) : null}
        {note === null ? null : <p className="text-xs text-muted-foreground">{note}</p>}
      </div>
      {worker.kind !== "off" && status.active ? (
        <SettingsRow
          title={gt("Second check before masking")}
          description={resolve(SECOND_CHECK)}
          control={
            <Switch
              checked={status.secondPass === true}
              aria-label={gt("Let the worker check messages before they are masked")}
              onCheckedChange={(checked) =>
                void setPrivacyPreference({ kind: "secondPass", on: Boolean(checked) })
              }
            />
          }
        />
      ) : null}
    </SettingsSection>
  );
}

/** Which hosts other than AI hosts an agent's tools may reach. */
export function EgressSection({ status }: { readonly status: PrivacyStatus }) {
  const gt = useGT();
  const resolve = useMessages();
  const searchableSetting = useSearchableSetting();
  const egress = egressOf(status);
  const [busy, setBusy] = useState(false);
  const [hosts, setHosts] = useState(egress.hosts.join(", "));
  const chosen = EGRESS_CHOICES.find((choice) => choice.value === egress.policy);
  const masking = status.mode !== "off";
  const save = (policy: PrivacyEgressPolicy, list: ReadonlyArray<string>) => {
    setBusy(true);
    return setPrivacyPreference({ kind: "egress", policy, hosts: [...list] }).finally(() =>
      setBusy(false),
    );
  };
  return (
    <SettingsSection {...searchableSetting("privacy-egress")} title={gt("Other hosts")}>
      <SettingsRow
        title={gt("Hosts agents' tools may reach")}
        description={chosen === undefined ? undefined : resolve(chosen.description)}
        control={
          <Select
            value={egress.policy}
            disabled={busy || !masking}
            onValueChange={(value) => {
              if (value === null || value === egress.policy) return;
              void save(value as PrivacyEgressPolicy, parseHosts(hosts));
            }}
          >
            <SelectTrigger
              aria-label={gt("Hosts agents' tools may reach")}
              className="w-44"
              size="sm"
            >
              <SelectValue>{chosen === undefined ? null : resolve(chosen.label)}</SelectValue>
            </SelectTrigger>
            <SelectPopup>
              {EGRESS_CHOICES.map((choice) => (
                <SelectItem key={choice.value} value={choice.value}>
                  {resolve(choice.label)}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        }
      />
      <div className="grid gap-2 px-4 py-3">
        {egress.policy === "allowlist" ? (
          <form
            className="flex items-center gap-2 sm:max-w-lg"
            onSubmit={(event) => {
              event.preventDefault();
              void save(egress.policy, parseHosts(hosts));
            }}
          >
            <Input
              dir="ltr"
              // oxlint-disable-next-line t3code/no-untranslated-copy -- example host names
              placeholder="github.com, registry.npmjs.org"
              aria-label={gt("Hosts that may be reached")}
              value={hosts}
              onChange={(event) => setHosts(event.target.value)}
            />
            <Button type="submit" variant="outline" size="sm" disabled={busy}>
              {gt("Save")}
            </Button>
          </form>
        ) : null}
        <p className="text-xs text-muted-foreground">
          {gt(
            "This covers programs that use the system proxy settings. A program that opens its own connection is not stopped here.",
          )}
        </p>
      </div>
    </SettingsSection>
  );
}

const saveText = (fileName: string, text: string): void => {
  const url = URL.createObjectURL(new Blob([text], { type: "text/plain;charset=utf-8" }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  anchor.click();
  URL.revokeObjectURL(url);
};

/** A folder's sealed documents, the finished files that hold their values, and the limit. */
export function SealedDocumentsSection({
  projects,
  foldersElsewhere = false,
  reader = "custom",
}: {
  /** The projects (folders, to the person) of the environment whose privacy settings these are. */
  readonly projects: ReadonlyArray<{ readonly id: string; readonly title: string }>;
  /** Who reads sealed files: DoeDesk Cloud's worker, the person's own server, or no one yet. */
  readonly reader?: PrivacyWorkerKind;
  /** Some folders are on another connected computer, whose privacy settings are not these. */
  readonly foldersElsewhere?: boolean;
}) {
  const gt = useGT();
  const resolve = useMessages();
  const locale = useLocale();
  const searchableSetting = useSearchableSetting();
  const timestampFormat = useClientSettings((settings) => settings.timestampFormat);
  const [selected, setSelected] = useState<string | null>(null);
  const projectId = selected ?? projects[0]?.id ?? null;
  const listing = useSealedDocuments(projectId);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  // The record of clear answers is read once the person opens it, and again as answers are given.
  const [answersOpen, setAnswersOpen] = useState(false);
  const answers = useSealedAnswers(answersOpen ? projectId : null);
  const act = (request: Parameters<typeof changeSealedDocuments>[0]) => {
    setBusy(true);
    setProblem(null);
    return changeSealedDocuments(request)
      .then((result) => {
        if (!result.ok) setProblem(result.message ?? gt("That did not work."));
        return result;
      })
      .catch(() => {
        setProblem(gt("The sealed files could not be changed."));
        return null;
      })
      .finally(() => setBusy(false));
  };
  const project = projects.find((candidate) => candidate.id === projectId);
  return (
    <SettingsSection
      {...searchableSetting("privacy-sealed")}
      title={gt("This folder's sealed files")}
    >
      <SettingsRow
        title={gt("Folder")}
        description={gt(
          "Sealed files belong to one folder. Its agents can ask about them and cannot open them.",
        )}
        control={
          <Select
            value={projectId ?? ""}
            onValueChange={(value) => {
              if (value === null) return;
              setSelected(value);
              setAnswersOpen(false);
            }}
          >
            <SelectTrigger aria-label={gt("Folder")} className="w-44" size="sm">
              <SelectValue>{project?.title ?? gt("No folder")}</SelectValue>
            </SelectTrigger>
            <SelectPopup>
              {projects.map((candidate) => (
                <SelectItem key={candidate.id} value={candidate.id}>
                  {candidate.title}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        }
      />
      <div className="grid gap-2 px-4 py-3">
        <p className="text-xs text-muted-foreground">
          {reader === "off"
            ? gt(
                "Seal a file from the folder's file list, from an open file, or from a file attached to a message. A sealed file is kept encrypted on this computer, outside your folder. Nothing reads it until you choose who reads sealed files, so your AI cannot ask about it yet.",
              )
            : reader === "cloud"
              ? gt(
                  "Seal a file from the folder's file list, from an open file, or from a file attached to a message. A sealed file is kept encrypted on this computer, outside your folder, and is sent through DoeDesk Cloud to your region's worker each time your AI asks about it. PDFs and images are read by DoeDesk Cloud in Saudi Arabia before they are sealed.",
                )
              : gt(
                  "Seal a file from the folder's file list, from an open file, or from a file attached to a message. A sealed file is kept encrypted on this computer, outside your folder, and is sent to your own server each time your AI asks about it. PDFs and images are read by your reading service before they are sealed.",
                )}{" "}
          <a
            className="underline decoration-current/40 underline-offset-2 hover:text-foreground"
            href={locale.startsWith("ar") ? SEALED_ARTICLE_URL.ar : SEALED_ARTICLE_URL.en}
            target="_blank"
            rel="noreferrer noopener"
          >
            {gt("How it works and what we measured")}
          </a>
        </p>
        {foldersElsewhere ? (
          <p className="text-xs text-muted-foreground">
            {gt(
              "Folders on another connected computer are not listed. Their sealed files, and the notices about hosts DoeDesk blocked, are in DoeDesk on that computer.",
            )}
          </p>
        ) : null}
        {problem !== null ? <p className="text-sm text-destructive">{problem}</p> : null}
        {listing === null ? (
          <p className="text-sm text-muted-foreground">
            {projectId === null ? gt("Add a folder first.") : gt("Loading…")}
          </p>
        ) : listing.documents.length + (listing.folders?.length ?? 0) === 0 ? (
          <p className="text-sm text-muted-foreground">
            {gt("Nothing is sealed for this folder.")}
          </p>
        ) : projectId === null ? null : (
          <SealedFilesList projectId={projectId} listing={listing} />
        )}
        {listing !== null && listing.outputs.length > 0 ? (
          <>
            <p className="pt-2 text-sm font-medium">{gt("Finished files")}</p>
            <p className="text-xs text-muted-foreground">
              {gt("Files an agent wrote with sealed values put in. They hold the real values.")}
            </p>
            <ul className="grid gap-1">
              {listing.outputs.map((output) => (
                <li key={output.name} className="flex items-center gap-3 text-sm">
                  <bdi className="min-w-0 flex-1 truncate">{output.name}</bdi>
                  <span className="text-xs text-muted-foreground">
                    {formatRecordTimestamp(output.writtenAt, timestampFormat, resolve)}
                  </span>
                  <Button
                    variant="ghost"
                    size="xs"
                    disabled={busy}
                    onClick={() =>
                      projectId === null
                        ? undefined
                        : void act({ action: "output", projectId, name: output.name }).then(
                            (result) => {
                              if (typeof result?.output === "string") {
                                saveText(output.name, result.output);
                              }
                            },
                          )
                    }
                  >
                    {gt("Download")}
                  </Button>
                </li>
              ))}
            </ul>
          </>
        ) : null}
        {listing !== null && listing.documents.length > 0 ? (
          <div className="flex flex-wrap items-center gap-3 pt-2">
            <p className="text-xs text-muted-foreground">
              {gt(
                'Yes-or-no, multiple-choice and "Not stated" answers reach your AI as they are; numbers, dates and reference numbers reach it as stand-ins. Each sealed file may give {perDocument} answers that reach your AI as they are; the most asked has given {used}. Every such answer is kept here for you to read.',
                {
                  perDocument: listing.clear.perDocument,
                  used: listing.clear.mostOnOneDocument,
                },
              )}
            </p>
            <Button
              variant="ghost"
              size="xs"
              disabled={busy}
              aria-expanded={answersOpen}
              onClick={() => setAnswersOpen((open) => !open)}
            >
              {answersOpen ? gt("Hide answers") : gt("Show answers")}
            </Button>
            <Button
              variant="ghost"
              size="xs"
              disabled={busy}
              onClick={() =>
                projectId === null ? undefined : void act({ action: "resetLimits", projectId })
              }
            >
              {gt("Reset limit")}
            </Button>
          </div>
        ) : null}
        {answers === null ? null : answers.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            {gt("No answer about these files has reached your AI as it is.")}
          </p>
        ) : (
          <ul
            aria-label={gt("Answers that reached your AI as they are")}
            className="grid max-h-80 gap-2 overflow-y-auto"
          >
            {answers.toReversed().map((answer) => (
              <li
                // One call asks each question of a document once, so these name one answer.
                key={`${answer.at}|${answer.handle}|${answer.asked}|${answer.kind}|${answer.value}`}
                className="grid gap-0.5 text-xs"
              >
                <span className="flex flex-wrap gap-x-2 text-muted-foreground">
                  <span>{formatRecordTimestamp(answer.at, timestampFormat, resolve)}</span>
                  <span className="font-mono">{answer.handle}</span>
                  <bdi>{answer.document}</bdi>
                  {answer.route === undefined ? null : (
                    <bdi>{answerRouteLabel(answer.route, resolve)}</bdi>
                  )}
                </span>
                <bdi className="break-words whitespace-pre-wrap">{answer.asked}</bdi>
                <bdi className="font-medium">{describeClearAnswer(answer, resolve)}</bdi>
              </li>
            ))}
          </ul>
        )}
      </div>
    </SettingsSection>
  );
}
