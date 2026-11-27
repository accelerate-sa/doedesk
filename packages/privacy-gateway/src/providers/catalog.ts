/**
 * What a settings screen needs to offer each service without knowing any vendor: its name, the
 * fields to ask for, and what it can do. Labels are the English defaults; a client translates by
 * `id` and field `name`.
 */

import type { DetectProviderId, OcrProviderId, WorkerProviderId } from "./types.ts";

export interface ProviderField {
  /** The key under `settings` or `secrets` of the stored choice. */
  readonly name: string;
  /** A field under `secrets` is write-only: the screen is only told whether it is set. */
  readonly in: "settings" | "secrets";
  readonly label: string;
  readonly input: "text" | "url" | "secret" | "select" | "list" | "number" | "headers";
  readonly required: boolean;
  /** Fields that share a group stand in for each other: one of them must be filled in. */
  readonly oneOf?: string | undefined;
  readonly options?: ReadonlyArray<string> | undefined;
  readonly placeholder?: string | undefined;
  readonly help?: string | undefined;
}

export interface ProviderCapabilities {
  /** Says where each word is, so an image can be sent with personal data covered. */
  readonly supportsLayoutPolygons: boolean;
  readonly supportsPdf: boolean;
  readonly supportsArabic: boolean;
  /** Runs on this computer or on a server the organisation hosts: nothing leaves its network. */
  readonly offline: boolean;
}

export interface ProviderCatalogEntry<Id extends string> {
  readonly id: Id;
  readonly label: string;
  readonly description: string;
  readonly fields: ReadonlyArray<ProviderField>;
  readonly capabilities: ProviderCapabilities;
  readonly docsUrl?: string | undefined;
}

type Entries<Id extends string> = Readonly<Record<Id, Omit<ProviderCatalogEntry<Id>, "id">>>;

/** Every provider of a service is in its record, so one that is added without an entry fails to compile. */
const listOf = <Id extends string>(entries: Entries<Id>): ReadonlyArray<ProviderCatalogEntry<Id>> =>
  (Object.keys(entries) as Array<Id>).map((id) => ({ id, ...entries[id] }));

const setting = (
  name: string,
  label: string,
  rest: Partial<Omit<ProviderField, "name" | "in" | "label">> = {},
): ProviderField => ({ name, in: "settings", label, input: "text", required: true, ...rest });

const secret = (
  name: string,
  label: string,
  rest: Partial<Omit<ProviderField, "name" | "in" | "label">> = {},
): ProviderField => ({ name, in: "secrets", label, input: "secret", required: true, ...rest });

const CLOUD_FIELDS = [
  secret("token", "DoeDesk Cloud sign-in", {
    help: "Set when someone signs in to DoeDesk Cloud. Not typed by hand.",
  }),
];

const customFields = (path: string) => [
  setting("endpoint", "Service address", {
    input: "url",
    placeholder: "https://doedesk.internal.example.com",
    help: `The address of a service that answers POST ${path}.`,
  }),
  secret("token", "Access token", { required: false }),
];

const AWS_FIELDS = [
  setting("region", "AWS region", { placeholder: "me-central-1" }),
  setting("accessKeyId", "Access key ID"),
  secret("secretAccessKey", "Secret access key"),
  secret("sessionToken", "Session token", {
    required: false,
    help: "Only for temporary credentials.",
  }),
  setting("endpoint", "Private endpoint", {
    input: "url",
    required: false,
    help: "A VPC or FIPS endpoint in place of the public one.",
  }),
];

const GOOGLE_CREDENTIALS = [
  secret("serviceAccountKey", "Service account key (JSON)", {
    required: false,
    oneOf: "credentials",
    help: "The key file of a service account that may use this service.",
  }),
  secret("apiKey", "API key", { required: false, oneOf: "credentials" }),
  secret("accessToken", "Access token", {
    required: false,
    oneOf: "credentials",
    help: "Google's own tokens end within the hour: use one only for a test.",
  }),
];

const OPENAI_FIELDS = [
  setting("baseUrl", "API address", {
    input: "url",
    placeholder: "http://localhost:11434/v1",
    help: "The API root. For Azure OpenAI: https://NAME.openai.azure.com/openai/deployments/DEPLOYMENT",
  }),
  setting("model", "Model"),
  secret("apiKey", "API key", { required: false }),
  setting("authScheme", "Key is sent as", {
    input: "select",
    required: false,
    options: ["bearer", "apiKey"],
    help: "`apiKey` for Azure OpenAI, which takes the key in an `api-key` header.",
  }),
  setting("apiVersion", "API version", {
    required: false,
    placeholder: "2024-10-21",
    help: "Azure OpenAI only.",
  }),
  secret("headers", "Extra request headers", { input: "headers", required: false }),
];

const NONE: ProviderCapabilities = {
  supportsLayoutPolygons: false,
  supportsPdf: false,
  supportsArabic: false,
  offline: false,
};

export const OCR_PROVIDERS = listOf<OcrProviderId>({
  doedeskCloud: {
    label: "DoeDesk Cloud",
    description: "Reading hosted by DoeDesk in the account's region.",
    fields: CLOUD_FIELDS,
    capabilities: {
      ...NONE,
      supportsLayoutPolygons: true,
      supportsPdf: true,
      supportsArabic: true,
    },
  },
  azureDocumentIntelligence: {
    label: "Azure AI Document Intelligence",
    description: "Microsoft's Read and Layout models in your own Azure resource.",
    fields: [
      setting("endpoint", "Resource endpoint", {
        input: "url",
        placeholder: "https://NAME.cognitiveservices.azure.com",
      }),
      secret("apiKey", "Resource key"),
      setting("model", "Model", {
        input: "select",
        required: false,
        options: ["prebuilt-read", "prebuilt-layout"],
      }),
    ],
    capabilities: {
      ...NONE,
      supportsLayoutPolygons: true,
      supportsPdf: true,
      supportsArabic: true,
    },
    docsUrl: "https://learn.microsoft.com/azure/ai-services/document-intelligence/",
  },
  deepSa: {
    label: "DEEP.SA alOCR",
    description: "Arabic-first reading hosted in Saudi Arabia.",
    fields: [
      secret("apiKey", "API key", { help: "A key with the `ocr` scope." }),
      setting("baseUrl", "API address", {
        input: "url",
        required: false,
        placeholder: "https://alapi.deep.sa/v1",
      }),
    ],
    capabilities: { ...NONE, supportsPdf: true, supportsArabic: true },
    docsUrl: "https://alapi.deep.sa/docs/ocr",
  },
  reducto: {
    label: "Reducto",
    description: "Document parsing by Reducto, hosted or in your own cloud.",
    fields: [
      secret("apiKey", "API key"),
      setting("baseUrl", "API address", {
        input: "url",
        required: false,
        placeholder: "https://platform.reducto.ai",
      }),
    ],
    capabilities: {
      ...NONE,
      supportsLayoutPolygons: true,
      supportsPdf: true,
      supportsArabic: true,
    },
    docsUrl: "https://docs.reducto.ai/api-reference/parse",
  },
  mistralOcr: {
    label: "Mistral OCR",
    description: "Mistral's OCR model. Gives each page as Markdown.",
    fields: [
      secret("apiKey", "API key"),
      setting("model", "Model", { required: false, placeholder: "mistral-ocr-latest" }),
      setting("baseUrl", "API address", {
        input: "url",
        required: false,
        placeholder: "https://api.mistral.ai/v1",
      }),
    ],
    capabilities: { ...NONE, supportsPdf: true, supportsArabic: true },
    docsUrl: "https://docs.mistral.ai/capabilities/document_ai/basic_ocr/",
  },
  googleDocumentAi: {
    label: "Google Cloud Document AI",
    description: "An OCR processor in your own Google Cloud project.",
    fields: [
      setting("projectId", "Project ID"),
      setting("location", "Location", { placeholder: "eu" }),
      setting("processorId", "Processor ID"),
      setting("processorVersion", "Processor version", { required: false }),
      ...GOOGLE_CREDENTIALS,
    ],
    capabilities: {
      ...NONE,
      supportsLayoutPolygons: true,
      supportsPdf: true,
      supportsArabic: true,
    },
    docsUrl: "https://cloud.google.com/document-ai/docs",
  },
  awsTextract: {
    label: "AWS Textract",
    description: "Amazon's text detection for images and one-page PDFs. No Arabic.",
    fields: AWS_FIELDS,
    capabilities: { ...NONE, supportsLayoutPolygons: true },
    docsUrl: "https://docs.aws.amazon.com/textract/latest/dg/API_DetectDocumentText.html",
  },
  custom: {
    label: "Your own service",
    description: "A service you host that speaks DoeDesk's reading contract.",
    fields: customFields("/v1/ocr"),
    capabilities: {
      supportsLayoutPolygons: true,
      supportsPdf: true,
      supportsArabic: true,
      offline: true,
    },
  },
});

export const DETECT_PROVIDERS = listOf<DetectProviderId>({
  doedeskCloud: {
    label: "DoeDesk Cloud",
    description: "Name and free-text detection hosted by DoeDesk in the account's region.",
    fields: CLOUD_FIELDS,
    capabilities: { ...NONE, supportsArabic: true },
  },
  presidio: {
    label: "Microsoft Presidio",
    description: "A Presidio Analyzer you host. Arabic needs an Arabic model configured in it.",
    fields: [
      setting("endpoint", "Analyzer address", {
        input: "url",
        placeholder: "http://localhost:5002",
      }),
      setting("language", "Language", { required: false, placeholder: "en" }),
      setting("entities", "Entity types", {
        input: "list",
        required: false,
        help: "Leave empty for every type the analyzer knows.",
      }),
      setting("scoreThreshold", "Minimum score", { input: "number", required: false }),
      secret("apiKey", "API key", { required: false }),
      setting("apiKeyHeader", "Key header", {
        required: false,
        placeholder: "x-api-key",
        help: "Leave empty to send the key as `authorization: Bearer`.",
      }),
    ],
    capabilities: { ...NONE, offline: true },
    docsUrl: "https://microsoft.github.io/presidio/api-docs/api-docs.html",
  },
  azureLanguagePii: {
    label: "Azure AI Language (PII)",
    description: "Microsoft's PII recognition in your own Azure resource.",
    fields: [
      setting("endpoint", "Resource endpoint", {
        input: "url",
        placeholder: "https://NAME.cognitiveservices.azure.com",
      }),
      secret("apiKey", "Resource key"),
      setting("language", "Language", { required: false, placeholder: "ar" }),
      setting("domain", "Domain", { input: "select", required: false, options: ["none", "phi"] }),
      setting("piiCategories", "PII categories", { input: "list", required: false }),
    ],
    capabilities: { ...NONE, supportsArabic: true },
    docsUrl:
      "https://learn.microsoft.com/azure/ai-services/language-service/personally-identifiable-information/overview",
  },
  awsComprehendPii: {
    label: "AWS Comprehend (PII)",
    description: "Amazon's PII detection. English and Spanish only.",
    fields: [
      ...AWS_FIELDS,
      setting("languageCode", "Language", {
        input: "select",
        required: false,
        options: ["en", "es"],
      }),
    ],
    capabilities: NONE,
    docsUrl:
      "https://docs.aws.amazon.com/comprehend/latest/APIReference/API_DetectPiiEntities.html",
  },
  googleCloudDlp: {
    label: "Google Cloud Sensitive Data Protection",
    description: "Google Cloud DLP inspection in your own project.",
    fields: [
      setting("projectId", "Project ID"),
      setting("location", "Processing location", { required: false, placeholder: "global" }),
      setting("infoTypes", "infoTypes", {
        input: "list",
        required: false,
        help: "Leave empty for Google's default set.",
      }),
      setting("minLikelihood", "Minimum likelihood", {
        input: "select",
        required: false,
        options: ["VERY_UNLIKELY", "UNLIKELY", "POSSIBLE", "LIKELY", "VERY_LIKELY"],
      }),
      ...GOOGLE_CREDENTIALS,
    ],
    capabilities: NONE,
    docsUrl:
      "https://cloud.google.com/sensitive-data-protection/docs/reference/rest/v2/projects.content/inspect",
  },
  openaiCompatible: {
    label: "OpenAI-compatible model",
    description:
      "Any model behind a Chat Completions address: vLLM, LiteLLM, Ollama, Azure OpenAI.",
    fields: OPENAI_FIELDS,
    capabilities: { ...NONE, supportsArabic: true, offline: true },
  },
  localOnly: {
    label: "On this computer only",
    description: "Fixed-format rules for phones, IDs, IBANs and emails. Names are not found.",
    fields: [],
    capabilities: { ...NONE, supportsArabic: true, offline: true },
  },
  custom: {
    label: "Your own service",
    description: "A service you host that speaks DoeDesk's detection contract.",
    fields: customFields("/v1/detect"),
    capabilities: { ...NONE, supportsArabic: true, offline: true },
  },
});

export const WORKER_PROVIDERS = listOf<WorkerProviderId>({
  doedeskCloud: {
    label: "DoeDesk Cloud",
    description: "The worker model DoeDesk hosts in the account's region.",
    fields: CLOUD_FIELDS,
    capabilities: { ...NONE, supportsArabic: true },
  },
  openaiCompatible: {
    label: "OpenAI-compatible model",
    description:
      "Any Chat Completions or Responses address: vLLM, LiteLLM, Ollama, Azure OpenAI, HUMAIN.",
    fields: [
      ...OPENAI_FIELDS,
      setting("driver", "API format", {
        input: "select",
        required: false,
        options: ["chatCompletions", "responses"],
      }),
      setting("reasoningEffort", "Reasoning effort", { required: false, placeholder: "low" }),
    ],
    capabilities: { ...NONE, supportsArabic: true, offline: true },
  },
  off: {
    label: "Off",
    description: "No worker. Sealed documents cannot be asked about.",
    fields: [],
    capabilities: { ...NONE, offline: true },
  },
});
