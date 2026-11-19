import { useAtomValue } from "@effect/atom-react";
import type {
  PrivacyLocale,
  PrivacyAccountRequest,
  PrivacyAccountResult,
  PrivacyActivityEntry,
  PrivacyConfigureRequest,
  PrivacyConfigureResult,
  PrivacyPreferenceRequest,
  PrivacyProfileRequest,
  PrivacyRedaction,
  PrivacySignInMethod,
  PrivacySignInRequest,
  PrivacySignInResult,
  PrivacyStatus,
  PrivacyVaultEntry,
  UsageDataRequest,
  UsageDataStatus,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { AsyncResult, Atom } from "effect/reactivity";

import { prefersArabic } from "~/doedesk/consentWords";
import { PrimaryEnvironmentHttpClient } from "~/environments/primary/httpClient";
import { runPrimaryHttp } from "~/lib/runtime";
import { appAtomRegistry } from "~/rpc/atomRegistry";

export const configurePrivacy = (
  payload: PrivacyConfigureRequest,
): Promise<PrivacyConfigureResult> =>
  runPrimaryHttp(
    PrimaryEnvironmentHttpClient.pipe(
      Effect.flatMap((client) => client.privacy.configure({ headers: {}, payload })),
    ),
  );

export const signInToCloud = (payload: PrivacySignInRequest): Promise<PrivacySignInResult> =>
  runPrimaryHttp(
    PrimaryEnvironmentHttpClient.pipe(
      Effect.flatMap((client) => client.privacy.signIn({ headers: {}, payload })),
    ),
  );

/**
 * Accepting the Terms, a copy of the account's data, or deleting the account. The status the
 * server answers with is shown at once: after a deletion that is the not-signed-in state.
 */
export const accountAction = async (
  payload: PrivacyAccountRequest,
): Promise<PrivacyAccountResult> => {
  const result = await runPrimaryHttp(
    PrimaryEnvironmentHttpClient.pipe(
      Effect.flatMap((client) => client.privacy.account({ headers: {}, payload })),
    ),
  );
  setPrivacyStatus(result.status);
  return result;
};

export const savePrivacyProfile = (payload: PrivacyProfileRequest): Promise<PrivacyStatus> =>
  runPrimaryHttp(
    PrimaryEnvironmentHttpClient.pipe(
      Effect.flatMap((client) => client.privacy.profile({ headers: {}, payload })),
    ),
  );

/** Saves a per-provider or usage-report choice and shows the status the server answers with. */
export const setPrivacyPreference = async (payload: PrivacyPreferenceRequest): Promise<void> => {
  setPrivacyStatus(
    await runPrimaryHttp(
      PrimaryEnvironmentHttpClient.pipe(
        Effect.flatMap((client) => client.privacy.preference({ headers: {}, payload })),
      ),
    ),
  );
};

const counter = (label: string) => Atom.make(0).pipe(Atom.keepAlive, Atom.withLabel(label));
const bump = (atom: Atom.Writable<number>) =>
  appAtomRegistry.set(atom, appAtomRegistry.get(atom) + 1);

const statusReadsAtom = counter("privacy:status-reads");
const fetchedStatusAtom = Atom.make((get) => {
  get(statusReadsAtom);
  return Effect.promise(() =>
    runPrimaryHttp(
      PrimaryEnvironmentHttpClient.pipe(
        Effect.flatMap((client) => client.privacy.status({ headers: {} })),
      ),
    ),
  );
}).pipe(Atom.withLabel("privacy:status"));

// The server returns the new status with every change, so a change needs no second request.
const changedStatusAtom = Atom.make<PrivacyStatus | null>(null).pipe(
  Atom.keepAlive,
  Atom.withLabel("privacy:changed-status"),
);

export type PrivacyStatusState =
  | { readonly kind: "loading" }
  | { readonly kind: "error" }
  | { readonly kind: "ready"; readonly status: PrivacyStatus };

export const setPrivacyStatus = (status: PrivacyStatus): void => {
  appAtomRegistry.set(changedStatusAtom, status);
};

/** Reads the status again without the loading state in between, for a check in the background. */
export const reloadPrivacyStatus = async (): Promise<void> => {
  setPrivacyStatus(
    await runPrimaryHttp(
      PrimaryEnvironmentHttpClient.pipe(
        Effect.flatMap((client) => client.privacy.status({ headers: {} })),
      ),
    ),
  );
};

export const refreshPrivacyStatus = (): void => {
  appAtomRegistry.set(changedStatusAtom, null);
  bump(statusReadsAtom);
};

export function usePrivacyStatus(): PrivacyStatusState {
  const fetched = useAtomValue(fetchedStatusAtom);
  const changed = useAtomValue(changedStatusAtom);
  if (changed !== null) return { kind: "ready", status: changed };
  if (AsyncResult.isSuccess(fetched)) return { kind: "ready", status: fetched.value };
  return AsyncResult.isFailure(fetched) ? { kind: "error" } : { kind: "loading" };
}

export interface SignInOptions {
  /** The ways this person may sign in, the first being the one to show. */
  readonly methods: ReadonlyArray<PrivacySignInMethod>;
  /** False when no new account can be created where this person is. */
  readonly signUpAvailable: boolean;
  /** False when DoeDesk Cloud did not answer: the documents to link to are then unknown. */
  readonly reached: boolean;
}

// Email works everywhere, so it is the answer when the cloud cannot be asked.
const UNREACHED: SignInOptions = { methods: ["email"], signUpAvailable: true, reached: false };

const signInOptionsReadsAtom = counter("privacy:sign-in-options-reads");
const signInOptionsAtom = Atom.make((get) => {
  get(signInOptionsReadsAtom);
  return Effect.promise(() => signInToCloud({ step: "options" })).pipe(
    Effect.map((result): SignInOptions => {
      // The answer carries the documents in force, which the form links to.
      setPrivacyStatus(result.status);
      return result.ok && result.methods !== null
        ? {
            methods: result.methods,
            signUpAvailable: result.signUpAvailable !== false,
            reached: true,
          }
        : UNREACHED;
    }),
  );
}).pipe(Atom.withLabel("privacy:sign-in-options"));

export const refreshSignInOptions = (): void => bump(signInOptionsReadsAtom);

/** What DoeDesk Cloud says before anyone signs in. Null while loading. */
export function useSignInOptions(): SignInOptions | null {
  const result = useAtomValue(signInOptionsAtom);
  if (AsyncResult.isSuccess(result)) return result.value;
  return AsyncResult.isFailure(result) ? UNREACHED : null;
}

const usageDataRequest = (payload: UsageDataRequest): Promise<UsageDataStatus> =>
  runPrimaryHttp(
    PrimaryEnvironmentHttpClient.pipe(
      Effect.flatMap((client) => client.privacy.setUsageData({ headers: {}, payload })),
    ),
  );

/** This device's region and time zone: two of the three signals that decide the usage-data rule. */
const deviceRegionSignals = (): {
  readonly locale: string | null;
  readonly timeZone: string | null;
} => {
  const resolved = Intl.DateTimeFormat().resolvedOptions();
  return {
    // The desktop app pins the browser's language list, so the system's own locale leads.
    locale: window.desktopBridge?.getSystemLocale?.() ?? resolved.locale ?? navigator.language,
    timeZone: resolved.timeZone ?? null,
  };
};

// Asked once each time the app starts: the server decides the rule for where this device is now.
const decidedUsageDataAtom = Atom.make(() =>
  Effect.promise(() => usageDataRequest({ action: "decide", ...deviceRegionSignals() })),
).pipe(Atom.keepAlive, Atom.withLabel("privacy:usage-data"));

const changedUsageDataAtom = Atom.make<UsageDataStatus | null>(null).pipe(
  Atom.keepAlive,
  Atom.withLabel("privacy:changed-usage-data"),
);

/** Records the person's choice, or that they continued past the notice, and shows the result. */
export const setUsageData = async (
  payload: Exclude<UsageDataRequest, { readonly action: "decide" }>,
): Promise<UsageDataStatus> => {
  const status = await usageDataRequest(payload);
  appAtomRegistry.set(changedUsageDataAtom, status);
  return status;
};

/** Where usage data stands. Null while loading, and when the server could not be asked. */
export function useUsageData(): UsageDataStatus | null {
  const decided = useAtomValue(decidedUsageDataAtom);
  const changed = useAtomValue(changedUsageDataAtom);
  if (changed !== null) return changed;
  return AsyncResult.isSuccess(decided) ? decided.value : null;
}

// The language the consent texts are shown in. One choice for every screen that shows them.
const consentLocaleAtom = Atom.make<PrivacyLocale | null>(null).pipe(
  Atom.keepAlive,
  Atom.withLabel("privacy:consent-locale"),
);

const systemLanguages = (): ReadonlyArray<string> => {
  const system = window.desktopBridge?.getPreferredSystemLanguages?.() ?? [];
  return system.length > 0 ? system : navigator.languages;
};

/**
 * The language the Terms, the notice and the usage-data choice are shown in: Arabic when the
 * system's first language is Arabic, English otherwise, until the person switches.
 */
export function useConsentLocale(): readonly [
  locale: PrivacyLocale,
  setLocale: (locale: PrivacyLocale) => void,
  /** Whether to offer the switch: only where the system's language is Arabic. */
  offered: boolean,
] {
  const chosen = useAtomValue(consentLocaleAtom);
  const arabicSystem = prefersArabic(systemLanguages());
  return [
    chosen ?? (arabicSystem ? "ar" : "en"),
    (locale) => appAtomRegistry.set(consentLocaleAtom, locale),
    arabicSystem,
  ];
}

const activityReadsAtom = counter("privacy:activity-reads");
const activityAtom = Atom.make((get) => {
  get(activityReadsAtom);
  return Effect.promise(() =>
    runPrimaryHttp(
      PrimaryEnvironmentHttpClient.pipe(
        Effect.flatMap((client) => client.privacy.activity({ headers: {} })),
      ),
    ),
  );
}).pipe(Atom.withLabel("privacy:activity"));

export const refreshPrivacyActivity = (): void => bump(activityReadsAtom);

/** Recent requests through the gateway. Null while loading; empty when it cannot be read. */
export function usePrivacyActivity(): ReadonlyArray<PrivacyActivityEntry> | null {
  const result = useAtomValue(activityAtom);
  if (AsyncResult.isSuccess(result)) return result.value.entries;
  return AsyncResult.isFailure(result) ? [] : null;
}

const redactionReadsAtom = counter("privacy:redaction-reads");
const redactionsAtom = Atom.make((get) => {
  get(redactionReadsAtom);
  return Effect.promise(() =>
    runPrimaryHttp(
      PrimaryEnvironmentHttpClient.pipe(
        Effect.flatMap((client) => client.privacy.redactions({ headers: {} })),
      ),
    ),
  );
}).pipe(Atom.withLabel("privacy:redactions"));

export const refreshPrivacyRedactions = (): void => bump(redactionReadsAtom);

/** What was sent in place of recent images and documents. Null while loading; empty when it cannot be read. */
export function usePrivacyRedactions(): ReadonlyArray<PrivacyRedaction> | null {
  const result = useAtomValue(redactionsAtom);
  if (AsyncResult.isSuccess(result)) return result.value.entries;
  return AsyncResult.isFailure(result) ? [] : null;
}

/** One of a record's two files, as a browser file. Null when it is no longer kept. */
export const fetchRedactionFile = async (
  id: string,
  part: "image" | "text",
): Promise<{ readonly fileName: string; readonly blob: Blob } | null> => {
  const { file } = await runPrimaryHttp(
    PrimaryEnvironmentHttpClient.pipe(
      Effect.flatMap((client) =>
        client.privacy.redactionFile({ headers: {}, payload: { id, part } }),
      ),
    ),
  );
  if (file === null) return null;
  const bytes = Uint8Array.from(atob(file.data), (character) => character.charCodeAt(0));
  return { fileName: file.fileName, blob: new Blob([bytes], { type: file.mediaType }) };
};

export const clearPrivacyRedactions = async (): Promise<void> => {
  await runPrimaryHttp(
    PrimaryEnvironmentHttpClient.pipe(
      Effect.flatMap((client) => client.privacy.clearRedactions({ headers: {} })),
    ),
  );
  refreshPrivacyRedactions();
};

const vaultReadsAtom = counter("privacy:vault-reads");
const vaultAtom = Atom.make((get) => {
  // Nothing is read until the user asks to see the real values.
  if (get(vaultReadsAtom) === 0)
    return Effect.succeed<ReadonlyArray<PrivacyVaultEntry> | null>(null);
  return Effect.promise(() =>
    runPrimaryHttp(
      PrimaryEnvironmentHttpClient.pipe(
        Effect.flatMap((client) => client.privacy.vault({ headers: {} })),
      ),
    ),
  ).pipe(Effect.map((vault): ReadonlyArray<PrivacyVaultEntry> | null => vault.entries));
}).pipe(Atom.withLabel("privacy:vault"));

export const revealPrivacyVault = (): void => bump(vaultReadsAtom);

export function usePrivacyVault(): {
  readonly entries: ReadonlyArray<PrivacyVaultEntry> | null;
  readonly loading: boolean;
} {
  const result = useAtomValue(vaultAtom);
  return {
    entries: AsyncResult.isSuccess(result) ? result.value : null,
    loading: result.waiting,
  };
}

/** Masking is decided: either a detection service is connected, or the user turned it off. */
export const isPrivacyDecided = (status: PrivacyStatus): boolean => status.mode !== "unconfigured";
