import type { PrivacyConfigureRequest, PrivacyStatus } from "@t3tools/contracts";
import { useGT, useMessages } from "gt-react";
import { useId, useState } from "react";

import { CONSENT_WORDS, TERMS_SHEET_WORDING_ID } from "~/doedesk/consentWords";
import { CLOUD_MESSAGES, LEGAL_UNKNOWN, NOT_WORKED, UNREACHABLE } from "~/doedesk/privacyMessages";
import { cn } from "~/lib/utils";
import {
  accountAction,
  configurePrivacy,
  setPrivacyStatus,
  useConsentLocale,
} from "~/privacy/privacyClient";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { ConsentBlock, ConsentLanguageSwitch, ConsentSentence } from "./ConsentText";
import { OwnServiceForm } from "./PrivacySetup";

const usesCloudService = (status: PrivacyStatus): boolean =>
  status.providers === undefined ||
  status.providers.ocr.provider === "doedeskCloud" ||
  status.providers.detect.provider === "doedeskCloud" ||
  status.providers.worker.provider === "doedeskCloud";

/** True when the signed-in account uses DoeDesk Cloud and has not accepted the Terms of Use required now. */
export const termsAcceptanceDue = (status: PrivacyStatus): boolean =>
  status.mode === "cloud" && status.acceptance?.outstanding === true && usesCloudService(status);

/**
 * Asks a signed-in account to accept the Terms of Use: an account from before the checkbox
 * existed, or one whose acceptance is for an older version. While DoeDesk Cloud still serves the
 * account the sheet can be closed and comes back at the next start; once DoeDesk Cloud refuses
 * to check requests, it stays until the person accepts, signs out, or connects their own service.
 */
export function TermsAcceptanceSheet({
  status,
  onLater,
}: {
  readonly status: PrivacyStatus;
  /** Closes the sheet without an answer. Absent when DoeDesk Cloud refuses the account's requests. */
  readonly onLater: (() => void) | undefined;
}) {
  const gt = useGT();
  const m = useMessages();
  const checkboxId = useId();
  const [locale, setLocale, languageOffered] = useConsentLocale();
  const words = CONSENT_WORDS[locale];
  const [ticked, setTicked] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ownService, setOwnService] = useState(false);
  const legal = status.legal ?? null;
  // No earlier acceptance: the account is from before DoeDesk had these documents.
  const first = (status.acceptance?.termsVersion ?? null) === null;

  const accept = async () => {
    if (legal === null) return;
    setBusy(true);
    setError(null);
    const result = await accountAction({
      action: "accept",
      acceptance: {
        termsVersion: legal.terms.version,
        privacyVersion: legal.privacy.version,
        locale,
        wordingId: TERMS_SHEET_WORDING_ID,
      },
    }).catch(() => null);
    setBusy(false);
    if (result === null) {
      setError(m(UNREACHABLE));
      return;
    }
    if (result.ok) return;
    const known = result.code === null ? undefined : CLOUD_MESSAGES[result.code];
    setError(known === undefined ? (result.message ?? m(NOT_WORKED)) : m(known));
    // The documents changed under the sheet: the links are new, so the box is empty again.
    if (result.code === "terms_outdated") setTicked(false);
  };

  const configure = async (payload: PrivacyConfigureRequest) => {
    setBusy(true);
    setError(null);
    const result = await configurePrivacy(payload).catch(() => null);
    setBusy(false);
    if (result === null) {
      setError(m(UNREACHABLE));
      return;
    }
    setPrivacyStatus(result.status);
    if (!result.ok) setError(result.message ?? m(NOT_WORKED));
  };

  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : onLater?.())}>
      <DialogPopup showCloseButton={onLater !== undefined}>
        <DialogHeader>
          {/* In Arabic the title starts on the side the close button is on: leave it room. */}
          <ConsentBlock
            locale={locale}
            className={cn("grid gap-2", locale === "ar" && onLater !== undefined && "ps-8")}
          >
            <DialogTitle>{first ? words.sheetFirstTitle : words.sheetUpdatedTitle}</DialogTitle>
            <DialogDescription>
              {first ? words.sheetFirstLead : words.sheetUpdatedLead}
            </DialogDescription>
          </ConsentBlock>
        </DialogHeader>
        <DialogPanel>
          {status.acceptance?.blocked === true ? (
            <p className="text-sm text-foreground">{m(CLOUD_MESSAGES.terms_update_required!)}</p>
          ) : null}
          {legal === null ? (
            <p className="text-sm text-muted-foreground">{m(LEGAL_UNKNOWN)}</p>
          ) : (
            <ConsentBlock locale={locale} className="flex items-start gap-2.5 text-sm">
              <span className="flex h-[1lh] shrink-0 items-center">
                <Checkbox
                  id={checkboxId}
                  checked={ticked}
                  onCheckedChange={(checked) => {
                    setTicked(checked === true);
                    setError(null);
                  }}
                />
              </span>
              <label htmlFor={checkboxId} className="min-w-0 text-foreground">
                <ConsentSentence parts={words.checkbox} locale={locale} legal={legal} />
              </label>
            </ConsentBlock>
          )}
          {languageOffered ? (
            <div dir={locale === "ar" ? "rtl" : undefined}>
              <ConsentLanguageSwitch locale={locale} onChange={setLocale} />
            </div>
          ) : null}
          {ownService ? (
            <div className="border-t border-border/60 pt-4">
              <OwnServiceForm busy={busy} onSubmit={configure} />
            </div>
          ) : null}
          {error !== null ? (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          ) : null}
        </DialogPanel>
        <DialogFooter>
          <Button
            variant="ghost"
            disabled={busy}
            onClick={() => void configure({ mode: "unconfigured" })}
          >
            <span lang={locale} className={locale === "ar" ? "font-reading" : undefined}>
              {words.signOut}
            </span>
          </Button>
          <Button variant="ghost" disabled={busy} onClick={() => setOwnService(!ownService)}>
            <span lang={locale} className={locale === "ar" ? "font-reading" : undefined}>
              {ownService ? gt("Hide the service address") : words.ownService}
            </span>
          </Button>
          <Button disabled={busy || !ticked || legal === null} onClick={() => void accept()}>
            <span lang={locale} className={locale === "ar" ? "font-reading" : undefined}>
              {words.agreeAndContinue}
            </span>
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
