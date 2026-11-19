import type { PrivacyLegal, PrivacyLocale, UsageDataStatus } from "@t3tools/contracts";
import { useGT } from "gt-react";
import { CheckIcon, CopyIcon } from "lucide-react";
import { useContext, useId, useState } from "react";

import {
  CONSENT_WORDS,
  USAGE_DATA_CHOICE_WORDING_ID,
  USAGE_DATA_NOTICE_WORDING_ID,
  USAGE_DATA_SETTINGS_WORDING_ID,
} from "~/doedesk/consentWords";
import { useCopyToClipboard } from "~/hooks/useCopyToClipboard";
import { SetupLocaleContext } from "~/onboarding/setupLocale";
import { setUsageData, useConsentLocale, usePrivacyStatus } from "~/privacy/privacyClient";
import { managedTelemetryOffMessage, usePrimaryManagedPolicy } from "~/state/managedPolicy";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { Switch } from "../ui/switch";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { SettingsRow } from "../settings/settingsLayout";
import { ConsentBlock, ConsentLanguageSwitch, ConsentSentence } from "./ConsentText";

/** True while the person has not yet seen the choice or the notice, and one can be shown. */
export const usageDataChoiceDue = (status: UsageDataStatus | null): boolean =>
  status !== null && status.state === "unset" && status.basis !== null && status.blockedBy === null;

/**
 * Records what leaving the first-run screen means when the person changed nothing: where usage
 * data is on by default, that the notice was shown; where it needs agreement, that none was given.
 */
export const settleUsageDataFirstRun = async (
  status: UsageDataStatus | null,
  locale: PrivacyLocale,
): Promise<void> => {
  if (!usageDataChoiceDue(status)) return;
  await (status?.basis === "notice"
    ? setUsageData({ action: "noticeShown", wordingId: USAGE_DATA_NOTICE_WORDING_ID, locale })
    : setUsageData({
        action: "choose",
        on: false,
        wordingId: USAGE_DATA_CHOICE_WORDING_ID,
        locale,
      }));
};

const useLegal = (): PrivacyLegal | null => {
  const privacy = usePrivacyStatus();
  return privacy.kind === "ready" ? (privacy.status.legal ?? null) : null;
};

/**
 * The first-run words about usage data. Where the law requires agreement first, an unticked box;
 * elsewhere, a notice that it is on, with the switch. Either works on the spot, and the screen's
 * own button continues whatever the person does here.
 */
export function UsageDataChoice({ status }: { readonly status: UsageDataStatus }) {
  const controlId = useId();
  const [locale, setLocale, consentSwitchOffered] = useConsentLocale();
  // Setup chose its language on its first step, and the consent words follow that choice.
  const inSetup = useContext(SetupLocaleContext) !== null;
  const languageOffered = consentSwitchOffered && !inSetup;
  const legal = useLegal();
  const [busy, setBusy] = useState(false);
  const words = CONSENT_WORDS[locale];
  const ask = status.basis === "ask";
  const wordingId = ask ? USAGE_DATA_CHOICE_WORDING_ID : USAGE_DATA_NOTICE_WORDING_ID;
  // Before anything is recorded, the notice shows the switch as it will be: on.
  const on = status.state === "unset" ? !ask : status.sending;

  const choose = async (next: boolean) => {
    setBusy(true);
    await setUsageData({ action: "choose", on: next, wordingId, locale }).catch(() => undefined);
    setBusy(false);
  };

  return (
    // Start-aligned in its own language, whatever the dialog or page around it does.
    <div className="grid gap-2 text-start">
      <ConsentBlock locale={locale} className="flex items-start gap-2.5 text-sm">
        {ask ? (
          <span className="flex h-[1lh] shrink-0 items-center">
            <Checkbox
              id={controlId}
              checked={on}
              disabled={busy}
              onCheckedChange={(checked) => void choose(checked === true)}
            />
          </span>
        ) : null}
        <label htmlFor={controlId} className="min-w-0 flex-1 text-muted-foreground">
          <ConsentSentence
            parts={ask ? words.usageChoice : words.usageNotice}
            locale={locale}
            legal={legal}
          />
        </label>
        {ask ? null : (
          // The switch slides the same way in both languages.
          <span dir="ltr" className="flex h-[1lh] shrink-0 items-center">
            <Switch
              id={controlId}
              checked={on}
              disabled={busy}
              aria-label={words.usageSwitch}
              onCheckedChange={(checked) => void choose(Boolean(checked))}
            />
          </span>
        )}
      </ConsentBlock>
      {languageOffered ? (
        <div dir={locale === "ar" ? "rtl" : undefined}>
          <ConsentLanguageSwitch locale={locale} onChange={setLocale} />
        </div>
      ) : null}
    </div>
  );
}

/**
 * Shows the choice or the notice once to an installation that is already set up: after the update
 * that introduced it, and again if usage data was on only by default and the device is now in a
 * place that needs agreement first.
 */
export function UsageDataChoiceOnce({
  status,
  onDone,
}: {
  readonly status: UsageDataStatus;
  readonly onDone: () => void;
}) {
  const gt = useGT();
  const [locale] = useConsentLocale();
  const [busy, setBusy] = useState(false);
  return (
    <AlertDialog open>
      <AlertDialogPopup>
        <AlertDialogHeader>
          <AlertDialogTitle>{gt("Usage data")}</AlertDialogTitle>
          <UsageDataChoice status={status} />
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogAction
            disabled={busy}
            onClick={() => {
              setBusy(true);
              void settleUsageDataFirstRun(status, locale)
                .catch(() => undefined)
                .then(onDone);
            }}
          >
            {gt("Continue")}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogPopup>
    </AlertDialog>
  );
}

/** Settings, Privacy: the usage-data switch, what it covers, and the installation identifier. */
export function UsageDataSettings({ status }: { readonly status: UsageDataStatus | null }) {
  const gt = useGT();
  const [locale] = useConsentLocale();
  const legal = useLegal();
  const policyOff = managedTelemetryOffMessage(usePrimaryManagedPolicy());
  const { copyToClipboard, isCopied } = useCopyToClipboard();
  const [busy, setBusy] = useState(false);
  const words = CONSENT_WORDS[locale];

  if (status === null) {
    return <p className="px-4 py-3 text-sm text-muted-foreground">{gt("Checking…")}</p>;
  }
  if (status.blockedBy !== null) {
    return (
      <p className="px-4 py-3 text-sm text-muted-foreground">
        {policyOff ??
          gt(
            "This computer's settings turn usage data off. DoeDesk sends none, whatever is chosen here.",
          )}
      </p>
    );
  }
  return (
    <SettingsRow
      title={<ConsentBlock locale={locale}>{words.usageSwitch}</ConsentBlock>}
      description={
        <ConsentBlock locale={locale}>
          <ConsentSentence
            parts={[`${words.usageSettings} `, { link: "privacy", text: words.usageDetails }]}
            locale={locale}
            legal={legal}
          />
        </ConsentBlock>
      }
      control={
        <Switch
          checked={status.sending}
          disabled={busy}
          aria-label={words.usageSwitch}
          onCheckedChange={(checked) => {
            setBusy(true);
            void setUsageData({
              action: "choose",
              on: Boolean(checked),
              wordingId: USAGE_DATA_SETTINGS_WORDING_ID,
              locale,
            })
              .catch(() => undefined)
              .then(() => setBusy(false));
          }}
        />
      }
    >
      {status.installId === null ? null : (
        <div className="grid min-w-0 gap-1 px-3 pb-3 sm:px-4">
          <ConsentBlock locale={locale} className="text-xs text-muted-foreground">
            {words.installationIdentifier}
          </ConsentBlock>
          <div className="flex min-w-0 items-center gap-1.5">
            {/* Shown whole, on two lines if need be: it is there to be quoted. */}
            <code className="min-w-0 text-xs break-all text-foreground">{status.installId}</code>
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    aria-label={gt("Copy the installation identifier")}
                    onClick={() => copyToClipboard(status.installId ?? "", undefined)}
                  />
                }
              >
                {isCopied ? <CheckIcon /> : <CopyIcon />}
              </TooltipTrigger>
              <TooltipPopup>{isCopied ? gt("Copied") : gt("Copy")}</TooltipPopup>
            </Tooltip>
          </div>
        </div>
      )}
    </SettingsRow>
  );
}
