import type {
  PrivacyProfileField,
  PrivacyProfileRequest,
  PrivacyProfileWorkplace,
  PrivacyStatus,
} from "@t3tools/contracts";
import { useGT } from "gt-react";
import { useState } from "react";

import { CONSENT_WORDS } from "~/doedesk/consentWords";
import { PROFILE_FIELDS, PROFILE_WORKPLACES } from "~/doedesk/profileAnswers";
import { cn } from "~/lib/utils";
import { savePrivacyProfile, useConsentLocale, usePrivacyStatus } from "~/privacy/privacyClient";
import { useSetupText } from "~/onboarding/setupLocale";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { ConsentBlock, ConsentSentence } from "./ConsentText";

const choiceOf = <Value extends string>(
  options: ReadonlyArray<{ readonly value: Value }>,
  value: string | null | undefined,
): Value | null => options.find((option) => option.value === value)?.value ?? null;

/**
 * The two optional questions, so DoeDesk learns who it is being used by. Asked once at the start;
 * from Settings the same form corrects the stored answers or removes them. `stored` is given
 * there: the answers DoeDesk Cloud holds now, or null for none. Setup passes `onAnswersChange`
 * and saves with its own Continue, so the form then shows no buttons.
 */
export function ProfileQuestions({
  onStatus,
  stored,
  onAnswersChange,
}: {
  readonly onStatus: (status: PrivacyStatus) => void;
  readonly stored?: PrivacyStatus["profile"];
  readonly onAnswersChange?: (answers: PrivacyProfileRequest) => void;
}) {
  const gt = useGT();
  const t = useSetupText();
  const correcting = stored !== undefined && onAnswersChange === undefined;
  const [locale] = useConsentLocale();
  const privacy = usePrivacyStatus();
  const legal = privacy.kind === "ready" ? (privacy.status.legal ?? null) : null;
  const [field, setField] = useState<PrivacyProfileField | null>(
    choiceOf(PROFILE_FIELDS, stored?.field),
  );
  const [fieldOther, setFieldOther] = useState("");
  const [workplace, setWorkplace] = useState<PrivacyProfileWorkplace | null>(
    choiceOf(PROFILE_WORKPLACES, stored?.workplace),
  );
  const [busy, setBusy] = useState(false);
  const answers = (next: {
    readonly field: PrivacyProfileField | null;
    readonly fieldOther: string;
    readonly workplace: PrivacyProfileWorkplace | null;
  }): PrivacyProfileRequest => ({
    field: next.field,
    fieldOther:
      next.field === "other" && next.fieldOther.trim().length > 0 ? next.fieldOther.trim() : null,
    workplace: next.workplace,
  });
  const change = (next: Partial<Parameters<typeof answers>[0]>) => {
    const merged = { field, fieldOther, workplace, ...next };
    if (next.field !== undefined) setField(next.field);
    if (next.fieldOther !== undefined) setFieldOther(next.fieldOther);
    if (next.workplace !== undefined) setWorkplace(next.workplace);
    onAnswersChange?.(answers(merged));
  };

  const save = async (answers: PrivacyProfileRequest) => {
    setBusy(true);
    try {
      onStatus(await savePrivacyProfile(answers));
    } catch {
      // The answers are optional. A failed save asks again next time rather than blocking.
    }
    setBusy(false);
  };

  return (
    <div className="grid gap-5 py-2">
      <ConsentBlock locale={locale} className="text-sm text-muted-foreground">
        <ConsentSentence parts={CONSENT_WORDS[locale].onboarding} locale={locale} legal={legal} />
      </ConsentBlock>
      <Question label={t(gt("Your field"), "مجال عملك")}>
        {PROFILE_FIELDS.map((option) => (
          <Chip
            key={option.value}
            selected={field === option.value}
            onSelect={() => change({ field: option.value })}
          >
            {t(option.label, option.labelAr)}
          </Chip>
        ))}
        {field === "other" ? (
          <Input
            autoFocus
            maxLength={80}
            placeholder={t(gt("Your field"), "مجال عملك")}
            aria-label={t(gt("Your field"), "مجال عملك")}
            className="mt-1 sm:max-w-xs"
            value={fieldOther}
            onChange={(event) => change({ fieldOther: event.target.value })}
          />
        ) : null}
      </Question>
      <Question label={t(gt("Where you work"), "جهة عملك")}>
        {PROFILE_WORKPLACES.map((option) => (
          <Chip
            key={option.value}
            selected={workplace === option.value}
            onSelect={() => change({ workplace: option.value })}
          >
            {t(option.label, option.labelAr)}
          </Chip>
        ))}
      </Question>
      {onAnswersChange !== undefined ? null : (
        <div className="flex items-center gap-3">
          <Button
            size="sm"
            disabled={busy || (field === null && workplace === null)}
            onClick={() => void save(answers({ field, fieldOther, workplace }))}
          >
            {gt("Save")}
          </Button>
          <Button
            size="sm"
            variant="ghost-muted"
            // Nothing stored: there is nothing to remove.
            disabled={busy || (correcting && stored === null)}
            onClick={() => void save({ field: null, fieldOther: null, workplace: null })}
          >
            {correcting ? gt("Remove my answers") : gt("Skip")}
          </Button>
        </div>
      )}
    </div>
  );
}

function Question({
  label,
  children,
}: {
  readonly label: string;
  readonly children: React.ReactNode;
}) {
  return (
    <div role="radiogroup" aria-label={label}>
      <p className="pb-2 text-sm text-foreground">{label}</p>
      <div className="flex flex-wrap gap-1.5">{children}</div>
    </div>
  );
}

function Chip({
  selected,
  onSelect,
  children,
}: {
  readonly selected: boolean;
  readonly onSelect: () => void;
  readonly children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      onClick={onSelect}
      className={cn(
        "rounded-full border px-3 py-1 text-sm transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
        selected
          ? "border-primary bg-primary text-primary-foreground"
          : "border-border text-foreground hover:bg-muted",
      )}
    >
      {children}
    </button>
  );
}
