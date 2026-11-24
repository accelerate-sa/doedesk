import { useAuth } from "@clerk/react";
import {
  configurePrivacy,
  isPrivacyDecided,
  savePrivacyProfile,
  setPrivacyStatus,
  useConsentLocale,
  usePrivacyStatus,
  useUsageDataState,
} from "~/privacy/privacyClient";
import {
  NOT_WORKED,
  UNREACHABLE,
  usePrivacyMessage,
  useServiceProblemMessage,
} from "~/doedesk/privacyMessages";
import { settleUsageDataFirstRun, usageDataChoiceDue } from "../privacy/UsageData";
import { termsAcceptanceDue } from "../privacy/TermsAcceptanceSheet";
import { useDeveloperMode } from "~/doedesk/product";
import {
  goBack,
  goForward,
  onboardingView,
  readOnboardingState,
  type OnboardingFacts,
  type OnboardingState,
  type OnboardingStep,
  type SetupLocale,
} from "~/onboarding/onboardingSteps.logic";
import { InSetupContext } from "~/onboarding/setupLocale";
import { useAtomValue } from "@effect/atom-react";
import type {
  AgentSessionProjectCandidate,
  EnvironmentId,
  PrivacyConfigureRequest,
  PrivacyProfileRequest,
  ProjectId,
  ProviderInstanceId,
  ScopedProjectRef,
  ServerConfig,
  ServerProvider,
} from "@t3tools/contracts";
import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { resolveProviderInstanceDisplayName as agentName } from "@t3tools/client-runtime/state/provider-instance-display";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  AgentSessionSource,
  AuthProvidersManageScope,
  AuthRelayReadScope,
  AuthRelayWriteScope,
  AuthTerminalOperateScope,
  CommandId,
  AuthOrchestrationOperateScope,
  isManagedDriverAllowed,
  ProviderDriverKind,
  ThreadId,
} from "@t3tools/contracts";
import { Link, useBlocker } from "@tanstack/react-router";
import * as Schema from "effect/Schema";
import { CheckIcon, ChevronDownIcon, ChevronRightIcon, PlusIcon, TerminalIcon } from "lucide-react";
import { msg, T, useGT, useLocale, useMessages, Var } from "gt-react";
import { useEffect, useEffectEvent, useRef, useState, type ReactNode } from "react";

import { TYPOGRAPHY_ADVANCED_STORAGE_KEY } from "../../appearanceFonts";
import { MOBILE_APP_URL } from "../../branding";
import { isElectron } from "../../env";
import { useLocalStorage } from "../../hooks/useLocalStorage";
import {
  updateClientSettings,
  useClientSettings,
  usePersistEnvironmentProviderInstanceMutation,
} from "../../hooks/useSettings";
import { useCloudLinkState } from "../../cloud/cloudLinkState";
import { hasCloudPublicConfig } from "../../cloud/publicConfig";
import { PRIVACY_POLICY_URL } from "../../legalLinks";
import { workspaceAreaProps } from "../../lib/workspaceFocus";
import { retryClerkLoad, useClerkLoadFailed } from "../clerk/clerkLoadFailure";
import { useT3ConnectAuthPrompt } from "../clerk/useT3ConnectAuthPrompt";
import { completeOnboarding } from "../../onboarding/firstRun";
import {
  groupOnboardingProjects,
  partitionOnboardingProjects,
  onboardingProjectKey,
  resolveOnboardingLandingProject,
  isNewOnboardingProject,
  resolveOnboardingProjectId,
  type OnboardingProjectGroup,
  splitOnboardingProjectPath,
} from "../../onboarding/projectImport.logic";
import {
  resolveOnboardingProviderInstallCommand,
  resolveOnboardingProviderLoginCommand,
} from "../../onboarding/providerReadiness.logic";
import {
  cliTerminalStep,
  codexCardProvider,
  codexNeedsSetup,
  groupWelcomeAgents,
  isBrokenVersion,
  turnedOnInstance,
  welcomeAgentState,
  welcomeOffersPhone,
} from "../../onboarding/welcomePage.logic";
import {
  StoredWelcomeImportSelection,
  type WelcomeImportSelection,
  welcomeImportSelectionKey,
} from "../../onboarding/welcomeState";
import { newProjectId, randomUUID } from "../../lib/utils";
import { agentSessionImport } from "../../state/agentSessions";
import { readProjects, useProjects, waitForProject } from "../../state/entities";
import { useEnvironments, usePrimaryEnvironmentId } from "../../state/environments";
import { managedTelemetryOffMessage, useManagedPolicy } from "../../state/managedPolicy";
import { useProjectScans } from "../../onboarding/useProjectScans";
import { projectEnvironment } from "../../state/projects";
import { serverEnvironment } from "../../state/server";
import {
  readEnvironmentScope,
  useEnvironmentScope,
  useEnvironmentsWithScope,
} from "../../state/session";
import { terminalEnvironment } from "../../state/terminal";
import { useThreadRunningTerminalIds } from "../../state/terminalSessions";
import { useAtomCommand } from "../../state/use-atom-command";
import { getProviderSummary } from "../settings/providerStatus";
import { AddProviderInstanceDialog } from "../settings/AddProviderInstanceDialog";
import { useDesktopCliCommand } from "../settings/CliCommandSettingsRow";
import { CodexSetupSection } from "../settings/CodexSetupSection";
import { readCodexSetupMode } from "../settings/CodexSetupSection.logic";
import { TerminalViewport } from "../ThreadTerminalDrawer";
import { ProviderInstanceIcon } from "../chat/ProviderInstanceIcon";
import { ACPRegistryIcon } from "../Icons";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../ui/collapsible";
import { QRCodeSvg } from "../ui/qr-code";
import { Tooltip, TooltipTrigger, TooltipPopup } from "../ui/tooltip";
import { ScrollArea } from "../ui/scroll-area";
import { SidebarInset } from "../ui/sidebar";
import { toastManager } from "../ui/toast";
import { WorkspacePageHeader } from "../WorkspacePageHeader";
import { cn } from "../../lib/utils";
import { formatRelativeTime } from "../../timestampFormat";
import { ProviderPrograms } from "./ProviderPrograms";
import {
  AccountStep,
  LanguageStep,
  MaskingStep,
  type OwnServiceDraft,
  ProfileStep,
  UsageDataStep,
} from "./SetupPrivacySteps";

const AGENT_ONBOARDING_THREAD_ID = ThreadId.make("onboarding-agent-setup");
const SCAN_LIMIT_MESSAGE = msg("Scan limit reached. Some folders or chats may not be listed.");

/** Stored progress for first-run setup, read and written through the client settings. */
function useOnboardingState() {
  const stored = useClientSettings((settings) => settings.onboardingProgress);
  const state = readOnboardingState(stored);
  const save = (next: OnboardingState) =>
    void updateClientSettings({
      onboardingProgress: {
        step: next.step,
        seen: [...next.seen],
        locale: next.locale,
        masking: next.masking,
      },
    }).catch(() => undefined);
  return [state, save] as const;
}

/**
 * First-run setup for one computer, one decision per step: the language, how names and numbers
 * are found, the account, two optional questions, usage data, the AI, and in Developer mode the
 * folders to import and the phone. Progress is kept in the client settings, so a quit reopens the
 * same step with the answers given so far.
 */
export function WelcomePage({
  environmentId,
  onDone,
}: {
  readonly environmentId: EnvironmentId;
  readonly onDone: (projectRef?: ScopedProjectRef) => void | Promise<void>;
}) {
  const developerMode = useDeveloperMode();
  const gt = useGT();
  const privacyMessages = usePrivacyMessage();
  const serviceProblemMessage = useServiceProblemMessage();
  const { environments } = useEnvironments();
  const environmentLabel = environments.find(
    (environment) => environment.environmentId === environmentId,
  )?.label;
  const agents = useWelcomeAgents(environmentId);
  const agentReady = agents.readyCount > 0;
  // The phone and `t3` on PATH belong to the primary computer, so only it offers them.
  const isPrimary = usePrimaryEnvironmentId() === environmentId;
  // The same access Settings → Sharing & access checks.
  const canReadRelay = useEnvironmentScope(environmentId, AuthRelayReadScope);
  const canWriteRelay = useEnvironmentScope(environmentId, AuthRelayWriteScope);
  const managedPolicy = useManagedPolicy(environmentId);
  const showPhone = welcomeOffersPhone({
    isPrimary,
    cloud: hasCloudPublicConfig(),
    canShare: canReadRelay && canWriteRelay,
    policy: managedPolicy,
  });
  const scans = useProjectScans([environmentId]);
  const [storedSelection, storeSelection] = useLocalStorage(
    welcomeImportSelectionKey(environmentId),
    null,
    StoredWelcomeImportSelection,
  );
  // The page keeps its own copy, so a failed write (a full quota) cannot undo a choice.
  const [importSelection, setImportSelectionState] = useState(storedSelection);
  const setImportSelection = (next: WelcomeImportSelection | null) => {
    setImportSelectionState(next);
    storeSelection(next);
  };
  const appLocale = useLocale();
  const [consentLocale, setConsentLocale] = useConsentLocale();
  const [state, saveState] = useOnboardingState();
  // Arabic when the app or system started in Arabic, until the person picks on the first step.
  const locale: SetupLocale = state.locale ?? (appLocale === "ar" ? "ar" : consentLocale);
  const [isImporting, setIsImporting] = useState(false);
  // True from Start until the landing; leaving earlier would drop the import or the landing.
  const holdPageRef = useRef(false);
  useBlocker({
    shouldBlockFn: () => {
      if (!holdPageRef.current) return false;
      toastManager.add({
        id: "welcome-finishing",
        type: "info",
        title: gt("Finishing setup"),
        description: gt("Wait a moment while DoeDesk saves your setup."),
      });
      return true;
    },
    // Electron cancels a quit silently when unload is blocked. A later visit resumes the import.
    enableBeforeUnload: false,
  });
  const finishingPromiseRef = useRef<Promise<boolean> | null>(null);
  // Starting before the project list loads keeps saved picks, such as an import a quit cut short.
  const keepChoicesRef = useRef(false);
  const completionErrorToastIdRef = useRef<ReturnType<typeof toastManager.add> | null>(null);
  const finish = (
    projectRef?: ScopedProjectRef,
    importWarning?: string,
    importedThreadCount = 0,
  ) => {
    if (finishingPromiseRef.current !== null) return finishingPromiseRef.current;
    if (completionErrorToastIdRef.current !== null) {
      toastManager.close(completionErrorToastIdRef.current);
      completionErrorToastIdRef.current = null;
    }

    holdPageRef.current = true;
    const completion = completeOnboarding()
      .then(async () => {
        if (completionErrorToastIdRef.current !== null) {
          toastManager.close(completionErrorToastIdRef.current);
          completionErrorToastIdRef.current = null;
        }
        // Release before onDone so its own navigation is not blocked.
        holdPageRef.current = false;
        await onDone(projectRef);
        if (!keepChoicesRef.current) setImportSelection(null);
        if (importWarning) {
          toastManager.add({
            type: "warning",
            title: gt("Some chat history could not be imported"),
            description: importWarning,
            timeout: 0,
          });
        } else if (importedThreadCount > 0) {
          toastManager.add({
            type: "success",
            title: gt(
              "{count, plural, one {Imported {count} chat} other {Imported {count} chats}}",
              {
                count: importedThreadCount,
              },
            ),
          });
        }
        return true;
      })
      .catch(() => {
        holdPageRef.current = false;
        const errorToast = {
          type: "error",
          title: gt("Could not finish setup"),
          description: gt("DoeDesk could not save your settings. Try again."),
        } as const;
        if (completionErrorToastIdRef.current === null) {
          completionErrorToastIdRef.current = toastManager.add(errorToast);
        } else {
          toastManager.update(completionErrorToastIdRef.current, errorToast);
        }
        return false;
      })
      .finally(() => {
        if (finishingPromiseRef.current === completion) {
          finishingPromiseRef.current = null;
        }
      });
    finishingPromiseRef.current = completion;
    return completion;
  };
  const projectImport = useProjectImport({
    scans,
    importSelection,
    onImportSelectionChange: setImportSelection,
    isImporting,
    setIsImporting,
    holdPageRef,
    onDone: finish,
  });
  // Without import permission, starting simply skips the projects.
  const selected = developerMode && projectImport.canWrite ? projectImport.selected : [];
  const privacy = usePrivacyStatus();
  const privacyStatus = privacy.kind === "ready" ? privacy.status : null;
  const usageDataState = useUsageDataState();
  const usageData = usageDataState.status;
  // Kept as a step from the moment the choice is due, even after the person answers it.
  const [usageDataOffered, setUsageDataOffered] = useState(false);
  if (!usageDataOffered && usageDataChoiceDue(usageData)) setUsageDataOffered(true);
  const usageDataPending =
    usageDataState.kind === "loading" && managedTelemetryOffMessage(managedPolicy) === undefined;
  const newCount = selected.filter(projectImport.isNew).length;

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- the consent texts read a shared language atom that is not stored; a resumed setup puts its stored language back into it
  useEffect(() => {
    if (state.locale !== null && state.locale !== consentLocale) setConsentLocale(state.locale);
  }, [state.locale, consentLocale, setConsentLocale]);

  const [ownServiceDraft, setOwnServiceDraft] = useState<OwnServiceDraft>({
    endpoint: "",
    token: "",
  });
  const [maskingError, setMaskingError] = useState<string | null>(null);
  const scan = scans[0];
  const facts: OnboardingFacts = {
    privacyMode: privacyStatus?.mode ?? null,
    termsOutstanding: privacyStatus !== null && termsAcceptanceDue(privacyStatus),
    profileAnswered: privacyStatus?.profileAnswered ?? false,
    usageDataDue: usageDataOffered,
    usageDataPending,
    ownServiceReady: ownServiceDraft.endpoint.trim().length > 0,
    developerMode,
    foldersAvailable:
      scan !== undefined &&
      (scan.isPending || scan.error !== null || projectImport.candidates.length > 0),
    phoneAvailable: showPhone,
    agentReady,
  };
  const view = onboardingView(state, facts);
  const profileAnswersRef = useRef<PrivacyProfileRequest | null>(null);
  const [advancing, setAdvancing] = useState(false);

  const start = () => {
    // Leaving with the choice untouched is an answer only if the person actually saw that step;
    // a late region answer that arrived after they passed it stays unset so PrivacyPrompts asks next.
    if (state.seen.includes("usageData")) {
      void settleUsageDataFirstRun(usageData, locale).catch(() => undefined);
    }
    keepChoicesRef.current = scans.some((entry) => entry.data === null);
    if (selected.length === 0) {
      projectImport.finishAfterImport();
      return;
    }
    // Stored now, so after a restart mid-import these stay checked even once they exist.
    projectImport.setSelectedKeys(new Set(selected.map((candidate) => candidate.key)));
    void projectImport.runImport(selected);
  };

  // Each step's own answer is recorded on the way out, then the next step that applies opens.
  const advance = async (options: { readonly skip?: boolean } = {}) => {
    if (advancing) return;
    let nextFacts = facts;
    setAdvancing(true);
    if (
      view.step === "masking" &&
      privacyStatus !== null &&
      !isPrivacyDecided(privacyStatus) &&
      (state.masking === "ownService" || state.masking === "off")
    ) {
      setMaskingError(null);
      const payload: PrivacyConfigureRequest =
        state.masking === "off"
          ? { mode: "off" }
          : {
              mode: "selfHosted",
              endpoint: ownServiceDraft.endpoint.trim(),
              ...(ownServiceDraft.token.trim().length > 0
                ? { token: ownServiceDraft.token.trim() }
                : {}),
            };
      const result = await configurePrivacy(payload).catch(() => null);
      if (result === null) {
        setMaskingError(privacyMessages(UNREACHABLE));
        setAdvancing(false);
        return;
      }
      setPrivacyStatus(result.status);
      if (!result.ok) {
        setMaskingError(
          result.problem === undefined
            ? (result.message ?? privacyMessages(NOT_WORKED))
            : serviceProblemMessage(result.problem),
        );
        setAdvancing(false);
        return;
      }
      nextFacts = {
        ...facts,
        privacyMode: result.status.mode,
        termsOutstanding: termsAcceptanceDue(result.status),
        profileAnswered: result.status.profileAnswered,
      };
    }
    // Both saves catch their own failures, so nothing here can skip the reset below.
    if (view.step === "profile" && privacyStatus !== null) {
      const answers = profileAnswersRef.current;
      if (answers !== null || !privacyStatus.profileAnswered) {
        const saved = await savePrivacyProfile(
          answers ?? { field: null, fieldOther: null, workplace: null },
        ).catch(() => null);
        // The answers are optional: a failed save asks again next time rather than blocking.
        if (saved !== null) setPrivacyStatus(saved);
        profileAnswersRef.current = null;
      }
    }
    if (view.step === "usageData") {
      await settleUsageDataFirstRun(usageData, locale).catch(() => undefined);
    }
    setAdvancing(false);
    if (view.isLast) {
      start();
      return;
    }
    const base = view.step === "welcome" ? { ...state, locale } : state;
    const nextState = goForward(base, nextFacts, options);
    if (view.step === "welcome") {
      // Lock the chosen (or Arabic-OS default) language into app settings for all later launches.
      void updateClientSettings({
        language: locale,
        onboardingProgress: {
          step: nextState.step,
          seen: [...nextState.seen],
          locale: nextState.locale,
          masking: nextState.masking,
        },
      }).catch(() => undefined);
    } else {
      saveState(nextState);
    }
  };

  const chooseLocale = (next: SetupLocale) => {
    setConsentLocale(next);
    void updateClientSettings({
      language: next,
      onboardingProgress: {
        step: state.step,
        seen: [...state.seen],
        locale: next,
        masking: state.masking,
      },
    }).catch(() => undefined);
  };

  return (
    <InSetupContext value={true}>
      <SidebarInset
        {...workspaceAreaProps("home", 1, "Welcome")}
        role="main"
        className="h-dvh min-h-0 overflow-hidden overscroll-y-none"
      >
        <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background">
          {/* The desktop window only moves where CSS opts in, so keep a titlebar strip. */}
          {isElectron ? <WorkspacePageHeader electron /> : null}
          <div className="min-h-0 flex-1 overflow-y-auto scrollbar-gutter-both">
            <div className="mx-auto flex min-h-full w-full max-w-2xl flex-col px-6 pt-10 pb-8 sm:pt-16">
              <StepProgress position={view.position} count={view.count} />
              <StepHeading step={view.step} label={environmentLabel} />
              <div className="mt-6 min-w-0">
                {view.step === "welcome" ? (
                  <LanguageStep locale={locale} onLocale={chooseLocale} />
                ) : view.step === "masking" ? (
                  <MaskingStep
                    status={privacyStatus}
                    loading={privacy.kind === "loading"}
                    choice={state.masking}
                    ownServiceDraft={ownServiceDraft}
                    busy={advancing}
                    error={maskingError}
                    onChoice={(masking) => {
                      setMaskingError(null);
                      saveState({ ...state, masking });
                    }}
                    onOwnServiceDraftChange={(draft) => {
                      setMaskingError(null);
                      setOwnServiceDraft(draft);
                    }}
                    onSubmitOwnService={() => void advance()}
                  />
                ) : view.step === "account" ? (
                  <AccountStep status={privacyStatus} loading={privacy.kind === "loading"} />
                ) : view.step === "profile" && privacyStatus !== null ? (
                  <ProfileStep
                    status={privacyStatus}
                    onAnswersChange={(answers) => {
                      profileAnswersRef.current = answers;
                    }}
                  />
                ) : view.step === "usageData" ? (
                  <UsageDataStep status={usageData} />
                ) : view.step === "agents" ? (
                  <>
                    <AgentsSection
                      environmentId={environmentId}
                      label={environmentLabel}
                      isPrimary={isPrimary}
                      onImportSourceEnabled={() => scan?.refresh()}
                    />
                    <ProviderPrograms
                      environmentId={environmentId}
                      providers={agents.allowed}
                      settings={agents.serverConfig?.settings}
                      platformOs={agents.serverConfig?.environment.platform.os}
                    />
                  </>
                ) : view.step === "folders" ? (
                  <ProjectsSection
                    scan={scan}
                    projectImport={projectImport}
                    isImporting={isImporting}
                  />
                ) : (
                  <PhoneSection environmentId={environmentId} />
                )}
              </div>
              <StepFooter
                isFirst={view.isFirst}
                isLast={view.isLast}
                canContinue={view.canContinue && !advancing && !isImporting}
                canSkip={view.canSkip && !view.canContinue && !isImporting}
                hint={stepHint(view.step, view.canContinue, facts)}
                continueLabel={
                  advancing && view.step === "masking" && state.masking === "ownService"
                    ? gt("Connecting…")
                    : null
                }
                startLabel={
                  isImporting
                    ? selected.length > 0
                      ? gt("Importing…")
                      : gt("Starting…")
                    : newCount > 0
                      ? gt(
                          "{count, plural, one {Import {count} folder and start} other {Import {count} folders and start}}",
                          { count: newCount },
                        )
                      : selected.length > 0
                        ? gt("Import chats and start")
                        : null
                }
                onBack={() => saveState(goBack(state, facts))}
                onContinue={() => void advance()}
                onSkip={() => void advance({ skip: true })}
              />
              <TelemetryNotice environmentId={environmentId} />
            </div>
          </div>
        </div>
      </SidebarInset>
    </InSetupContext>
  );
}

const STEP_HINTS = {
  masking: msg("Enter your detection service address to continue."),
  terms: msg("Accept the Terms of Use to continue."),
  signIn: msg("Sign in to continue."),
  agents: msg("Connect at least one AI tool to continue, or skip this step for now."),
} as const;

function stepHint(
  step: OnboardingStep,
  canContinue: boolean,
  facts: OnboardingFacts,
): string | null {
  if (canContinue) return null;
  switch (step) {
    case "masking":
      return facts.privacyMode === null ? null : STEP_HINTS.masking;
    case "account":
      return facts.termsOutstanding ? STEP_HINTS.terms : STEP_HINTS.signIn;
    case "agents":
      return STEP_HINTS.agents;
    default:
      return null;
  }
}

/** "Step 2 of 6", with one bar per step. Bars fill from the reading start in either language. */
function StepProgress({ position, count }: { readonly position: number; readonly count: number }) {
  const gt = useGT();
  return (
    <div className="grid gap-2">
      <p className="text-xs text-muted-foreground tabular-nums">
        {gt("Step {position} of {count}", { position, count })}
      </p>
      <div
        role="progressbar"
        aria-valuemin={1}
        aria-valuemax={count}
        aria-valuenow={position}
        aria-label={gt("Setup progress")}
        className="flex gap-1"
      >
        {Array.from({ length: count }, (_, index) => (
          <span
            key={index}
            className={cn("h-1 flex-1 rounded-full", index < position ? "bg-primary" : "bg-border")}
          />
        ))}
      </div>
    </div>
  );
}

const STEP_TITLES: Readonly<Record<OnboardingStep, readonly [title: string, lead: string | null]>> =
  {
    welcome: [
      msg("Welcome to DoeDesk"),
      msg(
        "Use your AI tools on confidential work. DoeDesk replaces personal details it finds with stand-ins before they reach the AI, then restores them in the replies.",
      ),
    ],
    masking: [
      msg("Choose how personal details are detected"),
      msg(
        "Details with fixed formats (phone numbers, IDs, IBANs, emails) are checked on this computer. Names, organizations, and addresses need a detection service. The list linking stand-ins to your real details never leaves this computer.",
      ),
    ],
    account: [
      msg("Sign in to DoeDesk"),
      msg("Sign in to an existing account, or create a new one below."),
    ],
    profile: [msg("About your work"), null],
    usageData: [msg("Usage data"), null],
    agents: [
      msg("Connect an AI tool"),
      msg(
        "DoeDesk works with your own AI subscription. Connect an AI tool already on this computer, or set one up below.",
      ),
    ],
    folders: [
      msg("Import folders"),
      msg("Bring in recent folders and chats from your existing AI tools."),
    ],
    phone: [
      msg("Connect your phone"),
      msg("Optional. Control DoeDesk on this computer from the mobile app."),
    ],
  };

function StepHeading({
  step,
  label,
}: {
  readonly step: OnboardingStep;
  readonly label: string | undefined;
}) {
  const m = useMessages();
  const [title, lead] = STEP_TITLES[step];
  return (
    <header className="mt-8">
      {/* Focus moves here on each step, so a screen reader announces the new one. */}
      <h1
        key={step}
        ref={(node) => node?.focus({ preventScroll: true })}
        tabIndex={-1}
        className="font-display text-3xl tracking-tight text-foreground outline-none sm:text-4xl"
      >
        {m(title)}
      </h1>
      {lead !== null ? (
        <p className="mt-2 font-reading text-lg text-muted-foreground">{m(lead)}</p>
      ) : null}
      {step === "agents" && label !== undefined ? (
        <p className="mt-1 text-xs text-muted-foreground">
          <bdi>{label}</bdi>
        </p>
      ) : null}
    </header>
  );
}

function StepFooter({
  isFirst,
  isLast,
  canContinue,
  canSkip,
  hint,
  continueLabel,
  startLabel,
  onBack,
  onContinue,
  onSkip,
}: {
  readonly isFirst: boolean;
  readonly isLast: boolean;
  readonly canContinue: boolean;
  readonly canSkip: boolean;
  readonly hint: string | null;
  readonly continueLabel?: string | null;
  /** The last step's button while folders are picked or the import runs. */
  readonly startLabel: string | null;
  readonly onBack: () => void;
  readonly onContinue: () => void;
  readonly onSkip: () => void;
}) {
  const gt = useGT();
  const m = useMessages();
  return (
    <footer className="mt-10 grid gap-3 border-t border-border/60 pt-5">
      {hint !== null ? <p className="text-xs text-muted-foreground">{m(hint)}</p> : null}
      <div className="flex flex-wrap items-center justify-between gap-3">
        {isFirst ? (
          <span />
        ) : (
          <Button variant="ghost" onClick={onBack}>
            {gt("Back")}
          </Button>
        )}
        <div className="flex flex-wrap items-center gap-2">
          {canSkip ? (
            <Button variant="ghost-muted" onClick={onSkip}>
              {isLast ? gt("Start without an AI tool") : gt("Skip for now")}
            </Button>
          ) : null}
          <Button disabled={!canContinue} onClick={onContinue}>
            {isLast ? (startLabel ?? gt("Start")) : (continueLabel ?? gt("Continue"))}
          </Button>
        </div>
      </div>
    </footer>
  );
}

// Where an organization's policy turns usage data off, the page says so instead of asking.
function TelemetryNotice({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const messages = useMessages();
  const telemetryOff = managedTelemetryOffMessage(useManagedPolicy(environmentId), messages);
  if (telemetryOff === undefined) return null;
  return (
    <p className="mt-auto pt-12 text-2xs leading-relaxed text-muted-foreground/70">
      {telemetryOff}{" "}
      <T>
        See the{" "}
        <a
          className="underline decoration-current/40 underline-offset-2 hover:text-muted-foreground"
          href={PRIVACY_POLICY_URL}
          target="_blank"
          rel="noreferrer noopener"
        >
          privacy policy
        </a>
        .
      </T>
    </p>
  );
}

// A part of a step. The step's heading names it, so the part carries its name only for screen readers.
function WelcomeSection({
  title,
  children,
}: {
  readonly title: string;
  readonly children: ReactNode;
}) {
  return (
    <section aria-label={title} className="min-w-0">
      {children}
    </section>
  );
}

// Rows share one icon column, so names, checkboxes, and steps line up down the page.
function RowIcon({ children }: { readonly children: ReactNode }) {
  return (
    <span className="flex size-5 shrink-0 items-center justify-center text-muted-foreground">
      {children}
    </span>
  );
}

const INSTALLABLE_DRIVERS = ["codex", "claudeAgent"] as const;
type OnboardingAgentDriver = (typeof INSTALLABLE_DRIVERS)[number];
const isInstallableDriver = (driver: string): driver is OnboardingAgentDriver =>
  (INSTALLABLE_DRIVERS as ReadonlyArray<string>).includes(driver);

interface AgentTerminalSession {
  readonly environmentId: EnvironmentId;
  readonly driver: OnboardingAgentDriver;
  readonly displayName: string;
  readonly providerInstanceId: ServerProvider["instanceId"];
  readonly cwd: string;
  readonly command: string;
  readonly keybindings: ServerConfig["keybindings"];
}

// Shared by the page (to enable Start) and the agents section, so both agree on what is ready.
function useWelcomeAgents(environmentId: EnvironmentId) {
  const developerMode = useDeveloperMode();
  const providers = useAtomValue(serverEnvironment.providersValueAtom(environmentId));
  const serverConfig = useAtomValue(serverEnvironment.configValueAtom(environmentId));
  const managedPolicy = serverConfig?.managedPolicy;
  const isAllowed = (provider: ServerProvider) =>
    isManagedDriverAllowed(managedPolicy, provider.driver) &&
    // Cursor's traffic cannot be masked, so DoeDesk blocks it; offering it would only fail.
    (developerMode || provider.driver !== "cursor");
  return {
    providers,
    serverConfig,
    allowed: (providers ?? []).filter(isAllowed),
    ...groupWelcomeAgents(providers, serverConfig?.settings, agentName, isAllowed),
  };
}

const isImportSource = Schema.is(AgentSessionSource);

// The setup card opens below a long list, so bring it into view once.
const revealOnMount = (node: HTMLElement | null) => node?.scrollIntoView({ block: "nearest" });

const ACP_REGISTRY_DRIVER_KIND = ProviderDriverKind.make("acpRegistry");

function AgentsSection({
  environmentId,
  label,
  isPrimary,
  onImportSourceEnabled,
}: {
  readonly environmentId: EnvironmentId;
  readonly label: string | undefined;
  readonly isPrimary: boolean;
  // The project scan only reads agents that are on, so turning one on can find more history.
  readonly onImportSourceEnabled: () => void;
}) {
  const developerMode = useDeveloperMode();
  const { providers, serverConfig, checking, found, available } = useWelcomeAgents(environmentId);
  const gt = useGT();
  const refreshProviders = useAtomCommand(serverEnvironment.refreshProviders, {
    reportFailure: false,
  });
  const persistProviderInstance = usePersistEnvironmentProviderInstanceMutation(environmentId);
  const canOperateTerminal = useEnvironmentScope(environmentId, AuthTerminalOperateScope);
  const canManageProviders = useEnvironmentScope(environmentId, AuthProvidersManageScope);
  const [terminalSession, setTerminalSession] = useState<AgentTerminalSession | null>(null);
  const [moreOpen, setMoreOpen] = useState<boolean | null>(null);
  const [addingProvider, setAddingProvider] = useState(false);
  const [codexSetupId, setCodexSetupId] = useState<ProviderInstanceId | null>(null);
  const [cliTerminalFor, setCliTerminalFor] = useState<ProviderInstanceId | null>(null);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- asks the environment to refresh its provider list when the environment changes
  useEffect(() => {
    void refreshProviders({ environmentId, input: {} });
  }, [environmentId, refreshProviders]);

  // Opened once the finished checks find nothing, since adding an agent is then the task. A first
  // status can be wrong, so this waits for the checks, and a later check never closes it.
  if (moreOpen === null && !checking && found.length === 0) setMoreOpen(true);
  const showMore = moreOpen ?? false;
  const acpAllowed = isManagedDriverAllowed(serverConfig?.managedPolicy, ACP_REGISTRY_DRIVER_KIND);
  const stateOf = (provider: ServerProvider) => welcomeAgentState(provider, serverConfig?.settings);
  const needsInstallOrSignIn = (provider: ServerProvider) => {
    const state = stateOf(provider);
    return (
      isInstallableDriver(provider.driver) &&
      !isBrokenVersion(provider) &&
      (state === "install" || state === "signIn")
    );
  };
  // Codex's card also offers ChatGPT sign-in, which still works when the CLI check failed.
  // Codex setup stays mounted by instance while its status changes, so a sign-in that starts
  // after an install is not lost when the agent moves between groups or briefly leaves the list.
  const [lastCodex, setLastCodex] = useState<ServerProvider | null>(null);
  const listedCodex =
    codexSetupId === null
      ? undefined
      : providers?.find((provider) => provider.instanceId === codexSetupId);
  if (listedCodex !== undefined && listedCodex !== lastCodex) setLastCodex(listedCodex);
  const codexSetupProvider = codexCardProvider({
    providers,
    instanceId: codexSetupId,
    last: lastCodex,
    settings: serverConfig?.settings,
  });
  // Once the card closes, a later status change does not reopen it and move the page.
  if (listedCodex !== undefined && codexSetupProvider === null) setCodexSetupId(null);

  const openTerminal = (provider: ServerProvider) => {
    if (
      !isInstallableDriver(provider.driver) ||
      serverConfig === null ||
      !readEnvironmentScope(environmentId, AuthTerminalOperateScope)
    )
      return;
    setTerminalSession({
      environmentId,
      driver: provider.driver,
      displayName: agentName(provider),
      providerInstanceId: provider.instanceId,
      cwd: serverConfig.cwd,
      command: provider.installed
        ? resolveOnboardingProviderLoginCommand(
            provider,
            serverConfig.settings,
            serverConfig.environment.platform.os,
          )
        : resolveOnboardingProviderInstallCommand(
            provider.driver,
            serverConfig.environment.platform.os,
          ),
      keybindings: serverConfig.keybindings,
    });
  };

  // "Use existing CLI" opens the CLI's terminal once Codex has checked the CLI.
  const cliProvider =
    cliTerminalFor === null
      ? undefined
      : providers?.find((provider) => provider.instanceId === cliTerminalFor);
  const cliStep =
    cliProvider === undefined ? "done" : cliTerminalStep(cliProvider, serverConfig?.settings);
  if (cliProvider !== undefined && cliStep !== "wait") {
    setCliTerminalFor(null);
    if (cliStep === "open") openTerminal(cliProvider);
  }

  const turnOn = async (provider: ServerProvider) => {
    if (serverConfig === null) return;
    const instance = serverConfig.settings.providerInstances[provider.instanceId] ?? {
      driver: provider.driver,
    };
    const result = await persistProviderInstance({
      operation: "upsert",
      instanceId: provider.instanceId,
      instance: turnedOnInstance(instance),
    });
    if (result._tag === "Failure") {
      if (!isAtomCommandInterrupted(result)) {
        const cause = squashAtomCommandFailure(result);
        toastManager.add({
          type: "error",
          title: gt("Could not turn on {agent}", { agent: agentName(provider) }),
          ...(cause instanceof Error ? { description: cause.message } : {}),
        });
      }
      return;
    }
    void refreshProviders({ environmentId, input: { instanceId: provider.instanceId } });
    if (isImportSource(provider.driver)) onImportSourceEnabled();
  };

  // One action per agent, the same in the list and in the grid.
  const actionFor = (provider: ServerProvider) => {
    const state = stateOf(provider);
    const name = agentName(provider);
    const settingsAction = (actionLabel: string) => (
      <Button
        size="xs"
        variant="outline"
        aria-label={gt("{action}: {agent}", { action: actionLabel, agent: name })}
        render={
          <Link
            to="/settings/providers"
            search={{ environmentId, instanceId: provider.instanceId }}
          />
        }
      >
        {actionLabel}
      </Button>
    );
    if (state === "disabled") {
      return (
        <Button
          size="xs"
          variant="outline"
          aria-label={gt("{action}: {agent}", { action: gt("Turn on"), agent: name })}
          disabled={!canManageProviders || serverConfig === null}
          onClick={() => void turnOn(provider)}
        >
          {gt("Turn on")}
        </Button>
      );
    }
    // Settings updates a broken CLI the way it was installed, including a custom binary path.
    if (isBrokenVersion(provider)) return settingsAction(gt("Update"));
    if (serverConfig !== null && codexNeedsSetup(provider, serverConfig.settings)) {
      const open = codexSetupId === provider.instanceId;
      return (
        <Button
          size="xs"
          variant="outline"
          aria-label={gt("{action}: {agent}", { action: gt("Set up"), agent: name })}
          aria-expanded={open}
          onClick={() => setCodexSetupId(open ? null : provider.instanceId)}
        >
          {gt("Set up")}
        </Button>
      );
    }
    if (needsInstallOrSignIn(provider)) {
      return (
        <TerminalAction
          name={name}
          signIn={state === "signIn"}
          disabled={
            terminalSession?.providerInstanceId === provider.instanceId ||
            serverConfig === null ||
            !canOperateTerminal
          }
          onClick={() => openTerminal(provider)}
        />
      );
    }
    return settingsAction(
      state === "signIn" ? gt("Sign in") : state === "attention" ? gt("Details") : gt("Set up"),
    );
  };

  const notes = [
    !canOperateTerminal &&
    [...found, ...available].some(
      (provider) =>
        needsInstallOrSignIn(provider) || codexNeedsSetup(provider, serverConfig?.settings),
    )
      ? gt("This connection does not have permission to open terminals.")
      : null,
    !canManageProviders &&
    (acpAllowed ||
      [...found, ...available].some(
        (provider) =>
          stateOf(provider) === "disabled" || codexNeedsSetup(provider, serverConfig?.settings),
      ))
      ? gt("This connection does not have permission to manage AI tools.")
      : null,
  ].filter((note) => note !== null);

  return (
    <WelcomeSection title={gt("AI tools")}>
      {found.map((provider) => (
        <AgentRow
          key={provider.instanceId}
          provider={provider}
          state={stateOf(provider)}
          action={actionFor(provider)}
        />
      ))}
      {checking && found.length === 0 ? (
        <p className="text-sm leading-10 text-muted-foreground">
          <T>
            Checking for AI tools on{" "}
            <bdi>
              <Var>{label ?? gt("this computer")}</Var>
            </bdi>
            …
          </T>
        </p>
      ) : null}
      {notes.map((note) => (
        <p key={note} className="ps-8 text-xs text-muted-foreground">
          {note}
        </p>
      ))}
      <Collapsible open={showMore} onOpenChange={setMoreOpen}>
        <CollapsibleTrigger className="group flex min-h-10 w-full items-center gap-3 rounded-md text-start outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset">
          <RowIcon>
            <PlusIcon className="size-4" />
          </RowIcon>
          <span
            className={cn(
              "text-sm group-hover:text-foreground",
              found.length > 0 ? "text-muted-foreground" : "text-foreground",
            )}
          >
            {found.length > 0 ? gt("Add another AI tool") : gt("Set up an AI tool")}
          </span>
          {showMore ? null : <AgentLogoStack providers={available} acp={acpAllowed} />}
          <ChevronDownIcon className="ms-auto size-4 text-muted-foreground group-data-panel-open:rotate-180" />
        </CollapsibleTrigger>
        <CollapsiblePanel>
          <div className="grid grid-cols-1 gap-x-8 sm:grid-cols-2">
            {available.map((provider) => (
              <AgentRow
                key={provider.instanceId}
                provider={provider}
                state={stateOf(provider)}
                compact
                action={actionFor(provider)}
              />
            ))}
          </div>
          {acpAllowed ? (
            <div className="flex min-h-9 items-center gap-3">
              <RowIcon>
                <ACPRegistryIcon className="size-4" />
              </RowIcon>
              <span className="min-w-0 flex-1 text-sm text-muted-foreground">
                {gt("More AI tools in the ACP Registry")}
              </span>
              <Button
                size="xs"
                variant="outline"
                disabled={!canManageProviders}
                onClick={() => setAddingProvider(true)}
              >
                {gt("Browse")}
              </Button>
            </div>
          ) : null}
        </CollapsiblePanel>
      </Collapsible>
      {codexSetupProvider !== null && serverConfig !== null ? (
        <div key={codexSetupProvider.instanceId} ref={revealOnMount} className="mt-2">
          <OnboardingCodexSetup
            environmentId={environmentId}
            provider={codexSetupProvider}
            serverConfig={serverConfig}
            onUseCliChange={(useCli) =>
              setCliTerminalFor(useCli ? codexSetupProvider.instanceId : null)
            }
          />
        </div>
      ) : null}
      {isPrimary && developerMode ? <CliPathSetup /> : null}
      {terminalSession !== null ? (
        <AgentInstallTerminal
          key={`${terminalSession.environmentId}:${terminalSession.providerInstanceId}:${terminalSession.driver}`}
          session={terminalSession}
          onCommandFinished={() =>
            void refreshProviders({
              environmentId,
              input: { instanceId: terminalSession.providerInstanceId },
            })
          }
          onClose={() => {
            setTerminalSession(null);
            void refreshProviders({ environmentId, input: {} });
          }}
        />
      ) : null}
      {addingProvider ? (
        <AddProviderInstanceDialog
          open
          environmentId={environmentId}
          environmentLabel={label ?? gt("this computer")}
          showMoreProviders
          onOpenChange={setAddingProvider}
          onCreated={(_instanceId, driver) => {
            void refreshProviders({ environmentId, input: {} });
            // A new Claude Code, Codex, or Pi instance can bring more history to import.
            if (isImportSource(driver)) onImportSourceEnabled();
          }}
        />
      ) : null}
    </WelcomeSection>
  );
}

// A quiet preview of what the fold holds; the names are inside it.
function AgentLogoStack({
  providers,
  acp,
}: {
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly acp: boolean;
}) {
  if (providers.length === 0 && !acp) return null;
  return (
    <span className="flex items-center gap-2 opacity-60 grayscale" aria-hidden>
      {providers.slice(0, 6).map((provider) => (
        <ProviderInstanceIcon
          key={provider.instanceId}
          driverKind={provider.driver}
          displayName={agentName(provider)}
          iconClassName="size-3.5"
        />
      ))}
      {acp ? <ACPRegistryIcon className="size-3.5" /> : null}
    </span>
  );
}

function ProjectsSection({
  scan,
  projectImport,
  isImporting,
}: {
  readonly scan: ReturnType<typeof useProjectScans>[number] | undefined;
  readonly projectImport: ReturnType<typeof useProjectImport>;
  readonly isImporting: boolean;
}) {
  const gt = useGT();
  const m = useMessages();
  const importSourcesLabel = useImportSourcesLabel();
  const [reviewing, setReviewing] = useState(false);
  const {
    canWrite,
    candidates,
    isNew,
    recent,
    selected,
    selectedKeys,
    setSelectedKeys,
    visibleImportError,
  } = projectImport;
  if (scan === undefined) return null;
  if (scan.isPending && candidates.length === 0) {
    return (
      <WelcomeSection title={gt("Folders")}>
        <p className="text-sm leading-10 text-muted-foreground">
          {gt("Looking for folders in your {sources} history…", { sources: importSourcesLabel })}
        </p>
      </WelcomeSection>
    );
  }
  const retry = (
    <Button variant="ghost" size="sm" onClick={scan.refresh}>
      {gt("Try again")}
    </Button>
  );
  if (scan.error !== null && candidates.length === 0) {
    return (
      <WelcomeSection title={gt("Folders")}>
        <div
          role="alert"
          className="flex min-h-10 items-center justify-between gap-3 text-sm text-muted-foreground"
        >
          <span>
            {gt("Could not scan folders.")} {scan.error}
          </span>
          {retry}
        </div>
      </WelcomeSection>
    );
  }
  if (candidates.length === 0) {
    return scan.data?.truncated ? (
      <WelcomeSection title={gt("Folders")}>
        <p className="text-xs leading-10 text-muted-foreground" role="status">
          {m(SCAN_LIMIT_MESSAGE)}
        </p>
      </WelcomeSection>
    ) : null;
  }

  const allKeys = candidates.map((candidate) => candidate.key);
  // Checking the box picks recent new projects, else any new ones, else everything listed.
  const fresh = candidates.filter(isNew);
  const defaultKeys = (recent.length > 0 ? recent : fresh.length > 0 ? fresh : candidates).map(
    (candidate) => candidate.key,
  );
  const partial =
    selected.length > 0 &&
    selected.length < candidates.length &&
    !(selected.length === defaultKeys.length && defaultKeys.every((key) => selectedKeys.has(key)));
  return (
    <WelcomeSection title={gt("Folders")}>
      <div className="flex min-h-10 items-center gap-3 py-1">
        <label className="flex min-w-0 flex-1 items-center gap-3">
          <RowIcon>
            <Checkbox
              checked={canWrite && selected.length > 0}
              indeterminate={canWrite && partial}
              disabled={isImporting || !canWrite}
              onCheckedChange={(checked) =>
                setSelectedKeys(new Set(checked ? defaultKeys : []), { optedOut: !checked })
              }
            />
          </RowIcon>
          <span className="min-w-0 flex-1">
            <span className="block text-sm font-medium text-foreground">
              {canWrite && selected.length > 0
                ? gt(
                    "{count, plural, one {Import {count} folder and its chats} other {Import {count} folders and their chats}}",
                    { count: selected.length },
                  )
                : gt("Import folders and their chats")}
            </span>
            <span className="block text-xs text-muted-foreground">
              {gt("From your {sources} history", { sources: importSourcesLabel })}
            </span>
          </span>
        </label>
        {canWrite ? (
          <Button
            variant="ghost-muted"
            size="xs"
            aria-expanded={reviewing}
            onClick={() => setReviewing((open) => !open)}
          >
            {reviewing
              ? gt("Hide")
              : gt("{count, plural, one {Review all {count}} other {Review all {count}}}", {
                  count: candidates.length,
                })}
            <ChevronDownIcon className={cn("size-3.5", reviewing && "rotate-180")} />
          </Button>
        ) : null}
      </div>
      {reviewing && canWrite ? (
        // The negative margin lines the list's checkboxes up with the one above it.
        <fieldset className="-mx-1.5 mt-1 min-w-0" disabled={isImporting}>
          <div className="flex items-center justify-between gap-3 px-2 text-xs text-muted-foreground">
            <span role="status">
              {gt(
                "{selected, plural, one {{selected} of {total} selected} other {{selected} of {total} selected}}",
                { selected: selected.length, total: candidates.length },
              )}
            </span>
            <div className="flex items-center gap-1">
              <Button
                variant="ghost"
                size="xs"
                disabled={selected.length === candidates.length}
                onClick={() => setSelectedKeys(new Set(allKeys))}
              >
                {gt("Select all")}
              </Button>
              <Button
                variant="ghost"
                size="xs"
                disabled={selected.length === 0}
                onClick={() => setSelectedKeys(new Set())}
              >
                {gt("Select none")}
              </Button>
            </div>
          </div>
          <ScrollArea scrollFade className="mt-1 h-auto max-h-80">
            <div className="space-y-0.5 pe-3">
              <ImportCandidateList
                candidates={candidates}
                selectedKeys={selectedKeys}
                onSelectionChange={setSelectedKeys}
              />
            </div>
          </ScrollArea>
        </fieldset>
      ) : null}
      {scan.data?.truncated ? (
        <p className="ps-8 text-xs text-muted-foreground" role="status">
          {m(SCAN_LIMIT_MESSAGE)}
        </p>
      ) : null}
      {scan.error !== null ? (
        <div
          role="alert"
          className="flex items-center justify-between gap-3 ps-8 text-sm text-muted-foreground"
        >
          <span>
            {gt("Could not rescan folders.")} {scan.error}
          </span>
          {retry}
        </div>
      ) : null}
      {visibleImportError ? (
        <p className="pt-1 ps-8 text-sm text-destructive">{m(visibleImportError)}</p>
      ) : null}
    </WelcomeSection>
  );
}

function PhoneSection({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const gt = useGT();
  return (
    <WelcomeSection title={gt("Phone")}>
      <div className="flex flex-col gap-6 pt-1 sm:flex-row sm:items-center sm:gap-8">
        <ol className="min-w-0 flex-1 space-y-5">
          <PhoneStep step={1}>
            <p className="text-sm text-foreground">
              {gt("Scan this code with your phone to install the app.")}
            </p>
          </PhoneStep>
          <PhoneStep step={2}>
            <PhoneConnectLink environmentId={environmentId} />
          </PhoneStep>
        </ol>
        {/* One code for both stores: the link opens the store that matches the phone. */}
        <div className="w-fit shrink-0 rounded-lg bg-white p-1.5">
          <QRCodeSvg
            value={MOBILE_APP_URL}
            size={124}
            level="M"
            marginSize={2}
            title={gt("DoeDesk app for iPhone and Android")}
          />
        </div>
      </div>
    </WelcomeSection>
  );
}

function PhoneStep({ step, children }: { readonly step: number; readonly children: ReactNode }) {
  return (
    <li className="flex gap-3">
      <span className="w-3 shrink-0 text-sm text-muted-foreground tabular-nums">{step}</span>
      <div className="flex min-w-0 flex-col items-start gap-2">{children}</div>
    </li>
  );
}

function PhoneConnectLink({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const { isLoaded, isSignedIn, userId } = useAuth({ treatPendingAsSignedOut: false });
  const gt = useGT();
  const loadFailed = useClerkLoadFailed();
  const { openAuthPrompt } = useT3ConnectAuthPrompt();
  const linkState = useCloudLinkState(environmentId);
  const refreshLinkState = useEffectEvent(linkState.refresh);
  // The server rechecks the tunnel every 30 s; read its latest result while this panel is open.
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- 30 s interval that refreshes the cloud link reachability while mounted
  useEffect(() => {
    const interval = window.setInterval(() => refreshLinkState(), 30_000);
    return () => window.clearInterval(interval);
  }, []);
  const link = linkState.data;
  // The phone reaches this computer through its tunnel; older servers leave that flag out.
  const shared =
    link !== null &&
    link.linked &&
    link.linkRevoked !== true &&
    link.cloudUserId === userId &&
    link.managedTunnelActive !== false;
  // The server checks the tunnel on its own; until it has, the result is unknown.
  const reachability = shared ? link.reachability?.status : undefined;
  const settingsLink = (label: string) => (
    <Button variant="outline" size="xs" render={<Link to="/settings/access" />}>
      {label}
    </Button>
  );
  if (isSignedIn && link === null && linkState.isPending) {
    return <p className="text-sm text-muted-foreground">{gt("Checking T3 Connect…")}</p>;
  }
  if (isSignedIn && linkState.error !== null) {
    return (
      <>
        <p className="text-sm text-foreground">{gt("Could not check T3 Connect.")}</p>
        {settingsLink(gt("Check T3 Connect"))}
      </>
    );
  }
  if (isSignedIn && reachability === "reachable") {
    return (
      <p className="flex gap-1.5 text-sm text-foreground">
        <CheckIcon className="mt-0.5 size-4 shrink-0 text-success-foreground" />
        {gt("Your phone can reach this computer. Sign in to the mobile app with the same account.")}
      </p>
    );
  }
  if (isSignedIn && shared && reachability === undefined) {
    return (
      <p className="text-sm text-foreground">
        {gt("T3 Connect is on for this computer. Sign in to the mobile app with the same account.")}
      </p>
    );
  }
  if (isSignedIn) {
    // Signing in alone does not share this computer, for example after "Not now".
    return (
      <>
        <p className="text-sm text-foreground">
          {shared
            ? gt("T3 Connect is on, but the mobile app cannot reach this computer.")
            : gt("Signed in. Share this computer so the mobile app can reach it.")}
        </p>
        {settingsLink(shared ? gt("Check T3 Connect") : gt("Set up T3 Connect"))}
      </>
    );
  }
  return (
    <>
      <p className="text-sm text-foreground">
        {gt(
          "T3 Connect uses a separate account from your DoeDesk account. Sign in to T3 Connect here, then sign in to the mobile app with that same account.",
        )}
      </p>
      {loadFailed ? (
        <Button variant="outline" size="xs" onClick={retryClerkLoad}>
          {gt("Retry sign-in")}
        </Button>
      ) : (
        <Button variant="outline" size="xs" disabled={!isLoaded} onClick={openAuthPrompt}>
          {gt("Sign in to T3 Connect")}
        </Button>
      )}
    </>
  );
}

// The ChatGPT card and the CLI card stay one card, so either choice can be undone here.
function OnboardingCodexSetup({
  environmentId,
  provider,
  serverConfig,
  onUseCliChange,
}: {
  readonly environmentId: EnvironmentId;
  readonly provider: ServerProvider;
  readonly serverConfig: ServerConfig;
  // True asks for the CLI's install or sign-in terminal once Codex has checked the CLI.
  readonly onUseCliChange: (useCli: boolean) => void;
}) {
  const gt = useGT();
  const canManageProviders = useEnvironmentScope(environmentId, AuthProvidersManageScope);
  const canOperateTerminal = useEnvironmentScope(environmentId, AuthTerminalOperateScope);
  const persistProviderInstance = usePersistEnvironmentProviderInstanceMutation(environmentId);
  const instanceId = provider.instanceId;
  const instance = serverConfig.settings.providerInstances[instanceId] ?? {
    driver: provider.driver,
    config: {},
  };
  const config =
    instance.config !== null && typeof instance.config === "object" ? instance.config : {};
  const mode = readCodexSetupMode(config);
  const changeMode = (setupMode: "managed" | "existing") => {
    // "Use existing CLI" also opens a terminal to install or sign in to the CLI.
    onUseCliChange(setupMode === "existing");
    const unchanged = mode === setupMode && provider.enabled;
    if (unchanged || !readEnvironmentScope(environmentId, AuthProvidersManageScope)) return;
    // One-instance upsert keeps a provider another client added in the meantime.
    void persistProviderInstance({
      operation: "upsert",
      instanceId,
      instance: { ...instance, enabled: true, config: { ...config, enabled: true, setupMode } },
    }).then((result) => {
      if (result._tag === "Failure") {
        onUseCliChange(false);
        if (!isAtomCommandInterrupted(result)) {
          const cause = squashAtomCommandFailure(result);
          toastManager.add({
            type: "error",
            title: gt("Could not save Codex setup"),
            ...(cause instanceof Error ? { description: cause.message } : {}),
          });
        }
      }
    });
  };
  return (
    <CodexSetupSection
      presentation="onboarding"
      environmentId={environmentId}
      instanceId={instanceId}
      provider={provider}
      mode={mode}
      enabled={provider.enabled}
      readOnly={!canManageProviders}
      existingCliDisabled={!canOperateTerminal}
      displayName={agentName(provider)}
      onModeChange={changeMode}
    />
  );
}

function TerminalAction({
  name,
  signIn,
  disabled,
  onClick,
}: {
  readonly name: string;
  readonly signIn: boolean;
  readonly disabled: boolean;
  readonly onClick: () => void;
}) {
  const gt = useGT();
  const label = signIn ? gt("Sign in") : gt("Install");
  return (
    <Button
      size="xs"
      variant="outline"
      aria-label={gt("{action}: {agent}", { action: label, agent: name })}
      disabled={disabled}
      onClick={onClick}
    >
      <TerminalIcon className="size-3.5" />
      {label}
    </Button>
  );
}

function AgentRow({
  provider,
  state,
  action,
  compact = false,
}: {
  readonly provider: ServerProvider;
  readonly state: ReturnType<typeof welcomeAgentState>;
  readonly action?: ReactNode;
  // A row in the "Add more" grid: the button carries the state, so no detail line.
  readonly compact?: boolean;
}) {
  const gt = useGT();
  const name = agentName(provider);
  const messages = useMessages();
  // Claude Code and Codex tiles show Install or Set up; other agents that are on say why not.
  const brokenMessage = isBrokenVersion(provider)
    ? (provider.compatibilityAdvisory?.message ?? null)
    : null;
  const detail =
    state === "install"
      ? isInstallableDriver(provider.driver)
        ? null
        : gt("Not installed")
      : compact || state === "ready" || state === "checking"
        ? null
        : state === "attention"
          ? (provider.unavailableReason ??
            brokenMessage ??
            provider.message ??
            getProviderSummary(provider, messages).headline)
          : (brokenMessage ?? getProviderSummary(provider, messages).headline);
  return (
    <div className={cn("flex items-center gap-3", compact ? "min-h-9" : "min-h-10 py-1")}>
      <RowIcon>
        <ProviderInstanceIcon
          driverKind={provider.driver}
          displayName={name}
          iconClassName={compact ? "size-4" : "size-[18px]"}
        />
      </RowIcon>
      <div className="min-w-0 flex-1">
        <span className={cn("block truncate text-sm text-foreground", !compact && "font-medium")}>
          {name}
        </span>
        {detail ? (
          <p className="line-clamp-2 text-xs leading-relaxed break-words text-muted-foreground">
            {detail}
          </p>
        ) : null}
      </div>
      <div className="shrink-0">
        {state === "ready" ? (
          <span className="inline-flex items-center gap-1.5 text-xs font-medium text-success-foreground">
            <CheckIcon className="size-3.5" />
            {gt("Ready")}
          </span>
        ) : state === "checking" ? (
          <span className="text-xs text-muted-foreground">{gt("Checking…")}</span>
        ) : (
          action
        )}
      </div>
    </div>
  );
}

function AgentInstallTerminal({
  session,
  onCommandFinished,
  onClose,
}: {
  readonly session: AgentTerminalSession;
  readonly onCommandFinished: () => void;
  readonly onClose: () => void;
}) {
  const { command, cwd, displayName, driver, environmentId, keybindings, providerInstanceId } =
    session;
  const canOperateTerminal = useEnvironmentScope(environmentId, AuthTerminalOperateScope);
  const gt = useGT();
  const [advancedTypography] = useLocalStorage(
    TYPOGRAPHY_ADVANCED_STORAGE_KEY,
    false,
    Schema.Boolean,
  );
  const openTerminal = useAtomCommand(terminalEnvironment.open, { reportFailure: false });
  const writeTerminal = useAtomCommand(terminalEnvironment.write, { reportFailure: false });
  const closeTerminal = useAtomCommand(terminalEnvironment.close, { reportFailure: false });
  const setupQueueRef = useRef(Promise.resolve());
  const setupGenerationRef = useRef(0);
  const activeSetupGenerationRef = useRef<number | null>(null);
  const [terminalId] = useState(() => `onboarding-${driver}-${randomUUID()}`);
  const threadRef = scopeThreadRef(environmentId, AGENT_ONBOARDING_THREAD_ID);
  const [setupAttempt, setSetupAttempt] = useState(0);
  const [setupState, setSetupState] = useState<
    "preparing" | "ready" | "openFailed" | "writeFailed"
  >("preparing");
  const terminalReady = setupState === "ready" || setupState === "writeFailed";
  const commandRunning = useThreadRunningTerminalIds({
    environmentId,
    threadId: AGENT_ONBOARDING_THREAD_ID,
  }).includes(terminalId);
  const commandStartedRef = useRef(false);
  const handleCommandFinished = useEffectEvent(onCommandFinished);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- the shell stays open after an install or sign-in, so its command exiting is the only signal to check the agent again
  useEffect(() => {
    if (commandRunning) {
      commandStartedRef.current = true;
    } else if (commandStartedRef.current) {
      commandStartedRef.current = false;
      handleCommandFinished();
    }
  }, [commandRunning]);

  // StrictMode can finish a cancelled open after replacement setup; it must not close or pre-type into that
  // session.
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- opens the setup PTY, types the command into it, and closes it on cleanup
  useEffect(() => {
    const generation = setupGenerationRef.current + 1;
    setupGenerationRef.current = generation;
    activeSetupGenerationRef.current = generation;
    // oxlint-disable-next-line react/set-state-in-effect -- A retry or a new command reopens the terminal, which shows as preparing until the open settles.
    setSetupState("preparing");

    setupQueueRef.current = setupQueueRef.current.then(async () => {
      if (activeSetupGenerationRef.current !== generation) return;
      if (!readEnvironmentScope(environmentId, AuthTerminalOperateScope)) {
        setSetupState("openFailed");
        return;
      }
      const opened = await openTerminal({
        environmentId,
        input: {
          threadId: AGENT_ONBOARDING_THREAD_ID,
          terminalId,
          cwd,
          providerInstanceId,
        },
      });
      if (opened._tag !== "Success") {
        if (activeSetupGenerationRef.current === generation) setSetupState("openFailed");
        return;
      }

      if (activeSetupGenerationRef.current !== generation) return;
      if (!readEnvironmentScope(environmentId, AuthTerminalOperateScope)) {
        setSetupState("writeFailed");
        return;
      }

      const wrote = await writeTerminal({
        environmentId,
        input: { threadId: AGENT_ONBOARDING_THREAD_ID, terminalId, data: command },
      });
      if (activeSetupGenerationRef.current !== generation) return;
      setSetupState(wrote._tag === "Success" ? "ready" : "writeFailed");
    });

    // Revocation leaves the PTY running; close only while terminal access remains.
    return () => {
      if (activeSetupGenerationRef.current === generation) {
        activeSetupGenerationRef.current = null;
      }
      setupQueueRef.current = setupQueueRef.current.then(async () => {
        if (!readEnvironmentScope(environmentId, AuthTerminalOperateScope)) return;
        await closeTerminal({
          environmentId,
          input: { threadId: AGENT_ONBOARDING_THREAD_ID, terminalId, deleteHistory: true },
        });
      });
    };
  }, [
    closeTerminal,
    command,
    cwd,
    environmentId,
    openTerminal,
    providerInstanceId,
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- Retry bumps setupAttempt to open the terminal again.
    setupAttempt,
    terminalId,
    writeTerminal,
  ]);

  return (
    <div
      data-thread-terminal-drawer
      className="mt-4 overflow-hidden rounded-lg border border-border/70 bg-background text-foreground"
    >
      <div className="flex items-center justify-between border-b border-border/60 bg-background/60 px-3 py-1.5">
        <span className="text-2xs font-medium text-muted-foreground">
          {!canOperateTerminal ? (
            gt("This connection does not have permission to open terminals.")
          ) : setupState === "writeFailed" ? (
            <T>
              Run{" "}
              <code className="rounded bg-muted px-1 font-mono" dir="ltr">
                <Var>{command}</Var>
              </code>{" "}
              in the terminal below.
            </T>
          ) : setupState === "ready" ? (
            gt("Review the command below, then press Enter to run it.")
          ) : setupState === "openFailed" ? (
            gt("Could not open the setup terminal.")
          ) : (
            gt("Preparing command…")
          )}
        </span>
        <div className="flex items-center gap-1">
          {setupState === "openFailed" ? (
            <Button
              size="xs"
              variant="ghost"
              disabled={!canOperateTerminal}
              onClick={() => {
                if (readEnvironmentScope(environmentId, AuthTerminalOperateScope)) {
                  setSetupAttempt((value) => value + 1);
                }
              }}
            >
              {gt("Try again")}
            </Button>
          ) : null}
          <Button size="xs" variant="ghost-muted" onClick={onClose}>
            {gt("Close")}
          </Button>
        </div>
      </div>
      <div className="h-64">
        {terminalReady ? (
          <TerminalViewport
            threadRef={threadRef}
            threadId={AGENT_ONBOARDING_THREAD_ID}
            terminalId={terminalId}
            terminalLabel={gt("Install {agent}", { agent: displayName })}
            cwd={cwd}
            providerInstanceId={providerInstanceId}
            advancedTypography={advancedTypography}
            onSessionExited={onClose}
            autoFocus
            visible
            keybindings={keybindings}
          />
        ) : null}
      </div>
    </div>
  );
}

const IMPORT_PERMISSION_MESSAGE = msg(
  "This connection does not have permission to import folders or chat history.",
);

// Creates the selected projects, then imports each one's agent history. Owns retry state so a
// second Start resumes instead of recreating projects.
function useProjectImport({
  scans,
  importSelection,
  onImportSelectionChange,
  isImporting,
  setIsImporting,
  holdPageRef,
  onDone,
}: {
  readonly scans: ReturnType<typeof useProjectScans>;
  readonly importSelection: WelcomeImportSelection | null;
  readonly onImportSelectionChange: (next: WelcomeImportSelection) => void;
  readonly isImporting: boolean;
  readonly setIsImporting: (value: boolean) => void;
  // Blocks leaving the page; onDone releases it before landing.
  readonly holdPageRef: { current: boolean };
  readonly onDone: (
    projectRef?: ScopedProjectRef,
    importWarning?: string,
    importedThreadCount?: number,
  ) => Promise<boolean>;
}) {
  const writableEnvironments = useEnvironmentsWithScope(scans, AuthOrchestrationOperateScope);
  const gt = useGT();
  const createProject = useAtomCommand(projectEnvironment.create, { reportFailure: false });
  const importThreads = useAtomCommand(agentSessionImport, { reportFailure: false });
  const importWarningRef = useRef("");
  // Per project, so a retry that skips finished projects still counts their threads.
  const importedThreadsRef = useRef(new Map<string, number>());
  const importedProjectsRef = useRef(new Map<string, ScopedProjectRef>());
  const projectsWithImportedHistoryRef = useRef(new Map<string, ScopedProjectRef>());
  const lastImportSelectionRef = useRef<ReadonlyArray<string>>([]);
  const projectAttemptsRef = useRef(
    new Map<string, { readonly projectId: ProjectId; readonly commandId: CommandId }>(),
  );
  const importGenerationRef = useRef(0);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- bumps the import generation on mount and unmount so in-flight imports drop stale results
  useEffect(() => {
    importGenerationRef.current += 1;
    return () => {
      importGenerationRef.current += 1;
    };
  }, []);

  const { available: candidates, recent: recentActive } = partitionOnboardingProjects(
    scans.flatMap((scan) =>
      (scan.data?.candidates ?? []).map((candidate) => ({
        ...candidate,
        environmentId: scan.environmentId,
        key: onboardingProjectKey(scan.environmentId, candidate.path),
      })),
    ),
  );
  // Projects already in DoeDesk stay in the list, but reopening the page does not import their
  // history again unless the user picks them. The scan can be 30 s old, so the live list decides.
  const projects = useProjects();
  const isNewProject = isNewOnboardingProject(projects);
  const isNew = (candidate: ImportCandidate) => isNewProject(candidate.environmentId, candidate);
  const recent = recentActive.filter(isNew);
  const recentKeys = new Set(recent.map((candidate) => candidate.key));
  const knownKeys = new Set(importSelection?.knownKeys);
  const pickedKeys = new Set(importSelection?.keys);
  const selected = importSelection?.optedOut
    ? []
    : candidates.filter((candidate) =>
        knownKeys.has(candidate.key)
          ? pickedKeys.has(candidate.key)
          : recentKeys.has(candidate.key),
      );
  const selectedKeys = new Set(selected.map((candidate) => candidate.key));
  const setSelectedKeys = (keys: ReadonlySet<string>, { optedOut = false } = {}) =>
    onImportSelectionChange({
      knownKeys: candidates.map((candidate) => candidate.key),
      keys: [...keys],
      optedOut,
    });

  const canWrite = scans.every((scan) => writableEnvironments.has(scan.environmentId));
  const canImport = selected.every((candidate) =>
    writableEnvironments.has(candidate.environmentId),
  );
  const visibleImportError = canWrite && canImport ? "" : IMPORT_PERMISSION_MESSAGE;

  const importedThreadTotal = () =>
    lastImportSelectionRef.current.reduce(
      (total, key) => total + (importedThreadsRef.current.get(key) ?? 0),
      0,
    );

  const finishAfterImport = () => {
    const projectRef = resolveOnboardingLandingProject(
      lastImportSelectionRef.current,
      projectsWithImportedHistoryRef.current,
      importedProjectsRef.current,
    );
    // Busy until setup is saved, so Start cannot run the import again meanwhile.
    setIsImporting(true);
    if (projectRef === undefined) {
      void onDone(undefined, importWarningRef.current, importedThreadTotal()).then((completed) => {
        if (!completed) setIsImporting(false);
      });
      return;
    }
    holdPageRef.current = true;
    const importGeneration = importGenerationRef.current;
    // waitForProject gives up after its timeout, so a project that never reaches the client
    // still finishes setup, just without landing in it.
    void waitForProject(projectRef)
      .then(
        () => projectRef,
        () => undefined,
      )
      .then(async (landing) => {
        if (importGeneration !== importGenerationRef.current) {
          holdPageRef.current = false;
          return;
        }
        const completed = await onDone(landing, importWarningRef.current, importedThreadTotal());
        if (!completed) setIsImporting(false);
      });
  };

  const runImport = async (selection: typeof candidates) => {
    if (isImporting) return;
    const hasAccess = () =>
      selection.every((candidate) =>
        readEnvironmentScope(candidate.environmentId, AuthOrchestrationOperateScope),
      );
    // The permission message shows from the session's scopes.
    const stopForDeniedAccess = () => setIsImporting(false);
    if (!hasAccess()) {
      stopForDeniedAccess();
      return;
    }
    setIsImporting(true);
    importWarningRef.current = "";
    lastImportSelectionRef.current = selection.map((candidate) => candidate.key);
    const importGeneration = importGenerationRef.current;
    const importedThreads = importedThreadsRef.current;
    const importedProjects = importedProjectsRef.current;
    const projectAttempts = projectAttemptsRef.current;
    let importedProjectsCount =
      importedProjects.size > 0
        ? selection.filter((candidate) => importedProjects.has(candidate.key)).length
        : 0;
    let skippedThreadCount = 0;
    const refreshEnvironments = new Set<EnvironmentId>();
    // Resolves false when the run stopped early: a newer run, an unmount, or lost access.
    const importEach = async () => {
      for (const candidate of selection) {
        const { environmentId } = candidate;
        if (importGeneration !== importGenerationRef.current) return false;
        if (!hasAccess()) {
          stopForDeniedAccess();
          return false;
        }
        if (importedProjects.has(candidate.key)) continue;
        let projectId = resolveOnboardingProjectId(readProjects(), environmentId, candidate);
        if (projectId === null) {
          let attempt = projectAttempts.get(candidate.key);
          if (attempt === undefined) {
            const nextProjectId = newProjectId();
            attempt = {
              projectId: nextProjectId,
              commandId: CommandId.make(`onboarding:project:create:${nextProjectId}`),
            };
            projectAttempts.set(candidate.key, attempt);
          }
          projectId = attempt.projectId;
          const result = await createProject({
            environmentId,
            input: {
              projectId,
              commandId: attempt.commandId,
              title: candidate.title,
              workspaceRoot: candidate.path,
              createWorkspaceRootIfMissing: false,
              defaultModelSelection: null,
            },
          });
          if (importGeneration !== importGenerationRef.current) return false;
          if (result._tag !== "Success") {
            if (!isAtomCommandInterrupted(result)) {
              projectAttempts.delete(candidate.key);
              refreshEnvironments.add(environmentId);
            }
            continue;
          }
        }

        if (!hasAccess()) {
          stopForDeniedAccess();
          return false;
        }
        const threadImportResult = await importThreads({
          environmentId,
          input: { projectId, expectedWorkspaceRoot: candidate.path },
        });
        if (importGeneration !== importGenerationRef.current) return false;
        if (threadImportResult._tag === "Success") {
          importedThreads.set(
            candidate.key,
            (importedThreads.get(candidate.key) ?? 0) + threadImportResult.value.importedCount,
          );
          skippedThreadCount += threadImportResult.value.skippedCount;
          if (threadImportResult.value.importedCount > 0) {
            projectsWithImportedHistoryRef.current.set(
              candidate.key,
              scopeProjectRef(environmentId, projectId),
            );
          }
          if (threadImportResult.value.skippedCount === 0) {
            importedProjectsCount += 1;
            importedProjects.set(candidate.key, scopeProjectRef(environmentId, projectId));
          }
        } else if (!isAtomCommandInterrupted(threadImportResult)) {
          projectAttempts.delete(candidate.key);
          refreshEnvironments.add(environmentId);
        }
      }
      return true;
    };
    holdPageRef.current = true;
    const completed = await importEach().finally(() => {
      holdPageRef.current = false;
    });
    if (!completed) return;
    for (const scan of scans) {
      if (refreshEnvironments.has(scan.environmentId)) scan.refresh();
    }
    setIsImporting(false);
    const importedThreadCount = importedThreadTotal();
    if (importedProjectsCount < selection.length) {
      if (importedThreadCount > 0 && skippedThreadCount > 0) {
        importWarningRef.current = `${gt(
          "{count, plural, one {Imported {count} chat.} other {Imported {count} chats.}}",
          { count: importedThreadCount },
        )} ${gt(
          "{count, plural, one {{count} chat could not be imported.} other {{count} chats could not be imported.}}",
          { count: skippedThreadCount },
        )}`;
      } else if (skippedThreadCount > 0) {
        importWarningRef.current = gt(
          "{count, plural, one {{count} chat could not be imported.} other {{count} chats could not be imported.}}",
          { count: skippedThreadCount },
        );
      } else if (importedThreadCount > 0) {
        importWarningRef.current = gt(
          "{count, plural, one {Imported {count} chat. Some chat history could not be imported.} other {Imported {count} chats. Some chat history could not be imported.}}",
          { count: importedThreadCount },
        );
      } else {
        importWarningRef.current = gt("Could not import chat history.");
      }
    }
    finishAfterImport();
  };

  return {
    canWrite,
    candidates,
    isNew,
    recent,
    selected,
    selectedKeys,
    setSelectedKeys,
    visibleImportError,
    runImport,
    finishAfterImport,
  };
}

type ImportCandidate = AgentSessionProjectCandidate & {
  readonly environmentId: EnvironmentId;
  readonly key: string;
};

function ImportCandidateList({
  candidates,
  selectedKeys,
  onSelectionChange,
}: {
  readonly candidates: ReadonlyArray<ImportCandidate>;
  readonly selectedKeys: ReadonlySet<string>;
  readonly onSelectionChange: (next: ReadonlySet<string>) => void;
}) {
  const { repositories, other } = groupOnboardingProjects(candidates);
  const setKeys = (keys: ReadonlyArray<string>, checked: boolean) => {
    const next = new Set(selectedKeys);
    for (const key of keys) {
      if (checked) next.add(key);
      else next.delete(key);
    }
    onSelectionChange(next);
  };
  const otherSelected = other.filter((candidate) => selectedKeys.has(candidate.key)).length;
  const gt = useGT();

  return (
    <>
      {repositories.map((group) => (
        <ImportRepositoryGroup
          key={group.key}
          group={group}
          selectedKeys={selectedKeys}
          onToggle={setKeys}
        />
      ))}
      {other.length > 0 ? (
        <Collapsible>
          <div className="flex items-center gap-2.5 rounded-md px-2 py-1.5 hover:bg-muted/40">
            <Checkbox
              checked={otherSelected === other.length}
              indeterminate={otherSelected > 0 && otherSelected < other.length}
              onCheckedChange={(checked) =>
                setKeys(
                  other.map((candidate) => candidate.key),
                  checked === true,
                )
              }
            />
            <CollapsibleTrigger className="group flex min-w-0 flex-1 items-center gap-1.5 text-start">
              <ChevronRightIcon className="size-3.5 shrink-0 text-muted-foreground transition-transform rtl:rotate-180 group-data-panel-open:rotate-90" />
              <span className="truncate text-sm text-muted-foreground">{gt("Other folders")}</span>
              <span className="ms-auto shrink-0 text-xs text-muted-foreground tabular-nums">
                {gt("{count, plural, one {{count} folder} other {{count} folders}}", {
                  count: other.length,
                })}
              </span>
            </CollapsibleTrigger>
          </div>
          <CollapsiblePanel>
            {other.map((candidate) => (
              <ImportCandidateRow
                key={candidate.key}
                candidate={candidate}
                path={candidate.path}
                nested
                checked={selectedKeys.has(candidate.key)}
                onCheckedChange={(checked) => setKeys([candidate.key], checked)}
              />
            ))}
          </CollapsiblePanel>
        </Collapsible>
      ) : null}
    </>
  );
}

function ImportRepositoryGroup({
  group,
  selectedKeys,
  onToggle,
}: {
  readonly group: OnboardingProjectGroup<ImportCandidate>;
  readonly selectedKeys: ReadonlySet<string>;
  readonly onToggle: (keys: ReadonlyArray<string>, checked: boolean) => void;
}) {
  const keys = group.candidates.map((candidate) => candidate.key);
  const selectedCount = keys.filter((key) => selectedKeys.has(key)).length;
  const single = group.candidates.length === 1;
  const only = group.candidates[0];
  if (single && only !== undefined) {
    return (
      <ImportCandidateRow
        candidate={only}
        label={group.label}
        path={only.path}
        checked={selectedKeys.has(only.key)}
        onCheckedChange={(checked) => onToggle([only.key], checked)}
      />
    );
  }
  return (
    <Collapsible defaultOpen>
      <div className="flex items-center gap-2.5 rounded-md px-2 py-1.5 hover:bg-muted/40">
        <Checkbox
          checked={selectedCount === keys.length}
          indeterminate={selectedCount > 0 && selectedCount < keys.length}
          onCheckedChange={(checked) => onToggle(keys, checked === true)}
        />
        <CollapsibleTrigger className="group flex min-w-0 flex-1 items-center gap-1.5 text-start">
          <ChevronRightIcon className="size-3.5 shrink-0 text-muted-foreground transition-transform rtl:rotate-180 group-data-panel-open:rotate-90" />
          <span className="truncate text-sm font-medium">{group.label}</span>
          <ImportRowMeta
            sources={[...new Set(group.candidates.flatMap((c) => c.sources))]}
            threadCount={group.threadCount}
            lastActiveAt={group.lastActiveAt}
          />
        </CollapsibleTrigger>
      </div>
      <CollapsiblePanel>
        {group.candidates.map((candidate) => (
          <ImportCandidateRow
            key={candidate.key}
            candidate={candidate}
            path={candidate.path}
            nested
            checked={selectedKeys.has(candidate.key)}
            onCheckedChange={(checked) => onToggle([candidate.key], checked)}
          />
        ))}
      </CollapsiblePanel>
    </Collapsible>
  );
}

function ProjectPathText({
  path,
  className,
}: {
  readonly path: string;
  readonly className?: string;
}) {
  const { name, parent } = splitOnboardingProjectPath(path);
  return (
    <span className={cn("flex min-w-0 items-baseline font-mono", className)}>
      {parent.length > 0 ? <span className="truncate">{parent}</span> : null}
      <span className="max-w-full shrink-0 truncate">{name}</span>
    </span>
  );
}

function ImportCandidateRow({
  candidate,
  label,
  path,
  nested = false,
  checked,
  onCheckedChange,
}: {
  readonly candidate: ImportCandidate;
  readonly label?: string;
  readonly path?: string;
  readonly nested?: boolean;
  readonly checked: boolean;
  readonly onCheckedChange: (checked: boolean) => void;
}) {
  return (
    <label
      className={cn(
        "flex cursor-pointer items-center gap-2.5 rounded-md px-2 py-1.5 hover:bg-muted/40 has-disabled:cursor-default",
        nested && "ps-8",
      )}
    >
      <Checkbox checked={checked} onCheckedChange={(value) => onCheckedChange(value === true)} />
      <Tooltip>
        <TooltipTrigger
          render={<span className="flex min-w-0 flex-1 items-baseline gap-2 truncate" />}
        >
          {label !== undefined ? (
            <span className="truncate text-sm font-medium">{label}</span>
          ) : null}
          {path !== undefined ? (
            <ProjectPathText
              path={path}
              className={label === undefined ? "text-xs" : "text-2xs text-muted-foreground"}
            />
          ) : null}
        </TooltipTrigger>
        <TooltipPopup variant="code">{candidate.path}</TooltipPopup>
      </Tooltip>
      <ImportRowMeta
        sources={nested ? null : candidate.sources}
        threadCount={candidate.threadCount}
        lastActiveAt={candidate.lastActiveAt}
      />
    </label>
  );
}

const IMPORT_SOURCE_NAMES: Record<AgentSessionSource, string> = {
  claudeAgent: "Claude Code",
  codex: "Codex",
  pi: "Pi",
};
function useImportSourcesLabel() {
  return new Intl.ListFormat(useLocale(), { type: "conjunction" }).format(
    AgentSessionSource.literals.map((source) => IMPORT_SOURCE_NAMES[source]),
  );
}

function ImportRowMeta({
  sources,
  threadCount,
  lastActiveAt,
}: {
  readonly sources: ReadonlyArray<AgentSessionSource> | null;
  readonly threadCount: number;
  readonly lastActiveAt: string | null;
}) {
  const gt = useGT();
  const messages = useMessages();
  const relative =
    lastActiveAt === null ? null : formatRelativeTime(lastActiveAt, undefined, messages);
  const age =
    relative === null
      ? ""
      : relative.suffix === null
        ? gt("now", { $context: "relative time" })
        : relative.value;
  return (
    <span className="ms-auto grid shrink-0 grid-cols-[1rem_1rem_1rem_2.5rem_2.25rem] items-center gap-x-1 text-xs text-muted-foreground tabular-nums">
      {AgentSessionSource.literals.map((source) => (
        <span key={source} className="flex size-4 items-center justify-center">
          {sources?.includes(source) ? (
            <span role="img" aria-label={IMPORT_SOURCE_NAMES[source]}>
              <ProviderInstanceIcon
                driverKind={ProviderDriverKind.make(source)}
                displayName={IMPORT_SOURCE_NAMES[source]}
                iconClassName="size-3"
              />
            </span>
          ) : null}
        </span>
      ))}
      <span className="text-end">{threadCount}</span>
      <span className="text-end whitespace-nowrap">{age}</span>
    </span>
  );
}

/** The desktop app links `t3` on a fresh install; this puts its folder on PATH when it is not. */
function CliPathSetup() {
  const gt = useGT();
  const { state, busy, run } = useDesktopCliCommand();
  const setup = state?.pathSetup;
  if (!setup) return null;
  return (
    <div className="flex min-h-10 items-center gap-3">
      <RowIcon>
        <TerminalIcon className="size-4" />
      </RowIcon>
      <p className="min-w-0 flex-1 text-sm text-muted-foreground">
        {setup.added ? (
          <T>
            Added to{" "}
            <bdi>
              <Var>{setup.file}</Var>
            </bdi>
            . Open a new terminal to use{" "}
            <code className="font-mono" dir="ltr">
              t3
            </code>
            .
          </T>
        ) : (
          <T>
            Use{" "}
            <code className="font-mono" dir="ltr">
              t3
            </code>{" "}
            from any terminal by adding one line to{" "}
            <bdi>
              <Var>{setup.file}</Var>
            </bdi>
            .
          </T>
        )}
      </p>
      {setup.added ? null : (
        <Button size="xs" variant="outline" disabled={busy} onClick={() => run("addToPath")}>
          {gt("Add to PATH")}
        </Button>
      )}
    </div>
  );
}
