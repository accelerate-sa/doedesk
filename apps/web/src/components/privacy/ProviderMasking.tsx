import { useAtomValue } from "@effect/atom-react";
import type { PrivacyStatus } from "@t3tools/contracts";
import { isolateLeftToRight } from "@t3tools/shared/textDirection";
import { T, useGT, useMessages, Var } from "gt-react";
import { useState } from "react";

import {
  consumerLoginWarning,
  directRowText,
  maskedRowText,
  maskingNotice,
  maskingNoticeTitle,
  type ProviderWords,
  resolveProviderWords,
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
  const resolve = useMessages();
  const { name } = resolveProviderWords(words, resolve);
  return (
    <AlertDialog open={open} onOpenChange={(next) => (next ? undefined : onClose())}>
      <AlertDialogPopup>
        <AlertDialogHeader>
          <AlertDialogTitle>{maskingNoticeTitle(words, resolve)}</AlertDialogTitle>
          <AlertDialogDescription render={<div />}>
            <ul className="list-disc space-y-2 ps-5 text-start">
              {maskingNotice(words, resolve).map((sentence) => (
                <li key={sentence}>{sentence}</li>
              ))}
            </ul>
            <p className="mt-3 text-start">
              <T>
                To use <Var>{name}</Var> without masking, open Settings, then Privacy.
              </T>
            </p>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <Button onClick={onClose}>
            <T>I understand</T>
          </Button>
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
  const gt = useGT();
  const resolve = useMessages();
  const [confirming, setConfirming] = useState(false);
  const [reading, setReading] = useState(false);
  const { words, driver } = provider;
  const { name, tool, company } = resolveProviderWords(words, resolve);
  const warning = consumerLoginWarning(driver, resolve);
  return (
    <>
      <SettingsRow
        title={name}
        description={
          <>
            {direct ? directRowText(words, resolve) : maskedRowText(words, resolve)}{" "}
            <button
              type="button"
              className="underline underline-offset-2"
              onClick={() => setReading(true)}
            >
              {gt("What DoeDesk changes")}
            </button>
            {warning === undefined ? null : (
              <span className="mt-1 block text-destructive">{warning}</span>
            )}
          </>
        }
        control={
          <Switch
            checked={!direct}
            aria-label={gt("Mask what {tool} sends to {company}", { tool, company })}
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
            <AlertDialogTitle>{gt("Stop masking {name}?", { name })}</AlertDialogTitle>
            <AlertDialogDescription>
              {stopMaskingWarning(words, resolve)}{" "}
              {gt(
                "Chats with {name} that are running now are stopped, so that none keeps the old setting.",
                { name },
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" />}>
              {gt("Keep masking")}
            </AlertDialogClose>
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
              {gt("Stop masking {name}", { name })}
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </>
  );
}

/** Settings, Privacy: masking for one AI company at a time, and Claude Code's usage reports. */
export function ProviderMaskingSection({ status }: { readonly status: PrivacyStatus }) {
  const gt = useGT();
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
    <SettingsSection id="privacy-providers" title={gt("AI companies")}>
      {providers.map((provider) => (
        <ProviderRow
          key={provider.driver}
          provider={provider}
          direct={direct.includes(provider.driver)}
        />
      ))}
      <SettingsRow
        title={gt("Claude Code usage reports")}
        description={
          reportsOn
            ? gt(
                "Claude Code tells Anthropic how it is used: timings and error counts, not your messages or files. DoeDesk leaves these reports on.",
              )
            : gt(
                "Claude Code tells Anthropic how it is used: timings and error counts, not your messages or files. DoeDesk turns these reports off.",
              )
        }
        control={
          <Switch
            checked={reportsOn}
            aria-label={gt("Let Claude Code send usage reports to Anthropic")}
            onCheckedChange={(checked) =>
              void setPrivacyPreference({ kind: "usageReports", send: Boolean(checked) })
            }
          />
        }
      >
        <p className="px-4 pb-3 text-xs text-muted-foreground">
          {developerMode
            ? gt(
                "For a masked chat DoeDesk sets these Claude Code switches and no others: {switches}.",
                {
                  switches: isolateLeftToRight(switches),
                },
              )
            : gt(
                "For a masked chat, DoeDesk turns off the parts of Claude Code that would send your text to Anthropic unmasked: error reports, feedback, published artifacts and claude.ai connectors.",
              )}
        </p>
      </SettingsRow>
    </SettingsSection>
  );
}
