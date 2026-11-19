import { useAtomValue } from "@effect/atom-react";
import type { PrivacyStatus } from "@t3tools/contracts";
import { useState } from "react";

import {
  consumerLoginWarning,
  directRowText,
  maskedRowText,
  maskingNotice,
  maskingNoticeTitle,
  type ProviderWords,
  stopMaskingWarning,
} from "~/doedesk/providerConnections";
import { useDeveloperMode } from "~/doedesk/product";
import { setPrivacyPreference, usePrivacyStatus } from "~/privacy/privacyClient";
import { primaryServerProvidersAtom } from "~/state/server";
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
import { type MaskedProvider, maskedProviders, pendingNotice } from "./ProviderMasking.logic";
import { SettingsRow, SettingsSection } from "../settings/settingsLayout";

function NoticeDialog({
  words,
  open,
  onClose,
}: {
  readonly words: ProviderWords;
  readonly open: boolean;
  readonly onClose: () => void;
}) {
  return (
    <AlertDialog open={open} onOpenChange={(next) => (next ? undefined : onClose())}>
      <AlertDialogPopup>
        <AlertDialogHeader>
          <AlertDialogTitle>{maskingNoticeTitle(words)}</AlertDialogTitle>
          <AlertDialogDescription render={<div />}>
            <ul className="list-disc space-y-2 ps-5 text-start">
              {maskingNotice(words).map((sentence) => (
                <li key={sentence}>{sentence}</li>
              ))}
            </ul>
            <p className="mt-3 text-start">
              To use {words.name} without masking, open Settings, then Privacy.
            </p>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <Button onClick={onClose}>I understand</Button>
        </AlertDialogFooter>
      </AlertDialogPopup>
    </AlertDialog>
  );
}

/**
 * Shows the notice once for each provider, the first time masking is on while the user is signed
 * in to it. Mounted with the chat screens.
 */
export function ProviderMaskingNoticeOnce() {
  const state = usePrivacyStatus();
  const providers = useAtomValue(primaryServerProvidersAtom);
  const pending = state.kind === "ready" ? pendingNotice(state.status, providers) : undefined;
  if (pending === undefined) return null;
  return (
    <NoticeDialog
      key={pending.driver}
      words={pending.words}
      open
      onClose={() => void setPrivacyPreference({ kind: "noticeRead", provider: pending.driver })}
    />
  );
}

function ProviderRow({
  provider,
  direct,
}: {
  readonly provider: MaskedProvider;
  readonly direct: boolean;
}) {
  const [confirming, setConfirming] = useState(false);
  const [reading, setReading] = useState(false);
  const { words, driver } = provider;
  const warning = consumerLoginWarning(driver);
  return (
    <>
      <SettingsRow
        title={words.name}
        description={
          <>
            {direct ? directRowText(words) : maskedRowText(words)}{" "}
            <button
              type="button"
              className="underline underline-offset-2"
              onClick={() => setReading(true)}
            >
              What DoeDesk changes
            </button>
            {warning === undefined ? null : (
              <span className="mt-1 block text-destructive">{warning}</span>
            )}
          </>
        }
        control={
          <Switch
            checked={!direct}
            aria-label={`Mask what ${words.tool} sends to ${words.company}`}
            onCheckedChange={(checked) => {
              if (!checked) {
                setConfirming(true);
                return;
              }
              void setPrivacyPreference({ kind: "providerRoute", provider: driver, direct: false });
            }}
          />
        }
      />
      <NoticeDialog
        words={words}
        open={reading}
        onClose={() => {
          setReading(false);
          void setPrivacyPreference({ kind: "noticeRead", provider: driver });
        }}
      />
      <AlertDialog open={confirming} onOpenChange={setConfirming}>
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>Stop masking {words.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              {stopMaskingWarning(words)} Chats with {words.name} that are running now are stopped,
              so that none keeps the old setting.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" />}>Keep masking</AlertDialogClose>
            <Button
              variant="destructive"
              onClick={() => {
                setConfirming(false);
                void setPrivacyPreference({
                  kind: "providerRoute",
                  provider: driver,
                  direct: true,
                });
              }}
            >
              Stop masking {words.name}
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </>
  );
}

/** Settings, Privacy: masking for one AI company at a time, and Claude Code's usage reports. */
export function ProviderMaskingSection({ status }: { readonly status: PrivacyStatus }) {
  const developerMode = useDeveloperMode();
  // A provider that is not installed, or is signed out, sends nothing: it gets no row.
  const providers = maskedProviders(useAtomValue(primaryServerProvidersAtom)).filter(
    (provider) => provider.setUp,
  );
  if (status.mode === "off" || status.directProviders === undefined) return null;
  const direct = status.directProviders;
  const reportsOn = status.usageReports !== false;
  const switches = Object.entries(status.sessionSwitches ?? {})
    .map(([name, value]) => `${name}=${value}`)
    .join(", ");
  return (
    <SettingsSection id="privacy-providers" title="AI companies">
      {providers.map((provider) => (
        <ProviderRow
          key={provider.driver}
          provider={provider}
          direct={direct.includes(provider.driver)}
        />
      ))}
      <SettingsRow
        title="Claude Code usage reports"
        description={`Claude Code tells Anthropic how it is used: timings and error counts, not your messages or files. ${
          reportsOn ? "DoeDesk leaves these reports on." : "DoeDesk turns these reports off."
        }`}
        control={
          <Switch
            checked={reportsOn}
            aria-label="Let Claude Code send usage reports to Anthropic"
            onCheckedChange={(checked) =>
              void setPrivacyPreference({ kind: "usageReports", send: Boolean(checked) })
            }
          />
        }
      >
        <p className="px-4 pb-3 text-xs text-muted-foreground">
          {developerMode
            ? `For a masked chat DoeDesk sets these Claude Code switches and no others: ${switches}.`
            : "For a masked chat, DoeDesk turns off the parts of Claude Code that would send your text to Anthropic unmasked: error reports, feedback, published artifacts and claude.ai connectors."}
        </p>
      </SettingsRow>
    </SettingsSection>
  );
}
