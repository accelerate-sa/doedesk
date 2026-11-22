import { RefreshIcon } from "~/components/ui/refresh-icon";
import { useAtomValue } from "@effect/atom-react";
import { useLocation, useNavigate, useRouter } from "@tanstack/react-router";
import { Atom } from "effect/reactivity";
import { useGT } from "gt-react";
import { useEffect, useState } from "react";

import {
  ensureClientSettingsHydrated,
  useClientSettings,
  useClientSettingsHydrationStatus,
} from "../../hooks/useSettings";
import { completeOnboarding } from "../../onboarding/firstRun";
import {
  isFirstRunWizardOwnedRoute,
  isFirstRunWorkspaceProvenanceAuthoritative,
  isFreshFirstRunWorkspace,
  resolveFirstRunDecision,
  resolveHostedFirstRunDecision,
  transitionFirstRunGateState,
  type FirstRunGateState,
} from "../../onboarding/firstRun.logic";
import { useAllEnvironmentShellsBootstrapped, useProjects } from "../../state/entities";
import { useEnvironments } from "../../state/environments";
import { environmentProjects } from "../../state/projects";
import { primaryServerConfigAtom, primaryServerWelcomeAtom } from "../../state/server";
import { environmentShell } from "../../state/shell";
import { environmentThreadShells } from "../../state/threads";
import { Button } from "../ui/button";

/** Pending blocks all rendering, including EventRouter welcome navigation. */

const FIRST_RUN_DECISION_TIMEOUT_MS = 4_000;

const primaryShellLiveAtom = Atom.make((get) => {
  const serverConfig = get(primaryServerConfigAtom);
  return (
    serverConfig !== null &&
    get(environmentShell.stateValueAtom(serverConfig.environment.environmentId)).status === "live"
  );
}).pipe(Atom.withLabel("web-onboarding-primary-shell-live"));

const workspaceEvidenceLiveAtom = Atom.make((get) => {
  const environmentIds = new Set([
    ...get(environmentProjects.projectsAtom).map((project) => project.environmentId),
    ...get(environmentThreadShells.threadShellsAtom).map((thread) => thread.environmentId),
  ]);

  for (const environmentId of environmentIds) {
    if (get(environmentShell.stateValueAtom(environmentId)).status !== "live") {
      return false;
    }
  }

  return true;
}).pipe(Atom.withLabel("web-onboarding-workspace-evidence-live"));

// Subscribe only to thread count and the sole thread so populated-workspace shell updates cannot rerender the
// app root.
const threadCountAtom = Atom.make(
  (get) => get(environmentThreadShells.threadShellsAtom).length,
).pipe(Atom.withLabel("web-onboarding-thread-count"));

const soleThreadAtom = Atom.make((get) => {
  const threads = get(environmentThreadShells.threadShellsAtom);
  return threads.length === 1 ? threads[0]! : null;
}).pipe(Atom.withLabel("web-onboarding-sole-thread"));

export function FirstRunGate({
  enabled,
  hostedStatic,
  children,
}: {
  readonly enabled: boolean;
  readonly hostedStatic: boolean;
  readonly children: React.ReactNode;
}) {
  const navigate = useNavigate();
  const router = useRouter();
  const pathname = useLocation({ select: (location) => location.pathname });
  const hydrationStatus = useClientSettingsHydrationStatus();
  const hydrated = hydrationStatus === "ready";
  const onboardingCompletedAt = useClientSettings((settings) => settings.onboardingCompletedAt);
  const bootstrapped = useAllEnvironmentShellsBootstrapped();
  const { isReady: environmentCatalogReady } = useEnvironments();
  const projects = useProjects();
  const threadCount = useAtomValue(threadCountAtom);
  const soleThread = useAtomValue(soleThreadAtom);
  const serverConfig = useAtomValue(primaryServerConfigAtom);
  const serverWelcome = useAtomValue(primaryServerWelcomeAtom);
  const primaryShellLive = useAtomValue(primaryShellLiveAtom);
  const workspaceEvidenceLive = useAtomValue(workspaceEvidenceLiveAtom);
  const [gateState, setGateState] = useState<FirstRunGateState>(() => ({
    decision:
      (!enabled && !hostedStatic) || (hydrated && onboardingCompletedAt !== null)
        ? "app"
        : "pending",
    stalled: false,
  }));
  const { decision, stalled } = gateState;
  const settingsReadFailed = hydrationStatus === "failed" || hydrationStatus === "retrying";
  // The server's sole cwd-bootstrap project/thread still counts as fresh so npx t3 users see onboarding.
  const serverCwd = serverConfig?.cwd ?? null;
  const primaryEnvironmentId = serverConfig?.environment.environmentId ?? null;
  const workspaceFresh =
    threadCount <= 1 &&
    isFreshFirstRunWorkspace({
      primaryEnvironmentId,
      serverCwd,
      bootstrapProjectId: serverWelcome?.bootstrapProjectId,
      bootstrapThreadId: serverWelcome?.bootstrapThreadId,
      bootstrapProjectCreated: serverWelcome?.bootstrapProjectCreated,
      bootstrapThreadCreated: serverWelcome?.bootstrapThreadCreated,
      projects,
      threads: soleThread === null ? [] : [soleThread],
    });

  const { decision: nextDecision, persistCompletion } = hostedStatic
    ? resolveHostedFirstRunDecision(hydrated)
    : resolveFirstRunDecision({
        enabled,
        hydrated,
        completed: onboardingCompletedAt !== null,
        bootstrapped,
        authoritative: primaryShellLive,
        workspaceAuthoritative: workspaceEvidenceLive,
        workspaceProvenanceAuthoritative: isFirstRunWorkspaceProvenanceAuthoritative({
          welcomeReceived: serverWelcome !== null,
          bootstrapStatus: serverWelcome?.bootstrapStatus ?? null,
        }),
        catalogReady: environmentCatalogReady,
        serverConfigAvailable: serverConfig !== null,
        workspaceFresh,
        projectCount: projects.length,
        threadCount,
      });

  if (hydrated) {
    const transitioned = transitionFirstRunGateState(gateState, {
      type: "evidence",
      decision: nextDecision,
    });
    if (transitioned !== gateState) setGateState(transitioned);
  }

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- persists onboarding completion to settings once the gate settles on skipping the wizard
  useEffect(() => {
    if (decision === "wizard" || !hydrated) return;
    if (persistCompletion && onboardingCompletedAt === null) {
      void completeOnboarding().catch(() => undefined);
    }
  }, [decision, hydrated, onboardingCompletedAt, persistCompletion]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- timer gives up on a pending first-run decision after the timeout
  useEffect(() => {
    if (!enabled || decision !== "pending" || !hydrated) return;
    const timer = window.setTimeout(
      () => setGateState((state) => transitionFirstRunGateState(state, { type: "timeout" })),
      FIRST_RUN_DECISION_TIMEOUT_MS,
    );
    return () => window.clearTimeout(timer);
  }, [decision, enabled, hydrated]);

  // Setup opens by itself only from the home route. A direct link, such as
  // Settings, opens as asked so setup can never lock a user out of the app.
  const shouldRedirectToWelcome = pathname === "/";
  const wizardOwnsRoute = isFirstRunWizardOwnedRoute(pathname);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- preloads the lazy /welcome chunk while checking whether first-run setup will open
  useEffect(() => {
    if (!enabled || !hydrated || onboardingCompletedAt !== null || !shouldRedirectToWelcome) return;
    void router.preloadRoute({ to: "/welcome" }).catch(() => undefined);
  }, [enabled, hydrated, onboardingCompletedAt, router, shouldRedirectToWelcome]);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- navigates from the home route to /welcome when the gate decides on the wizard
  useEffect(() => {
    if (decision === "wizard" && shouldRedirectToWelcome) {
      void navigate({ to: "/welcome", replace: true });
    }
  }, [decision, navigate, shouldRedirectToWelcome]);

  if (settingsReadFailed) {
    return <FirstRunRecovery reason="settings" retrying={hydrationStatus === "retrying"} />;
  }
  if (decision === "wizard" && !wizardOwnsRoute) {
    return children;
  }
  if (decision !== "app") {
    return stalled ? <FirstRunRecovery reason="connection" /> : <BootShell />;
  }
  return children;
}

/** Matches index.html's static #boot-shell visually without reusing its pre-mount DOM ids. */
export function BootShell() {
  const gt = useGT();
  return (
    <div className="relative flex min-h-full w-full items-center justify-center overflow-hidden bg-background text-foreground">
      <div
        className="relative z-1 flex size-24 items-center justify-center"
        aria-label={gt("DoeDesk splash screen")}
      >
        <img className="size-16 object-contain" src="/apple-touch-icon.png" alt="DoeDesk" />
      </div>
    </div>
  );
}

function FirstRunRecovery({
  reason,
  retrying = false,
}: {
  readonly reason: "settings" | "connection";
  readonly retrying?: boolean;
}) {
  const settingsReadFailed = reason === "settings";
  const gt = useGT();
  return (
    <main className="flex h-dvh min-h-0 items-center justify-center bg-background px-6 text-foreground">
      <div className="flex max-w-sm flex-col items-center text-center">
        <h1 className="font-display text-2xl">
          {settingsReadFailed ? gt("Could not load settings") : gt("Still connecting")}
        </h1>
        <p className="mt-2 text-sm text-muted-foreground">
          {settingsReadFailed
            ? gt("DoeDesk could not load your saved settings. Try again.")
            : gt("DoeDesk is taking longer than expected to connect to this computer.")}
        </p>
        <Button
          className="mt-5"
          size="sm"
          variant="outline"
          disabled={retrying}
          onClick={() => {
            if (settingsReadFailed) {
              void ensureClientSettingsHydrated().catch(() => undefined);
            } else {
              window.location.reload();
            }
          }}
        >
          <RefreshIcon refreshing={retrying} />
          {settingsReadFailed ? gt("Try again") : gt("Reload")}
        </Button>
      </div>
    </main>
  );
}
