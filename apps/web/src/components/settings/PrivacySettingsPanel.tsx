import type { PrivacyActivityEntry, PrivacyStatus, PrivacyVaultEntry } from "@t3tools/contracts";
import { useLocation } from "@tanstack/react-router";
import { msg, T, useGT, useMessages, Var } from "gt-react";

import { useClientSettings } from "~/hooks/useSettings";
import { formatClockTimeWithSeconds } from "~/timestampFormat";
import { ChevronDownIcon, ChevronRightIcon } from "lucide-react";
import { type ReactNode, useState } from "react";

import {
  changePrivacyVault,
  refreshPrivacyActivity,
  refreshPrivacyStatus,
  revealPrivacyVault,
  setPrivacyPreference,
  usePrivacyActivity,
  usePrivacyStatus,
  usePrivacyVault,
  useUsageData,
} from "~/privacy/privacyClient";
import { AccountRightsSection, LegalDocumentsSection } from "../privacy/AccountRights";
import { ImageHandlingSection, RedactionsSection } from "../privacy/ImageRedaction";
import { EgressSection, SealedDocumentsSection, WorkerSection } from "../privacy/SealedWorker";
import { useProjects } from "~/state/entities";
import { usePrimaryEnvironmentId } from "~/state/environments";
import { ProviderMaskingSection } from "../privacy/ProviderMasking";
import { UsageDataSettings } from "../privacy/UsageData";
import { WhatLeavesOverview } from "../privacy/WhatLeavesOverview";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { Button } from "../ui/button";
import { Switch } from "../ui/switch";
import { DeidentificationProvidersSection } from "./DeidentificationProvidersSection";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";
import { useSearchableSetting } from "./settingsSearch";

/** How personal data is kept from the model, what was masked, and the real values behind it. */
export function PrivacySettingsPanel() {
  const gt = useGT();
  const searchableSetting = useSearchableSetting();
  const state = usePrivacyStatus();
  const usageData = useUsageData();
  // Privacy settings are the primary environment's, so its projects are the ones that can seal.
  const primary = usePrimaryEnvironmentId();
  const allProjects = useProjects();
  const projects = allProjects.filter((project) => project.environmentId === primary);
  return (
    <SettingsPageContainer>
      {state.kind === "ready" ? (
        <DeidentificationProvidersSection status={state.status} />
      ) : (
        <SettingsSection {...searchableSetting("privacy-masking")}>
          <div className="px-4 py-2">
            {state.kind === "loading" ? (
              <p className="py-2 text-sm text-muted-foreground">{gt("Checking…")}</p>
            ) : (
              <div className="flex items-center gap-3 py-2">
                <p className="text-sm text-destructive">
                  {gt("Could not read the privacy settings.")}
                </p>
                <Button variant="outline" size="sm" onClick={refreshPrivacyStatus}>
                  {gt("Retry")}
                </Button>
              </div>
            )}
          </div>
        </SettingsSection>
      )}
      {state.kind === "ready" ? <WhatLeavesOverview status={state.status} /> : null}
      <ActivitySection />
      {state.kind === "ready" ? (
        <SealedDocumentsSection
          projects={projects}
          foldersElsewhere={allProjects.length > projects.length}
          reader={state.status.worker?.kind ?? "off"}
        />
      ) : null}
      <AdvancedSettings>
        {state.kind === "ready" ? <WorkerSection status={state.status} /> : null}
        {state.kind === "ready" ? <EgressSection status={state.status} /> : null}
        {state.kind === "ready" ? <ProviderMaskingSection status={state.status} /> : null}
        {state.kind === "ready" ? <ImageHandlingSection status={state.status} /> : null}
        {state.kind === "ready" ? <WebResultsSection status={state.status} /> : null}
        <RedactionsSection />
        <VaultSection />
      </AdvancedSettings>
      {state.kind === "ready" ? <AccountRightsSection status={state.status} /> : null}
      <SettingsSection {...searchableSetting("usage-data")} title={gt("Usage data")}>
        <UsageDataSettings status={usageData} />
      </SettingsSection>
      {state.kind === "ready" ? <LegalDocumentsSection status={state.status} /> : null}
    </SettingsPageContainer>
  );
}

// Sections kept under Advanced. A search result or link that names one opens the group.
const ADVANCED_SECTIONS: ReadonlySet<string> = new Set([
  "privacy-worker",
  "privacy-egress",
  "privacy-providers",
  "privacy-images",
  "privacy-web",
  "privacy-redactions",
  "privacy-vault",
]);

/** What few people change: who reads sealed files, the other-hosts rule, and how masking is tuned. */
function AdvancedSettings({ children }: { readonly children: ReactNode }) {
  const gt = useGT();
  const target = useLocation({ select: (location) => location.hash.replace(/^#/, "") });
  const [open, setOpen] = useState(false);
  // The page clears the hash once it has scrolled there, so the opening is kept in state.
  if (!open && ADVANCED_SECTIONS.has(target)) setOpen(true);
  return (
    <>
      <div className="flex">
        <Button variant="ghost" size="sm" aria-expanded={open} onClick={() => setOpen(!open)}>
          {open ? <ChevronDownIcon /> : <ChevronRightIcon className="rtl:rotate-180" />}
          {gt("Advanced", { $context: "group of privacy settings that few people change" })}
        </Button>
      </div>
      {open ? children : null}
    </>
  );
}

/** Whether public web pages and search results are searched for new names. */
function WebResultsSection({ status }: { readonly status: PrivacyStatus }) {
  const gt = useGT();
  const searchableSetting = useSearchableSetting();
  const [busy, setBusy] = useState(false);
  return (
    <SettingsSection {...searchableSetting("privacy-web")} title={gt("Web pages and searches")}>
      <SettingsRow
        title={gt("Check web results for new personal data")}
        description={gt(
          "When this is off, a public web page an agent fetches and the results of a web search are not searched for new names: only values DoeDesk already knows are replaced, so the names on a news page reach the AI as written. Pages on your own network or behind a sign-in, and the results of every other tool, are always checked.",
        )}
        control={
          <Switch
            aria-label={gt("Check web results for new personal data")}
            checked={status.webResultsChecked === true}
            disabled={busy || status.mode === "off"}
            onCheckedChange={(check) => {
              setBusy(true);
              void setPrivacyPreference({ kind: "webResults", check }).finally(() =>
                setBusy(false),
              );
            }}
          />
        }
      />
    </SettingsSection>
  );
}

const OUTCOME_LABELS: Record<PrivacyActivityEntry["outcome"], string> = {
  masked: msg("Sent, masked"),
  passed: msg("Sent unchanged"),
  refused: msg("Not sent"),
  blocked: msg("Blocked", { $context: "a request DoeDesk did not let through" }),
};

/**
 * Entries worded here, by the name the gateway gives them: what happened in plain words, in place
 * of the outcome's label and the gateway's English.
 */
const NOTICES = new Map([
  [
    "websocketToMaskedRoute",
    {
      label: msg("Connection type refused", {
        $context: "a calm entry in a list of recent requests: nothing went wrong",
      }),
      detail: msg(
        "The AI tool asked for a kind of connection DoeDesk cannot mask (a WebSocket), so DoeDesk refused it and nothing was sent on it. The tool then sends its requests the ordinary way, and DoeDesk masks them. Nothing needs fixing.",
      ),
    },
  ],
  [
    "unknownRequest",
    {
      label: msg("Not sent"),
      detail: msg(
        "The AI tool sent the AI company a kind of request DoeDesk has no rule for, so DoeDesk could not check it for personal data and did not send it. Your messages and the AI's answers are not affected.",
      ),
    },
  ],
  [
    "appCall",
    {
      label: msg("Not sent"),
      detail: msg(
        "The AI tool tried to use an app that the AI company hosts. That would carry real values to the company, so DoeDesk did not send it.",
      ),
    },
  ],
  [
    "proxySignIn",
    {
      label: msg("Not sent"),
      detail: msg(
        "The proxy this computer is set to use asked for a user name and password that DoeDesk does not have, so the request was not sent. Add them to the proxy address this computer uses, then start DoeDesk again.",
      ),
    },
  ],
  [
    "proxyRefused",
    {
      label: msg("Not sent"),
      detail: msg(
        "The proxy this computer is set to use would not carry this request, so it was not sent. DoeDesk does not go around the proxy. Check the proxy, or ask whoever runs it.",
      ),
    },
  ],
]);

/** The gateway's fixed reasons, which it sends in English. Any other reason is shown as sent. */
const GATEWAY_REASONS: Readonly<Record<string, string>> = {
  "DoeDesk refused a WebSocket connection to this AI host: it cannot mask what such a connection carries. Nothing was sent on it.":
    msg(
      "DoeDesk refused a WebSocket connection to this AI host: it cannot mask what such a connection carries. Nothing was sent on it.",
    ),
  "This host is not on the list of hosts agents may reach. Add it in Settings, under Privacy, if it should be.":
    msg(
      "This host is not on the list of hosts agents may reach. Add it in Settings → Privacy if it should be.",
    ),
  "This provider's traffic cannot be masked, so DoeDesk does not let it through.": msg(
    "This AI tool's requests cannot be masked, so DoeDesk does not let them through.",
  ),
};

function ActivitySection() {
  const gt = useGT();
  const resolve = useMessages();
  const timestampFormat = useClientSettings((settings) => settings.timestampFormat);
  const entries = usePrivacyActivity();
  // Only requests to the AI itself are worth a line; background calls would bury them.
  const shown = (entries ?? []).filter((entry) => entry.outcome !== "passed").slice(0, 50);
  return (
    <SettingsSection
      id="privacy-activity"
      title={gt("Recent requests")}
      headerAction={
        <Button variant="ghost" size="sm" onClick={refreshPrivacyActivity}>
          {gt("Refresh")}
        </Button>
      }
    >
      <div className="px-4 py-2">
        {entries === null ? (
          <p className="py-2 text-sm text-muted-foreground">{gt("Loading…")}</p>
        ) : shown.length === 0 ? (
          <p className="py-2 text-sm text-muted-foreground">{gt("Nothing yet.")}</p>
        ) : (
          <ul className="divide-y divide-border/60">
            {shown.map((entry) => {
              const notice = entry.notice === undefined ? undefined : NOTICES.get(entry.notice);
              const detail =
                notice !== undefined
                  ? resolve(notice.detail)
                  : entry.reason === null
                    ? null
                    : resolve(GATEWAY_REASONS[entry.reason] ?? entry.reason);
              return (
                <li
                  key={`${entry.at}-${entry.host}-${entry.outcome}-${entry.masked}`}
                  className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-0.5 py-1.5 text-sm"
                >
                  <span className="min-w-0 truncate text-foreground">
                    {resolve(notice?.label ?? OUTCOME_LABELS[entry.outcome])}
                    <span className="text-muted-foreground">
                      {" · "}
                      <bdi dir="ltr">{entry.host}</bdi>
                    </span>
                  </span>
                  <span className="text-xs text-muted-foreground tabular-nums">
                    {entry.outcome !== "masked"
                      ? ""
                      : entry.withheld > 0
                        ? `${gt("{masked} masked, {withheld} withheld", {
                            masked: entry.masked,
                            withheld: entry.withheld,
                          })} · `
                        : `${gt("{masked, plural, one {{masked} masked} other {{masked} masked}}", {
                            masked: entry.masked,
                          })} · `}
                    {formatClockTimeWithSeconds(entry.at, timestampFormat)}
                  </span>
                  {entry.request === undefined ? null : (
                    <span className="w-full truncate text-xs text-muted-foreground">
                      <bdi dir="ltr">{entry.request}</bdi>
                    </span>
                  )}
                  {detail !== null ? (
                    <span className="w-full text-xs text-muted-foreground">{detail}</span>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </SettingsSection>
  );
}

function VaultSection() {
  const gt = useGT();
  const { vault, loading } = usePrivacyVault();
  const [shown, setShown] = useState(false);
  const visible = shown ? vault : null;
  const unmasked = visible?.unmasked ?? [];
  // The entry whose masking the person asked to stop, until they confirm or cancel.
  const [stopping, setStopping] = useState<PrivacyVaultEntry | null>(null);
  return (
    <SettingsSection
      id="privacy-vault"
      title={gt("Stand-ins on this computer")}
      headerAction={
        <Button
          variant="ghost"
          size="sm"
          disabled={shown && loading}
          onClick={() => {
            // Read again each time it is opened, so the list is current.
            if (!shown) revealPrivacyVault();
            setShown(!shown);
          }}
        >
          {shown ? gt("Hide") : gt("Show")}
        </Button>
      }
    >
      {visible === null ? null : (
        <div className="px-4 py-2">
          {visible.entries.length === 0 ? (
            <p className="py-2 text-sm text-muted-foreground">{gt("Nothing masked yet.")}</p>
          ) : (
            <>
              <p className="py-2 text-xs text-muted-foreground">
                {gt(
                  "If a word here is not personal, such as a word of code, stop masking it. From the next request it is sent to the AI as written, in every conversation.",
                )}
              </p>
              <ul className="max-h-96 divide-y divide-border/60 overflow-y-auto">
                {visible.entries.map((entry) => (
                  <VaultRow
                    key={entry.token}
                    entry={entry}
                    action={entry.removable === false ? null : "stopMasking"}
                    onStopMasking={setStopping}
                  />
                ))}
              </ul>
            </>
          )}
          {unmasked.length === 0 ? null : (
            <>
              <h4 className="pt-4 pb-1 text-xs font-medium text-muted-foreground">
                {gt("No longer masked")}
              </h4>
              <ul className="max-h-48 divide-y divide-border/60 overflow-y-auto">
                {unmasked.map((entry) => (
                  <VaultRow key={entry.token} entry={entry} action="maskAgain" />
                ))}
              </ul>
            </>
          )}
        </div>
      )}
      <StopMaskingDialog entry={stopping} onClose={() => setStopping(null)} />
    </SettingsSection>
  );
}

/**
 * Asks before a value is sent as written: the list puts words of code beside real names, and
 * what has been sent cannot be taken back. Cancel comes first, so it holds the focus.
 */
function StopMaskingDialog({
  entry,
  onClose,
}: {
  readonly entry: PrivacyVaultEntry | null;
  readonly onClose: () => void;
}) {
  const gt = useGT();
  // The dialog keeps the last entry's words while it closes.
  const [last, setLast] = useState(entry);
  if (entry !== null && entry !== last) setLast(entry);
  const shownEntry = entry ?? last;
  return (
    <AlertDialog open={entry !== null} onOpenChange={(next) => (next ? undefined : onClose())}>
      <AlertDialogPopup>
        <AlertDialogHeader>
          <AlertDialogTitle>{gt("Stop masking this value?")}</AlertDialogTitle>
          <AlertDialogDescription render={<div />}>
            {shownEntry === null ? null : (
              <p className="text-start">
                <T>
                  From the next request,{" "}
                  <Var>
                    <bdi dir="auto" className="font-medium text-foreground">
                      {shownEntry.value}
                    </bdi>
                  </Var>{" "}
                  is sent to the AI as written, in every conversation, where{" "}
                  <Var>
                    <code dir="ltr">{shownEntry.token}</code>
                  </Var>{" "}
                  was sent before. What has been sent cannot be taken back.
                </T>
              </p>
            )}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogClose render={<Button variant="outline" />}>{gt("Cancel")}</AlertDialogClose>
          <Button
            variant="destructive"
            onClick={() => {
              if (entry !== null)
                void changePrivacyVault({ action: "stopMasking", token: entry.token });
              onClose();
            }}
          >
            {gt("Stop masking")}
          </Button>
        </AlertDialogFooter>
      </AlertDialogPopup>
    </AlertDialog>
  );
}

function VaultRow({
  entry,
  action,
  onStopMasking,
}: {
  readonly entry: PrivacyVaultEntry;
  /** Null for a value of a sealed document, which stays masked. */
  readonly action: "stopMasking" | "maskAgain" | null;
  /** Stopping asks first; masking again does not. */
  readonly onStopMasking?: (entry: PrivacyVaultEntry) => void;
}) {
  const gt = useGT();
  const [busy, setBusy] = useState(false);
  return (
    <li className="flex items-center justify-between gap-4 py-1.5 text-sm">
      <span className="min-w-0 flex-1 truncate text-foreground" dir="auto">
        {entry.value}
      </span>
      <code dir="ltr" className="shrink-0 text-xs text-muted-foreground">
        {entry.token}
      </code>
      {action === null ? null : (
        <Button
          variant="ghost"
          size="xs"
          disabled={busy}
          onClick={() => {
            if (action === "stopMasking") {
              onStopMasking?.(entry);
              return;
            }
            setBusy(true);
            void changePrivacyVault({ action, token: entry.token }).finally(() => setBusy(false));
          }}
        >
          {action === "stopMasking" ? gt("Stop masking") : gt("Mask again")}
        </Button>
      )}
    </li>
  );
}
