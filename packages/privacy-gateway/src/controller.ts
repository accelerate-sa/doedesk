import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { type Detector, DetectorUnavailableError, makeRemoteDetector } from "./detect.ts";
import type { GatewayRecord } from "./gateway.ts";
import {
  MASKED_SESSION_SWITCHES,
  type PrivacyGateway,
  startPrivacyGateway,
  USAGE_REPORTS_OFF_SWITCHES,
} from "./index.ts";
import type { ImageHandling } from "./attachments.ts";
import { cacheReader, makeRemoteReader, type Reader, type ReaderUsage } from "./reader.ts";
import { type ImageRedactor, makeImageRedactor } from "./redaction/redactImage.ts";
import { type RedactionFile, type RedactionRecord, RedactionStore } from "./redaction/store.ts";

/**
 * Images go as masked text until the redacted-image path is measured on a larger set of images
 * it was not tuned on (docs/operations/image-redaction.md). People can choose redacted images
 * in Settings.
 */
const DEFAULT_IMAGE_HANDLING: "redacted" | "text" | "withheld" = "text";

export type PrivacyMode = "unconfigured" | "cloud" | "selfHosted" | "off";

export type SignInMethod = "phone" | "email";

export const PROFILE_FIELDS = [
  "legal",
  "finance",
  "government",
  "healthcare",
  "hr",
  "real_estate",
  "consulting",
  "engineering",
  "research",
  "other",
] as const;
export type ProfileField = (typeof PROFILE_FIELDS)[number];

export const PROFILE_WORKPLACES = ["self", "small_company", "large_company", "government"] as const;
export type ProfileWorkplace = (typeof PROFILE_WORKPLACES)[number];

interface StoredConfig {
  readonly mode: PrivacyMode;
  readonly endpoint?: string;
  readonly token?: string;
  /** The email, or the phone number with its middle hidden, of the signed-in account. */
  readonly accountLabel?: string;
  /** The onboarding questions were answered or skipped on this computer. */
  readonly profileAnswered?: boolean;
  /** Providers the user chose to use without the gateway, and so without masking. */
  readonly directProviders?: ReadonlyArray<string>;
  /** Providers whose notice the user has read, with the notice version they read. */
  readonly noticesRead?: Readonly<Record<string, number>>;
  /** False when the user turned Claude Code's usage reports off. Sent by default. */
  readonly usageReports?: boolean;
  /** How images are sent. Unset: redacted. */
  readonly imageHandling?: ImageHandling;
  /** False when the user turned the masked-text reading tool off. Offered by default. */
  readonly readingTool?: boolean;
  /** The signed-in account's identifier at DoeDesk Cloud. */
  readonly accountId?: string;
  /** Where the signed-in account stands on the Terms of Use, as DoeDesk Cloud last said. */
  readonly acceptance?: PrivacyAcceptanceStatus;
  /** The documents in force, as DoeDesk Cloud last reported them. Kept across sign-out. */
  readonly legal?: PrivacyLegal;
  /** The onboarding answers stored with the account. */
  readonly profile?: PrivacyProfileAnswers;
}

export interface PrivacyLegalDocument {
  readonly version: string;
  readonly url: { readonly en: string; readonly ar: string };
}

/** The Terms of Use and the Privacy Policy that are in force. */
export interface PrivacyLegal {
  readonly terms: PrivacyLegalDocument;
  readonly privacy: PrivacyLegalDocument;
}

export interface PrivacyAcceptanceStatus {
  /** The account has not accepted the Terms version required now. */
  readonly outstanding: boolean;
  /** With `outstanding`: DoeDesk Cloud refuses detection and reading until the account accepts. */
  readonly blocked: boolean;
  readonly termsVersion: string | null;
  readonly privacyVersion: string | null;
  readonly acceptedAt: string | null;
}

export interface PrivacyProfileAnswers {
  readonly field: string | null;
  readonly workplace: string | null;
}

/** What the person agreed to, exactly as the screen showed it. */
export interface PrivacyAcceptanceInput {
  readonly termsVersion: string;
  readonly privacyVersion: string;
  readonly locale: "en" | "ar";
  readonly wordingId: string;
}

export interface PrivacyAccountDeleted {
  readonly accountId: string;
  readonly deletedAt: string;
  readonly kept: ReadonlyArray<{ readonly record: string; readonly until: string }>;
}

/** Raised when the notice's meaning changes, so that it is shown again. */
export const PROVIDER_NOTICE_VERSION = 1;

export interface PrivacyControllerStatus {
  readonly mode: PrivacyMode;
  readonly active: boolean;
  readonly accountLabel: string | null;
  readonly endpoint: string | null;
  readonly vaultSize: number;
  readonly problem: string | null;
  readonly profileAnswered: boolean;
  /** Providers used without the gateway by the user's choice. They are not masked. */
  readonly directProviders: ReadonlyArray<string>;
  /** Providers whose current notice the user has read. */
  readonly noticesRead: ReadonlyArray<string>;
  /** Whether Claude Code's usage reports are left on. */
  readonly usageReports: boolean;
  /** How images are sent: redacted, as masked text, or not at all. */
  readonly imageHandling: ImageHandling;
  /** Whether agents are offered the tool that reads a file as masked text. */
  readonly readingTool: boolean;
  /** The vendor switches DoeDesk sets for a masked session, exactly as set. */
  readonly sessionSwitches: Readonly<Record<string, string>>;
  readonly accountId: string | null;
  /** Null when no account is signed in, or DoeDesk Cloud has not yet said where it stands. */
  readonly acceptance: PrivacyAcceptanceStatus | null;
  /** Null until DoeDesk Cloud has been asked. */
  readonly legal: PrivacyLegal | null;
  readonly profile: PrivacyProfileAnswers | null;
}

/** A choice that is separate from which detection service is used. */
export type PrivacyPreferenceInput =
  | { readonly kind: "providerRoute"; readonly provider: string; readonly direct: boolean }
  | { readonly kind: "noticeRead"; readonly provider: string }
  | { readonly kind: "usageReports"; readonly send: boolean }
  | { readonly kind: "imageHandling"; readonly handling: ImageHandling }
  | { readonly kind: "readingTool"; readonly offered: boolean };

/** What the masked-text reading tool answers. */
export type PrivacyReadMaskedResult =
  | { readonly ok: true; readonly text: string }
  /** `message` is written for the agent and never quotes the file. */
  | { readonly ok: false; readonly message: string };

export type PrivacyConfigureInput =
  | { readonly mode: "selfHosted"; readonly endpoint: string; readonly token?: string }
  | { readonly mode: "off" }
  | { readonly mode: "unconfigured" };

/** Why a sign-in is started. Deleting the account needs a sign-in made minutes before. */
export type PrivacySignInPurpose = "signIn" | "deleteAccount";

/** One step of signing in to DoeDesk Cloud. */
export type PrivacySignInInput =
  | { readonly step: "options" }
  | {
      readonly step: "phoneStart";
      readonly phone: string;
      readonly acceptance?: PrivacyAcceptanceInput;
      readonly purpose?: PrivacySignInPurpose;
    }
  | { readonly step: "phoneVerify"; readonly requestId: string; readonly code: string }
  | {
      readonly step: "emailStart";
      readonly email: string;
      readonly locale?: string;
      readonly acceptance?: PrivacyAcceptanceInput;
      readonly purpose?: PrivacySignInPurpose;
    }
  | { readonly step: "emailCheck"; readonly requestId: string };

export interface PrivacySignInResult {
  readonly ok: boolean;
  readonly message: string | null;
  /** `options`: the ways this person may sign in, the first being the one to show. */
  readonly methods: ReadonlyArray<SignInMethod> | null;
  /** `phoneStart` and `emailStart`: names the attempt in the next step. */
  readonly requestId: string | null;
  /** `phoneStart`: seconds until another code may be asked for. */
  readonly resendIn: number | null;
  /** `emailCheck`: whether the emailed link has been confirmed. */
  readonly signedIn: boolean;
  /** DoeDesk Cloud's error code when it refused, such as `terms_required`. */
  readonly code: string | null;
  /** `options`: false when no new account can be created where this person is. */
  readonly signUpAvailable: boolean | null;
  /** A sign-in started to delete the account: what DoeDesk Cloud confirmed. */
  readonly deleted: PrivacyAccountDeleted | null;
}

export type PrivacyAccountInput =
  | { readonly action: "accept"; readonly acceptance: PrivacyAcceptanceInput }
  | { readonly action: "refresh" }
  | { readonly action: "export" }
  | { readonly action: "delete" };

export interface PrivacyAccountResult {
  readonly ok: boolean;
  readonly code: string | null;
  readonly message: string | null;
  /** `export`: everything DoeDesk Cloud holds about the account, as JSON text. */
  readonly exported: string | null;
  readonly deleted: PrivacyAccountDeleted | null;
}

export interface PrivacyProfileInput {
  readonly field: ProfileField | null;
  readonly fieldOther: string | null;
  readonly workplace: ProfileWorkplace | null;
}

export interface PrivacyController {
  readonly status: () => PrivacyControllerStatus;
  readonly configure: (
    input: PrivacyConfigureInput,
  ) => Promise<{ readonly ok: boolean; readonly message: string | null }>;
  readonly signIn: (input: PrivacySignInInput) => Promise<PrivacySignInResult>;
  readonly account: (input: PrivacyAccountInput) => Promise<PrivacyAccountResult>;
  readonly saveProfile: (input: PrivacyProfileInput) => Promise<void>;
  readonly setPreference: (input: PrivacyPreferenceInput) => void;
  /**
   * The variables to add to a provider's process, or `undefined` for none. None are added when
   * masking is off or the user uses this provider without the gateway: the vendor's tool then
   * starts exactly as it would without DoeDesk.
   */
  readonly environmentFor: (
    provider: string | undefined,
  ) => Readonly<Record<string, string>> | undefined;
  /** A short-lived signed token proving the signed-in account to another DoeDesk service. */
  readonly accountToken: (audience: string) => Promise<string | null>;
  readonly activity: () => ReadonlyArray<GatewayRecord>;
  /**
   * The text of an image or PDF with every personal value replaced by its stand-in: what the
   * agent's reading tool returns. Nothing unmasked is returned on any path.
   */
  readonly readMasked: (bytes: Buffer, mediaType: string) => Promise<PrivacyReadMaskedResult>;
  /** What was sent in place of recent images and documents, newest first. */
  readonly redactions: () => ReadonlyArray<RedactionRecord>;
  readonly redactionFile: (id: string, part: "image" | "text") => RedactionFile | undefined;
  readonly clearRedactions: () => void;
  readonly vault: () => ReadonlyArray<{
    readonly token: string;
    readonly kind: string;
    readonly value: string;
  }>;
  readonly close: () => Promise<void>;
}

/**
 * Switches for measuring what masking costs. They are never part of the stored configuration and
 * no settings screen sets them: the server reads them from `DOEDESK_EVAL_*` when it starts.
 */
export interface PrivacyEvaluationOptions {
  /**
   * With a detection service connected, images and files are still replaced by the text read from
   * them, but no value is replaced by a placeholder. Personal data reaches the model.
   */
  readonly attachmentsOnly?: boolean | undefined;
  /** Receives every request body sent to a model, as written, one JSON object per line. */
  readonly sentBodiesPath?: string | undefined;
  /**
   * Receives what the gateway did, one JSON object per line: each request, each call to the
   * detection service, each file read, and the vault when the gateway closes.
   */
  readonly eventsPath?: string | undefined;
}

const ATTACHMENTS_ONLY_WARNING =
  "Evaluation mode (DOEDESK_EVAL_OCR_ONLY): images and files are read as text, " +
  "but personal data is NOT masked.";

const appendLine = (filePath: string, value: unknown): void => {
  NodeFS.mkdirSync(NodePath.dirname(filePath), { recursive: true });
  NodeFS.appendFileSync(filePath, `${JSON.stringify(value)}\n`, { mode: 0o600 });
};

export interface PrivacyControllerOptions {
  readonly dataDirectory: string;
  /** Base URL of DoeDesk Cloud. Defaults to `DOEDESK_CLOUD_URL`, then the public service. */
  readonly cloudUrl?: string;
  /**
   * Called when the answer of `environmentFor` changed for some provider. Agent processes keep
   * the environment they were started with, so the caller restarts them.
   */
  readonly onRoutingChange?: (() => void) | undefined;
  readonly fetch?: typeof fetch;
  /** The host's `process.platform`, for naming this computer to the person signing in. */
  readonly platform?: string;
  /** This app's version, recorded with an acceptance of the Terms. */
  readonly appVersion?: string | undefined;
  readonly evaluation?: PrivacyEvaluationOptions | undefined;
}

export const DEFAULT_DOEDESK_CLOUD_URL = "https://api.doedesk.com";

const NOT_SET_UP =
  "DoeDesk privacy is not set up yet. Open Settings, then Privacy, and sign in to DoeDesk Cloud " +
  "or connect your own detection service.";

const TERMS_NOT_ACCEPTED =
  "DoeDesk Cloud did not check this request, because this account has not accepted the current " +
  "Terms of Use. Open DoeDesk to read and accept them, or connect your own detection service in " +
  "Settings, under Privacy.";

const MAX_ACTIVITY = 300;

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

const asText = (value: unknown): string | null => (typeof value === "string" ? value : null);

const readLegalDocument = (value: unknown): PrivacyLegalDocument | null => {
  const document = asRecord(value);
  const url = asRecord(document?.url);
  const version = asText(document?.version);
  const en = asText(url?.en);
  const ar = asText(url?.ar);
  return version === null || en === null || ar === null ? null : { version, url: { en, ar } };
};

/** The `legal` object DoeDesk Cloud sends with its answers. Null when it is missing or malformed. */
const readLegal = (value: unknown): PrivacyLegal | null => {
  const legal = asRecord(value);
  const terms = readLegalDocument(legal?.terms);
  const privacy = readLegalDocument(legal?.privacy);
  return terms === null || privacy === null ? null : { terms, privacy };
};

const readAcceptance = (value: unknown): PrivacyAcceptanceStatus | null => {
  const acceptance = asRecord(value);
  if (acceptance === undefined || typeof acceptance.outstanding !== "boolean") return null;
  return {
    outstanding: acceptance.outstanding,
    blocked: acceptance.blocked === true,
    termsVersion: asText(acceptance.termsVersion),
    privacyVersion: asText(acceptance.privacyVersion),
    acceptedAt: asText(acceptance.acceptedAt),
  };
};

const readDeleted = (body: Record<string, unknown>): PrivacyAccountDeleted | null => {
  const accountId = asText(body.accountId);
  const deletedAt = asText(body.deletedAt);
  if (body.deleted !== true || accountId === null || deletedAt === null) return null;
  const kept = Array.isArray(body.kept) ? body.kept : [];
  return {
    accountId,
    deletedAt,
    kept: kept.flatMap((entry) => {
      const record = asText(asRecord(entry)?.record);
      const until = asText(asRecord(entry)?.until);
      return record === null || until === null ? [] : [{ record, until }];
    }),
  };
};

/** What DoeDesk Cloud accepts as a label: letters, digits and `. _ + -`, at most 64. */
const isLabel = (value: string): boolean => /^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/.test(value);

const readConfig = (filePath: string): StoredConfig => {
  try {
    const parsed = JSON.parse(NodeFS.readFileSync(filePath, "utf8")) as Partial<StoredConfig>;
    if (
      parsed.mode === "cloud" ||
      parsed.mode === "selfHosted" ||
      parsed.mode === "off" ||
      parsed.mode === "unconfigured"
    ) {
      return parsed as StoredConfig;
    }
  } catch {
    // Missing or unreadable: start unconfigured, which sends nothing.
  }
  return { mode: "unconfigured" };
};

/**
 * Owns the gateway for one DoeDesk server: which detection service it uses, the account it is
 * signed in with, and the record of what it did.
 */
export const startPrivacyController = async (
  options: PrivacyControllerOptions,
): Promise<PrivacyController> => {
  const fetchImpl = options.fetch ?? fetch;
  const configPath = NodePath.join(options.dataDirectory, "config.json");
  const cloudUrl = (
    options.cloudUrl ??
    (process.env.DOEDESK_CLOUD_URL?.trim() || DEFAULT_DOEDESK_CLOUD_URL)
  ).replace(/\/+$/, "");
  let config = readConfig(configPath);
  let problem: string | null = null;
  const activity: Array<GatewayRecord> = [];
  const evaluation = options.evaluation ?? {};
  const logEvent = (event: { readonly type: string } & Record<string, unknown>) => {
    if (evaluation.eventsPath === undefined) return;
    appendLine(evaluation.eventsPath, { at: new Date().toISOString(), ...event });
  };
  const onRead = (read: ReaderUsage) => logEvent({ type: "read", ...read });
  const sentBodiesPath = evaluation.sentBodiesPath;

  // Counts refusals for Terms that were not accepted, so the caller of a detection can tell one
  // happened during its own call.
  let termsRefusals = 0;
  let onTermsRefused: (legal: PrivacyLegal | null) => void = () => undefined;
  let onCloudDetected: () => void = () => undefined;
  /**
   * `fetch` for detection and reading at DoeDesk Cloud. It notices the answer that says the
   * account has to accept the Terms first, so the app can show the sheet.
   */
  const cloudFetch: typeof fetch = async (input, init) => {
    const response = await fetchImpl(input, init);
    if (response.status === 403) {
      const body = asRecord(
        await response
          .clone()
          .json()
          .catch(() => undefined),
      );
      const error = asRecord(body?.error);
      if (error?.code === "terms_update_required") {
        termsRefusals += 1;
        onTermsRefused(readLegal(error.legal));
      }
    } else if (response.ok) {
      onCloudDetected();
    }
    return response;
  };

  const detectorFor = (current: StoredConfig): Detector => {
    if (current.mode === "cloud" && current.token !== undefined) {
      return makeRemoteDetector({ endpoint: cloudUrl, token: current.token, fetch: cloudFetch });
    }
    if (current.mode === "selfHosted" && current.endpoint !== undefined) {
      return makeRemoteDetector({
        endpoint: current.endpoint,
        token: current.token,
        fetch: fetchImpl,
      });
    }
    return { detect: () => Promise.reject(new DetectorUnavailableError(NOT_SET_UP)) };
  };

  const readerFor = (current: StoredConfig): Reader | undefined => {
    if (current.mode === "cloud" && current.token !== undefined) {
      return cacheReader(
        makeRemoteReader({ endpoint: cloudUrl, token: current.token, fetch: cloudFetch, onRead }),
      );
    }
    if (current.mode === "selfHosted" && current.endpoint !== undefined) {
      return cacheReader(
        makeRemoteReader({
          endpoint: current.endpoint,
          token: current.token,
          fetch: fetchImpl,
          onRead,
        }),
      );
    }
    return undefined;
  };

  let detector = detectorFor(config);
  let reader = readerFor(config);
  // Redacted images and masked texts of recent attachments, for the user to download. A store
  // on disk that this feature adds: see redaction/store.ts for what it holds and for how long.
  const redactionStore = new RedactionStore(NodePath.join(options.dataDirectory, "redactions"));
  let redactor: ImageRedactor | undefined;
  let gateway: PrivacyGateway | undefined;
  try {
    gateway = await startPrivacyGateway({
      dataDirectory: options.dataDirectory,
      attachments: () => ({
        images: config.imageHandling ?? DEFAULT_IMAGE_HANDLING,
        // A reader that cannot say where words are leaves `redacted` to be carried out as text.
        redactor: reader?.readLayout === undefined ? undefined : redactor,
        onReplaced: (replaced) => {
          redactionStore.save({
            original: replaced.original,
            kind: replaced.kind,
            outcome: "text",
            text: replaced.text,
          });
        },
      }),
      // Looked up on every call, so a new choice applies to agents that are already running.
      detector: {
        detect: async (texts) => {
          const refusalsBefore = termsRefusals;
          const found = await detector.detect(texts).catch((cause: unknown) => {
            // The service's own words are for the app; the person is told what to do.
            if (termsRefusals > refusalsBefore)
              throw new DetectorUnavailableError(TERMS_NOT_ACCEPTED);
            throw cause;
          });
          if (evaluation.eventsPath !== undefined) {
            const kinds: Record<string, number> = {};
            for (const entity of found.flat()) kinds[entity.kind] = (kinds[entity.kind] ?? 0) + 1;
            logEvent({
              type: "detect",
              texts: texts.length,
              characters: texts.reduce((total, text) => total + text.length, 0),
              entities: kinds,
            });
          }
          return found;
        },
      },
      masking: () => config.mode !== "off",
      reader: () => reader,
      // Without a reader nothing is connected, and the ordinary path refuses the request.
      attachmentsOnly: () => evaluation.attachmentsOnly === true && reader !== undefined,
      ...(sentBodiesPath === undefined
        ? {}
        : {
            onSentBody: (host: string, path: string, body: string) =>
              appendLine(sentBodiesPath, { at: new Date().toISOString(), host, path, body }),
          }),
      onRecord: (record) => {
        activity.push(record);
        if (activity.length > MAX_ACTIVITY) activity.splice(0, activity.length - MAX_ACTIVITY);
        logEvent({ type: "request", ...record });
      },
    });
    redactor = makeImageRedactor({
      pseudonymizer: gateway.pseudonymizer,
      // Looked up on every call: signing in or out changes the reader.
      reader: {
        readLayout: (bytes, mediaType) => {
          const readLayout = reader?.readLayout;
          if (readLayout === undefined) {
            return Promise.reject(
              new Error("No reading service that can place words is connected."),
            );
          }
          return readLayout(bytes, mediaType);
        },
      },
      onResult: (original, result) => {
        logEvent({
          type: "redaction",
          outcome: result.kind,
          ...(result.kind === "redacted" ? result.stats : { reason: result.reason }),
        });
        // A withheld image falls back to its text, which is recorded when that text is sent.
        if (result.kind !== "redacted") return;
        redactionStore.save({
          original,
          kind: "image",
          outcome: "redacted",
          image: result.image,
          text: result.maskedText,
          width: result.width,
          height: result.height,
          valueBoxes: result.stats.valueBoxes,
          unreadableBoxes: result.stats.unreadableBoxes + result.stats.unreadInkBoxes,
        });
      },
    });
  } catch (cause) {
    problem = `The privacy gateway could not start: ${String(cause)}`;
  }
  const maskingGateway = gateway;

  // If the gateway could not start, agents get a proxy address nothing listens on. Their model
  // requests fail instead of leaving unmasked.
  const gatewayEnvironment: Readonly<Record<string, string>> = gateway?.environment ?? {
    HTTPS_PROXY: "http://127.0.0.1:9",
    https_proxy: "http://127.0.0.1:9",
    NODE_USE_ENV_PROXY: "1",
  };
  const sessionSwitches = (current: StoredConfig): Readonly<Record<string, string>> => ({
    ...MASKED_SESSION_SWITCHES,
    ...(current.usageReports === false ? USAGE_REPORTS_OFF_SWITCHES : {}),
  });
  const environmentFor = (
    provider: string | undefined,
  ): Readonly<Record<string, string>> | undefined => {
    if (config.mode === "off") return undefined;
    if (provider !== undefined && config.directProviders?.includes(provider) === true) {
      return undefined;
    }
    return { ...gatewayEnvironment, ...sessionSwitches(config) };
  };
  /** Everything `environmentFor` depends on, to tell when agents need a restart. */
  const routingKey = (current: StoredConfig): string =>
    JSON.stringify([
      current.mode === "off",
      [...(current.directProviders ?? [])].toSorted(),
      current.usageReports !== false,
    ]);

  /**
   * What stays when the detection service changes: answers and per-provider choices. Nothing that
   * belongs to the account stays: its identifier, its acceptance and its answers go with it.
   */
  const keptAnswers = (): Partial<StoredConfig> => ({
    ...(config.profileAnswered === true ? { profileAnswered: true } : {}),
    ...(config.legal === undefined ? {} : { legal: config.legal }),
    ...(config.directProviders === undefined ? {} : { directProviders: config.directProviders }),
    ...(config.noticesRead === undefined ? {} : { noticesRead: config.noticesRead }),
    ...(config.usageReports === undefined ? {} : { usageReports: config.usageReports }),
    ...(config.imageHandling === undefined ? {} : { imageHandling: config.imageHandling }),
    ...(config.readingTool === undefined ? {} : { readingTool: config.readingTool }),
  });

  const apply = (next: StoredConfig) => {
    const routingBefore = routingKey(config);
    config = next;
    detector = detectorFor(next);
    reader = readerFor(next);
    NodeFS.mkdirSync(options.dataDirectory, { recursive: true, mode: 0o700 });
    NodeFS.writeFileSync(configPath, JSON.stringify(next), { mode: 0o600 });
    if (routingKey(next) !== routingBefore) options.onRoutingChange?.();
  };

  const DEVICE_NAMES: Readonly<Record<string, string>> = {
    darwin: "Mac",
    win32: "Windows",
    linux: "Linux",
  };
  // Shown on the page that confirms an emailed link, so the person can tell which app is asking.
  const device = `DoeDesk on ${DEVICE_NAMES[options.platform ?? ""] ?? "this computer"}`;

  type CloudAnswer =
    | { readonly ok: true; readonly body: Record<string, unknown> }
    | {
        readonly ok: false;
        readonly message: string;
        /** DoeDesk Cloud's error code. Null when it did not answer, or answered without one. */
        readonly code: string | null;
        readonly status: number | null;
        readonly error: Record<string, unknown>;
      };

  /** Calls DoeDesk Cloud. Resolves to the message to show when the call did not succeed. */
  const cloud = async (
    path: string,
    body: unknown,
    token?: string,
    method: "GET" | "POST" | "DELETE" = body === undefined ? "GET" : "POST",
  ): Promise<CloudAnswer> => {
    let response: Response;
    try {
      response = await fetchImpl(`${cloudUrl}${path}`, {
        method,
        headers: {
          ...(body === undefined ? {} : { "content-type": "application/json" }),
          ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(20_000),
      });
    } catch {
      return {
        ok: false,
        message: "DoeDesk Cloud could not be reached. Check your connection.",
        code: null,
        status: null,
        error: {},
      };
    }
    const parsed = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    if (!response.ok) {
      const error = asRecord(parsed.error) ?? {};
      return {
        ok: false,
        message:
          typeof error.message === "string"
            ? error.message
            : `DoeDesk Cloud answered ${response.status}.`,
        code: asText(error.code),
        status: response.status,
        error,
      };
    }
    return { ok: true, body: parsed };
  };

  const EMPTY_RESULT: PrivacySignInResult = {
    ok: true,
    message: null,
    methods: null,
    requestId: null,
    resendIn: null,
    signedIn: false,
    code: null,
    signUpAvailable: null,
    deleted: null,
  };
  const failed = (message: string, code: string | null = null): PrivacySignInResult => ({
    ...EMPTY_RESULT,
    ok: false,
    message,
    code,
  });

  /** Keeps the documents DoeDesk Cloud just named, so the screens link to the versions in force. */
  const rememberLegal = (value: unknown) => {
    const legal = readLegal(value);
    if (legal !== null && JSON.stringify(legal) !== JSON.stringify(config.legal)) {
      apply({ ...config, legal });
    }
  };
  /** A refusal that names the documents carries the versions to show and ask about again. */
  const refused = (answer: Extract<CloudAnswer, { readonly ok: false }>): PrivacySignInResult => {
    rememberLegal(answer.error.legal);
    return failed(answer.message, answer.code);
  };

  onTermsRefused = (legal) => {
    if (config.mode !== "cloud") return;
    if (legal === null && config.acceptance?.blocked === true) return;
    apply({
      ...config,
      ...(legal === null ? {} : { legal }),
      acceptance: {
        termsVersion: null,
        privacyVersion: null,
        acceptedAt: null,
        ...config.acceptance,
        outstanding: true,
        blocked: true,
      },
    });
  };
  // Detection worked although this computer thought it was refused: the account accepted elsewhere.
  onCloudDetected = () => {
    if (config.mode === "cloud" && config.acceptance?.blocked === true) void refreshAccount();
  };

  /** The `acceptance` object as DoeDesk Cloud takes it: what the screen showed, plus this app. */
  const acceptanceBody = (acceptance: PrivacyAcceptanceInput) => ({
    termsVersion: acceptance.termsVersion,
    privacyVersion: acceptance.privacyVersion,
    locale: acceptance.locale,
    wordingId: acceptance.wordingId,
    method: "checkbox+button",
    ...(options.appVersion !== undefined && isLabel(options.appVersion)
      ? { appVersion: options.appVersion }
      : {}),
  });

  // The secret each emailed link is waited on with. It stays here, so the window never holds it.
  const emailWaits = new Map<string, string>();
  // Sign-ins started to delete the account. Completing one deletes; it never replaces the sign-in.
  const deletionRequests = new Set<string>();

  const accountOf = (body: Record<string, unknown>) => {
    const account = asRecord(body.account) ?? body;
    return {
      id: asText(account.id),
      label: asText(account.email) ?? asText(account.phone),
      profileAnswered: account.profileAnswered === true,
    };
  };

  const finishSignIn = (body: Record<string, unknown>): PrivacySignInResult => {
    const account = accountOf(body);
    if (typeof body.token !== "string") return failed("DoeDesk Cloud sent an unexpected answer.");
    const acceptance = readAcceptance(body.acceptance);
    const legal = readLegal(body.legal);
    apply({
      ...keptAnswers(),
      mode: "cloud",
      token: body.token,
      ...(account.label === null ? {} : { accountLabel: account.label }),
      ...(account.id === null ? {} : { accountId: account.id }),
      ...(acceptance === null ? {} : { acceptance }),
      ...(legal === null ? {} : { legal }),
      profileAnswered: account.profileAnswered || config.profileAnswered === true,
    });
    return { ...EMPTY_RESULT, signedIn: true };
  };

  /** Forgets the account on this computer. The per-provider choices stay. */
  const forgetAccount = () => {
    const { profileAnswered: _answered, ...kept } = keptAnswers();
    apply({ mode: "unconfigured", ...kept });
  };

  const deleteWith = async (token: string) => {
    const answer = await cloud("/v1/me", undefined, token, "DELETE");
    if (!answer.ok) return answer;
    const deleted = readDeleted(answer.body);
    return deleted === null
      ? ({
          ok: false,
          message: "DoeDesk Cloud sent an unexpected answer.",
          code: null,
          status: null,
          error: {},
        } as const)
      : ({ ok: true, deleted } as const);
  };

  /**
   * A sign-in started to delete the account was verified. The new sign-in is used once, for the
   * deletion, and only if it is for the account signed in here.
   */
  const finishDeletion = async (body: Record<string, unknown>): Promise<PrivacySignInResult> => {
    const fresh = asText(body.token);
    if (fresh === null) return failed("DoeDesk Cloud sent an unexpected answer.");
    const verified = accountOf(body);
    // A sign-in from before accounts had identifiers here: ask which account it is.
    if (config.mode === "cloud" && config.accountId === undefined) await refreshAccount();
    const current = config.mode === "cloud" ? config.token : undefined;
    if (
      current === undefined ||
      config.accountId === undefined ||
      verified.id !== config.accountId
    ) {
      // Another number or address was verified. If that made an account, it is removed again.
      if (body.created === true) await deleteWith(fresh);
      else await cloud("/v1/auth/sign-out", {}, fresh);
      return failed(
        "That number or address belongs to a different account. Nothing was deleted.",
        "different_account",
      );
    }
    const answer = await deleteWith(fresh);
    if (!answer.ok) {
      // The new sign-in replaces the old one, so "Try again" can delete without another code.
      await cloud("/v1/auth/sign-out", {}, current);
      apply({ ...config, token: fresh });
      return failed(answer.message, answer.code);
    }
    forgetAccount();
    return { ...EMPTY_RESULT, deleted: answer.deleted };
  };

  const finish = (requestId: string, body: Record<string, unknown>) => {
    if (!deletionRequests.delete(requestId)) return finishSignIn(body);
    return finishDeletion(body);
  };

  const signIn = async (input: PrivacySignInInput): Promise<PrivacySignInResult> => {
    switch (input.step) {
      case "options": {
        // The request names no account and no device.
        const answer = await cloud("/v1/auth/options", undefined);
        if (!answer.ok) return refused(answer);
        rememberLegal(answer.body.legal);
        const methods = Array.isArray(answer.body.methods)
          ? answer.body.methods.filter(
              (method): method is SignInMethod => method === "phone" || method === "email",
            )
          : [];
        const first =
          answer.body.default === "phone" && methods.includes("phone") ? "phone" : "email";
        return {
          ...EMPTY_RESULT,
          methods: [first, ...methods.filter((method) => method !== first)],
          signUpAvailable: asRecord(answer.body.signUp)?.available !== false,
        };
      }
      case "phoneStart": {
        const answer = await cloud("/v1/auth/phone/start", {
          phone: input.phone,
          client: "desktop",
          device,
          ...(input.purpose === "deleteAccount" ? { purpose: "delete_account" } : {}),
          ...(input.acceptance === undefined
            ? {}
            : { acceptance: acceptanceBody(input.acceptance) }),
        });
        if (!answer.ok) return refused(answer);
        const requestId = asText(answer.body.requestId);
        if (requestId !== null && input.purpose === "deleteAccount") {
          deletionRequests.add(requestId);
        }
        return {
          ...EMPTY_RESULT,
          requestId,
          resendIn: typeof answer.body.resendIn === "number" ? answer.body.resendIn : 60,
        };
      }
      case "phoneVerify": {
        const answer = await cloud("/v1/auth/phone/verify", {
          requestId: input.requestId,
          code: input.code,
        });
        return answer.ok ? finish(input.requestId, answer.body) : refused(answer);
      }
      case "emailStart": {
        const answer = await cloud("/v1/auth/email/start", {
          email: input.email,
          client: "desktop",
          device,
          ...(input.purpose === "deleteAccount" ? { purpose: "delete_account" } : {}),
          ...(input.locale === undefined ? {} : { locale: input.locale }),
          ...(input.acceptance === undefined
            ? {}
            : { acceptance: acceptanceBody(input.acceptance) }),
        });
        if (!answer.ok) return refused(answer);
        const { requestId, pollSecret } = answer.body;
        if (typeof requestId !== "string" || typeof pollSecret !== "string") {
          return failed("DoeDesk Cloud sent an unexpected answer.");
        }
        emailWaits.set(requestId, pollSecret);
        if (input.purpose === "deleteAccount") deletionRequests.add(requestId);
        return { ...EMPTY_RESULT, requestId };
      }
      case "emailCheck": {
        const pollSecret = emailWaits.get(input.requestId);
        if (pollSecret === undefined) return failed("This sign-in has expired. Start again.");
        const answer = await cloud("/v1/auth/email/poll", {
          requestId: input.requestId,
          pollSecret,
        });
        if (!answer.ok) {
          emailWaits.delete(input.requestId);
          deletionRequests.delete(input.requestId);
          return refused(answer);
        }
        if (answer.body.status !== "approved") return EMPTY_RESULT;
        emailWaits.delete(input.requestId);
        return finish(input.requestId, answer.body);
      }
    }
  };

  /**
   * Asks the cloud whether the stored sign-in still stands, and where the account stands on the
   * Terms. A sign-in that was ended elsewhere would otherwise look signed in here while every
   * model request is refused.
   */
  const refreshAccount = async () => {
    const token = config.mode === "cloud" ? config.token : undefined;
    if (token === undefined) return;
    // Offline: keep the sign-in. Requests are refused anyway until detection answers.
    const answer = await cloud("/v1/me", undefined, token);
    if (config.token !== token) return;
    if (!answer.ok) {
      if (answer.status === 401) forgetAccount();
      return;
    }
    const account = accountOf(answer.body);
    const label = account.label ?? config.accountLabel;
    const acceptance = readAcceptance(answer.body.acceptance);
    const legal = readLegal(answer.body.legal);
    const field = asText(answer.body.field);
    const workplace = asText(answer.body.workplace);
    const { profile: _profile, ...rest } = config;
    apply({
      ...rest,
      ...(label === undefined ? {} : { accountLabel: label }),
      ...(account.id === null ? {} : { accountId: account.id }),
      ...(acceptance === null ? {} : { acceptance }),
      ...(legal === null ? {} : { legal }),
      ...(field === null && workplace === null ? {} : { profile: { field, workplace } }),
      profileAnswered: account.profileAnswered || config.profileAnswered === true,
    });
  };
  void refreshAccount();

  const signOut = async () => {
    if (config.mode === "cloud" && config.token !== undefined) {
      // Best effort: the local sign-out happens whether or not the cloud hears about it.
      await cloud("/v1/auth/sign-out", {}, config.token);
    }
  };

  const NOT_SIGNED_IN: PrivacyAccountResult = {
    ok: false,
    code: "unauthenticated",
    message: "No DoeDesk Cloud account is signed in on this computer.",
    exported: null,
    deleted: null,
  };
  const accountDone: PrivacyAccountResult = {
    ok: true,
    code: null,
    message: null,
    exported: null,
    deleted: null,
  };

  const account = async (input: PrivacyAccountInput): Promise<PrivacyAccountResult> => {
    const token = config.mode === "cloud" ? config.token : undefined;
    if (token === undefined) return NOT_SIGNED_IN;
    const refusal = (answer: Extract<CloudAnswer, { readonly ok: false }>) => {
      rememberLegal(answer.error.legal);
      // The sign-in was ended elsewhere, or the account is gone.
      if (answer.status === 401 && config.token === token) forgetAccount();
      return { ...accountDone, ok: false, code: answer.code, message: answer.message };
    };
    switch (input.action) {
      case "refresh":
        await refreshAccount();
        return accountDone;
      case "accept": {
        const answer = await cloud(
          "/v1/me/acceptance",
          { acceptance: acceptanceBody(input.acceptance) },
          token,
        );
        if (!answer.ok) return refusal(answer);
        const acceptance = readAcceptance(answer.body.acceptance);
        const legal = readLegal(answer.body.legal);
        if (config.token === token) {
          apply({
            ...config,
            ...(acceptance === null ? {} : { acceptance }),
            ...(legal === null ? {} : { legal }),
          });
        }
        return accountDone;
      }
      case "export": {
        const answer = await cloud("/v1/me/export", undefined, token);
        if (!answer.ok) return refusal(answer);
        return { ...accountDone, exported: JSON.stringify(answer.body, null, 2) };
      }
      case "delete": {
        const answer = await deleteWith(token);
        if (!answer.ok) return refusal(answer);
        if (config.token === token) forgetAccount();
        return { ...accountDone, deleted: answer.deleted };
      }
    }
  };

  const connectSelfHosted = async (
    input: Extract<PrivacyConfigureInput, { mode: "selfHosted" }>,
  ) => {
    let endpoint: URL;
    try {
      endpoint = new URL(input.endpoint.trim());
    } catch {
      return {
        ok: false,
        message: "Enter the service address as a full URL, such as http://localhost:8080.",
      };
    }
    const next: StoredConfig = {
      mode: "selfHosted",
      endpoint: endpoint.toString().replace(/\/+$/, ""),
      ...(input.token ? { token: input.token } : {}),
      ...keptAnswers(),
    };
    try {
      await detectorFor(next).detect(["Connection test."]);
    } catch (cause) {
      return {
        ok: false,
        message: cause instanceof Error ? cause.message : "The detection service did not answer.",
      };
    }
    await signOut();
    apply(next);
    return { ok: true, message: null };
  };

  const signedIn = () => config.mode === "cloud";

  return {
    status: () => ({
      mode: config.mode,
      active: gateway !== undefined && config.mode !== "off",
      accountLabel: signedIn() ? (config.accountLabel ?? null) : null,
      endpoint: config.mode === "selfHosted" ? (config.endpoint ?? null) : null,
      vaultSize: gateway?.vault.size ?? 0,
      problem:
        problem ??
        (evaluation.attachmentsOnly === true && config.mode !== "off" && reader !== undefined
          ? ATTACHMENTS_ONLY_WARNING
          : null),
      profileAnswered: config.profileAnswered === true,
      directProviders: config.directProviders ?? [],
      noticesRead: Object.entries(config.noticesRead ?? {}).flatMap(([provider, version]) =>
        version >= PROVIDER_NOTICE_VERSION ? [provider] : [],
      ),
      usageReports: config.usageReports !== false,
      imageHandling: config.imageHandling ?? DEFAULT_IMAGE_HANDLING,
      readingTool: config.readingTool !== false,
      sessionSwitches: sessionSwitches(config),
      accountId: signedIn() ? (config.accountId ?? null) : null,
      acceptance: signedIn() ? (config.acceptance ?? null) : null,
      legal: config.legal ?? null,
      profile: signedIn() ? (config.profile ?? null) : null,
    }),
    environmentFor,
    setPreference: (input) => {
      switch (input.kind) {
        case "providerRoute": {
          const others = (config.directProviders ?? []).filter((name) => name !== input.provider);
          apply({
            ...config,
            directProviders: input.direct ? [...others, input.provider] : others,
          });
          return;
        }
        case "noticeRead":
          apply({
            ...config,
            noticesRead: { ...config.noticesRead, [input.provider]: PROVIDER_NOTICE_VERSION },
          });
          return;
        case "imageHandling":
          apply({ ...config, imageHandling: input.handling });
          break;
        case "readingTool":
          apply({ ...config, readingTool: input.offered });
          break;
        case "usageReports":
          apply({ ...config, usageReports: input.send });
          return;
      }
    },
    configure: async (input) => {
      switch (input.mode) {
        case "selfHosted":
          return connectSelfHosted(input);
        case "off":
        case "unconfigured":
          await signOut();
          apply({ mode: input.mode, ...keptAnswers() });
          return { ok: true, message: null };
      }
    },
    signIn,
    account,
    saveProfile: async (input) => {
      const { profile: _profile, ...rest } = config;
      const answered = input.field !== null || input.workplace !== null;
      apply({
        ...rest,
        profileAnswered: true,
        ...(signedIn() && answered
          ? { profile: { field: input.field, workplace: input.workplace } }
          : {}),
      });
      if (config.mode === "cloud" && config.token !== undefined) {
        await cloud("/v1/me/profile", input, config.token);
      }
    },
    accountToken: async (audience) => {
      if (config.mode !== "cloud" || config.token === undefined) return null;
      const answer = await cloud("/v1/auth/token", { audience }, config.token);
      return answer.ok && typeof answer.body.token === "string" ? answer.body.token : null;
    },
    activity: () => activity.toReversed(),
    readMasked: async (bytes, mediaType) => {
      if (config.mode === "off" || config.mode === "unconfigured" || maskingGateway === undefined) {
        return { ok: false, message: "DoeDesk privacy is not active, so nothing was read." };
      }
      if (config.readingTool === false) {
        return { ok: false, message: "The reading tool is turned off in Settings, under Privacy." };
      }
      if (reader === undefined) {
        return { ok: false, message: "No reading service is connected, so nothing was read." };
      }
      let text: string;
      try {
        text = await reader.read(bytes, mediaType);
      } catch (cause) {
        const reason = cause instanceof Error ? cause.message : "it could not be read";
        return { ok: false, message: `The file could not be read (${reason}).` };
      }
      try {
        // Masked exactly as the text of an attachment is, with the same vault.
        const { texts } = await maskingGateway.pseudonymizer.mask([{ text, mode: "detect" }]);
        const masked = texts[0] ?? "";
        redactionStore.save({
          original: bytes,
          kind: mediaType.startsWith("image/") ? "image" : "file",
          outcome: "text",
          text: masked,
        });
        return { ok: true, text: masked };
      } catch (cause) {
        const reason =
          cause instanceof DetectorUnavailableError
            ? cause.message
            : "Masking failed unexpectedly.";
        return {
          ok: false,
          message: `The text could not be checked for personal data, so none of it is returned. ${reason}`,
        };
      }
    },
    redactions: () => redactionStore.list(),
    redactionFile: (id, part) => redactionStore.read(id, part),
    clearRedactions: () => redactionStore.clear(),
    vault: () =>
      (gateway?.vault.entries() ?? []).map((entry) => ({
        token: entry.token,
        kind: entry.kind,
        value: entry.value,
      })),
    close: async () => {
      logEvent({ type: "vault", entries: gateway?.vault.entries() ?? [] });
      await gateway?.close();
    },
  };
};
