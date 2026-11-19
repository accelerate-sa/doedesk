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
 * there: the answers DoeDesk Cloud holds now, or null for none.
 */
export function ProfileQuestions({
  onStatus,
  stored,
}: {
  readonly onStatus: (status: PrivacyStatus) => void;
  readonly stored?: PrivacyStatus["profile"];
}) {
  const gt = useGT();
  const correcting = stored !== undefined;
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
      <Question label={gt("Your field")}>
        {PROFILE_FIELDS.map((option) => (
          <Chip
            key={option.value}
            selected={field === option.value}
            onSelect={() => setField(option.value)}
          >
            {option.label}
          </Chip>
        ))}
        {field === "other" ? (
          <Input
            autoFocus
            maxLength={80}
            placeholder={gt("Your field")}
            aria-label={gt("Your field")}
            className="mt-1 sm:max-w-xs"
            value={fieldOther}
            onChange={(event) => setFieldOther(event.target.value)}
          />
        ) : null}
      </Question>
      <Question label={gt("Where you work")}>
        {PROFILE_WORKPLACES.map((option) => (
          <Chip
            key={option.value}
            selected={workplace === option.value}
            onSelect={() => setWorkplace(option.value)}
          >
            {option.label}
          </Chip>
        ))}
      </Question>
      <div className="flex items-center gap-3">
        <Button
          size="sm"
          disabled={busy || (field === null && workplace === null)}
          onClick={() =>
            void save({
              field,
              fieldOther:
                field === "other" && fieldOther.trim().length > 0 ? fieldOther.trim() : null,
              workplace,
            })
          }
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
