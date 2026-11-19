import type { PrivacyProfileField, PrivacyProfileWorkplace } from "@t3tools/contracts";

/** The two onboarding questions' choices, in the order they are offered. */
export const PROFILE_FIELDS: ReadonlyArray<{
  readonly value: PrivacyProfileField;
  readonly label: string;
  readonly labelAr: string;
}> = [
  { value: "legal", label: "Legal", labelAr: "القانون" },
  { value: "finance", label: "Finance", labelAr: "المالية" },
  { value: "government", label: "Government services", labelAr: "الخدمات الحكومية" },
  { value: "healthcare", label: "Healthcare", labelAr: "الرعاية الصحية" },
  { value: "hr", label: "Human resources", labelAr: "الموارد البشرية" },
  { value: "real_estate", label: "Real estate", labelAr: "العقار" },
  { value: "consulting", label: "Consulting", labelAr: "الاستشارات" },
  { value: "engineering", label: "Engineering and IT", labelAr: "الهندسة وتقنية المعلومات" },
  { value: "research", label: "Research and education", labelAr: "البحث والتعليم" },
  { value: "other", label: "Other", labelAr: "غير ذلك" },
];

export const PROFILE_WORKPLACES: ReadonlyArray<{
  readonly value: PrivacyProfileWorkplace;
  readonly label: string;
  readonly labelAr: string;
}> = [
  { value: "self", label: "On my own", labelAr: "أعمل لحسابي" },
  { value: "small_company", label: "Company under 50 people", labelAr: "شركة يقل موظفوها عن 50" },
  { value: "large_company", label: "Company of 50 or more", labelAr: "شركة موظفوها 50 أو أكثر" },
  { value: "government", label: "Government entity", labelAr: "جهة حكومية" },
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
