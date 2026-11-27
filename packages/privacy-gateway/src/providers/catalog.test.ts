import { describe, expect, it } from "vite-plus/test";

import { DETECT_PROVIDERS, OCR_PROVIDERS, WORKER_PROVIDERS } from "./catalog.ts";
import { makeOcrProvider } from "./ocrProviders.ts";
import { AWS_KEYS } from "./testkit.ts";
import {
  type DetectProviderConfig,
  type OcrProviderConfig,
  type OcrProviderId,
  toPublicConfig,
  type WorkerProviderConfig,
} from "./types.ts";

/** One filled-in choice of every provider. Its keys are what the catalog's fields must name. */
const OCR: { readonly [Id in OcrProviderId]: Extract<OcrProviderConfig, { provider: Id }> } = {
  doedeskCloud: { provider: "doedeskCloud", settings: {}, secrets: { token: "SECRET" } },
  azureDocumentIntelligence: {
    provider: "azureDocumentIntelligence",
    settings: { endpoint: "https://contoso.cognitiveservices.azure.com", model: "prebuilt-read" },
    secrets: { apiKey: "SECRET" },
  },
  deepSa: {
    provider: "deepSa",
    settings: { baseUrl: "https://alapi.deep.sa/v1" },
    secrets: { apiKey: "SECRET" },
  },
  reducto: {
    provider: "reducto",
    settings: { baseUrl: "https://platform.reducto.ai" },
    secrets: { apiKey: "SECRET" },
  },
  mistralOcr: {
    provider: "mistralOcr",
    settings: { baseUrl: "https://api.mistral.ai/v1", model: "mistral-ocr-latest" },
    secrets: { apiKey: "SECRET" },
  },
  googleDocumentAi: {
    provider: "googleDocumentAi",
    settings: { projectId: "p", location: "eu", processorId: "x", processorVersion: "v" },
    secrets: { serviceAccountKey: "SECRET", apiKey: "SECRET", accessToken: "SECRET" },
  },
  awsTextract: {
    provider: "awsTextract",
    settings: { ...AWS_KEYS.settings, endpoint: "https://vpce.example" },
    secrets: { secretAccessKey: "SECRET", sessionToken: "SECRET" },
  },
  custom: {
    provider: "custom",
    settings: { endpoint: "http://ocr.internal" },
    secrets: { token: "SECRET" },
  },
};

const DETECT: ReadonlyArray<DetectProviderConfig> = [
  { provider: "doedeskCloud", settings: {}, secrets: { token: "SECRET" } },
  {
    provider: "presidio",
    settings: {
      endpoint: "http://p",
      language: "en",
      entities: ["PERSON"],
      scoreThreshold: 0.5,
      apiKeyHeader: "x-api-key",
    },
    secrets: { apiKey: "SECRET" },
  },
  {
    provider: "azureLanguagePii",
    settings: { endpoint: "https://a", language: "ar", domain: "none", piiCategories: ["Person"] },
    secrets: { apiKey: "SECRET" },
  },
  {
    provider: "awsComprehendPii",
    settings: { ...AWS_KEYS.settings, endpoint: "https://vpce.example", languageCode: "en" },
    secrets: { secretAccessKey: "SECRET", sessionToken: "SECRET" },
  },
  {
    provider: "googleCloudDlp",
    settings: {
      projectId: "p",
      location: "global",
      infoTypes: ["PERSON_NAME"],
      minLikelihood: "LIKELY",
    },
    secrets: { serviceAccountKey: "SECRET", apiKey: "SECRET", accessToken: "SECRET" },
  },
  {
    provider: "openaiCompatible",
    settings: { baseUrl: "http://m/v1", model: "m", authScheme: "bearer", apiVersion: "v" },
    secrets: { apiKey: "SECRET", headers: { "x-token": "SECRET" } },
  },
  { provider: "localOnly", settings: {}, secrets: {} },
  { provider: "custom", settings: { endpoint: "http://d" }, secrets: { token: "SECRET" } },
];

const WORKER: ReadonlyArray<WorkerProviderConfig> = [
  { provider: "doedeskCloud", settings: {}, secrets: { token: "SECRET" } },
  {
    provider: "openaiCompatible",
    settings: {
      baseUrl: "http://m/v1",
      model: "m",
      driver: "responses",
      reasoningEffort: "low",
      authScheme: "apiKey",
      apiVersion: "v",
    },
    secrets: { apiKey: "SECRET", headers: { "x-token": "SECRET" } },
  },
  { provider: "off", settings: {}, secrets: {} },
];

describe("the provider catalogs", () => {
  const services = [
    ["reading", OCR_PROVIDERS, Object.values(OCR)],
    ["detection", DETECT_PROVIDERS, DETECT],
    ["worker", WORKER_PROVIDERS, WORKER],
  ] as const;

  it("offer a field for everything a choice can hold, in the place it is stored", () => {
    for (const [service, catalog, choices] of services) {
      expect(
        catalog.map((entry) => entry.id),
        service,
      ).toEqual(choices.map((choice) => choice.provider));
      for (const choice of choices) {
        const entry = catalog.find((candidate) => candidate.id === choice.provider);
        const named = (place: "settings" | "secrets") =>
          (entry?.fields ?? [])
            .filter((field) => field.in === place)
            .map((field) => field.name)
            .toSorted();
        const label = `${service} ${choice.provider}`;
        // What DoeDesk Cloud said of its own worker is stored with the choice and is not typed in.
        const typed = Object.keys(choice.settings).filter(
          (name) => choice.provider !== "doedeskCloud" || name === "endpoint",
        );
        expect(named("settings"), label).toEqual(expect.arrayContaining(typed));
        expect(named("secrets"), label).toEqual(Object.keys(choice.secrets).toSorted());
        for (const field of entry?.fields ?? []) {
          expect(field.in === "secrets", `${label} ${field.name}`).toBe(
            field.input === "secret" || field.input === "headers",
          );
        }
      }
    }
  });

  it("say a reader places words exactly when it can", () => {
    for (const entry of OCR_PROVIDERS) {
      expect(makeOcrProvider(OCR[entry.id]).readLayout !== undefined, entry.id).toBe(
        entry.capabilities.supportsLayoutPolygons,
      );
    }
  });
});

describe("toPublicConfig", () => {
  it("shows the settings and says only whether each secret is set", () => {
    const every = [...Object.values(OCR), ...DETECT, ...WORKER];
    for (const choice of every) {
      const shown = toPublicConfig(choice);
      expect(JSON.stringify(shown), choice.provider).not.toContain("SECRET");
      expect(shown.settings, choice.provider).toEqual(choice.settings);
      expect(
        Object.values(shown.secretsSet).every((set) => set === true),
        choice.provider,
      ).toBe(true);
    }
    expect(
      toPublicConfig({
        provider: "openaiCompatible",
        settings: { baseUrl: "http://m/v1", model: "m" },
        secrets: { apiKey: "  ", headers: {} },
      }),
    ).toEqual({
      provider: "openaiCompatible",
      settings: { baseUrl: "http://m/v1", model: "m" },
      secretsSet: { apiKey: false, headers: false },
    });
  });
});
