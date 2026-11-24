import {
  replacedValueCount,
  turnPrivacyHeadline,
  type TurnPrivacyHeadline,
} from "@t3tools/client-runtime/state/thread-privacy";
import type {
  EnvironmentId,
  PrivacySealedTurn,
  PrivacyTurnRecord,
  PrivacyTurnValues,
  RunId,
  ScopedThreadRef,
} from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { formatCommaList } from "@t3tools/client-runtime/list-format";
import { useGT, useMessages } from "gt-react";
import { ShieldAlertIcon, ShieldCheckIcon, ShieldOffIcon, ShieldQuestionIcon } from "lucide-react";
import { useEffect, useState } from "react";

import { fileNameInText } from "~/lib/fileNameText";
import { cn } from "~/lib/utils";
import {
  fetchSealedTurn,
  fetchTurnValues,
  usePrivacyStatus,
  useSealedDocuments,
} from "~/privacy/privacyClient";
import { useQuietThreadShell, useThreadRunPrivacy } from "~/state/entities";
import { usePrimaryEnvironmentId } from "~/state/environments";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Dialog, DialogHeader, DialogPanel, DialogPopup, DialogTitle } from "../ui/dialog";
import { describeClearAnswer } from "./SealedWorker.logic";
import { SentLabel } from "./SentLabel";
import { answerRouteLabel } from "./sealReader";
import { sealedFilesAsked, standInKindLabel, valuesByKind } from "./TurnPrivacy.logic";

type Translate = ReturnType<typeof useGT>;

const HEADLINE_ICONS = {
  replaced: ShieldCheckIcon,
  nothingFound: ShieldCheckIcon,
  notSent: ShieldAlertIcon,
  unmasked: ShieldOffIcon,
  unseen: ShieldQuestionIcon,
} as const;

/** The one sentence a turn's line says. Each count is something the gateway did. */
const headlineText = (headline: TurnPrivacyHeadline, gt: Translate): string => {
  switch (headline.kind) {
    case "replaced":
      return gt(
        "{count, plural, one {{count} value replaced with a stand-in before sending} other {{count} values replaced with stand-ins before sending}}",
        { count: headline.count },
      );
    case "nothingFound":
      return gt("DoeDesk checked this turn and found nothing to replace");
    case "notSent":
      return gt(
        "{count, plural, one {{count} request was not sent because DoeDesk could not check it} other {{count} requests were not sent because DoeDesk could not check them}}",
        { count: headline.count },
      );
    case "unmasked":
      return gt("Sent without masking");
    case "unseen":
      return gt("DoeDesk did not see this turn's requests");
  }
};

type TurnSealedFiles = NonNullable<PrivacyTurnRecord["sealedFiles"]>;

/** What the turn's line adds when its agent asked about sealed files. */
const sealedText = (
  sealedFiles: TurnSealedFiles,
  listing: Parameters<typeof sealedFilesAsked>[1],
  gt: Translate,
  resolve: ReturnType<typeof useMessages>,
): string => {
  const asked = sealedFilesAsked(sealedFiles, listing);
  const listed = formatCommaList(asked.names.map(fileNameInText), resolve);
  const names =
    asked.more === 0
      ? listed
      : gt("{count, plural, one {{names} and {count} more} other {{names} and {count} more}}", {
          names: listed,
          count: asked.more,
        });
  const files = gt(
    "{count, plural, one {{count} sealed file asked: {names}} other {{count} sealed files asked: {names}}}",
    { count: asked.count, names },
  );
  return sealedFiles.clear === 0
    ? files
    : `${files} · ${gt(
        "{count, plural, one {{count} answer reached your AI as it is} other {{count} answers reached your AI as they are}}",
        { count: sealedFiles.clear },
      )}`;
};

/**
 * One muted line under a turn's final answer: what the gateway did for the turn, and the way
 * into the detail. Nothing is shown for a turn without a record.
 */
export function TurnPrivacyLine({
  threadRef,
  runId,
  environmentId,
}: {
  readonly threadRef: ScopedThreadRef;
  readonly runId: RunId;
  readonly environmentId: EnvironmentId;
}) {
  const gt = useGT();
  const resolve = useMessages();
  const [inspecting, setInspecting] = useState(false);
  const record = useThreadRunPrivacy(threadRef).find((turn) => turn.runId === runId)?.privacy;
  const sealedFiles = record?.sealedFiles;
  // The files' names are on the computer that holds them. Anywhere else the line names handles.
  const local = usePrimaryEnvironmentId() === environmentId;
  const projectId = useQuietThreadShell(threadRef)?.projectId ?? null;
  const listing = useSealedDocuments(local && sealedFiles !== undefined ? projectId : null);
  if (record === undefined) return null;
  const headline = turnPrivacyHeadline(record);
  const Icon = HEADLINE_ICONS[headline.kind];
  const calm = headline.kind === "replaced" || headline.kind === "nothingFound";
  return (
    <>
      <button
        type="button"
        data-turn-privacy={headline.kind}
        className={cn(
          "mt-1.5 flex max-w-full items-center gap-1.5 rounded-sm text-start text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
          calm ? "text-muted-foreground" : "text-warning-foreground",
        )}
        onClick={() => setInspecting(true)}
      >
        <Icon aria-hidden className="size-3.5 shrink-0" />
        {/* The space is for a screen reader: the two parts are one name. */}
        <span className="min-w-0">
          {headlineText(headline, gt)}
          {sealedFiles === undefined || sealedFiles.askedCount === 0
            ? null
            : ` · ${sealedText(sealedFiles, listing, gt, resolve)}`}
        </span>{" "}
        <span className="shrink-0 underline underline-offset-2">
          {gt("Inspect", { $context: "button, opens the detail of what was masked in a turn" })}
        </span>
      </button>
      {inspecting ? (
        <TurnPrivacyInspect
          record={record}
          threadRef={threadRef}
          runId={runId}
          environmentId={environmentId}
          onClose={() => setInspecting(false)}
        />
      ) : null}
    </>
  );
}

type TurnValues = NonNullable<PrivacyTurnValues["values"]>;
type ValuesState =
  | { readonly kind: "hidden" }
  | { readonly kind: "loading" }
  | { readonly kind: "failed" }
  | { readonly kind: "shown"; readonly values: TurnValues | null };

function Section({
  title,
  children,
}: {
  readonly title: string;
  readonly children: React.ReactNode;
}) {
  return (
    <section className="space-y-2">
      <h3 className="font-medium text-sm">{title}</h3>
      {children}
    </section>
  );
}

function Note({ children }: { readonly children: React.ReactNode }) {
  return <p className="text-muted-foreground text-sm">{children}</p>;
}

/** What was replaced, by kind, with the stand-in beside the value once the person asks for it. */
function ReplacedSection({
  record,
  runId,
  local,
}: {
  readonly record: Extract<PrivacyTurnRecord, { state: "masked" }>;
  readonly runId: RunId;
  readonly local: boolean;
}) {
  const gt = useGT();
  const resolve = useMessages();
  const [values, setValues] = useState<ValuesState>({ kind: "hidden" });
  const count = replacedValueCount(record);
  const show = () => {
    setValues({ kind: "loading" });
    void fetchTurnValues(runId).then(
      (list) => setValues({ kind: "shown", values: list }),
      () => setValues({ kind: "failed" }),
    );
  };
  const listed = values.kind === "shown" && values.values !== null ? values.values : null;
  return (
    <Section title={gt("Replaced with stand-ins")}>
      {count === 0 ? (
        <Note>{gt("DoeDesk found nothing to replace in this turn.")}</Note>
      ) : (
        <>
          <Note>
            {gt("DoeDesk found these values and sent stand-ins in their place.")}{" "}
            {gt(
              "Each turn sends the chat history again, so values from earlier messages appear here too.",
            )}
          </Note>
          {record.attribution === "time" ? (
            <Note>
              {gt(
                "This AI tool does not identify which chat a request belongs to, so this list may include values from other chats running at the same time.",
              )}
            </Note>
          ) : null}
          {listed === null ? (
            <ul className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
              {record.replaced.map((entry) => (
                <li key={entry.kind}>
                  {resolve(standInKindLabel(entry.kind))}{" "}
                  <bdi dir="ltr" className="text-muted-foreground tabular-nums">
                    {entry.count}
                  </bdi>
                </li>
              ))}
            </ul>
          ) : (
            valuesByKind(record.replaced, listed).map((group) => (
              <div key={group.kind}>
                <h4 className="text-muted-foreground text-xs">
                  {resolve(standInKindLabel(group.kind))}{" "}
                  <bdi dir="ltr" className="tabular-nums">
                    {group.values.length}
                  </bdi>
                </h4>
                <ul className="divide-y divide-border/60">
                  {group.values.map((entry) => (
                    <li
                      key={entry.token}
                      className="flex items-baseline justify-between gap-4 py-1.5 text-sm"
                    >
                      <span className="min-w-0 wrap-anywhere" dir="auto">
                        {entry.value ?? (
                          <span className="text-muted-foreground">
                            {gt("No longer on this computer")}
                          </span>
                        )}
                        {entry.sealed ? (
                          <>
                            {" "}
                            <Badge variant="outline" size="sm">
                              {gt("Sealed file")}
                            </Badge>
                          </>
                        ) : null}
                      </span>
                      <code dir="ltr" className="shrink-0 text-muted-foreground text-xs">
                        {entry.token}
                      </code>
                    </li>
                  ))}
                </ul>
              </div>
            ))
          )}
          {!local ? (
            <Note>
              {gt(
                "The real values are kept on the computer this chat runs on. Open DoeDesk there to see them.",
              )}
            </Note>
          ) : values.kind === "shown" && values.values === null ? (
            <Note>
              {gt(
                "The list for this turn is no longer kept on this computer. The counts were recorded when the turn ended.",
              )}
            </Note>
          ) : values.kind === "failed" ? (
            <Note>{gt("The values could not be read from this computer.")}</Note>
          ) : (
            <div className="flex items-center gap-3">
              <Button
                variant="outline"
                size="sm"
                disabled={values.kind === "loading"}
                onClick={listed === null ? show : () => setValues({ kind: "hidden" })}
              >
                {listed === null ? gt("Show real values") : gt("Hide real values")}
              </Button>
              <span className="text-muted-foreground text-xs">
                {listed?.some((entry) => entry.sealed) === true
                  ? gt(
                      "The real values are read from this computer. Those marked Sealed file came from a sealed file.",
                    )
                  : gt("The real values stay on this computer.")}
              </span>
            </div>
          )}
        </>
      )}
    </Section>
  );
}

function Rows({ rows }: { readonly rows: ReadonlyArray<string> }) {
  return (
    <ul className="list-disc space-y-1 ps-5 text-sm">
      {rows.map((row) => (
        <li key={row}>{row}</li>
      ))}
    </ul>
  );
}

/** What went out changed, what was held back, and what went out as written, as counted. */
function SentSections({
  record,
}: {
  readonly record: Extract<PrivacyTurnRecord, { state: "masked" }>;
}) {
  const gt = useGT();
  const files = [
    record.redacted > 0
      ? gt(
          "{count, plural, one {{count} image sent with the details DoeDesk found covered} other {{count} images sent with the details DoeDesk found covered}}",
          { count: record.redacted },
        )
      : null,
    record.read > 0
      ? gt(
          "{count, plural, one {{count} image or file sent as masked text} other {{count} images or files sent as masked text}}",
          { count: record.read },
        )
      : null,
  ].filter((row) => row !== null);
  const notSent = [
    record.withheld > 0
      ? gt(
          "{count, plural, one {{count} image or file withheld} other {{count} images or files withheld}}",
          { count: record.withheld },
        )
      : null,
    record.sealed > 0
      ? gt(
          "{count, plural, one {{count} excerpt withheld because it matched a sealed file} other {{count} excerpts withheld because they matched a sealed file}}",
          { count: record.sealed },
        )
      : null,
    record.refused > 0
      ? gt("{count, plural, one {{count} request not sent} other {{count} requests not sent}}", {
          count: record.refused,
        })
      : null,
  ].filter((row) => row !== null);
  return (
    <>
      {files.length === 0 ? null : (
        <Section title={gt("Images and files")}>
          <Rows rows={files} />
        </Section>
      )}
      {notSent.length === 0 ? null : (
        <Section title={gt("Not sent", { $context: "heading: what DoeDesk held back in a turn" })}>
          <Rows rows={notSent} />
        </Section>
      )}
      <Section title={gt("Sent as written")}>
        <Note>
          {gt(
            "Everything DoeDesk did not replace was sent as written. DoeDesk can only replace what it finds, so any detail it did not recognize was sent too.",
          )}
        </Note>
      </Section>
    </>
  );
}

type SealedTurnState =
  | { readonly kind: "loading" }
  | { readonly kind: "failed" }
  | { readonly kind: "shown"; readonly turn: PrivacySealedTurn | null };

/**
 * Which sealed files the turn's agent asked about, and every answer that reached the AI as it
 * is. The names and the answers are read from the computer that holds the files; anywhere else,
 * and once they are no longer kept, the handles and the counts on the turn are what is shown.
 */
function SealedFilesSection({
  sealedFiles,
  runId,
  projectId,
  local,
}: {
  readonly sealedFiles: TurnSealedFiles;
  readonly runId: RunId;
  readonly projectId: string | null;
  readonly local: boolean;
}) {
  const gt = useGT();
  const resolve = useMessages();
  const [state, setState] = useState<SealedTurnState>({ kind: "loading" });
  const readable = local && projectId !== null;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- the turn's sealed record is kept by the server on this computer and read when the dialog opens
  useEffect(() => {
    if (!readable) return;
    let current = true;
    void fetchSealedTurn(projectId, runId).then(
      (turn) => current && setState({ kind: "shown", turn }),
      () => current && setState({ kind: "failed" }),
    );
    return () => {
      current = false;
    };
  }, [readable, projectId, runId]);
  const turn = readable && state.kind === "shown" ? state.turn : null;
  const asked = turn?.asked ?? sealedFiles.asked.map((handle) => ({ handle, name: "" }));
  const unlisted = sealedFiles.askedCount - asked.length;
  return (
    <Section title={gt("Sealed files asked in this turn")}>
      <ul className="divide-y divide-border/60">
        {asked.map((document) => (
          <li key={document.handle} className="grid gap-0.5 py-1.5 text-sm">
            <span className="flex items-baseline justify-between gap-4">
              <bdi className="min-w-0 wrap-anywhere">
                {document.name === "" ? document.handle : document.name}
              </bdi>
              {document.name === "" ? null : (
                <code dir="ltr" className="shrink-0 text-muted-foreground text-xs">
                  {document.handle}
                </code>
              )}
            </span>
            {"label" in document && document.label !== undefined ? (
              <span className="text-muted-foreground text-xs">
                {gt("Your AI company was told:")} <SentLabel label={document.label} />
              </span>
            ) : null}
          </li>
        ))}
      </ul>
      {unlisted > 0 ? (
        <Note>
          {gt("{count, plural, one {And {count} more file.} other {And {count} more files.}}", {
            count: unlisted,
          })}
        </Note>
      ) : null}
      <h4 className="pt-1 text-muted-foreground text-xs">
        {gt("Answers that reached your AI as they are")}{" "}
        <bdi dir="ltr" className="tabular-nums">
          {sealedFiles.clear}
        </bdi>
      </h4>
      {sealedFiles.clear === 0 ? (
        <Note>
          {gt(
            "None. Every answer in this turn reached your AI as a stand-in, or said the file does not state it.",
          )}
        </Note>
      ) : turn !== null ? (
        <ul className="grid gap-2">
          {turn.answers.map((answer) => (
            <li
              // One call asks each question of a file once, so these name one answer.
              key={`${answer.at}|${answer.handle}|${answer.asked}|${answer.kind}|${answer.value}`}
              className="grid gap-0.5 text-sm"
            >
              <span className="flex flex-wrap gap-x-2 text-muted-foreground text-xs">
                <code dir="ltr">{answer.handle}</code>
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
      ) : null}
      {!local ? (
        <Note>
          {gt(
            "The file names and the answers are kept on the computer this chat runs on. Open DoeDesk there to see them.",
          )}
        </Note>
      ) : state.kind === "failed" ? (
        <Note>{gt("The answers could not be read from this computer.")}</Note>
      ) : state.kind === "shown" && state.turn === null ? (
        <Note>
          {gt(
            "The names and answers for this turn are no longer kept on this computer. Every answer the folder's sealed files gave is listed in Settings, under Privacy.",
          )}
        </Note>
      ) : (
        <Note>
          {gt(
            'A yes or no, a choice from a list and "Not stated" reach your AI as they are. Numbers, dates and reference numbers reach it as stand-ins.',
          )}
        </Note>
      )}
    </Section>
  );
}

function TurnPrivacyInspect({
  record,
  threadRef,
  runId,
  environmentId,
  onClose,
}: {
  readonly record: PrivacyTurnRecord;
  readonly threadRef: ScopedThreadRef;
  readonly runId: RunId;
  readonly environmentId: EnvironmentId;
  readonly onClose: () => void;
}) {
  const gt = useGT();
  const navigate = useNavigate();
  const local = usePrimaryEnvironmentId() === environmentId;
  const privacy = usePrivacyStatus();
  const hasSealed = local && privacy.kind === "ready" && (privacy.status.sealedDocuments ?? 0) > 0;
  const projectId = useQuietThreadShell(threadRef)?.projectId ?? null;
  const sealed = useSealedDocuments(hasSealed ? projectId : null);
  const sealedDocuments = sealed?.documents.length ?? 0;
  const sealedFiles = record.sealedFiles;
  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogPopup>
        <DialogHeader>
          <DialogTitle>{gt("What DoeDesk did in this turn")}</DialogTitle>
        </DialogHeader>
        <DialogPanel className="text-start">
          {record.state === "masked" ? (
            <>
              <ReplacedSection record={record} runId={runId} local={local} />
              <SentSections record={record} />
            </>
          ) : record.state === "unmasked" ? (
            <Section title={gt("Sent without masking")}>
              <Note>
                {record.reason === "off"
                  ? gt("This turn was sent without masking because masking was turned off.")
                  : gt(
                      "This turn was sent without masking because masking was turned off for the AI tool this chat used.",
                    )}{" "}
                {gt("The AI company received your messages and files as they are.")}
              </Note>
              {local ? (
                <div>
                  <Button
                    variant="link"
                    size="sm"
                    onClick={() => {
                      onClose();
                      void navigate({ to: "/settings/privacy" });
                    }}
                  >
                    {gt("Privacy settings")}
                  </Button>
                </div>
              ) : null}
            </Section>
          ) : (
            <Section title={gt("DoeDesk did not see this turn's requests")}>
              <Note>
                {gt(
                  "The AI tool was started behind DoeDesk's masking service, but the service rewrote no request that it could tie to this turn. If the tool sent this turn somewhere DoeDesk does not check, it was sent as written.",
                )}
              </Note>
            </Section>
          )}
          {sealedFiles !== undefined && sealedFiles.askedCount > 0 ? (
            <SealedFilesSection
              sealedFiles={sealedFiles}
              runId={runId}
              projectId={projectId}
              local={local}
            />
          ) : sealedDocuments > 0 ? (
            <p className="text-muted-foreground text-xs" data-sealed-answers-record>
              {gt("This turn asked nothing of the folder's sealed files.")}
            </p>
          ) : null}
        </DialogPanel>
      </DialogPopup>
    </Dialog>
  );
}
