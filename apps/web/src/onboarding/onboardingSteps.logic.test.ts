import { describe, expect, it } from "vite-plus/test";

import {
  goBack,
  goForward,
  INITIAL_ONBOARDING_STATE,
  type OnboardingFacts,
  type OnboardingState,
  onboardingView,
  readOnboardingState,
} from "./onboardingSteps.logic";

const facts = (overrides: Partial<OnboardingFacts> = {}): OnboardingFacts => ({
  privacyMode: "unconfigured",
  termsOutstanding: false,
  profileAnswered: false,
  usageDataDue: true,
  developerMode: false,
  foldersAvailable: false,
  phoneAvailable: false,
  agentReady: false,
  ...overrides,
});

const state = (overrides: Partial<OnboardingState> = {}): OnboardingState => ({
  ...INITIAL_ONBOARDING_STATE,
  ...overrides,
});

describe("onboarding steps", () => {
  it("walks a new account through every step that applies, one at a time", () => {
    let current = state();
    const walk: string[] = [];
    const record = (now: OnboardingFacts) => {
      const view = onboardingView(current, now);
      walk.push(`${view.step} ${view.position}/${view.count}`);
    };

    record(facts());
    current = goForward(current, facts());
    record(facts());
    // Masking waits for the status, then goes on with the preselected account.
    expect(goForward(current, facts({ privacyMode: null })).step).toBe("masking");
    current = goForward(current, facts());
    record(facts());
    // The account step waits for the sign-in and the Terms.
    expect(goForward(current, facts()).step).toBe("account");
    const signedIn = facts({ privacyMode: "cloud" });
    current = goForward(current, signedIn);
    record(signedIn);
    current = goForward(current, signedIn);
    record(signedIn);
    current = goForward(current, signedIn);
    record(signedIn);
    expect(onboardingView(current, signedIn)).toMatchObject({ isLast: true, canContinue: false });

    expect(walk).toEqual([
      "welcome 1/6",
      "masking 2/6",
      "account 3/6",
      "profile 4/6",
      "usageData 5/6",
      "agents 6/6",
    ]);
  });

  it("skips what does not apply: no account step or questions for one's own service", () => {
    const own = facts({ privacyMode: "selfHosted", usageDataDue: false, agentReady: true });
    const view = onboardingView(state({ step: "masking", masking: "ownService" }), own);
    expect(view.steps).toEqual(["welcome", "masking", "agents"]);
    expect(goForward(state({ step: "masking", masking: "ownService" }), own).step).toBe("agents");
  });

  it("holds the count while the way to detect is still being chosen", () => {
    const counts = (["account", "ownService", "off"] as const).map((masking) => {
      const view = onboardingView(state({ step: "masking", masking }), facts());
      return `${view.position}/${view.count}`;
    });
    expect(counts).toEqual(["2/6", "2/6", "2/6"]);
  });

  it("adds the programming steps only in Developer mode", () => {
    const available = { foldersAvailable: true, phoneAvailable: true, privacyMode: "off" } as const;
    expect(onboardingView(state(), facts(available)).steps).not.toContain("folders");
    expect(onboardingView(state(), facts({ ...available, developerMode: true })).steps).toEqual([
      "welcome",
      "masking",
      "usageData",
      "agents",
      "folders",
      "phone",
    ]);
  });

  it("resumes at the stored step with the earlier answers", () => {
    const stored = readOnboardingState({
      step: "usageData",
      seen: ["welcome", "masking", "account", "profile", "usageData"],
      locale: "ar",
      masking: "account",
    });
    const signedIn = facts({ privacyMode: "cloud", profileAnswered: true });
    expect(stored).toMatchObject({ locale: "ar", masking: "account" });
    expect(onboardingView(stored, signedIn)).toMatchObject({
      step: "usageData",
      position: 5,
      count: 6,
    });
    // Setup left on the removed sealed-documents step goes on at the step that followed it.
    const leftOnSealed = readOnboardingState({
      step: "sealed",
      seen: ["welcome", "masking", "account", "profile", "usageData", "sealed"],
      locale: "ar",
      masking: "account",
    });
    expect(leftOnSealed.seen).not.toContain("sealed");
    expect(onboardingView(leftOnSealed, signedIn)).toMatchObject({
      step: "agents",
      position: 6,
      count: 6,
    });
  });

  it("goes back to an earlier step, and keeps a step once shown so the count holds", () => {
    const signedIn = facts({ privacyMode: "cloud", profileAnswered: true, usageDataDue: false });
    const atAgents = state({
      step: "agents",
      seen: ["welcome", "masking", "account", "profile", "usageData", "agents"],
      masking: "account",
    });
    expect(onboardingView(atAgents, signedIn)).toMatchObject({ position: 6, count: 6 });
    const back = goBack(atAgents, signedIn);
    expect(back.step).toBe("usageData");
    expect(goBack(goBack(back, signedIn), signedIn).step).toBe("account");
    expect(goBack(state(), signedIn).step).toBe("welcome");
  });

  it("returns to a gate that came undone while the app was closed", () => {
    const away = state({
      step: "agents",
      seen: ["welcome", "masking", "account", "profile", "usageData", "agents"],
      masking: "account",
    });
    // Signed out meanwhile: the sign-in comes back before anything after it.
    expect(onboardingView(away, facts()).step).toBe("account");
    // A Terms update to accept holds it there too.
    expect(onboardingView(away, facts({ privacyMode: "cloud", termsOutstanding: true })).step).toBe(
      "account",
    );
  });

  it("moves a stored step that no longer applies to the next one that does", () => {
    const stored = state({ step: "folders", masking: "off" });
    expect(onboardingView(stored, facts({ privacyMode: "off" })).step).toBe("agents");
  });

  it("lets the AI step be skipped, but not continued, without a ready AI", () => {
    const off = facts({ privacyMode: "off", usageDataDue: false, developerMode: true });
    const atAgents = state({ step: "agents", seen: ["welcome", "masking", "agents"] });
    const withFolders = { ...off, foldersAvailable: true };
    expect(goForward(atAgents, withFolders).step).toBe("agents");
    expect(goForward(atAgents, withFolders, { skip: true }).step).toBe("folders");
  });

  it("drops stored values it does not know", () => {
    expect(
      readOnboardingState({ step: "retired", seen: ["masking", "x"], locale: "fr", masking: "?" }),
    ).toEqual({ step: "welcome", seen: ["masking"], locale: null, masking: null });
  });

  it("keeps the step count stable while usage-data region detection is still loading", () => {
    const loading = facts({ usageDataDue: false, usageDataPending: true });
    // Before the region answer arrives, step 1 already counts usageData so 1/5 never jumps to 1/6.
    expect(onboardingView(state(), loading)).toMatchObject({
      step: "welcome",
      position: 1,
      count: 6,
    });
    // Reaching usageData while still loading holds Continue and does not lock it into seen yet.
    const atProfile = state({
      step: "profile",
      seen: ["welcome", "masking", "account", "profile"],
      masking: "account",
    });
    const signedInLoading = facts({
      privacyMode: "cloud",
      usageDataDue: false,
      usageDataPending: true,
    });
    const reachedPending = goForward(atProfile, signedInLoading);
    expect(reachedPending.step).toBe("usageData");
    expect(reachedPending.seen).not.toContain("usageData");
    expect(onboardingView(reachedPending, signedInLoading).canContinue).toBe(false);
    // If usage data turns out not to apply, setup moves on to agents cleanly instead of showing an empty step.
    expect(
      onboardingView(
        reachedPending,
        facts({ privacyMode: "cloud", usageDataDue: false, usageDataPending: false }),
      ).step,
    ).toBe("agents");
    // Going back while still loading does not lock an unshown usageData step into seen either.
    expect(goBack(reachedPending, signedInLoading).seen).not.toContain("usageData");
  });

  it("lets Continue commit ownService once an address is entered, or off immediately, while still gating resumed steps", () => {
    const atMaskingOwn = state({ step: "masking", masking: "ownService" });
    expect(onboardingView(atMaskingOwn, facts({ ownServiceReady: false })).canContinue).toBe(false);
    expect(onboardingView(atMaskingOwn, facts({ ownServiceReady: true })).canContinue).toBe(true);

    const atMaskingOff = state({ step: "masking", masking: "off" });
    expect(onboardingView(atMaskingOff, facts()).canContinue).toBe(true);

    // If privacy was reset to unconfigured while the app was closed, resuming past masking returns to it.
    const resumedOff = state({
      step: "agents",
      seen: ["welcome", "masking", "agents"],
      masking: "off",
    });
    expect(onboardingView(resumedOff, facts()).step).toBe("masking");
    const resumedOwn = state({
      step: "agents",
      seen: ["welcome", "masking", "agents"],
      masking: "ownService",
    });
    expect(onboardingView(resumedOwn, facts({ ownServiceReady: true })).step).toBe("masking");
  });
});
