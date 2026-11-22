import type {
  PrivacyConfigureRequest,
  PrivacyProfileRequest,
  PrivacyStatus,
  UsageDataStatus,
} from "@t3tools/contracts";
import { T, useGT, Var } from "gt-react";
import { CheckIcon } from "lucide-react";
import { useState } from "react";

import { NOT_WORKED, UNREACHABLE, usePrivacyMessage } from "~/doedesk/privacyMessages";
import type { MaskingChoice, SetupLocale } from "~/onboarding/onboardingSteps.logic";
import {
  configurePrivacy,
  isPrivacyDecided,
  refreshPrivacyStatus,
  setPrivacyStatus,
  useSignInOptions,
} from "~/privacy/privacyClient";
import { cn } from "~/lib/utils";
import { CloudSignIn, OwnServiceForm, PrivacySetup } from "../privacy/PrivacySetup";
import { ProfileQuestions } from "../privacy/ProfileQuestions";
import { termsAcceptanceDue } from "../privacy/TermsAcceptanceSheet";
import { UsageDataChoice } from "../privacy/UsageData";
import { Button } from "../ui/button";

/** One choice among a step's options, as a large radio. */
function ChoiceCard({
  selected,
  title,
  detail,
  lang,
  onSelect,
}: {
  readonly selected: boolean;
  readonly title: string;
  readonly detail?: string;
  readonly lang?: string;
  readonly onSelect: () => void;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      lang={lang}
      onClick={onSelect}
      className={cn(
        "flex w-full items-start gap-3 rounded-lg border px-4 py-3 text-start transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
        selected ? "border-primary bg-primary/5" : "border-border hover:bg-muted/60",
      )}
    >
      <span
        className={cn(
          "mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full border",
          selected ? "border-primary bg-primary text-primary-foreground" : "border-input",
        )}
      >
        {selected ? <CheckIcon className="size-3" /> : null}
      </span>
      <span className="min-w-0">
        <span className="block text-sm font-medium text-foreground">{title}</span>
        {detail ? (
          <span className="mt-0.5 block text-xs leading-relaxed text-muted-foreground">
            {detail}
          </span>
        ) : null}
      </span>
    </button>
  );
}

export function LanguageStep({
  locale,
  onLocale,
}: {
  readonly locale: SetupLocale;
  readonly onLocale: (locale: SetupLocale) => void;
}) {
  const gt = useGT();
  return (
    <div className="grid gap-3">
      <p className="text-sm text-muted-foreground">
        {gt(
          "Choose your language for DoeDesk. Setup takes a few steps, and you can change this later in Settings.",
        )}
      </p>
      <div role="radiogroup" aria-label={gt("App language")} className="grid gap-2 sm:max-w-sm">
        <ChoiceCard
          selected={locale === "en"}
          // oxlint-disable-next-line t3code/no-untranslated-copy -- each language is named in itself
          title="English"
          lang="en"
          onSelect={() => onLocale("en")}
        />
        <ChoiceCard
          selected={locale === "ar"}
          // oxlint-disable-next-line t3code/no-untranslated-copy -- each language is named in itself
          title="العربية"
          lang="ar"
          onSelect={() => onLocale("ar")}
        />
      </div>
    </div>
  );
}

/**
 * How names and numbers are found: a DoeDesk account, a detection service of one's own, or, only
 * where no account can be made here, no masking. Once one is in place the step shows it, and
 * changing it means signing out or disconnecting first.
 */
export function MaskingStep({
  status,
  choice,
  onChoice,
}: {
  readonly status: PrivacyStatus | null;
  readonly choice: MaskingChoice | null;
  readonly onChoice: (choice: MaskingChoice) => void;
}) {
  const gt = useGT();
  const m = usePrivacyMessage();
  const options = useSignInOptions();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (status === null) return <PrivacyUnavailable />;
  if (isPrivacyDecided(status)) {
    return <PrivacySetup status={status} onStatus={setPrivacyStatus} />;
  }

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
  // Without masking is offered only where DoeDesk Cloud will not open an account from here.
  const refused = options?.signUpAvailable === false;
  const selected = choice ?? "account";

  return (
    <div className="grid gap-4">
      <div role="radiogroup" aria-label={gt("Detection service")} className="grid gap-2">
        <ChoiceCard
          selected={selected === "account"}
          title={gt("Use a DoeDesk account")}
          detail={gt(
            "Recommended. Text and files are checked on DoeDesk's server in Saudi Arabia and are not stored. Sign in or create an account in the next step.",
          )}
          onSelect={() => onChoice("account")}
        />
        <ChoiceCard
          selected={selected === "ownService"}
          title={gt("Use my own detection service")}
          detail={gt(
            "For teams or organizations that host their own detection server. Text and files are sent only to the address you enter.",
          )}
          onSelect={() => onChoice("ownService")}
        />
        {refused ? (
          <ChoiceCard
            selected={selected === "off"}
            title={gt("Continue without masking")}
            detail={gt(
              "Everything you send, including messages and files, reaches the AI as written.",
            )}
            onSelect={() => onChoice("off")}
          />
        ) : null}
      </div>
      {selected === "ownService" ? <OwnServiceForm busy={busy} onSubmit={configure} /> : null}
      {selected === "off" ? (
        <div>
          <Button size="sm" disabled={busy} onClick={() => void configure({ mode: "off" })}>
            {gt("Use DoeDesk without masking")}
          </Button>
        </div>
      ) : null}
      {error !== null ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  );
}

function PrivacyUnavailable() {
  const gt = useGT();
  return (
    <div className="flex flex-wrap items-center gap-3">
      <p className="text-sm text-destructive">
        {gt("Could not reach the DoeDesk service on this computer.")}
      </p>
      <Button variant="outline" size="sm" onClick={refreshPrivacyStatus}>
        {gt("Try again")}
      </Button>
    </div>
  );
}

/**
 * Signing in creates the account and records the Terms on the first go. Neither can be undone by
 * going back, so once signed in the step shows where the account stands instead of the form.
 */
export function AccountStep({ status }: { readonly status: PrivacyStatus | null }) {
  const gt = useGT();
  const options = useSignInOptions();
  if (status === null) return <PrivacyUnavailable />;
  if (status.mode !== "cloud") {
    return (
      <CloudSignIn
        options={options}
        // Without an answer just now, the versions in force are not known: none are shown.
        legal={options?.reached === true ? (status.legal ?? null) : null}
        onStatus={setPrivacyStatus}
      />
    );
  }
  const outstanding = termsAcceptanceDue(status);
  return (
    <div className="grid gap-2">
      <p className="flex items-center gap-2 text-sm text-foreground">
        <CheckIcon className="size-4 shrink-0 text-success-foreground" />
        <span>
          <T>
            Signed in as{" "}
            <bdi>
              <Var>{status.accountLabel ?? ""}</Var>
            </bdi>
          </T>
        </span>
      </p>
      {outstanding ? (
        <p className="text-sm text-muted-foreground">
          {gt("Accept the updated Terms of Use to continue.")}
        </p>
      ) : (
        <p className="flex items-center gap-2 text-sm text-foreground">
          <CheckIcon className="size-4 shrink-0 text-success-foreground" />
          {gt("Terms of Use accepted")}
        </p>
      )}
      <p className="text-xs text-muted-foreground">
        {gt("To switch accounts, sign out in Settings → Privacy.")}
      </p>
    </div>
  );
}

export function ProfileStep({
  status,
  onAnswersChange,
}: {
  readonly status: PrivacyStatus;
  readonly onAnswersChange: (answers: PrivacyProfileRequest) => void;
}) {
  return (
    <ProfileQuestions
      onStatus={setPrivacyStatus}
      stored={status.profile ?? null}
      onAnswersChange={onAnswersChange}
    />
  );
}

export function UsageDataStep({ status }: { readonly status: UsageDataStatus | null }) {
  return status === null ? null : <UsageDataChoice status={status} />;
}
