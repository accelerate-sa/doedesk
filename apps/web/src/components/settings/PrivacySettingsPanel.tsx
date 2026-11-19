import type { PrivacyActivityEntry } from "@t3tools/contracts";
import { useGT } from "gt-react";
import { useState } from "react";

import {
  refreshPrivacyActivity,
  refreshPrivacyStatus,
  revealPrivacyVault,
  setPrivacyStatus,
  usePrivacyActivity,
  usePrivacyStatus,
  usePrivacyVault,
  useUsageData,
} from "~/privacy/privacyClient";
import { AccountRightsSection, LegalDocumentsSection } from "../privacy/AccountRights";
import { ImageHandlingSection, RedactionsSection } from "../privacy/ImageRedaction";
import { PrivacySetup } from "../privacy/PrivacySetup";
import { ProviderMaskingSection } from "../privacy/ProviderMasking";
import { UsageDataSettings } from "../privacy/UsageData";
import { Button } from "../ui/button";
import { SettingsPageContainer, SettingsSection } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";

/** How personal data is kept from the model, what was masked, and the real values behind it. */
export function PrivacySettingsPanel() {
  const gt = useGT();
  const state = usePrivacyStatus();
  const usageData = useUsageData();
  return (
    <SettingsPageContainer>
      <SettingsSection id="privacy-masking" title="Masking">
        <div className="px-4 py-2">
          {state.kind === "ready" ? (
            <PrivacySetup status={state.status} onStatus={setPrivacyStatus} allowTurningOff />
          ) : state.kind === "loading" ? (
            <p className="py-2 text-sm text-muted-foreground">Checking…</p>
          ) : (
            <div className="flex items-center gap-3 py-2">
              <p className="text-sm text-destructive">Could not read the privacy settings.</p>
              <Button variant="outline" size="sm" onClick={refreshPrivacyStatus}>
                Retry
              </Button>
            </div>
          )}
        </div>
      </SettingsSection>
      {state.kind === "ready" ? <ProviderMaskingSection status={state.status} /> : null}
      {state.kind === "ready" ? <ImageHandlingSection status={state.status} /> : null}
      <RedactionsSection />
      <ActivitySection />
      <VaultSection />
      {state.kind === "ready" ? <AccountRightsSection status={state.status} /> : null}
      <SettingsSection {...searchableSetting("usage-data")} title={gt("Usage data")}>
        <UsageDataSettings status={usageData} />
      </SettingsSection>
      {state.kind === "ready" ? <LegalDocumentsSection status={state.status} /> : null}
    </SettingsPageContainer>
  );
}

const OUTCOME_LABELS: Record<PrivacyActivityEntry["outcome"], string> = {
  masked: "Sent, masked",
  passed: "Sent unchanged",
  refused: "Not sent",
  blocked: "Blocked",
};

const TIME_FORMAT = new Intl.DateTimeFormat(undefined, { timeStyle: "medium" });

function ActivitySection() {
  const entries = usePrivacyActivity();
  // Only requests to the AI itself are worth a line; background calls would bury them.
  const shown = (entries ?? []).filter((entry) => entry.outcome !== "passed").slice(0, 50);
  return (
    <SettingsSection
      id="privacy-activity"
      title="Recent requests"
      headerAction={
        <Button variant="ghost" size="sm" onClick={refreshPrivacyActivity}>
          Refresh
        </Button>
      }
    >
      <div className="px-4 py-2">
        {entries === null ? (
          <p className="py-2 text-sm text-muted-foreground">Loading…</p>
        ) : shown.length === 0 ? (
          <p className="py-2 text-sm text-muted-foreground">Nothing yet.</p>
        ) : (
          <ul className="divide-y divide-border/60">
            {shown.map((entry) => (
              <li
                key={`${entry.at}-${entry.host}-${entry.outcome}-${entry.masked}`}
                className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-0.5 py-1.5 text-sm"
              >
                <span className="min-w-0 truncate text-foreground">
                  {OUTCOME_LABELS[entry.outcome]}
                  <span className="text-muted-foreground"> · {entry.host}</span>
                </span>
                <span className="text-xs text-muted-foreground tabular-nums">
                  {entry.outcome === "masked"
                    ? `${entry.masked} masked${entry.withheld > 0 ? `, ${entry.withheld} withheld` : ""} · `
                    : ""}
                  {TIME_FORMAT.format(new Date(entry.at))}
                </span>
                {entry.reason !== null ? (
                  <span className="w-full text-xs text-muted-foreground">{entry.reason}</span>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </div>
    </SettingsSection>
  );
}

function VaultSection() {
  const { entries, loading } = usePrivacyVault();
  const [shown, setShown] = useState(false);
  const visible = shown ? entries : null;
  return (
    <SettingsSection
      id="privacy-vault"
      title="Stand-ins on this computer"
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
          {shown ? "Hide" : "Show"}
        </Button>
      }
    >
      {visible === null ? null : (
        <div className="px-4 py-2">
          {visible.length === 0 ? (
            <p className="py-2 text-sm text-muted-foreground">Nothing masked yet.</p>
          ) : (
            <ul className="max-h-96 divide-y divide-border/60 overflow-y-auto">
              {visible.map((entry) => (
                <li
                  key={entry.token}
                  className="flex items-baseline justify-between gap-4 py-1.5 text-sm"
                >
                  <span className="min-w-0 truncate text-foreground" dir="auto">
                    {entry.value}
                  </span>
                  <code className="shrink-0 text-xs text-muted-foreground">{entry.token}</code>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </SettingsSection>
  );
}
