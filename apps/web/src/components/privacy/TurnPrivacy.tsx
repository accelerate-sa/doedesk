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
import {
  FileLock2Icon,
  ShieldAlertIcon,
  ShieldCheckIcon,
  ShieldOffIcon,
  ShieldQuestionIcon,
} from "lucide-react";
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
import { SharedTooltipTrigger } from "../ui/shared-tooltip";
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

/** The badge under a turn: an outcome in a word or two, with the count where there is one. */
const badgeText = (headline: TurnPrivacyHeadline, gt: Translate): string => {
  switch (headline.kind) {
    case "replaced":
      return gt("De-identified · {count}", { count: headline.count });
    case "nothingFound":
      return gt("Checked", {
        $context: "badge under a reply: it was checked and held no personal details",
      });
    case "notSent":
      return gt("Held · {count}", { count: headline.count });
    case "unmasked":
      return gt("Unprotected", {
        $context: "badge under a reply: it was sent as written, without de-identification",
      });
    case "unseen":
      return gt("Unconfirmed", {
        $context: "badge under a reply: its de-identification could not be confirmed",
      });
  }
};

/** What the badge means, as one sentence: its tooltip, and its name for a screen reader. */
const headlineText = (headline: TurnPrivacyHeadline, gt: Translate): string => {
  switch (headline.kind) {
    case "replaced":
      return gt(
        "{count, plural, one {{count} value de-identified before sending} other {{count} values de-identified before sending}}",
        { count: headline.count },
      );
    case "nothingFound":
      return gt("Checked: nothing to de-identify");
    case "notSent":
      return gt(
        "{count, plural, one {{count} request held: DoeDesk could not check it} other {{count} requests held: DoeDesk could not check them}}",
        { count: headline.count },
      );
    case "unmasked":
      return gt("Sent as written, without de-identification");
    case "unseen":
      return gt("DoeDesk could not confirm this turn was de-identified");
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
 * A quiet badge under a turn's final answer: the outcome in a word or two, the sentence on
 * hover, and the detail on click. Nothing is shown for a turn without a record.
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
  // The files' names are on the computer that holds them. Anywhere else the badge names handles.
  const local = usePrimaryEnvironmentId() === environmentId;
  const projectId = useQuietThreadShell(threadRef)?.projectId ?? null;
  const listing = useSealedDocuments(local && sealedFiles !== undefined ? projectId : null);
  if (record === undefined) return null;
  const headline = turnPrivacyHeadline(record);
  const Icon = HEADLINE_ICONS[headline.kind];
  const calm = headline.kind === "replaced" || headline.kind === "nothingFound";
  const asked = sealedFiles === undefined ? 0 : sealedFiles.askedCount;
  const sentence =
    sealedFiles === undefined || asked === 0
      ? headlineText(headline, gt)
      : `${headlineText(headline, gt)} · ${sealedText(sealedFiles, listing, gt, resolve)}`;
  return (
    <div className="mt-1.5 flex">
      <SharedTooltipTrigger
        render={
          <button
            type="button"
            data-turn-privacy={headline.kind}
            aria-label={sentence}
            className={cn(
              "-ms-1.5 inline-flex h-6 max-w-full items-center gap-1.5 rounded-md px-1.5 text-xs outline-none transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset motion-reduce:transition-none",
              calm ? "text-muted-foreground hover:text-foreground" : "text-warning-foreground",
            )}
            onClick={() => setInspecting(true)}
          />
        }
        label={sentence}
      >
        <Icon aria-hidden className="size-3.5 shrink-0" />
        <span className="truncate tabular-nums">{badgeText(headline, gt)}</span>
        {asked === 0 ? null : (
          <span data-turn-sealed-asked className="flex shrink-0 items-center gap-1 tabular-nums">
            <FileLock2Icon aria-hidden className="size-3.5" />
            <bdi dir="ltr">{asked}</bdi>
          </span>
        )}
      </SharedTooltipTrigger>
      {inspecting ? (
        <TurnPrivacyInspect
          record={record}
          threadRef={threadRef}
          runId={runId}
          environmentId={environmentId}
          onClose={() => setInspecting(false)}
        />
      ) : null}
    </div>
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

/** What was de-identified, by kind, with what was sent beside each value once the person asks. */
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
    <Section title={gt("De-identified values")}>
      {count === 0 ? (
        <Note>{gt("Nothing to de-identify in this turn.")}</Note>
      ) : (
        <>
          <Note>{gt("Includes earlier messages, which are sent again with each turn.")}</Note>
          {record.attribution === "time" ? (
            <Note>{gt("May include values from other chats running at the same time.")}</Note>
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
            <Note>{gt("The real values stay on the computer this chat runs on.")}</Note>
          ) : values.kind === "shown" && values.values === null ? (
            <Note>{gt("This turn's values are no longer kept on this computer.")}</Note>
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
                  ? gt("Read from this computer. Sealed file: from a sealed file.")
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
      ? gt("{count, plural, one {{count} image redacted} other {{count} images redacted}}", {
          count: record.redacted,
        })
      : null,
    record.read > 0
      ? gt(
          "{count, plural, one {{count} image or file sent as de-identified text} other {{count} images or files sent as de-identified text}}",
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
          "{count, plural, one {{count} excerpt of a sealed file withheld} other {{count} excerpts of sealed files withheld}}",
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
        <Note>{gt("Anything DoeDesk did not recognize was sent as written.")}</Note>
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
    <Section title={gt("Sealed files asked")}>
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
        {gt("Answers sent as they are")}{" "}
        <bdi dir="ltr" className="tabular-nums">
          {sealedFiles.clear}
        </bdi>
      </h4>
      {sealedFiles.clear === 0 ? (
        <Note>{gt("None. Every answer was de-identified or not stated.")}</Note>
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
        <Note>{gt("File names and answers stay on the computer this chat runs on.")}</Note>
      ) : state.kind === "failed" ? (
        <Note>{gt("The answers could not be read from this computer.")}</Note>
      ) : state.kind === "shown" && state.turn === null ? (
        <Note>{gt("No longer kept here. Every answer is listed in Settings, under Privacy.")}</Note>
      ) : (
        <Note>
          {gt(
            'A yes or no, a choice from a list and "Not stated" are sent as they are. Numbers, dates and reference numbers are de-identified.',
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
          <DialogTitle>{gt("Privacy in this turn")}</DialogTitle>
        </DialogHeader>
        <DialogPanel className="text-start">
          {record.state === "masked" ? (
            <>
              <ReplacedSection record={record} runId={runId} local={local} />
              <SentSections record={record} />
            </>
          ) : record.state === "unmasked" ? (
            <Section title={gt("Sent as written")}>
              <Note>
                {record.reason === "off"
                  ? gt(
                      "De-identification was off, so your messages and files were sent as they are.",
                    )
                  : gt(
                      "De-identification was off for this AI tool, so your messages and files were sent as they are.",
                    )}
              </Note>
              {local ? (
                <div className="-ms-2.5">
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
            <Section
              title={gt("Unconfirmed", {
                $context: "heading: a reply whose de-identification could not be confirmed",
              })}
            >
              <Note>
                {gt(
                  "DoeDesk could not confirm this turn was de-identified. The AI tool may have sent it as written.",
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
              {gt("No sealed file was asked in this turn.")}
            </p>
          ) : null}
        </DialogPanel>
      </DialogPopup>
    </Dialog>
  );
}
