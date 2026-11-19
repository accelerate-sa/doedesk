import type { PrivacyProfileField, PrivacyProfileWorkplace } from "@t3tools/contracts";

/** The two onboarding questions' choices, in the order they are offered. */
export const PROFILE_FIELDS: ReadonlyArray<{
  readonly value: PrivacyProfileField;
  readonly label: string;
}> = [
  { value: "legal", label: "Legal" },
  { value: "finance", label: "Finance" },
  { value: "government", label: "Government services" },
  { value: "healthcare", label: "Healthcare" },
  { value: "hr", label: "Human resources" },
  { value: "real_estate", label: "Real estate" },
  { value: "consulting", label: "Consulting" },
  { value: "engineering", label: "Engineering and IT" },
  { value: "research", label: "Research and education" },
  { value: "other", label: "Other" },
];

export const PROFILE_WORKPLACES: ReadonlyArray<{
  readonly value: PrivacyProfileWorkplace;
  readonly label: string;
}> = [
  { value: "self", label: "On my own" },
  { value: "small_company", label: "Company under 50 people" },
  { value: "large_company", label: "Company of 50 or more" },
  { value: "government", label: "Government entity" },
];

const labelOf = (
  options: ReadonlyArray<{ readonly value: string; readonly label: string }>,
  value: string | null | undefined,
): string | null => options.find((option) => option.value === value)?.label ?? value ?? null;

/** The stored answers in the words the questions use. Null when there are none. */
export const answersSummary = (
  profile: { readonly field: string | null; readonly workplace: string | null } | null | undefined,
): string | null => {
  const parts = [
    labelOf(PROFILE_FIELDS, profile?.field),
    labelOf(PROFILE_WORKPLACES, profile?.workplace),
  ].filter((part): part is string => part !== null && part.length > 0);
  return parts.length === 0 ? null : parts.join(" · ");
};
