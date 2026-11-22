import type {
  PrivacyConfigureRequest,
  PrivacyProfileRequest,
  PrivacyStatus,
  UsageDataStatus,
} from "@t3tools/contracts";
import { CheckIcon } from "lucide-react";
import { useState } from "react";

import { NOT_WORKED, UNREACHABLE, usePrivacyMessage } from "~/doedesk/privacyMessages";
import type { MaskingChoice, SetupLocale } from "~/onboarding/onboardingSteps.logic";
import { useSetupText } from "~/onboarding/setupLocale";
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
  const t = useSetupText();
  return (
    <div className="grid gap-3">
      <p className="text-sm text-muted-foreground">
        {t(
          "Choose a language for setup. It takes a few steps, and you can go back at any time.",
          "اختر لغة الإعداد. لن يستغرق الأمر سوى خطوات قليلة، ويمكنك الرجوع إلى أي خطوة متى شئت.",
        )}
      </p>
      <div
        role="radiogroup"
        aria-label={t("Setup language", "لغة الإعداد")}
        className="grid gap-2 sm:max-w-sm"
      >
        <ChoiceCard
          selected={locale === "en"}
          title="English"
          lang="en"
          onSelect={() => onLocale("en")}
        />
        <ChoiceCard
          selected={locale === "ar"}
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
  const t = useSetupText();
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
      <div
        role="radiogroup"
        aria-label={t("Detection service", "خدمة الكشف")}
        className="grid gap-2"
      >
        <ChoiceCard
          selected={selected === "account"}
          title={t("Use a DoeDesk account", "استخدام حساب DoeDesk")}
          detail={t(
            "Recommended. Text and files are checked on DoeDesk's server in Saudi Arabia and are not stored. Sign in or create an account in the next step.",
            "الخيار الموصى به. يفحص خادم DoeDesk داخل المملكة النصوص والملفات دون تخزينها. سجّل الدخول أو أنشئ حسابًا في الخطوة التالية.",
          )}
          onSelect={() => onChoice("account")}
        />
        <ChoiceCard
          selected={selected === "ownService"}
          title={t("Use my own detection service", "استخدام خدمة كشف خاصة بي")}
          detail={t(
            "For teams or organizations that host their own detection server. Text and files are sent only to the address you enter.",
            "للفرق والجهات التي تشغّل خادم الكشف الخاص بها. يقتصر إرسال النصوص والملفات للفحص على العنوان الذي تحدده.",
          )}
          onSelect={() => onChoice("ownService")}
        />
        {refused ? (
          <ChoiceCard
            selected={selected === "off"}
            title={t("Continue without masking", "المتابعة دون إخفاء البيانات")}
            detail={t(
              "Everything you send, including messages and files, reaches the AI as written.",
              "تصل جميع رسائلك وملفاتك إلى الذكاء الاصطناعي كما هي، دون إخفاء أي بيانات.",
            )}
            onSelect={() => onChoice("off")}
          />
        ) : null}
      </div>
      {selected === "ownService" ? <OwnServiceForm busy={busy} onSubmit={configure} /> : null}
      {selected === "off" ? (
        <div>
          <Button size="sm" disabled={busy} onClick={() => void configure({ mode: "off" })}>
            {t("Use DoeDesk without masking", "استخدام DoeDesk دون إخفاء البيانات")}
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
  const t = useSetupText();
  return (
    <div className="flex flex-wrap items-center gap-3">
      <p className="text-sm text-destructive">
        {t(
          "Could not reach the DoeDesk service on this computer.",
          "تعذّر الاتصال بخدمة DoeDesk على هذا الجهاز.",
        )}
      </p>
      <Button variant="outline" size="sm" onClick={refreshPrivacyStatus}>
        {t("Try again", "أعد المحاولة")}
      </Button>
    </div>
  );
}

/**
 * Signing in creates the account and records the Terms on the first go. Neither can be undone by
 * going back, so once signed in the step shows where the account stands instead of the form.
 */
export function AccountStep({ status }: { readonly status: PrivacyStatus | null }) {
  const t = useSetupText();
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
          {t("Signed in as", "سجّلت الدخول بحساب")} <bdi>{status.accountLabel ?? ""}</bdi>
        </span>
      </p>
      {outstanding ? (
        <p className="text-sm text-muted-foreground">
          {t(
            "Accept the updated Terms of Use to continue.",
            "وافق على شروط الاستخدام المحدّثة للمتابعة.",
          )}
        </p>
      ) : (
        <p className="flex items-center gap-2 text-sm text-foreground">
          <CheckIcon className="size-4 shrink-0 text-success-foreground" />
          {t("Terms of Use accepted", "وافقت على شروط الاستخدام")}
        </p>
      )}
      <p className="text-xs text-muted-foreground">
        {t(
          "To switch accounts, sign out in Settings → Privacy.",
          "للتبديل إلى حساب آخر، سجّل الخروج من الإعدادات، قسم الخصوصية.",
        )}
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
