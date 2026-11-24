import { useAtomValue } from "@effect/atom-react";
import type {
  PrivacyKnownValues,
  PrivacyKnownValuesRequest,
  PrivacyLocale,
  PrivacyAccountRequest,
  PrivacyAccountResult,
  PrivacyActivityEntry,
  PrivacyClearAnswer,
  PrivacyConfigureRequest,
  PrivacyConfigureResult,
  PrivacyPreferenceRequest,
  PrivacyProfileRequest,
  PrivacyRedaction,
  PrivacySealedListing,
  PrivacySealedRequest,
  PrivacySealedResult,
  PrivacySealedTurn,
  PrivacySignInMethod,
  PrivacySignInRequest,
  PrivacySignInResult,
  PrivacyStatus,
  PrivacyTurnValues,
  PrivacyVault,
  PrivacyVaultRequest,
  PrivacyWorkerRequest,
  UsageDataRequest,
  UsageDataStatus,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { AsyncResult, Atom } from "effect/reactivity";
import { useLocale } from "gt-react";

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

/** Starts the startup usage-data rule check in the background without mounting any prompt. */
export const prefetchUsageData = (): void => {
  appAtomRegistry.get(decidedUsageDataAtom);
};

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

export type UsageDataLoadState =
  | { readonly kind: "loading"; readonly status: null }
  | { readonly kind: "error"; readonly status: null }
  | { readonly kind: "ready"; readonly status: UsageDataStatus };

/** Where usage data stands, distinguishing an in-flight region check from an error. */
export function useUsageDataState(): UsageDataLoadState {
  const decided = useAtomValue(decidedUsageDataAtom);
  const changed = useAtomValue(changedUsageDataAtom);
  if (changed !== null) return { kind: "ready", status: changed };
  if (AsyncResult.isSuccess(decided)) return { kind: "ready", status: decided.value };
  return AsyncResult.isFailure(decided)
    ? { kind: "error", status: null }
    : { kind: "loading", status: null };
}

/** Where usage data stands. Null while loading, and when the server could not be asked. */
export function useUsageData(): UsageDataStatus | null {
  return useUsageDataState().status;
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
 * The language the Terms, the notice and the usage-data choice are shown in: follows the app's
 * active language when Arabic, or English otherwise, until the person switches the consent text.
 */
export function useConsentLocale(): readonly [
  locale: PrivacyLocale,
  setLocale: (locale: PrivacyLocale) => void,
  /** Whether to offer the switch: whenever the app or system is in Arabic. */
  offered: boolean,
] {
  const appLocale = useLocale();
  const chosen = useAtomValue(consentLocaleAtom);
  const arabicSystem = prefersArabic(systemLanguages());
  const arabicApp = appLocale === "ar";
  return [
    chosen ?? (arabicApp ? "ar" : "en"),
    (locale) => appAtomRegistry.set(consentLocaleAtom, locale),
    arabicApp || arabicSystem,
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
  if (get(vaultReadsAtom) === 0) return Effect.succeed<PrivacyVault | null>(null);
  return Effect.promise(() =>
    runPrimaryHttp(
      PrimaryEnvironmentHttpClient.pipe(
        Effect.flatMap((client) => client.privacy.vault({ headers: {} })),
      ),
    ),
  ).pipe(Effect.map((vault): PrivacyVault | null => vault));
}).pipe(Atom.withLabel("privacy:vault"));

// The server returns the vault with every change, so a change needs no second request.
const changedVaultAtom = Atom.make<PrivacyVault | null>(null).pipe(
  Atom.keepAlive,
  Atom.withLabel("privacy:changed-vault"),
);

export const revealPrivacyVault = (): void => {
  appAtomRegistry.set(changedVaultAtom, null);
  bump(vaultReadsAtom);
};

/** The stand-ins and their real values, and the values no longer masked. Null until revealed. */
export function usePrivacyVault(): {
  readonly vault: PrivacyVault | null;
  readonly loading: boolean;
} {
  const result = useAtomValue(vaultAtom);
  const changed = useAtomValue(changedVaultAtom);
  return {
    vault: changed ?? (AsyncResult.isSuccess(result) ? result.value : null),
    loading: result.waiting,
  };
}

/**
 * Stops masking one value, or masks it again, by its stand-in. It applies from the next request
 * of every conversation. Resolves to false when the entry is gone or belongs to a sealed document.
 */
export const changePrivacyVault = async (payload: PrivacyVaultRequest): Promise<boolean> => {
  const result = await runPrimaryHttp(
    PrimaryEnvironmentHttpClient.pipe(
      Effect.flatMap((client) => client.privacy.changeVault({ headers: {}, payload })),
    ),
  );
  appAtomRegistry.set(changedVaultAtom, result.vault);
  setPrivacyStatus(result.status);
  return result.ok;
};

/**
 * A turn's stand-ins beside their real values, read when the person asks to see them. Null when
 * the list for that turn is no longer kept.
 */
export const fetchTurnValues = async (runId: string): Promise<PrivacyTurnValues["values"]> =>
  (
    await runPrimaryHttp(
      PrimaryEnvironmentHttpClient.pipe(
        Effect.flatMap((client) => client.privacy.turnValues({ headers: {}, payload: { runId } })),
      ),
    )
  ).values;

/**
 * Stand-ins with every spelling of their values, for marking them in the chat (`turns`) or in an
 * open file (`vault`). Empty while masking is off.
 */
export const fetchKnownValues = (payload: PrivacyKnownValuesRequest): Promise<PrivacyKnownValues> =>
  runPrimaryHttp(
    PrimaryEnvironmentHttpClient.pipe(
      Effect.flatMap((client) => client.privacy.knownValues({ headers: {}, payload })),
    ),
  );

/** Connects, changes or removes the worker that reads sealed documents. */
export const configurePrivacyWorker = async (
  payload: PrivacyWorkerRequest,
): Promise<PrivacyConfigureResult> => {
  const result = await runPrimaryHttp(
    PrimaryEnvironmentHttpClient.pipe(
      Effect.flatMap((client) => client.privacy.worker({ headers: {}, payload })),
    ),
  );
  setPrivacyStatus(result.status);
  return result;
};

const sealedReadsAtom = counter("privacy:sealed-reads");
// Counted apart from changes made here: a sealed folder seals files on the server, unasked.
const sealedReloadsAtom = counter("privacy:sealed-reloads");
const sealedListingAtom = Atom.family((projectId: string) =>
  Atom.make((get) => {
    get(sealedReadsAtom);
    get(sealedReloadsAtom);
    if (projectId === "") return Effect.succeed<PrivacySealedListing | null>(null);
    return Effect.promise(() =>
      runPrimaryHttp(
        PrimaryEnvironmentHttpClient.pipe(
          Effect.flatMap((client) =>
            client.privacy.sealed({ headers: {}, payload: { action: "list", projectId } }),
          ),
        ),
      ),
    ).pipe(Effect.map((result): PrivacySealedListing | null => result.listing));
  }).pipe(Atom.withLabel(`privacy:sealed:${projectId}`)),
);

/** A project's sealed documents and finished files. Null while loading or with no project. */
export function useSealedDocuments(projectId: string | null): PrivacySealedListing | null {
  const result = useAtomValue(sealedListingAtom(projectId ?? ""));
  return AsyncResult.isSuccess(result) ? result.value : null;
}

const sealedAnswersAtom = Atom.family((projectId: string) =>
  Atom.make((get) => {
    get(sealedReadsAtom);
    get(sealedReloadsAtom);
    if (projectId === "") return Effect.succeed<ReadonlyArray<PrivacyClearAnswer> | null>(null);
    return Effect.promise(() =>
      runPrimaryHttp(
        PrimaryEnvironmentHttpClient.pipe(
          Effect.flatMap((client) =>
            client.privacy.sealed({ headers: {}, payload: { action: "answers", projectId } }),
          ),
        ),
      ),
    ).pipe(Effect.map((result): ReadonlyArray<PrivacyClearAnswer> | null => result.answers ?? []));
  }).pipe(Atom.withLabel(`privacy:sealed-answers:${projectId}`)),
);

/**
 * Every answer about a project's sealed files that reached the AI as it is, read again whenever
 * the listing is. Null while loading, and with no project: nothing is read until it is asked for.
 */
export function useSealedAnswers(
  projectId: string | null,
): ReadonlyArray<PrivacyClearAnswer> | null {
  const result = useAtomValue(sealedAnswersAtom(projectId ?? ""));
  return AsyncResult.isSuccess(result) ? result.value : null;
}

/** Requests that change nothing, so no list is read again after them. */
const READS_OF_SEALED: ReadonlySet<PrivacySealedRequest["action"]> = new Set([
  "inspect",
  "inspectPaths",
  "inspectFolder",
  "labels",
  "output",
  "answers",
  "turn",
]);

/**
 * Reads the sealed lists again. A sealed folder seals what arrives in it without being asked
 * from here, so its list is read again whenever the folder's files are.
 */
export const reloadSealedDocuments = (): void => bump(sealedReloadsAtom);

/** Seals or removes a document, resets the limits, or reads a finished file. */
export const changeSealedDocuments = async (
  payload: PrivacySealedRequest,
): Promise<PrivacySealedResult> => {
  const result = await runPrimaryHttp(
    PrimaryEnvironmentHttpClient.pipe(
      Effect.flatMap((client) => client.privacy.sealed({ headers: {}, payload })),
    ),
  );
  if (!READS_OF_SEALED.has(payload.action)) {
    bump(sealedReadsAtom);
    // The status carries the count of sealed files, which the chat's status reads.
    refreshPrivacyStatus();
  }
  return result;
};

/**
 * What one turn asked of sealed files: the files by name and the answers that reached the AI as
 * they are. Null when the turn asked nothing, or its record is no longer kept.
 */
export const fetchSealedTurn = async (
  projectId: string,
  runId: string,
): Promise<PrivacySealedTurn | null> =>
  (await changeSealedDocuments({ action: "turn", projectId, runId })).turn ?? null;

/** Counts changes to sealed documents, for views that list the folder they were moved out of. */
export function useSealedRevision(): number {
  return useAtomValue(sealedReadsAtom);
}

/** Masking is decided: either a detection service is connected, or the user turned it off. */
export const isPrivacyDecided = (status: PrivacyStatus): boolean => status.mode !== "unconfigured";
