import type { PrivacyProfileField, PrivacyProfileWorkplace } from "@t3tools/contracts";
import { msg } from "gt-react";

/** The two onboarding questions' choices, in the order they are offered. */
export const PROFILE_FIELDS: ReadonlyArray<{
  readonly value: PrivacyProfileField;
  readonly label: string;
}> = [
  { value: "legal", label: msg("Legal") },
  { value: "finance", label: msg("Finance") },
  { value: "government", label: msg("Government services") },
  { value: "healthcare", label: msg("Healthcare") },
  { value: "hr", label: msg("Human resources") },
  { value: "real_estate", label: msg("Real estate") },
  { value: "consulting", label: msg("Consulting") },
  { value: "engineering", label: msg("Engineering and IT") },
  { value: "research", label: msg("Research and education") },
  { value: "other", label: msg("Other") },
];

export const PROFILE_WORKPLACES: ReadonlyArray<{
  readonly value: PrivacyProfileWorkplace;
  readonly label: string;
}> = [
  { value: "self", label: msg("On my own") },
  { value: "small_company", label: msg("Company (under 50 people)") },
  { value: "large_company", label: msg("Company (50 or more)") },
  { value: "government", label: msg("Government entity") },
];

const labelOf = (
  options: ReadonlyArray<{ readonly value: string; readonly label: string }>,
  value: string | null | undefined,
  resolve: (message: string) => string,
): string | null => {
  const match = options.find((option) => option.value === value);
  if (match !== undefined) return resolve(match.label);
  return value ?? null;
};

/** The stored answers in the words the questions use. Null when there are none. */
export const answersSummary = (
  profile: { readonly field: string | null; readonly workplace: string | null } | null | undefined,
  resolve: (message: string) => string = (message) => message,
): string | null => {
  const parts = [
    labelOf(PROFILE_FIELDS, profile?.field, resolve),
    labelOf(PROFILE_WORKPLACES, profile?.workplace, resolve),
  ].filter((part): part is string => part !== null && part.length > 0);
  return parts.length === 0 ? null : parts.join(" · ");
};
