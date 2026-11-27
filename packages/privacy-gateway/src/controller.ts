import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { type Detector, type DetectorProblem, DetectorUnavailableError } from "./detect.ts";
import type { EgressPolicy, GatewayOptions, GatewayRecord } from "./gateway.ts";
import { fetchThrough, readHostNetwork } from "./upstream.ts";
import {
  MASKED_SESSION_SWITCHES,
  type PrivacyGateway,
  startPrivacyGateway,
  USAGE_REPORTS_OFF_SWITCHES,
} from "./index.ts";
import type { ImageHandling } from "./attachments.ts";
import {
  DOEDESK_CLOUD,
  mergeChoice,
  migrateProviders,
  plainChoice,
  type ProviderChoiceInput,
  providerCatalog,
  type PublicProviderChoice,
  publicChoice,
  type ServiceKind,
  type StoredProviderChoice,
  type StoredProviders,
} from "./providerChoices.ts";
import type { ProviderCatalogEntry } from "./providers/catalog.ts";
import { makeDetectProvider } from "./providers/detectProviders.ts";
import { makeOcrProvider } from "./providers/ocrProviders.ts";
import type {
  DetectProviderConfig,
  OcrProviderConfig,
  ProviderHealthResult,
  WorkerHealthResult,
  WorkerProvider,
  WorkerProviderConfig,
} from "./providers/types.ts";
import { makeWorkerProvider } from "./providers/workerProviders.ts";
import { cacheReader, type Reader, type ReaderUsage } from "./reader.ts";
import { type ImageRedactor, makeImageRedactor } from "./redaction/redactImage.ts";
import { type RedactionFile, type RedactionRecord, RedactionStore } from "./redaction/store.ts";
import { ProxyRefusal } from "./refusals.ts";
import { kindOfStandIn, TurnLedger, type TurnTally } from "./turns.ts";
import type { StructuredOutput, WorkerDriver, WorkerEndpoint } from "./worker/client.ts";
import type { FieldSpec } from "./worker/fields.ts";
import { DEFAULT_SEAL_POLICY, type SealPolicy } from "./worker/seal.ts";
import { makeSecondPassDetector } from "./worker/secondPass.ts";
import {
  type ReadForSealing,
  sealFile,
  type SealFileResult,
  unsealFile,
  type UnsealFileResult,
} from "./sealedFiles.ts";
import {
  comparablePath,
  makeSealedFolders,
  type SealChange,
  type SealedFolderGate,
  type SealedFolderHold,
  type SealedFolders,
  type SealFolderResult,
  type SealTargetsInspection,
  type UnsealFolderResult,
} from "./sealedFolders.ts";
import type { FileLabel, FileLabels } from "./fileLabels.ts";
import { type FolderCopies, findFolderCopies } from "./folderCopies.ts";
import { recordNumbersIn } from "./knownParts.ts";
import { maskedLabels, neutralLabel } from "./sealedLabels.ts";
import { type AskAnswer, makeSealedWorker, type SealedWorker } from "./worker/sealedWorker.ts";
import { WITHHELD_SEALED_NOTE } from "./worker/tripwire.ts";
import {
  localText,
  readLocally,
  type SealedDocumentInfo,
  type SealedFolderInfo,
  type RecordedClearAnswer,
  type SealedOutputInfo,
  type SealedOutputSpan,
  SealedStore,
  type SealedTurnActivity,
} from "./worker/store.ts";
import { sealedTurn, takeSealedTurn } from "./worker/turnActivity.ts";

/**
 * Images go redacted: the image with a labelled box over each detected value (owner's decision,
 * 19 November 2026). An image that cannot be redacted safely, or a service that returns no word
 * positions, falls back to masked text. People can choose masked text or withholding in Settings.
 */
const DEFAULT_IMAGE_HANDLING: "redacted" | "text" | "withheld" = "redacted";

/**
 * What the app is told. `cloud`: an account is signed in. `selfHosted`: nobody is signed in and
 * detection is a service of the person's own. `unconfigured`: nothing can detect yet.
 */
export type PrivacyMode = "unconfigured" | "cloud" | "selfHosted" | "off";
/** What is kept. Which services are used is kept apart from it, in `providers`. */
type StoredMode = "unconfigured" | "cloud" | "off";

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

/**
 * The model that reads sealed documents. `cloud`: the one DoeDesk Cloud hosts, at the upstream for
 * the account's region. `custom`: the person's own server, which is any address that speaks Chat
 * Completions or Responses. `off`: none.
 */
export type WorkerKind = "off" | "cloud" | "custom";

/** Where DoeDesk Cloud runs the hosted worker for an account. Only DoeDesk Cloud maps it to a host. */
export const ACCOUNT_REGIONS = ["sa", "eu", "global"] as const;
export type AccountRegion = (typeof ACCOUNT_REGIONS)[number];

/** DoeDesk Cloud's worker for the account's region, as it last described it. */
interface HostedWorker {
  /** False: the region has no worker now. DoeDesk Cloud sends its requests to no other region. */
  readonly available: boolean;
  readonly model: string | null;
  readonly structured: StructuredOutput | null;
  /** Calls the region takes at once, for everyone, and the longest one waits there for its turn. */
  readonly parallel: number | null;
  readonly maxWaitSeconds: number | null;
  /** Who runs the region's model and where, in DoeDesk Cloud's words. */
  readonly hostLabel?: string;
  readonly locationLabel?: string;
}

/** Told to the person who asks for DoeDesk Cloud's worker on an account that does not have it. */
const HOSTED_WORKER_NOT_INCLUDED =
  "DoeDesk Cloud's worker is not included in this account. Connect your own server to read sealed files.";

/** A sealed document may be this long: about the context a 128K-token worker can hold. */
const MAX_SEALED_CHARACTERS = 320_000;
const MAX_SEALED_BYTES = 20 * 1024 * 1024;

const READER_MEDIA_TYPES: Readonly<Record<string, string>> = {
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".tif": "image/tiff",
  ".tiff": "image/tiff",
};

interface StoredConfig {
  readonly mode: StoredMode;
  /**
   * The service chosen for reading, for detection and for the worker, each with its secrets.
   * Unset, reading and detection are DoeDesk Cloud's, and the worker is DoeDesk Cloud's where the
   * signed-in account has it and nobody otherwise.
   */
  readonly providers?: StoredProviders;
  /** The signed-in account's region, as DoeDesk Cloud last said. */
  readonly accountRegion?: AccountRegion;
  /** DoeDesk Cloud last said its hosted worker is included for this account. Unset: it is not. */
  readonly hostedWorkerEntitled?: boolean;
  readonly hostedWorker?: HostedWorker;
  /** Which hosts other than model hosts agents may reach. Unset: all of them. */
  readonly egress?: { readonly policy: EgressPolicy; readonly hosts: ReadonlyArray<string> };
  /** Limits on what may be revealed about sealed documents. Unset: the defaults. */
  readonly sealing?: Partial<SealPolicy>;
  /** True: the worker also checks every text for references and names the first check missed. */
  readonly secondPass?: boolean;
  /** True: public web pages and search results are checked for new values too. Unset: not. */
  readonly checkWebResults?: boolean;
  /** The signed-in account's token at DoeDesk Cloud. */
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

/** The worker as the settings screen shows it. The key is never part of it. */
export interface PrivacyWorkerStatus {
  readonly kind: WorkerKind;
  /** The address documents are sent to. Null when no worker is connected. */
  readonly address: string | null;
  readonly model: string | null;
  readonly driver: WorkerDriver | null;
  readonly reasoningEffort: string | null;
  /** A worker is connected and has not stopped answering. */
  readonly available: boolean;
  /** Where the worker's server said it handled the last call, when it says so. */
  readonly servedFrom: string | null;
  /** `cloud` only: the account region whose worker is used. Null until DoeDesk Cloud has said. */
  readonly region: AccountRegion | null;
  /** The worker's server last said it was busy, with this many calls waiting. Not a failure. */
  readonly busy: { readonly waiting: number } | null;
  /** DoeDesk Cloud's worker was the one in use, and the signed-in account does not have it. */
  readonly notIncluded: boolean;
}

export type PrivacyWorkerInput =
  | { readonly kind: "off" }
  | { readonly kind: "cloud" }
  | {
      readonly kind: "custom";
      readonly baseUrl: string;
      readonly apiKey?: string | undefined;
      readonly model: string;
      readonly driver: WorkerDriver;
      readonly reasoningEffort?: string | undefined;
    };

/** What the person chose a provider is told a file is called. Masked names unless neutral. */
export interface SealLabelChoice {
  /** Send the handle and the file type alone. */
  readonly neutralLabel?: boolean;
}

export interface SealedForAgents {
  readonly files: ReadonlyArray<{
    readonly handle: string;
    /** The masked name, or the handle and type. */
    readonly name: string;
    /** Where the file was, masked. Unset for a file sent by handle and type that was in no sealed folder. */
    readonly path?: string;
    /** No text to ask about yet. */
    readonly unread: boolean;
  }>;
  /** Sealed folders whose paths were checked, masked. */
  readonly folders: ReadonlyArray<string>;
}

export interface PrivacySealedListing {
  /** `label` is always set here: what a provider is told the file is called. */
  readonly documents: ReadonlyArray<SealedDocumentInfo>;
  readonly outputs: ReadonlyArray<SealedOutputInfo>;
  /** Subfolders whose files are sealed as they arrive. */
  readonly folders: ReadonlyArray<SealedFolderInfo>;
  /** Answers given in clear about the most-asked document, and how many each may give. */
  readonly clear: { readonly mostOnOneDocument: number; readonly perDocument: number };
}

export interface PrivacyAskInput {
  readonly project: string;
  readonly caller: string;
  readonly handles: ReadonlyArray<string>;
  readonly files?: ReadonlyArray<{ readonly name: string; readonly text: string }> | undefined;
  readonly instruction: string;
  readonly fields: ReadonlyArray<FieldSpec>;
  readonly program?: string | undefined;
}

/** A service's provider, and whether it can be used now. */
export interface PrivacyProviderState {
  readonly provider: string;
  /** False: DoeDesk Cloud is the choice and no signed-in account has it. */
  readonly ready: boolean;
}

/** A service as a settings screen shows it. */
export interface PrivacyProviderDetail {
  readonly config: PublicProviderChoice;
  /** Every provider the service can be, with the fields each asks for. */
  readonly catalog: ReadonlyArray<ProviderCatalogEntry<string>>;
}

export type PrivacyProviders = { readonly [Service in ServiceKind]: PrivacyProviderDetail };

export interface PrivacyProviderInput extends ProviderChoiceInput {
  readonly service: ServiceKind;
}

export interface PrivacyProviderOutcome {
  readonly ok: boolean;
  /** Why the choice was not stored, in words the person can act on. Null when `ok`. */
  readonly message: string | null;
  /** How the service answered when it was asked. Unset when it was not asked. */
  readonly health?: ProviderHealthResult;
}

export interface PrivacyControllerStatus {
  readonly mode: PrivacyMode;
  readonly providers: { readonly [Service in ServiceKind]: PrivacyProviderState };
  readonly worker: PrivacyWorkerStatus;
  /** The rule the person chose for hosts that are not AI hosts. Sealing does not change it. */
  readonly egress: {
    readonly policy: EgressPolicy;
    readonly hosts: ReadonlyArray<string>;
    /** Hosts the rule refused since the app started and that are still refused, newest first. */
    readonly refused: ReadonlyArray<{ readonly host: string; readonly at: string }>;
  };
  /** Sealed documents held on this device, over all projects. */
  readonly sealedDocuments: number;
  /** Turns that have not started because a file is still arriving in a sealed folder. */
  readonly sealingBeforeTurn: ReadonlyArray<SealedFolderHold>;
  /** Whether the worker also checks every text for references and names. */
  readonly secondPass: boolean;
  /**
   * Whether public web pages and search results are checked for new personal data. False: only
   * values already known are replaced in them (see `webResults.ts`).
   */
  readonly webResultsChecked: boolean;
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
  /** The signed-in account's region. Null when signed out, or DoeDesk Cloud has not yet said. */
  readonly accountRegion: AccountRegion | null;
  /** DoeDesk Cloud's hosted worker is included for the signed-in account. */
  readonly hostedWorkerEntitled: boolean;
  /** False: the account has it, and DoeDesk Cloud offers none in the account's region yet. */
  readonly hostedWorkerOffered: boolean;
  /** Who runs the worker for the account's region and where, as DoeDesk Cloud names them. */
  readonly hostedWorker: { readonly host: string; readonly location: string } | null;
  /** Null when no account is signed in, or DoeDesk Cloud has not yet said where it stands. */
  readonly acceptance: PrivacyAcceptanceStatus | null;
  /** Null until DoeDesk Cloud has been asked. */
  readonly legal: PrivacyLegal | null;
  readonly profile: PrivacyProfileAnswers | null;
}

export interface PrivacyTurnValue {
  readonly token: string;
  readonly kind: string;
  /** The real value. Null when the vault no longer holds the stand-in. */
  readonly value: string | null;
  /** The value comes from a sealed document. */
  readonly sealed: boolean;
}

/** Stand-ins with every spelling of their values, and the turns that wrote them. */
export interface PrivacyKnownValues {
  readonly values: ReadonlyArray<{
    readonly token: string;
    readonly surfaces: ReadonlyArray<string>;
    /** A spelling held both ways is found under the stand-in that is not sealed. */
    readonly sealed: boolean;
  }>;
  readonly turns: ReadonlyArray<{ readonly runId: string; readonly tokens: ReadonlyArray<string> }>;
}

/** A choice that is separate from which detection service is used. */
export type PrivacyPreferenceInput =
  | { readonly kind: "providerRoute"; readonly provider: string; readonly direct: boolean }
  | { readonly kind: "noticeRead"; readonly provider: string }
  | { readonly kind: "usageReports"; readonly send: boolean }
  | { readonly kind: "imageHandling"; readonly handling: ImageHandling }
  | { readonly kind: "readingTool"; readonly offered: boolean }
  | {
      readonly kind: "egress";
      readonly policy: EgressPolicy;
      readonly hosts: ReadonlyArray<string>;
    }
  | { readonly kind: "secondPass"; readonly on: boolean }
  /** Lets one refused host through: until the app closes, or for good by adding it to the list. */
  | { readonly kind: "allowHost"; readonly host: string; readonly lasting: boolean }
  | { readonly kind: "webResults"; readonly check: boolean };

/** What the masked-text reading tool answers. */
export type PrivacyReadMaskedResult =
  | { readonly ok: true; readonly text: string }
  /** `message` is written for the agent and never quotes the file. */
  | { readonly ok: false; readonly message: string };

export type PrivacyConfigureInput =
  | { readonly mode: "selfHosted"; readonly endpoint: string; readonly token?: string }
  | { readonly mode: "off" }
  | { readonly mode: "unconfigured" };

/** `problem` says why one's own detection service could not be connected, for the app to word. */
export interface PrivacyConfigureOutcome {
  readonly ok: boolean;
  readonly message: string | null;
  readonly problem?: DetectorProblem | { readonly kind: "address" };
}

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
  | { readonly action: "delete" }
  | { readonly action: "setRegion"; readonly region: AccountRegion };

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
  readonly configure: (input: PrivacyConfigureInput) => Promise<PrivacyConfigureOutcome>;
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
    /** False for a value of a sealed document, which is never sent as written. */
    readonly removable: boolean;
  }>;
  /** The values the person stopped masking, each with the stand-in it had. */
  readonly unmaskedValues: () => ReadonlyArray<{
    readonly token: string;
    readonly kind: string;
    readonly value: string;
  }>;
  /**
   * Stops masking a value, or masks it again (see `Vault.release`). False when no such entry
   * exists or it belongs to a sealed document.
   */
  readonly setValueMasked: (token: string, masked: boolean) => boolean;
  /**
   * What the gateway did for the chats that go by these names since it was last asked, or
   * undefined when it did nothing. The stand-ins are kept under `id` for `turnValues`.
   */
  readonly takeTurn: (id: string, sessions: ReadonlyArray<string>) => TurnTally | undefined;
  /**
   * Why no request is getting out right now: what the computer's proxy last refused, when
   * nothing has been sent since. For a failure whose own words do not say it.
   */
  readonly refusingNow: () => string | undefined;
  /** A kept turn's stand-ins beside their real values. Undefined when the turn is not kept. */
  readonly turnValues: (id: string) => ReadonlyArray<PrivacyTurnValue> | undefined;
  /**
   * What the thread's agent asked of sealed documents since its last turn, kept under `id` for
   * `sealedTurn`. Undefined when it asked nothing.
   */
  readonly takeSealedTurn: (id: string, thread: string) => SealedTurnActivity | undefined;
  /** A kept turn's sealed files and clear answers. Undefined when it asked nothing or is gone. */
  readonly sealedTurn: (id: string) => SealedTurnActivity | undefined;
  /**
   * What a client needs to mark replaced values where the person reads them: the stand-ins of
   * these kept turns, or with no turns named every value `Vault.findKnown` looks for. Nothing
   * while masking is off.
   */
  readonly knownValues: (runIds?: ReadonlyArray<string>) => PrivacyKnownValues;
  /** Connects, changes or removes the worker. Connecting asks it one question that holds nothing confidential. */
  readonly configureWorker: (
    input: PrivacyWorkerInput,
  ) => Promise<{ readonly ok: boolean; readonly message: string | null }>;
  /** The three services as a settings screen shows them: no secret is part of it. */
  readonly providers: () => PrivacyProviders;
  /**
   * Chooses the service for reading, for detection or for the worker, and leaves the other two
   * as they are. A service with an address or a key is asked once first, and is not stored when
   * it does not answer.
   */
  readonly configureProvider: (input: PrivacyProviderInput) => Promise<PrivacyProviderOutcome>;
  /** Asks a choice's service one small thing without storing the choice. */
  readonly testProvider: (input: PrivacyProviderInput) => Promise<ProviderHealthResult>;
  /** Whether agents are offered the tools that ask about sealed documents. */
  readonly workerOffered: () => boolean;
  /** Evaluation only: the worker answers in free text, with no checks. */
  readonly workerFreeText: () => boolean;
  /**
   * A file's text, unmasked, for the worker. Text and Word files are read here; a PDF or an image
   * goes to the reading service.
   */
  readonly documentText: (name: string, bytes: Buffer) => ReturnType<ReadForSealing>;
  /**
   * Seals a file: keeps its text where agents cannot read it. With `origin`, the path the caller
   * is about to remove the file from, the file itself is kept too, so it can be put back.
   */
  readonly sealDocument: (
    project: string,
    name: string,
    bytes: Buffer,
    origin?: string,
    label?: SealLabelChoice,
  ) => Promise<SealFileResult>;
  /**
   * What `root`, a project's folder, holds of a file that came as a copy with no path: the file
   * itself when exactly one has the same bytes and name, and otherwise the files that would stay
   * readable were the copy alone sealed.
   */
  readonly attachedFileInFolder: (
    root: string,
    name: string,
    sha256: string,
    size: number,
  ) => Promise<FolderCopies>;
  /**
   * Seals a file that came as a copy. Where the folder holds the file itself, that file is sealed
   * where it lies (`original`); otherwise the copy is, and `readable` names what stays in the
   * folder for an agent to open. Without `root` the copy is sealed and nothing is looked for.
   */
  readonly sealAttached: (
    project: string,
    root: string | null,
    name: string,
    bytes: Buffer,
    label?: SealLabelChoice,
  ) => Promise<
    (Extract<SealFileResult, { ok: true }> & FolderCopies) | Extract<SealFileResult, { ok: false }>
  >;
  /**
   * Seals the file at a path on this machine and moves it out of its folder, whether or not its
   * text can be read: one that cannot is kept all the same, and cannot be asked about yet.
   */
  readonly sealFile: (
    project: string,
    filePath: string,
    label?: SealLabelChoice,
  ) => Promise<SealFileResult>;
  /**
   * Reads a sealed file that has no text yet, from the copy that was kept. Resolves `ok` once it
   * can be asked about.
   */
  readonly readSealed: (
    project: string,
    handle: string,
  ) => Promise<{ readonly ok: boolean; readonly message: string | null }>;
  /** Seals each file where it lies. One that fails leaves the others sealed. */
  readonly sealFiles: (
    project: string,
    filePaths: ReadonlyArray<string>,
    label?: SealLabelChoice,
  ) => Promise<{
    readonly sealed: number;
    /** Of `sealed`: kept with no text yet, so nothing can be asked about them. */
    readonly unread: number;
    readonly failed: ReadonlyArray<{ readonly name: string; readonly message: string }>;
  }>;
  /** Puts a sealed file back where it was and forgets its sealed copy. */
  readonly unsealFile: (project: string, handle: string) => Promise<UnsealFileResult>;
  /**
   * Whether a turn has started in the project since one of these files, or a file of this folder,
   * was unsealed back into it. The copies kept for undo cannot say: a file that was sealed once is
   * never copied again.
   */
  readonly openedToTurns: (
    project: string,
    target: { readonly folder: string } | { readonly files: ReadonlyArray<string> },
  ) => boolean;
  /** Before sealing a folder or several files: how many, and what the person has to be told. */
  readonly inspectSealTargets: (
    target: { readonly folder: string } | { readonly files: ReadonlyArray<string> },
  ) => Promise<SealTargetsInspection>;
  /**
   * Seals a subfolder of `root`, the project's folder: every file in it, and every file that
   * appears in it later.
   */
  readonly sealFolder: (
    project: string,
    root: string,
    folder: string,
    options?: { readonly neutralLabels?: boolean },
  ) => Promise<SealFolderResult>;
  /**
   * What a provider would be told each of these file names is: the name with the values found in
   * it replaced by stand-ins. Null for a name that cannot be checked now, which is then sent as
   * its handle and type. Shown to the person before they confirm sealing.
   */
  readonly sealLabels: (names: ReadonlyArray<string>) => Promise<ReadonlyArray<string | null>>;
  /**
   * The person's choice for a sealed file: its handle and type alone, or its name with the values
   * in it masked. False when no such file is sealed.
   */
  readonly setSealedLabel: (project: string, handle: string, neutral: boolean) => Promise<boolean>;
  /**
   * A project's sealed files and folders as an agent, and so a provider, is told them: never a
   * file's own name. Paths are written from `cwd`, the agent's working folder, where they lie
   * below it.
   */
  readonly sealedForAgents: (project: string, cwd: string | null) => SealedForAgents;
  /** Stops sealing a folder and puts its files back as they were. */
  readonly unsealFolder: (project: string, folder: string) => Promise<UnsealFolderResult>;
  /**
   * Run before an agent's turn starts: seals what has appeared in the project's sealed folders,
   * waiting a bounded time for a file still being written. The turn starts only on `ok`.
   */
  readonly sealedFoldersBeforeTurn: (
    project: string,
    signal?: AbortSignal,
  ) => Promise<SealedFolderGate>;
  /** Sweeps a project's sealed folders soon: after an agent's tool call that can write. */
  readonly sweepSealedFoldersSoon: (project: string) => void;
  /** The sealed folder that holds this path: an agent must not write there. */
  readonly sealedFolderContaining: (path: string) => string | undefined;
  /** Every sealed folder, of any project: nothing in one is to be copied for undo. */
  readonly sealedFolderPaths: () => ReadonlyArray<string>;
  readonly sealedListing: (project: string) => PrivacySealedListing;
  readonly resetSealedLimits: (project: string) => void;
  /** Every answer the remote model was given in clear about a project's sealed documents. */
  readonly sealedClearAnswers: (project: string) => ReadonlyArray<RecordedClearAnswer>;
  /**
   * A finished file that holds sealed values, with where each value came from, for the person.
   * Never returned to an agent.
   */
  readonly sealedOutputDetail: (
    project: string,
    name: string,
  ) =>
    | {
        readonly text: string;
        readonly provenance: ReadonlyArray<SealedOutputSpan>;
        readonly hasTemplate: boolean;
      }
    | undefined;
  /** Finished files whose draft the `read_sealed_draft` tool can give back. */
  readonly sealedDrafts: (project: string) => ReadonlyArray<string>;
  /** What the `read_sealed_draft` tool gives back: stand-ins and markers, never a value. */
  readonly sealedDraft: (project: string, name: string) => string | undefined;
  /** What the `ask_documents` tool answers. */
  readonly askDocuments: (input: PrivacyAskInput) => Promise<AskAnswer>;
  /** Evaluation only. See `workerFreeText`. */
  readonly askDocumentsFreeText: (input: PrivacyAskInput) => Promise<AskAnswer>;
  /** What the `fill_sealed` tool does: nothing of the finished file is returned. */
  readonly fillSealed: (
    project: string,
    name: string,
    template: string,
  ) => ReturnType<SealedWorker["fill"]>;
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
  /**
   * Receives everything sent to the worker and everything it wrote back, one JSON object per
   * line. Sealed documents are in it, unmasked.
   */
  readonly workerPath?: string | undefined;
  /** Receives every connection to a host that is not a model host, and whether it passed. */
  readonly otherHostsPath?: string | undefined;
  /** The worker's answers are not checked against the document, and not asked for again. */
  readonly workerUnchecked?: boolean | undefined;
  /** Agents get a tool that returns the worker's own words about each document, unchecked. */
  readonly workerFreeText?: boolean | undefined;
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
   * the environment they were started with, so the caller restarts those of the providers for
   * which `changed` is true, and leaves the turns of the others running.
   */
  readonly onRoutingChange?:
    | ((changed: (provider: string | undefined) => boolean) => void)
    | undefined;
  readonly fetch?: typeof fetch;
  /** Waits between tries of the detection service. Tests pass one that does not wait. */
  readonly sleep?: ((milliseconds: number) => Promise<void>) | undefined;
  /** The host's `process.platform`, for naming this computer to the person signing in. */
  readonly platform?: string;
  /** This app's version, recorded with an acceptance of the Terms. */
  readonly appVersion?: string | undefined;
  /** The folders agents work in. See `PrivacyGatewayConfig.workspaceRoots`. */
  readonly workspaceRoots?: (() => ReadonlyArray<string>) | undefined;
  /** The person's own proxy and certificates. See `PrivacyGatewayConfig.hostEnvironment`. */
  readonly hostEnvironment?: NodeJS.ProcessEnv | undefined;
  /** Where an AI company's host is reached. Tests point this at a local server. */
  readonly upstream?: GatewayOptions["upstream"];
  readonly evaluation?: PrivacyEvaluationOptions | undefined;
  /**
   * Told, once for each action, which files left a folder by being sealed or came back by being
   * unsealed, however that happened: one file, several, a folder, or a sweep of a sealed folder.
   * Awaited, so the host can remove the copies it keeps of a sealed file before anything goes on.
   */
  readonly onSealChange?: ((change: SealChange) => Promise<void>) | undefined;
  /**
   * Told whenever what a project's sealed listing shows has changed, however it happened: a file
   * sealed or put back, a folder's sweep, an answer given, a finished file written, limits reset.
   */
  readonly onSealedListingChange?: (() => void) | undefined;
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

const readRegion = (value: unknown): AccountRegion | null =>
  ACCOUNT_REGIONS.find((region) => region === value) ?? null;

/** The `worker` object DoeDesk Cloud sends with an account. Null when it is missing or malformed. */
const readHostedWorker = (value: unknown): HostedWorker | null => {
  const worker = asRecord(value);
  if (worker === undefined || typeof worker.available !== "boolean") return null;
  const structured = (["jsonSchema", "jsonObject", "none"] as const).find(
    (candidate) => candidate === worker.structured,
  );
  const whole = (candidate: unknown): number | null =>
    typeof candidate === "number" && Number.isFinite(candidate) && candidate >= 1
      ? Math.floor(candidate)
      : null;
  return {
    available: worker.available,
    model: asText(worker.model),
    structured: structured ?? null,
    parallel: whole(worker.parallel),
    maxWaitSeconds: whole(worker.maxWaitSeconds),
    ...(typeof worker.hostLabel === "string" ? { hostLabel: worker.hostLabel } : {}),
    ...(typeof worker.locationLabel === "string" ? { locationLabel: worker.locationLabel } : {}),
  };
};

/** DoeDesk Cloud's worker can be used: an account is signed in and DoeDesk Cloud includes it. */
const hostedIncluded = (config: StoredConfig): boolean =>
  config.mode === "cloud" && config.token !== undefined && config.hostedWorkerEntitled === true;

/**
 * Who reads sealed documents now. DoeDesk Cloud's worker needs a signed-in account that has it;
 * for any other it is never the default, and a stored choice of it reads as none, not as the
 * person's own server: sealed files go nowhere the person did not choose.
 */
const workerKindOf = (config: StoredConfig): WorkerKind => {
  const chosen = config.providers?.worker?.provider;
  if (chosen === "openaiCompatible") return "custom";
  if (chosen === "off") return "off";
  return hostedIncluded(config) ? "cloud" : "off";
};

/** The person's own server for sealed documents, when that is what reads them. */
const ownWorkerOf = (config: StoredConfig): StoredProviderChoice | undefined =>
  workerKindOf(config) === "custom" ? config.providers?.worker : undefined;

/** Which worker answers now, as the record of clear answers names it. Null: none. */
const workerRouteOf = (config: StoredConfig): string | null => {
  const kind = workerKindOf(config);
  if (kind === "cloud") return config.accountRegion ?? "cloud";
  const own = ownWorkerOf(config);
  if (own === undefined) return null;
  try {
    return `custom:${new URL(String(own.settings.baseUrl)).host}`;
  } catch {
    return "custom";
  }
};

/** Detection is a service of the person's own: it needs no account. */
const ownDetection = (config: StoredConfig): boolean =>
  config.providers?.detect !== undefined && config.providers.detect.provider !== DOEDESK_CLOUD;

const readConfig = (filePath: string): StoredConfig => {
  try {
    const parsed: unknown = JSON.parse(NodeFS.readFileSync(filePath, "utf8"));
    const stored = asRecord(parsed);
    if (
      stored !== undefined &&
      (stored.mode === "cloud" ||
        stored.mode === "selfHosted" ||
        stored.mode === "off" ||
        stored.mode === "unconfigured")
    ) {
      const { providers, rest } = migrateProviders(stored);
      return {
        ...(rest as unknown as StoredConfig),
        mode: stored.mode === "selfHosted" ? "unconfigured" : stored.mode,
        ...(Object.keys(providers).length === 0 ? {} : { providers }),
      };
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
  // Detection, reading, the worker and DoeDesk Cloud: through the person's proxy, as the gateway.
  const fetchImpl =
    options.fetch ?? fetchThrough(readHostNetwork(options.hostEnvironment ?? process.env));
  const configPath = NodePath.join(options.dataDirectory, "config.json");
  const cloudUrl = (
    options.cloudUrl ??
    (process.env.DOEDESK_CLOUD_URL?.trim() || DEFAULT_DOEDESK_CLOUD_URL)
  ).replace(/\/+$/, "");
  let config = readConfig(configPath);
  let problem: string | null = null;
  const activity: Array<GatewayRecord> = [];
  // Stand-ins and counts of recent turns, never a value. See turns.ts.
  const turns = new TurnLedger(NodePath.join(options.dataDirectory, "turns.json"));
  const proxyRefusal = new ProxyRefusal();
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

  const cloudToken = (current: StoredConfig): string | undefined =>
    current.mode === "cloud" ? current.token : undefined;
  /**
   * The choice for reading or detection as its adapter takes it, or undefined when it cannot be
   * used: DoeDesk Cloud's with nobody signed in. A stored choice was checked against the catalog
   * when it was stored, so it is one of the adapter's own shapes.
   */
  const choiceOf = <Config extends OcrProviderConfig | DetectProviderConfig>(
    current: StoredConfig,
    stored: StoredProviderChoice | undefined,
  ): Config | undefined => {
    if (stored !== undefined && stored.provider !== DOEDESK_CLOUD) {
      return stored as unknown as Config;
    }
    const token = cloudToken(current);
    return token === undefined
      ? undefined
      : ({
          provider: DOEDESK_CLOUD,
          settings: { endpoint: cloudUrl },
          secrets: { token },
        } as Config);
  };
  /** DoeDesk Cloud's answers are watched for the one that asks the account to accept the Terms. */
  const fetchFor = (provider: string): typeof fetch =>
    provider === DOEDESK_CLOUD ? cloudFetch : fetchImpl;

  const detectProviderOf = (choice: DetectProviderConfig, retry = true) =>
    makeDetectProvider(choice, { fetch: fetchFor(choice.provider), sleep: options.sleep, retry });
  const ocrProviderOf = (choice: OcrProviderConfig) =>
    makeOcrProvider(choice, { fetch: fetchFor(choice.provider), sleep: options.sleep, onRead });

  const detectorFor = (current: StoredConfig): Detector => {
    const choice =
      current.mode === "off"
        ? undefined
        : choiceOf<DetectProviderConfig>(current, current.providers?.detect);
    return choice === undefined
      ? { detect: () => Promise.reject(new DetectorUnavailableError(NOT_SET_UP)) }
      : detectProviderOf(choice);
  };

  const readerFor = (current: StoredConfig): Reader | undefined => {
    const choice =
      current.mode === "off"
        ? undefined
        : choiceOf<OcrProviderConfig>(current, current.providers?.ocr);
    return choice === undefined ? undefined : cacheReader(ocrProviderOf(choice));
  };

  /** The worker's choice as its adapter takes it: DoeDesk Cloud's, the person's own, or none. */
  const workerChoiceOf = (current: StoredConfig): WorkerProviderConfig => {
    const kind = workerKindOf(current);
    const hosted = current.hostedWorker;
    if (kind === "cloud") {
      // DoeDesk Cloud sends it on to the upstream for the account's region, which it alone knows.
      return {
        provider: DOEDESK_CLOUD,
        settings: {
          endpoint: cloudUrl,
          ...(hosted?.structured == null ? {} : { structured: hosted.structured }),
          ...(typeof hosted?.parallel === "number"
            ? { parallel: hosted.parallel, maxWaitSeconds: hosted.maxWaitSeconds ?? 0 }
            : {}),
        },
        secrets: { token: current.token ?? "" },
      };
    }
    const own = ownWorkerOf(current);
    return own === undefined
      ? { provider: "off", settings: {}, secrets: {} }
      : (own as unknown as WorkerProviderConfig);
  };
  const workerFor = (current: StoredConfig): WorkerProvider =>
    makeWorkerProvider(workerChoiceOf(current), { fetch: fetchImpl });

  let detector = detectorFor(config);
  let reader = readerFor(config);
  let workerProvider = workerFor(config);
  /** The worker's own `fetch`: it adds what an endpoint's address cannot carry. */
  const workerFetch: typeof fetch = (input, init) => workerProvider.fetch(input, init);
  // Redacted images and masked texts of recent attachments, for the user to download. A store
  // on disk that this feature adds: see redaction/store.ts for what it holds and for how long.
  const redactionStore = new RedactionStore(NodePath.join(options.dataDirectory, "redactions"));
  let fileLabels: FileLabels | undefined;
  const sealedStore = new SealedStore(NodePath.join(options.dataDirectory, "sealed"), () => {
    fileLabels?.changed();
    options.onSealedListingChange?.();
  });
  /** Every sealed file and folder with what a provider is told for it: see `FileLabels`. */
  const sealedFileLabels = (): ReadonlyArray<FileLabel> => [
    ...sealedStore.allDocuments().flatMap((document): ReadonlyArray<FileLabel> => {
      // Not checked yet, or the person's choice: the handle and the type stand for the name.
      if (document.neutralLabel === true || document.label === undefined) {
        const label = neutralLabel(document.handle, document.name);
        return [{ name: document.name, label, neutral: true }];
      }
      return [
        { name: document.name, label: document.label },
        ...(document.origin === undefined || document.originLabel === undefined
          ? []
          : [{ name: document.origin, label: document.originLabel }]),
      ];
    }),
    ...sealedStore
      .allFolders()
      .flatMap((folder) =>
        folder.pathLabel === undefined ? [] : [{ name: folder.path, label: folder.pathLabel }],
      ),
  ];
  const sealedCount = () => sealedStore.tripwire.size;
  // A sealed value is never restored in a tool call, so sealing leaves this rule as chosen.
  const egressPolicy = (): EgressPolicy => config.egress?.policy ?? "open";
  const hostsUntilClose = new Set<string>();
  const refusedHosts = new Map<string, string>();
  const MAX_REFUSED_HOSTS = 20;
  let redactor: ImageRedactor | undefined;
  let gateway: PrivacyGateway | undefined;
  // Built once the worker's settings can be read, further down.
  let secondPass: Detector | undefined;
  try {
    gateway = await startPrivacyGateway({
      dataDirectory: options.dataDirectory,
      workspaceRoots: options.workspaceRoots,
      hostEnvironment: options.hostEnvironment,
      upstream: options.upstream,
      webResults: () => (config.checkWebResults === true ? "detect" : "known"),
      secondPass: () => (config.secondPass === true ? secondPass : undefined),
      egress: () => ({
        policy: egressPolicy(),
        hosts: config.egress?.hosts ?? [],
        untilClose: [...hostsUntilClose],
      }),
      // Evaluation only: with the worker answering in free prose, its answers are let through
      // whole, so that what is measured is the prose and not this check on it.
      withholdSealedText: (text, typed) =>
        evaluation.workerFreeText === true
          ? undefined
          : typed
            ? sealedStore.tripwire.withoutPassages(text)
            : sealedStore.tripwire.flags(text)
              ? WITHHELD_SEALED_NOTE
              : undefined,
      onOtherHost: (host, port, outcome) => {
        const at = new Date().toISOString();
        if (outcome === "blocked") {
          refusedHosts.delete(host);
          refusedHosts.set(host, at);
          for (const oldest of [...refusedHosts.keys()].slice(0, -MAX_REFUSED_HOSTS)) {
            refusedHosts.delete(oldest);
          }
        }
        if (evaluation.otherHostsPath !== undefined) {
          appendLine(evaluation.otherHostsPath, { at, host, port, outcome });
        }
      },
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
      onRestored: ({ sessions, tokens }) => turns.restored(sessions, tokens),
      onRecord: (record) => {
        proxyRefusal.note(record, Date.now());
        activity.push(record);
        if (activity.length > MAX_ACTIVITY) activity.splice(0, activity.length - MAX_ACTIVITY);
        turns.add(record);
        const { replaced: _replaced, sessions: _sessions, ...logged } = record;
        logEvent({ type: "request", ...logged });
      },
    });
    fileLabels = gateway.vault.fileLabels;
    fileLabels.from(sealedFileLabels);
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
  const environmentOf = (
    current: StoredConfig,
    provider: string | undefined,
  ): Readonly<Record<string, string>> | undefined => {
    if (current.mode === "off") return undefined;
    if (provider !== undefined && current.directProviders?.includes(provider) === true) {
      return undefined;
    }
    return { ...gatewayEnvironment, ...sessionSwitches(current) };
  };
  const environmentFor = (provider: string | undefined) => environmentOf(config, provider);
  /** Everything `environmentFor` depends on, to tell when agents need a restart. */
  const routingKey = (current: StoredConfig): string =>
    JSON.stringify([
      current.mode === "off",
      [...(current.directProviders ?? [])].toSorted(),
      current.usageReports !== false,
    ]);

  /**
   * What stays when the account changes: answers, per-provider choices and the three services.
   * Nothing that belongs to the account stays: its identifier, its acceptance and its answers go
   * with it.
   */
  const keptAnswers = (): Partial<StoredConfig> => ({
    ...(config.profileAnswered === true ? { profileAnswered: true } : {}),
    ...(config.legal === undefined ? {} : { legal: config.legal }),
    ...(config.directProviders === undefined ? {} : { directProviders: config.directProviders }),
    ...(config.noticesRead === undefined ? {} : { noticesRead: config.noticesRead }),
    ...(config.usageReports === undefined ? {} : { usageReports: config.usageReports }),
    ...(config.imageHandling === undefined ? {} : { imageHandling: config.imageHandling }),
    ...(config.readingTool === undefined ? {} : { readingTool: config.readingTool }),
    ...(config.providers === undefined ? {} : { providers: config.providers }),
    ...(config.egress === undefined ? {} : { egress: config.egress }),
    ...(config.sealing === undefined ? {} : { sealing: config.sealing }),
    ...(config.secondPass === undefined ? {} : { secondPass: config.secondPass }),
    ...(config.checkWebResults === undefined ? {} : { checkWebResults: config.checkWebResults }),
  });

  // Set once the worker exists, further down.
  let onWorkerRouteChange: () => void = () => undefined;
  const apply = (next: StoredConfig) => {
    const before = config;
    const routingBefore = routingKey(config);
    const workerRouteBefore = workerRouteOf(config);
    config = next;
    detector = detectorFor(next);
    reader = readerFor(next);
    workerProvider = workerFor(next);
    NodeFS.mkdirSync(options.dataDirectory, { recursive: true, mode: 0o700 });
    NodeFS.writeFileSync(configPath, JSON.stringify(next), { mode: 0o600 });
    // The mode above is only given to a new file, and this one now holds the services' keys.
    NodeFS.chmodSync(configPath, 0o600);
    if (routingKey(next) !== routingBefore) {
      options.onRoutingChange?.(
        (provider) =>
          JSON.stringify(environmentOf(before, provider)) !==
          JSON.stringify(environmentOf(next, provider)),
      );
    }
    // Another worker answers from now on: what the last one answered and how it failed do not carry over.
    if (workerRouteOf(next) !== workerRouteBefore) onWorkerRouteChange();
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
      region: readRegion(account.region),
    };
  };
  /**
   * The account's region, whether the hosted worker is included and the worker there, as an
   * answer of DoeDesk Cloud's states them. An answer that does not say it is included (an older
   * DoeDesk Cloud, or one without the worker) means it is not.
   */
  const hostedOf = (region: AccountRegion | null, worker: unknown): Partial<StoredConfig> => {
    const entitled = asRecord(worker)?.entitled === true;
    const hostedWorker = entitled ? readHostedWorker(worker) : null;
    return {
      ...(region === null ? {} : { accountRegion: region }),
      hostedWorkerEntitled: entitled,
      ...(hostedWorker === null ? {} : { hostedWorker }),
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
      ...hostedOf(account.region, body.worker),
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
    const { profile: _profile, hostedWorker: _hostedWorker, ...rest } = config;
    apply({
      ...rest,
      ...(label === undefined ? {} : { accountLabel: label }),
      ...(account.id === null ? {} : { accountId: account.id }),
      ...hostedOf(account.region, answer.body.worker),
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
      case "setRegion": {
        const answer = await cloud("/v1/me/region", { region: input.region }, token);
        if (!answer.ok) return refusal(answer);
        // Sealed files stay as they are. `apply` forgets what the last region's worker answered.
        if (config.token === token) {
          const { hostedWorker: _hostedWorker, ...rest } = config;
          apply({
            ...rest,
            ...hostedOf(readRegion(answer.body.region) ?? input.region, answer.body.worker),
          });
        }
        return accountDone;
      }
    }
  };

  /** Changes one service's choice and leaves the other two as they are. */
  const withProvider = (service: ServiceKind, choice: StoredProviderChoice): StoredConfig => ({
    ...config,
    providers: { ...config.providers, [service]: choice },
  });

  /**
   * One's own service that speaks DoeDesk's contract, for detection and for reading at once, in
   * place of an account: what the welcome page and the Terms sheet offer. It signs the account
   * out, which is the way out of a sheet that waits for the Terms. `configureProvider` changes one
   * service and keeps the account.
   */
  const connectSelfHosted = async (
    input: Extract<PrivacyConfigureInput, { mode: "selfHosted" }>,
  ): Promise<PrivacyConfigureOutcome> => {
    let endpoint: URL;
    try {
      endpoint = new URL(input.endpoint.trim());
    } catch {
      return {
        ok: false,
        message: "Enter the service address as a full URL, such as http://localhost:8080.",
        problem: { kind: "address" },
      };
    }
    const own: StoredProviderChoice = {
      provider: "custom",
      settings: { endpoint: endpoint.toString().replace(/\/+$/, "") },
      secrets: input.token ? { token: input.token } : {},
    };
    try {
      await detectProviderOf(own as unknown as DetectProviderConfig, false).detect([
        "Connection test.",
      ]);
    } catch (cause) {
      return {
        ok: false,
        message: cause instanceof Error ? cause.message : "The detection service did not answer.",
        ...(cause instanceof DetectorUnavailableError && cause.problem !== undefined
          ? { problem: cause.problem }
          : {}),
      };
    }
    await signOut();
    const kept = keptAnswers();
    apply({
      mode: "unconfigured",
      ...kept,
      providers: { ...kept.providers, detect: own, ocr: own },
    });
    return { ok: true, message: null };
  };

  const signedIn = () => config.mode === "cloud";

  /** The worker to call now: DoeDesk Cloud's, the person's own server, or none. */
  const workerEndpoint = (): WorkerEndpoint | undefined => workerProvider.endpoint;
  secondPass = makeSecondPassDetector({
    endpoint: () => workerEndpoint(),
    cachePath: NodePath.join(options.dataDirectory, "second-pass-cache.json"),
    fetch: workerFetch,
    onCall: (call) => logEvent({ type: "second_pass", ...call }),
  });
  const sealPolicy = (): SealPolicy => ({ ...DEFAULT_SEAL_POLICY, ...config.sealing });
  let servedFrom: string | null = null;
  /**
   * DoeDesk Cloud described the account's region as one with no worker: not available, and no
   * model named. A region whose worker is only not answering still names its model.
   */
  const regionHasNoWorker = (): boolean =>
    hostedIncluded(config) &&
    config.hostedWorker?.available === false &&
    config.hostedWorker.model === null;
  const hostedNotInRegion = (): boolean => workerKindOf(config) === "cloud" && regionHasNoWorker();
  let regionAskedAt = 0;
  const sealedWorker = makeSealedWorker({
    store: sealedStore,
    vault: () => (config.mode === "off" ? undefined : gateway?.vault),
    endpoint: () => workerEndpoint(),
    route: () => workerRouteOf(config),
    // DoeDesk Cloud can change a region's model without the region changing.
    model: () => (workerKindOf(config) === "cloud" ? (config.hostedWorker?.model ?? null) : null),
    policy: sealPolicy,
    fetch: workerFetch,
    readLater: (project, handle) => readSealed(project, handle).then(() => undefined),
    // Nothing is sent for a region with no worker. DoeDesk Cloud may have begun to offer one since
    // the account was last read, so it is read again first, once a minute at most.
    notInRegion: async () => {
      if (!hostedNotInRegion()) return false;
      if (Date.now() - regionAskedAt > 60_000) {
        regionAskedAt = Date.now();
        await refreshAccount();
      }
      return hostedNotInRegion();
    },
    // DoeDesk Cloud said so before the account was read again: from now on nothing is sent to it.
    onNotIncluded: () => {
      if (workerKindOf(config) !== "cloud") return;
      const { hostedWorker: _hostedWorker, ...rest } = config;
      apply({ ...rest, hostedWorkerEntitled: false });
    },
    onCall: (record) => {
      servedFrom = record.jobs.find((job) => job.servedFrom !== null)?.servedFrom ?? servedFrom;
      logEvent({ type: "worker", ...record });
    },
    ...(evaluation.workerPath === undefined
      ? {}
      : {
          onExchange: (exchange) =>
            appendLine(evaluation.workerPath ?? "", { at: new Date().toISOString(), ...exchange }),
        }),
    ...(evaluation.workerUnchecked === true ? { checks: { evidence: false } } : {}),
  });
  onWorkerRouteChange = () => {
    sealedWorker.reset();
    servedFrom = null;
  };

  /** Why DoeDesk Cloud's worker cannot be chosen now, or null when it can. */
  const hostedWorkerRefusal = (): string | null =>
    !signedIn()
      ? "Sign in to DoeDesk Cloud first to use its worker."
      : hostedIncluded(config)
        ? null
        : HOSTED_WORKER_NOT_INCLUDED;

  /**
   * Asks the person's own server one question that holds nothing confidential, and gives the
   * choice to store: with how the server takes JSON, and the reasoning setting it accepted.
   */
  const probedWorker = async (
    choice: StoredProviderChoice,
  ): Promise<{ readonly health: WorkerHealthResult; readonly choice: StoredProviderChoice }> => {
    const { structured: _structured, ...unprobed } = choice.settings;
    const health = await makeWorkerProvider(
      { ...choice, settings: unprobed } as unknown as WorkerProviderConfig,
      { fetch: fetchImpl },
    ).testConnection();
    if (!health.ok) return { health, choice };
    // The server refused the reasoning setting typed and took another: that one is kept.
    const { reasoningEffort: _refused, ...withoutEffort } = unprobed;
    const taken =
      health.reasoningEffort === undefined
        ? unprobed
        : health.reasoningEffort === null
          ? withoutEffort
          : { ...withoutEffort, reasoningEffort: health.reasoningEffort };
    return {
      health,
      choice: {
        ...choice,
        settings: {
          ...taken,
          ...(health.structured === undefined ? {} : { structured: health.structured }),
        },
      },
    };
  };

  const configureWorker = async (
    input: PrivacyWorkerInput,
  ): Promise<{ readonly ok: boolean; readonly message: string | null }> => {
    if (input.kind === "off" || input.kind === "cloud") {
      const refusal = input.kind === "cloud" ? hostedWorkerRefusal() : null;
      if (refusal !== null) return { ok: false, message: refusal };
      apply(withProvider("worker", plainChoice(input.kind === "cloud" ? DOEDESK_CLOUD : "off")));
      return { ok: true, message: null };
    }
    let address: URL;
    try {
      address = new URL(input.baseUrl.trim());
    } catch {
      return {
        ok: false,
        message: "Enter the worker address as a full URL, such as http://localhost:11434/v1.",
      };
    }
    if (input.model.trim().length === 0) return { ok: false, message: "Enter the model's name." };
    // This form has no fields for these, so what was stored for the same server stays.
    const stored = ownWorkerOf(config);
    const { authScheme, apiVersion } = stored?.settings ?? {};
    const probed = await probedWorker({
      provider: "openaiCompatible",
      settings: {
        baseUrl: address.toString().replace(/\/+$/, ""),
        model: input.model.trim(),
        driver: input.driver,
        ...(input.reasoningEffort?.trim() ? { reasoningEffort: input.reasoningEffort.trim() } : {}),
        ...(authScheme === undefined ? {} : { authScheme }),
        ...(apiVersion === undefined ? {} : { apiVersion }),
      },
      secrets: {
        ...(input.apiKey?.trim() ? { apiKey: input.apiKey.trim() } : {}),
        ...(stored?.secrets.headers === undefined ? {} : { headers: stored.secrets.headers }),
      },
    });
    if (!probed.health.ok) return { ok: false, message: probed.health.message };
    apply(withProvider("worker", probed.choice));
    return { ok: true, message: null };
  };

  /**
   * DoeDesk Cloud's worker was the one in use and the account does not have it: the person chose
   * it, or sealed files while it was the default and connected no server since.
   */
  const hostedNotIncluded = (): boolean =>
    signedIn() &&
    !hostedIncluded(config) &&
    (config.providers?.worker?.provider === DOEDESK_CLOUD ||
      (config.providers?.worker === undefined && sealedCount() > 0));

  const workerStatus = (): PrivacyWorkerStatus => {
    const endpoint = workerEndpoint();
    const hosted = workerKindOf(config) === "cloud";
    return {
      kind: workerKindOf(config),
      address: endpoint?.baseUrl ?? null,
      // The hosted worker's model is DoeDesk Cloud's to choose, and to name.
      model: hosted ? (config.hostedWorker?.model ?? null) : (endpoint?.model ?? null),
      driver: endpoint?.driver ?? null,
      reasoningEffort: endpoint?.reasoningEffort ?? null,
      available: sealedWorker.available() && !(hosted && config.hostedWorker?.available === false),
      servedFrom,
      region: hosted ? (config.accountRegion ?? null) : null,
      busy: sealedWorker.busy(),
      notIncluded: hostedNotIncluded(),
    };
  };

  /** What is told for a service: the stored choice, or the one that is used when none is. */
  const chosenProvider = (service: ServiceKind): StoredProviderChoice => {
    const stored = config.providers?.[service];
    if (service !== "worker") return stored ?? plainChoice(DOEDESK_CLOUD);
    const kind = workerKindOf(config);
    // A stored choice of DoeDesk Cloud's worker stays the choice while the account lacks it.
    if (stored !== undefined && kind !== "custom") return plainChoice(stored.provider);
    return stored ?? plainChoice(kind === "cloud" ? DOEDESK_CLOUD : "off");
  };
  /** Whether a service's choice can be used now. DoeDesk Cloud's needs an account that has it. */
  const providerReady = (service: ServiceKind): boolean => {
    if (chosenProvider(service).provider !== DOEDESK_CLOUD) return true;
    return service === "worker" ? hostedIncluded(config) : cloudToken(config) !== undefined;
  };
  const providerState = (service: ServiceKind): PrivacyProviderState => ({
    provider: chosenProvider(service).provider,
    ready: providerReady(service),
  });
  const providerDetail = (service: ServiceKind): PrivacyProviderDetail => ({
    config: publicChoice(service, chosenProvider(service)),
    catalog: providerCatalog(service),
  });
  const modeOf = (current: StoredConfig): PrivacyMode =>
    current.mode === "unconfigured" && ownDetection(current) ? "selfHosted" : current.mode;
  /** Where the person's own detection service is, when it has an address of its own. */
  const ownDetectionAddress = (): string | null => {
    const settings = config.providers?.detect?.settings ?? {};
    const address = settings.endpoint ?? settings.baseUrl;
    return typeof address === "string" ? address : null;
  };

  const NOT_SIGNED_IN_HEALTH: ProviderHealthResult = {
    ok: false,
    kind: "auth",
    message: "Sign in to DoeDesk Cloud to use it.",
    latencyMs: 0,
  };
  /**
   * Asks a choice's service one small thing and says how it went. Nothing is stored. For the
   * person's own worker the choice comes back as it is to be stored.
   */
  const checkProvider = async (
    service: ServiceKind,
    choice: StoredProviderChoice,
  ): Promise<{ readonly health: ProviderHealthResult; readonly choice: StoredProviderChoice }> => {
    if (service === "worker") {
      if (choice.provider === "openaiCompatible") return probedWorker(choice);
      const refusal = choice.provider === DOEDESK_CLOUD ? hostedWorkerRefusal() : null;
      if (refusal !== null) {
        const kind = signedIn() ? "refused" : "auth";
        return { health: { ...NOT_SIGNED_IN_HEALTH, kind, message: refusal }, choice };
      }
      const provider =
        choice.provider === DOEDESK_CLOUD
          ? workerFor({ ...config, providers: { ...config.providers, worker: choice } })
          : makeWorkerProvider({ provider: "off", settings: {}, secrets: {} });
      return { health: await provider.testConnection(), choice };
    }
    const stored = choice.provider === DOEDESK_CLOUD ? undefined : choice;
    if (service === "detect") {
      const taken = choiceOf<DetectProviderConfig>(config, stored);
      if (taken === undefined) return { health: NOT_SIGNED_IN_HEALTH, choice };
      return { health: await detectProviderOf(taken, false).testConnection(), choice };
    }
    const taken = choiceOf<OcrProviderConfig>(config, stored);
    if (taken === undefined) return { health: NOT_SIGNED_IN_HEALTH, choice };
    return { health: await ocrProviderOf(taken).testConnection(), choice };
  };

  const misconfigured = (message: string): ProviderHealthResult => ({
    ok: false,
    kind: "misconfigured",
    message,
    latencyMs: 0,
  });
  const testProvider: PrivacyController["testProvider"] = async (input) => {
    const merged = mergeChoice(input.service, input, config.providers?.[input.service]);
    if (!merged.ok) return misconfigured(merged.message);
    return (await checkProvider(input.service, merged.choice)).health;
  };
  const configureProvider: PrivacyController["configureProvider"] = async (input) => {
    const { service } = input;
    const merged = mergeChoice(service, input, config.providers?.[service]);
    if (!merged.ok) return { ok: false, message: merged.message };
    let { choice } = merged;
    if (service === "worker" && choice.provider === DOEDESK_CLOUD) {
      const refusal = hostedWorkerRefusal();
      if (refusal !== null) return { ok: false, message: refusal };
    }
    // A service with something to fill in is asked once before it is used: detection that does
    // not answer refuses every request to a model.
    const filledIn = providerCatalog(service).some(
      (entry) => entry.id === choice.provider && entry.fields.length > 0,
    );
    if (filledIn) {
      const checked = await checkProvider(service, choice);
      if (!checked.health.ok) {
        return { ok: false, message: checked.health.message, health: checked.health };
      }
      choice = checked.choice;
      apply(withProvider(service, choice));
      return { ok: true, message: null, health: checked.health };
    }
    apply(withProvider(service, choice));
    return { ok: true, message: null };
  };

  const documentText: PrivacyController["documentText"] = async (name, bytes) => {
    if (bytes.length === 0 || bytes.length > MAX_SEALED_BYTES) {
      return {
        ok: false,
        kind: bytes.length === 0 ? "noText" : "tooLarge",
        message: "The file is empty or larger than 20 MB.",
      };
    }
    let text = localText(bytes, name);
    const mediaType = READER_MEDIA_TYPES[NodePath.extname(name).toLowerCase()];
    if (text === undefined && mediaType !== undefined) {
      // A PDF or an image has to be read first, and only the reading service can do that.
      if (reader === undefined) {
        return {
          ok: false,
          kind: "service",
          message:
            "A PDF or an image has to be read first, and no reading service is connected. Use a text or Word file, or connect a reading service.",
        };
      }
      try {
        text = await reader.read(bytes, mediaType);
      } catch (cause) {
        return {
          ok: false,
          kind: "service",
          message: `The file could not be read (${cause instanceof Error ? cause.message : "unknown reason"}).`,
        };
      }
    }
    if (text === undefined) {
      return {
        ok: false,
        kind: "unsupported",
        message:
          "This kind of file cannot be read by the worker yet. Text, Markdown, CSV, JSON, HTML, Word, PDF and images can.",
      };
    }
    if (text.trim().length === 0) {
      return { ok: false, kind: "noText", message: "No text was found in the file." };
    }
    if (text.length > MAX_SEALED_CHARACTERS) {
      return {
        ok: false,
        kind: "tooLarge",
        message: "The file is too long for the worker to read in one piece. Split it into parts.",
      };
    }
    return { ok: true, text, mediaType: mediaType ?? "text/plain" };
  };

  /** Names as a provider may be told them, or undefined when they cannot be checked now. */
  const checkedLabels = async (
    names: ReadonlyArray<string>,
    /** For each name, the record numbers its file's own text holds. */
    ownRecords: ReadonlyArray<ReadonlyArray<string>> = [],
  ): Promise<ReadonlyArray<string> | undefined> => {
    if (names.length === 0) return [];
    const pseudonymizer = gateway?.pseudonymizer;
    if (pseudonymizer === undefined) return undefined;
    try {
      return await maskedLabels(pseudonymizer, names, ownRecords);
    } catch {
      return undefined;
    }
  };
  /**
   * Checks the names of a project's sealed files that have no label yet, and with `folders` the
   * paths of its sealed folders. Until a name is checked, its handle and type are sent.
   */
  const labelPending = async (project: string, folders: boolean): Promise<void> => {
    const documents = sealedStore
      .list(project)
      .filter((document) => document.neutralLabel !== true && document.label === undefined);
    const unchecked = folders
      ? sealedFolders.list(project).filter((folder) => folder.pathLabel === undefined)
      : [];
    if (documents.length === 0 && unchecked.length === 0) return;
    const records = documents.map((document) =>
      recordNumbersIn(sealedStore.read(project, document.handle) ?? ""),
    );
    const labels = await checkedLabels(
      [
        ...documents.map((document) => document.name),
        ...documents.map((document) => document.origin ?? document.name),
        ...unchecked.map((folder) => folder.path),
      ],
      [...records, ...records],
    );
    if (labels === undefined) return;
    sealedStore.setLabels(
      project,
      documents.map((document, index) => ({
        handle: document.handle,
        label: labels[index] ?? neutralLabel(document.handle, document.name),
        ...(document.origin === undefined
          ? {}
          : { originLabel: labels[documents.length + index] ?? "" }),
      })),
    );
    for (const [index, folder] of unchecked.entries()) {
      const pathLabel = labels[2 * documents.length + index];
      if (pathLabel !== undefined) {
        await sealedFolders.setPathLabel(project, folder.path, pathLabel);
      }
    }
  };
  /** After a file was sealed: records the person's choice, or checks its name. */
  const labelled = async (
    project: string,
    result: SealFileResult,
    neutral: boolean,
  ): Promise<SealFileResult> => {
    if (!result.ok) return result;
    if (neutral) sealedStore.setNeutralLabel(project, result.document.handle, true);
    // Folders are left to the next turn's check: this runs inside a sweep, which saves them.
    else await labelPending(project, false);
    return result;
  };
  const sealDocument: PrivacyController["sealDocument"] = async (
    project,
    name,
    bytes,
    origin,
    label,
  ) => {
    const read = await documentText(name, bytes);
    // A copy with nothing to ask about protects nothing: the file it was made from is elsewhere.
    if (!read.ok) return { ok: false, message: read.message };
    const original = origin === undefined ? undefined : { bytes, path: origin };
    return labelled(
      project,
      { ok: true, document: sealedStore.add(project, name, read.text, read.mediaType, original) },
      label?.neutralLabel === true,
    );
  };
  const sealFileAt = (project: string, filePath: string, replaceSamePath = false) =>
    sealFile(sealedStore, documentText, project, filePath, {
      maxReadBytes: MAX_SEALED_BYTES,
      replaceSamePath,
    });
  const readSealed: PrivacyController["readSealed"] = async (project, handle) => {
    const info = sealedStore.list(project).find((document) => document.handle === handle);
    if (info === undefined) return { ok: false, message: "No sealed document has that handle." };
    if (info.unread === undefined) return { ok: true, message: null };
    // A file kept for being too large was never held in memory, and is not read into it now.
    const kept = sealedStore.originalWithin(project, handle, MAX_SEALED_BYTES);
    if (kept === undefined) return { ok: false, message: info.unread.message };
    const read = await documentText(info.name, kept);
    if (!read.ok) {
      sealedStore.setUnread(project, handle, { kind: read.kind, message: read.message });
      return { ok: false, message: read.message };
    }
    sealedStore.setText(project, handle, read.text, read.mediaType);
    return { ok: true, message: null };
  };
  const readFirst = (name: string) =>
    !readLocally(name) && READER_MEDIA_TYPES[NodePath.extname(name).toLowerCase()] !== undefined;
  /** Puts a sealed file back, and remembers that an agent can open it again from now on. */
  const putBack = async (project: string, handle: string): Promise<UnsealFileResult> => {
    const result = await unsealFile(sealedStore, project, handle);
    if (result.ok && result.path !== null) sealedStore.notePutBack(project, [result.path]);
    return result;
  };
  const comparable = comparablePath(options.platform);
  const sealedFolders: SealedFolders = makeSealedFolders({
    store: sealedStore,
    // A document saved again into a sealed folder is one sealed file, on the handle it had. Its
    // label follows the choice made for the folder.
    sealFile: (project, filePath) =>
      sealFileAt(project, filePath, true).then((result) =>
        labelled(
          project,
          result,
          sealedFolders
            .list(project)
            .some(
              (folder) =>
                folder.neutralLabels === true && folder.path === sealedFolders.containing(filePath),
            ),
        ),
      ),
    unsealFile: (project, handle) => putBack(project, handle),
    canRead: (name) => readLocally(name) || (reader !== undefined && readFirst(name)),
    readFirst,
    platform: options.platform,
    onSealChange: options.onSealChange,
  });
  const sealChanged = (change: SealChange): Promise<void> =>
    change.paths.length === 0
      ? Promise.resolve()
      : (options.onSealChange?.(change).catch(() => undefined) ?? Promise.resolve());

  const sealFileInPlace: PrivacyController["sealFile"] = async (project, filePath, label) => {
    const result = await labelled(
      project,
      await sealFileAt(project, filePath),
      label?.neutralLabel === true,
    );
    if (result.ok) await sealChanged({ kind: "sealed", paths: [filePath] });
    return result;
  };
  /** A file's name is the same on this computer when its path would be. */
  const sameFileName = (left: string, right: string): boolean =>
    comparable(NodePath.join(NodePath.sep, left)) ===
    comparable(NodePath.join(NodePath.sep, right));

  return {
    documentText,
    configureWorker,
    providers: () => ({
      ocr: providerDetail("ocr"),
      detect: providerDetail("detect"),
      worker: providerDetail("worker"),
    }),
    configureProvider,
    testProvider,
    // Where DoeDesk Cloud's worker is included it is there without a choice, so its tools wait for
    // something to be sealed or for the person to choose it. A worker the person connected is
    // offered at once.
    workerOffered: () =>
      gateway !== undefined &&
      config.mode !== "off" &&
      sealedWorker.connected() &&
      (config.providers?.worker !== undefined || sealedCount() > 0),
    workerFreeText: () => evaluation.workerFreeText === true,
    sealDocument,
    sealedListing: (project) => {
      const ledger = sealedStore.ledger(project);
      return {
        documents: sealedStore
          .list(project)
          .map((document) =>
            document.neutralLabel !== true && document.label !== undefined
              ? document
              : { ...document, label: neutralLabel(document.handle, document.name) },
          ),
        outputs: sealedStore.outputs(project),
        folders: sealedFolders.list(project),
        clear: {
          mostOnOneDocument: Math.max(0, ...Object.values(ledger.clearAnswers)),
          perDocument: sealPolicy().clearAnswersPerDocument,
        },
      };
    },
    sealFile: sealFileInPlace,
    attachedFileInFolder: (root, name, sha256, size) =>
      findFolderCopies(root, { name, sha256, size }, sameFileName),
    sealAttached: async (project, root, name, bytes, label) => {
      const copies =
        root === null
          ? { readable: [], complete: true }
          : await findFolderCopies(
              root,
              {
                name,
                sha256: NodeCrypto.createHash("sha256").update(bytes).digest("hex"),
                size: bytes.length,
              },
              sameFileName,
            );
      if (copies.original !== undefined) {
        const result = await sealFileInPlace(project, copies.original, label);
        return result.ok
          ? { ...result, original: copies.original, readable: [], complete: true }
          : result;
      }
      const result = await sealDocument(project, name, bytes, undefined, label);
      return result.ok
        ? { ...result, readable: copies.readable, complete: copies.complete }
        : result;
    },
    sealLabels: async (names) => (await checkedLabels(names)) ?? names.map(() => null),
    setSealedLabel: async (project, handle, neutral) => {
      if (!sealedStore.setNeutralLabel(project, handle, neutral)) return false;
      if (!neutral) await labelPending(project, false);
      return true;
    },
    sealedForAgents: (project, cwd) => {
      const slashes = (value: string) => value.replaceAll("\\", "/");
      const root = cwd === null ? null : `${slashes(cwd).replace(/\/+$/, "")}/`;
      // As many of the label's last parts as the real path has below the working folder.
      const fromCwd = (real: string, label: string): string => {
        const path = slashes(real);
        if (root === null || !path.startsWith(root)) return slashes(label);
        const depth = path.slice(root.length).split("/").length;
        return slashes(label).split("/").slice(-depth).join("/");
      };
      const folders = sealedFolders
        .list(project)
        .flatMap((folder) =>
          folder.pathLabel === undefined
            ? []
            : [{ path: folder.path, told: fromCwd(folder.path, folder.pathLabel) }],
        );
      return {
        folders: folders.map((folder) => folder.told),
        files: sealedStore.list(project).map((document) => {
          const unread = document.unread !== undefined;
          if (document.neutralLabel !== true && document.label !== undefined) {
            return {
              handle: document.handle,
              name: document.label,
              ...(document.origin === undefined || document.originLabel === undefined
                ? {}
                : { path: fromCwd(document.origin, document.originLabel) }),
              unread,
            };
          }
          const name = neutralLabel(document.handle, document.name);
          // Its sealed folder is told anyway; where in it the file lay is not.
          const around =
            document.origin === undefined ? undefined : sealedFolders.containing(document.origin);
          const within = folders.find((folder) => folder.path === around);
          return {
            handle: document.handle,
            name,
            ...(within === undefined ? {} : { path: `${within.told}/${name}` }),
            unread,
          };
        }),
      };
    },
    readSealed,
    sealFiles: async (project, filePaths, label) => {
      const sealed: Array<string> = [];
      let unread = 0;
      const failed: Array<{ name: string; message: string }> = [];
      for (const filePath of filePaths) {
        const result = await labelled(
          project,
          await sealFileAt(project, filePath),
          label?.neutralLabel === true,
        );
        if (!result.ok) {
          failed.push({ name: NodePath.basename(filePath), message: result.message });
          continue;
        }
        sealed.push(filePath);
        if (result.document.unread !== undefined) unread += 1;
      }
      await sealChanged({ kind: "sealed", paths: sealed });
      return { sealed: sealed.length, unread, failed };
    },
    unsealFile: async (project, handle) => {
      const origin = sealedStore.list(project).find((info) => info.handle === handle)?.origin;
      const folder = origin === undefined ? undefined : sealedFolders.containing(origin);
      // Put back alone, the file would be sealed again by the folder's next sweep.
      if (folder !== undefined) {
        return {
          ok: false,
          message: `This file is in ${NodePath.basename(folder)}, a sealed folder. Unseal the folder to put its files back.`,
        };
      }
      const result = await putBack(project, handle);
      if (result.ok && result.path !== null) {
        await sealChanged({ kind: "unsealed", paths: [result.path] });
      }
      return result;
    },
    openedToTurns: (project, target) => {
      const opened = sealedStore.openedToTurns(project).map(comparable);
      if ("files" in target) {
        const files = new Set(target.files.map(comparable));
        return opened.some((path) => files.has(path));
      }
      const folder = `${comparable(target.folder)}${NodePath.sep}`;
      return opened.some((path) => path.startsWith(folder));
    },
    inspectSealTargets: (target) =>
      "folder" in target
        ? sealedFolders.inspectFolder(target.folder)
        : sealedFolders.inspectFiles(target.files),
    sealFolder: async (project, root, folder, sealOptions) => {
      const result = await sealedFolders.seal(project, root, folder, sealOptions);
      if (result.ok) await labelPending(project, true);
      return result;
    },
    unsealFolder: sealedFolders.unseal,
    sealedFoldersBeforeTurn: async (project, signal) => {
      sealedStore.noteTurn(project);
      const gate = await sealedFolders.beforeTurn(project, signal);
      // A name that could not be checked when its file was sealed is checked before the turn.
      await labelPending(project, true);
      return gate;
    },
    sweepSealedFoldersSoon: sealedFolders.sweepSoon,
    sealedFolderContaining: sealedFolders.containing,
    sealedFolderPaths: sealedFolders.paths,
    resetSealedLimits: (project) => sealedStore.resetLedger(project),
    sealedClearAnswers: (project) => sealedStore.clearAnswers(project),
    sealedOutputDetail: (project, name) => {
      const text = sealedStore.readOutput(project, name);
      if (text === undefined) return undefined;
      return {
        text,
        provenance: sealedStore.readOutputProvenance(project, name),
        hasTemplate: sealedStore.readOutputTemplate(project, name) !== undefined,
      };
    },
    sealedDrafts: (project) => sealedWorker.drafts(project),
    sealedDraft: (project, name) => sealedWorker.draft(project, name),
    askDocuments: (input) => sealedWorker.ask(input),
    askDocumentsFreeText: (input) => sealedWorker.askFreeText(input),
    fillSealed: (project, name, template) => sealedWorker.fill(project, name, template),
    status: () => ({
      mode: modeOf(config),
      providers: {
        ocr: providerState("ocr"),
        detect: providerState("detect"),
        worker: providerState("worker"),
      },
      worker: workerStatus(),
      egress: {
        policy: egressPolicy(),
        hosts: config.egress?.hosts ?? [],
        refused: [...refusedHosts].map(([host, at]) => ({ host, at })).toReversed(),
      },
      sealedDocuments: sealedCount(),
      sealingBeforeTurn: sealedFolders.holds(),
      secondPass: config.secondPass === true,
      webResultsChecked: config.checkWebResults === true,
      active: gateway !== undefined && config.mode !== "off",
      accountLabel: signedIn() ? (config.accountLabel ?? null) : null,
      endpoint: modeOf(config) === "selfHosted" ? ownDetectionAddress() : null,
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
      accountRegion: signedIn() ? (config.accountRegion ?? null) : null,
      hostedWorkerEntitled: hostedIncluded(config),
      hostedWorkerOffered: !regionHasNoWorker(),
      hostedWorker:
        hostedIncluded(config) &&
        config.hostedWorker?.hostLabel !== undefined &&
        config.hostedWorker.locationLabel !== undefined
          ? { host: config.hostedWorker.hostLabel, location: config.hostedWorker.locationLabel }
          : null,
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
        case "secondPass":
          apply({ ...config, secondPass: input.on });
          return;
        case "webResults":
          apply({ ...config, checkWebResults: input.check });
          return;
        case "egress":
          // A new rule is a new question: what the old one refused says nothing about it.
          refusedHosts.clear();
          apply({
            ...config,
            egress: {
              policy: input.policy,
              hosts: [...new Set(input.hosts.map((host) => host.trim().toLowerCase()))].filter(
                (host) => /^[a-z0-9.-]+$/.test(host),
              ),
            },
          });
          return;
        case "allowHost": {
          const host = input.host.trim().toLowerCase();
          if (!/^[a-z0-9.-]+$/.test(host)) return;
          refusedHosts.delete(host);
          // "AI hosts only" has no list to add to, so one click never loosens it for good.
          if (!input.lasting || egressPolicy() !== "allowlist") {
            hostsUntilClose.add(host);
            return;
          }
          const hosts = config.egress?.hosts ?? [];
          if (!hosts.includes(host)) {
            apply({ ...config, egress: { policy: "allowlist", hosts: [...hosts, host] } });
          }
          return;
        }
      }
    },
    configure: async (input) => {
      switch (input.mode) {
        case "selfHosted":
          return connectSelfHosted(input);
        case "off":
          await signOut();
          apply({ mode: "off", ...keptAnswers() });
          return { ok: true, message: null };
        case "unconfigured": {
          const kept = keptAnswers();
          // Signing out, or turning masking on again: the three services stay as chosen.
          if (config.mode !== "unconfigured") {
            await signOut();
            apply({ mode: "unconfigured", ...kept });
            return { ok: true, message: null };
          }
          // Nobody is signed in: this disconnects the person's own detection and reading.
          const { ocr: _ocr, detect: _detect, ...others } = kept.providers ?? {};
          apply({ mode: "unconfigured", ...kept, providers: others });
          return { ok: true, message: null };
        }
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
    refusingNow: () => proxyRefusal.reason(Date.now()),
    takeTurn: (id, sessions) => {
      const tally = turns.take(sessions);
      if (tally !== undefined) turns.keep(id, tally.replaced);
      return tally;
    },
    turnValues: (id) => {
      const vault = gateway?.vault;
      return turns.kept(id)?.map((token) => ({
        token,
        kind: kindOfStandIn(token),
        value: vault?.resolve(token) ?? null,
        sealed: vault?.isSealed(token) === true,
      }));
    },
    takeSealedTurn: (id, thread) => takeSealedTurn(sealedStore, thread, id),
    sealedTurn: (id) => sealedTurn(sealedStore, id),
    knownValues: (runIds) => {
      const vault = gateway?.vault;
      if (vault === undefined || modeOf(config) === "off" || modeOf(config) === "unconfigured") {
        return { values: [], turns: [] };
      }
      const kept = (runIds ?? []).flatMap((runId) => {
        const tokens = turns.kept(runId);
        return tokens === undefined ? [] : [{ runId, tokens }];
      });
      const written = new Set(kept.flatMap((turn) => turn.tokens));
      const values = vault
        .entries()
        .filter((entry) => entry.surfaces.length > 0)
        // A sealed value is replaced in what the person types, never in a file a tool reads.
        .filter((entry) =>
          runIds === undefined ? entry.sealed !== true : written.has(entry.token),
        )
        .map((entry) => ({
          token: entry.token,
          surfaces: entry.surfaces,
          sealed: entry.sealed === true,
        }));
      return { values, turns: kept };
    },
    readMasked: async (bytes, mediaType) => {
      if (
        modeOf(config) === "off" ||
        modeOf(config) === "unconfigured" ||
        maskingGateway === undefined
      ) {
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
        removable: entry.sealed !== true,
      })),
    unmaskedValues: () =>
      (gateway?.vault.released() ?? []).map((entry) => ({
        token: entry.token,
        kind: entry.kind,
        value: entry.value,
      })),
    setValueMasked: (token, masked) => {
      const vault = gateway?.vault;
      if (vault === undefined) return false;
      const changed = masked ? vault.restore(token) : vault.release(token) !== undefined;
      // Written at once: a restart must not bring the stand-in back.
      if (changed) vault.flush();
      return changed;
    },
    close: async () => {
      logEvent({ type: "vault", entries: gateway?.vault.entries() ?? [] });
      turns.flush();
      sealedFolders.close();
      await gateway?.close();
    },
  };
};
