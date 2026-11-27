/**
 * The three services an organisation chooses on its own: reading, detection and the worker. Each
 * choice stands alone, and none needs a DoeDesk Cloud account. `settings` may be shown on a
 * settings screen and `secrets` may not: `toPublicConfig` is the only shape that leaves the server.
 */

import type { Detector } from "../detect.ts";
import type { Reader } from "../reader.ts";
import type { StructuredOutput, WorkerDriver, WorkerEndpoint } from "../worker/client.ts";

interface ProviderChoice<Id extends string, Settings, Secrets> {
  readonly provider: Id;
  readonly settings: Settings;
  readonly secrets: Secrets;
}

/** A DoeDesk Cloud service. `endpoint` is only set to reach a region's own address. */
interface DoeDeskCloudSettings {
  readonly endpoint?: string | undefined;
}

/** A service the organisation hosts that speaks DoeDesk's own contract. */
interface CustomServiceSettings {
  readonly endpoint: string;
}

/** AWS names the key in every signed request; only the secret half is kept from the screen. */
interface AwsSettings {
  readonly region: string;
  readonly accessKeyId: string;
  /** A private or FIPS address in place of the public regional one. */
  readonly endpoint?: string | undefined;
}

interface AwsSecrets {
  readonly secretAccessKey: string;
  readonly sessionToken?: string | undefined;
}

/** One of the three. A service account key is the JSON file Google Cloud hands out. */
export interface GoogleSecrets {
  readonly serviceAccountKey?: string | undefined;
  readonly apiKey?: string | undefined;
  /** Sent as it is. Google's own expire within the hour. */
  readonly accessToken?: string | undefined;
}

/** How an OpenAI-compatible server takes its key: `authorization: Bearer`, or Azure's `api-key`. */
export type OpenAiAuthScheme = "bearer" | "apiKey";

interface OpenAiCompatibleSecrets {
  readonly apiKey?: string | undefined;
  /** Extra request headers. Kept with the secrets: a gateway's own token travels this way. */
  readonly headers?: Readonly<Record<string, string>> | undefined;
}

export type OcrProviderConfig =
  | ProviderChoice<"doedeskCloud", DoeDeskCloudSettings, { readonly token: string }>
  | ProviderChoice<
      "azureDocumentIntelligence",
      {
        readonly endpoint: string;
        readonly model?: "prebuilt-read" | "prebuilt-layout" | undefined;
      },
      { readonly apiKey: string }
    >
  | ProviderChoice<"deepSa", { readonly baseUrl?: string | undefined }, { readonly apiKey: string }>
  | ProviderChoice<
      "reducto",
      { readonly baseUrl?: string | undefined },
      { readonly apiKey: string }
    >
  | ProviderChoice<
      "mistralOcr",
      { readonly baseUrl?: string | undefined; readonly model?: string | undefined },
      { readonly apiKey: string }
    >
  | ProviderChoice<
      "googleDocumentAi",
      {
        readonly projectId: string;
        readonly location: string;
        readonly processorId: string;
        readonly processorVersion?: string | undefined;
        readonly endpoint?: string | undefined;
      },
      GoogleSecrets
    >
  | ProviderChoice<"awsTextract", AwsSettings, AwsSecrets>
  | ProviderChoice<"custom", CustomServiceSettings, { readonly token?: string | undefined }>;

export type DetectProviderConfig =
  | ProviderChoice<"doedeskCloud", DoeDeskCloudSettings, { readonly token: string }>
  | ProviderChoice<
      "presidio",
      {
        readonly endpoint: string;
        /** The language Presidio's recognisers run for. `en` unless set. */
        readonly language?: string | undefined;
        /** Presidio entity types to look for. Unset: every type the server knows. */
        readonly entities?: ReadonlyArray<string> | undefined;
        readonly scoreThreshold?: number | undefined;
        /** The header the key is sent in as it is. Unset: `authorization: Bearer`. */
        readonly apiKeyHeader?: string | undefined;
      },
      { readonly apiKey?: string | undefined }
    >
  | ProviderChoice<
      "azureLanguagePii",
      {
        readonly endpoint: string;
        readonly language?: string | undefined;
        readonly domain?: "phi" | "none" | undefined;
        readonly piiCategories?: ReadonlyArray<string> | undefined;
      },
      { readonly apiKey: string }
    >
  | ProviderChoice<
      "awsComprehendPii",
      AwsSettings & { readonly languageCode?: string | undefined },
      AwsSecrets
    >
  | ProviderChoice<
      "googleCloudDlp",
      {
        readonly projectId: string;
        /** A processing region, such as `me-central2`. Unset: `global`. */
        readonly location?: string | undefined;
        /** Unset: Google's default set. */
        readonly infoTypes?: ReadonlyArray<string> | undefined;
        readonly minLikelihood?: string | undefined;
        readonly endpoint?: string | undefined;
      },
      GoogleSecrets
    >
  | ProviderChoice<
      "openaiCompatible",
      {
        readonly baseUrl: string;
        readonly model: string;
        readonly authScheme?: OpenAiAuthScheme | undefined;
        /** Azure OpenAI's `api-version`, added to every request. */
        readonly apiVersion?: string | undefined;
        /** How the server is asked for JSON. `jsonObject` unless set. */
        readonly structured?: StructuredOutput | undefined;
      },
      OpenAiCompatibleSecrets
    >
  | ProviderChoice<"localOnly", Record<never, never>, Record<never, never>>
  | ProviderChoice<"custom", CustomServiceSettings, { readonly token?: string | undefined }>;

export type WorkerProviderConfig =
  | ProviderChoice<
      "doedeskCloud",
      DoeDeskCloudSettings & {
        /** What DoeDesk Cloud said of its worker at sign-in. */
        readonly structured?: StructuredOutput | undefined;
        readonly parallel?: number | undefined;
        readonly maxWaitSeconds?: number | undefined;
      },
      { readonly token: string }
    >
  | ProviderChoice<
      "openaiCompatible",
      {
        readonly baseUrl: string;
        readonly model: string;
        readonly driver?: WorkerDriver | undefined;
        readonly reasoningEffort?: string | undefined;
        /** As found by the connection test. `jsonSchema` unless set. */
        readonly structured?: StructuredOutput | undefined;
        readonly authScheme?: OpenAiAuthScheme | undefined;
        readonly apiVersion?: string | undefined;
      },
      OpenAiCompatibleSecrets
    >
  | ProviderChoice<"off", Record<never, never>, Record<never, never>>;

export type OcrProviderId = OcrProviderConfig["provider"];
export type DetectProviderId = DetectProviderConfig["provider"];
export type WorkerProviderId = WorkerProviderConfig["provider"];

type AnyProviderConfig = OcrProviderConfig | DetectProviderConfig | WorkerProviderConfig;

/** A choice as a settings screen may see it: each secret is only said to be set or not. */
export type PublicProviderConfig<Config extends AnyProviderConfig = AnyProviderConfig> =
  Config extends ProviderChoice<infer Id, infer Settings, infer Secrets>
    ? {
        readonly provider: Id;
        readonly settings: Settings;
        readonly secretsSet: { readonly [Name in keyof Secrets]-?: boolean };
      }
    : never;

const isSet = (secret: unknown): boolean =>
  typeof secret === "string"
    ? secret.trim() !== ""
    : typeof secret === "object" && secret !== null && Object.keys(secret).length > 0;

export const toPublicConfig = <Config extends AnyProviderConfig>(
  config: Config,
): PublicProviderConfig<Config> =>
  ({
    provider: config.provider,
    settings: config.settings,
    secretsSet: Object.fromEntries(
      Object.entries(config.secrets).map(([name, secret]) => [name, isSet(secret)]),
    ),
  }) as PublicProviderConfig<Config>;

export type ProviderProblemKind =
  /** The key or token was not accepted, or may not use this service. */
  | "auth"
  | "busy"
  | "timeout"
  | "unreachable"
  /** The service has a fault of its own. */
  | "failing"
  /** The service turned the request down for a reason a wait will not change. */
  | "refused"
  /** The service answered with something that is not its documented answer. */
  | "unreadable"
  /** The choice as stored cannot be used: a field is missing or malformed. */
  | "misconfigured";

export interface ProviderHealthResult {
  readonly ok: boolean;
  readonly kind: "ok" | ProviderProblemKind;
  /** Written for the person setting the service up. */
  readonly message: string;
  readonly host?: string | undefined;
  readonly status?: number | undefined;
  readonly latencyMs: number;
}

/** A provider did not give an answer. The message is written for the person using DoeDesk. */
export class ProviderError extends Error {
  override readonly name = "ProviderError";
  readonly kind: ProviderProblemKind;
  readonly host: string | undefined;
  readonly status: number | undefined;
  /** Asking again after a short wait may work. */
  readonly transient: boolean;
  constructor(
    message: string,
    details: {
      readonly kind: ProviderProblemKind;
      readonly host?: string | undefined;
      readonly status?: number | undefined;
      readonly transient?: boolean | undefined;
      readonly cause?: unknown;
    },
  ) {
    super(message, details.cause === undefined ? undefined : { cause: details.cause });
    this.kind = details.kind;
    this.host = details.host;
    this.status = details.status;
    this.transient = details.transient ?? false;
  }
}

/** What every adapter is given besides its choice. Tests pass a recorded `fetch` and no waiting. */
export interface ProviderRuntime {
  readonly fetch?: typeof fetch | undefined;
  /** For one request. A service that works on a document for longer is asked again, not waited on. */
  readonly timeoutMs?: number | undefined;
  readonly sleep?: ((milliseconds: number) => Promise<void>) | undefined;
  /** False for a connection test, which should say at once that the service is not there. */
  readonly retry?: boolean | undefined;
  readonly now?: (() => Date) | undefined;
}

export interface OcrProvider extends Reader {
  readonly id: OcrProviderId;
  readonly testConnection: () => Promise<ProviderHealthResult>;
}

export interface DetectProvider extends Detector {
  readonly id: DetectProviderId;
  readonly testConnection: () => Promise<ProviderHealthResult>;
}

export interface WorkerHealthResult extends ProviderHealthResult {
  /** The strictest way of asking for JSON the server accepted. Store it with the choice. */
  readonly structured?: StructuredOutput | undefined;
  /** Set when the server refused the reasoning setting and took another: null for none at all. */
  readonly reasoningEffort?: string | null | undefined;
}

export interface WorkerProvider {
  readonly id: WorkerProviderId;
  /** What `callWorker` is given. Undefined when the worker is off. */
  readonly endpoint: WorkerEndpoint | undefined;
  /** The `fetch` to call the endpoint with: it adds what the endpoint's address cannot carry. */
  readonly fetch: typeof fetch;
  readonly testConnection: () => Promise<WorkerHealthResult>;
}
