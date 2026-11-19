import type { OnboardingProgress, PrivacyMode } from "@t3tools/contracts";

/** The steps in the order they are taken. A step that does not apply is left out, not shown empty. */
const ONBOARDING_STEPS = [
  "welcome",
  "masking",
  "account",
  "profile",
  "usageData",
  "agents",
  "folders",
  "phone",
] as const;
export type OnboardingStep = (typeof ONBOARDING_STEPS)[number];

export type MaskingChoice = "account" | "ownService" | "off";
export type SetupLocale = "en" | "ar";

export interface OnboardingState {
  readonly step: OnboardingStep;
  readonly seen: ReadonlyArray<OnboardingStep>;
  readonly locale: SetupLocale | null;
  readonly masking: MaskingChoice | null;
}

/** What the app knows now. Answers given outside setup, such as a sign-in, count too. */
export interface OnboardingFacts {
  /** Null while the privacy status loads. */
  readonly privacyMode: PrivacyMode | null;
  /** A signed-in account still has to accept the Terms of Use in force. */
  readonly termsOutstanding: boolean;
  readonly profileAnswered: boolean;
  /** The usage-data choice or notice has not been shown yet and can be. */
  readonly usageDataDue: boolean;
  readonly developerMode: boolean;
  readonly foldersAvailable: boolean;
  readonly phoneAvailable: boolean;
  readonly agentReady: boolean;
}

export const INITIAL_ONBOARDING_STATE: OnboardingState = {
  step: "welcome",
  seen: [],
  locale: null,
  masking: null,
};

const isStep = (value: string): value is OnboardingStep =>
  (ONBOARDING_STEPS as ReadonlyArray<string>).includes(value);

/** Reads stored progress; anything a different version wrote that this one does not know is dropped. */
export function readOnboardingState(stored: OnboardingProgress | null): OnboardingState {
  if (stored === null) return INITIAL_ONBOARDING_STATE;
  return {
    step: isStep(stored.step) ? stored.step : "welcome",
    seen: stored.seen.filter(isStep),
    locale: stored.locale === "en" || stored.locale === "ar" ? stored.locale : null,
    masking:
      stored.masking === "account" || stored.masking === "ownService" || stored.masking === "off"
        ? stored.masking
        : null,
  };
}

const privacyDecided = (facts: OnboardingFacts) =>
  facts.privacyMode !== null && facts.privacyMode !== "unconfigured";

// Until another way is chosen, the account is assumed: it is the recommended one, and the count
// then only ever shrinks when the person picks their own service.
const usesAccount = (state: OnboardingState, facts: OnboardingFacts) =>
  facts.privacyMode === "cloud" ||
  (!privacyDecided(facts) && state.masking !== "ownService" && state.masking !== "off");

function applies(step: OnboardingStep, state: OnboardingState, facts: OnboardingFacts): boolean {
  // A step once shown stays, so Back finds it and the count does not shrink under the person.
  const shown = state.seen.includes(step);
  switch (step) {
    case "welcome":
    case "masking":
    case "agents":
      return true;
    case "account":
      return usesAccount(state, facts);
    case "profile":
      // The answers are kept with the account, so they are asked only of one.
      return usesAccount(state, facts) && (!facts.profileAnswered || shown);
    case "usageData":
      return facts.usageDataDue || shown;
    case "folders":
      return facts.developerMode && facts.foldersAvailable;
    case "phone":
      return facts.developerMode && facts.phoneAvailable;
  }
}

/**
 * Whether the person can go on from a step. Masking and the account are gates: nothing after them
 * is reached until they are settled. The AI step can be skipped instead.
 */
function canContinue(
  step: OnboardingStep,
  state: OnboardingState,
  facts: OnboardingFacts,
): boolean {
  switch (step) {
    case "masking":
      // The account is the preselected way, so it needs no click to go on with.
      return (
        privacyDecided(facts) ||
        ((state.masking ?? "account") === "account" && facts.privacyMode !== null)
      );
    case "account":
      return facts.privacyMode === "cloud" && !facts.termsOutstanding;
    case "agents":
      return facts.agentReady;
    default:
      return true;
  }
}

const GATES: ReadonlyArray<OnboardingStep> = ["masking", "account"];

function visibleSteps(state: OnboardingState, facts: OnboardingFacts) {
  return ONBOARDING_STEPS.filter((step) => applies(step, state, facts));
}

/**
 * The step to show. A stored step that no longer applies gives way to the next one that does, and
 * an earlier gate that came undone, such as a sign-out while the app was closed, comes first.
 */
function currentStep(state: OnboardingState, facts: OnboardingFacts): OnboardingStep {
  const steps = visibleSteps(state, facts);
  const storedIndex = ONBOARDING_STEPS.indexOf(state.step);
  const target =
    steps.find((step) => ONBOARDING_STEPS.indexOf(step) >= storedIndex) ?? steps.at(-1)!;
  const blocked = steps.find(
    (step) =>
      GATES.includes(step) &&
      ONBOARDING_STEPS.indexOf(step) < ONBOARDING_STEPS.indexOf(target) &&
      !canContinue(step, state, facts),
  );
  return blocked ?? target;
}

export function onboardingView(state: OnboardingState, facts: OnboardingFacts) {
  const steps = visibleSteps(state, facts);
  const step = currentStep(state, facts);
  const index = steps.indexOf(step);
  return {
    steps,
    step,
    /** One-based, for "Step 2 of 6". */
    position: index + 1,
    count: steps.length,
    isFirst: index === 0,
    isLast: index === steps.length - 1,
    canContinue: canContinue(step, state, facts),
    canSkip: step === "agents",
  };
}

const withSeen = (state: OnboardingState, ...steps: ReadonlyArray<OnboardingStep>) => {
  const seen = [...state.seen];
  for (const step of steps) if (!seen.includes(step)) seen.push(step);
  return seen;
};

/** Moves to the next step that applies. Skipping is how the AI step is passed without an agent. */
export function goForward(
  state: OnboardingState,
  facts: OnboardingFacts,
  options: { readonly skip?: boolean } = {},
): OnboardingState {
  const view = onboardingView(state, facts);
  if (view.isLast || !(view.canContinue || (options.skip === true && view.canSkip))) {
    return state.step === view.step ? state : { ...state, step: view.step };
  }
  const next = view.steps[view.steps.indexOf(view.step) + 1]!;
  return { ...state, step: next, seen: withSeen(state, view.step, next) };
}

export function goBack(state: OnboardingState, facts: OnboardingFacts): OnboardingState {
  const view = onboardingView(state, facts);
  if (view.isFirst) return state;
  const previous = view.steps[view.steps.indexOf(view.step) - 1]!;
  return { ...state, step: previous, seen: withSeen(state, view.step) };
}
