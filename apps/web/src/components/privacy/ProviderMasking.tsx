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
import { useThreadShells } from "~/state/entities";
import { usePrimaryEnvironmentId } from "~/state/environments";
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
import {
  driversInUse,
  type MaskedProvider,
  maskedProviders,
  pendingNotice,
  unreadNotices,
} from "./ProviderMasking.logic";
import { settleProviderNotice, useProviderNoticeGate } from "./providerNoticeGate";
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
                To use <Var>{name}</Var> without de-identification, open Settings, then Privacy.
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
 * Shows a provider's notice once, when a chat with that provider starts: at the first Send to
 * it, before the message goes, or when a chat with it already exists. It is not shown for every
 * signed-in provider on load. Reading it is recorded on the server.
 */
export function ProviderMaskingNoticeOnce() {
  const state = usePrivacyStatus();
  const providers = useAtomValue(primaryServerProvidersAtom);
  const primary = usePrimaryEnvironmentId();
  const asked = useProviderNoticeGate((gate) => gate.asked?.driver ?? null);
  const unread = state.kind === "ready" ? unreadNotices(state.status, providers) : [];
  // The list of chats changes often, so it is read only while a notice is still unread.
  const chats = useThreadShells(unread.length > 0);
  const pending =
    state.kind === "ready"
      ? pendingNotice(state.status, providers, driversInUse(chats, providers, primary), asked)
      : undefined;
  if (pending === undefined) return null;
  const { driver } = pending;
  return (
    <NoticeDialog
      key={driver}
      words={pending.words}
      open
      onClose={() =>
        void setPrivacyPreference({ kind: "noticeRead", provider: driver }).then(
          () => settleProviderNotice(driver, true),
          () => settleProviderNotice(driver, false),
        )
      }
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
              className="rounded-sm underline underline-offset-2 outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
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
            aria-label={gt("De-identify what {tool} sends to {company}", { tool, company })}
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
            <AlertDialogTitle>{gt("Stop de-identifying {name}?", { name })}</AlertDialogTitle>
            <AlertDialogDescription>
              {stopMaskingWarning(words, resolve)}{" "}
              {gt("Running chats with {name} are stopped.", { name })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" />}>
              {gt("Keep de-identifying")}
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
              {gt("Stop de-identifying {name}", { name })}
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </>
  );
}

/** Settings, Privacy: de-identification for one AI company at a time, and Claude Code's usage reports. */
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
        description={gt(
          "Timings and error counts sent to Anthropic. Never your messages or files.",
        )}
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
            ? gt("De-identified chats set only these Claude Code switches: {switches}.", {
                switches: isolateLeftToRight(switches),
              })
            : gt(
                "De-identified chats also turn off Claude Code's error reports, feedback, published artifacts and claude.ai connectors.",
              )}
        </p>
      </SettingsRow>
    </SettingsSection>
  );
}
