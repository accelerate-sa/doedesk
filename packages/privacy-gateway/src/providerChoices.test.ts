import { describe, expect, it } from "vite-plus/test";

import {
  mergeChoice,
  migrateProviders,
  providerCatalog,
  publicChoice,
  readStoredChoice,
} from "./providerChoices.ts";

describe("a service's choice", () => {
  it("takes each field as its adapter does, and nothing the provider has no field for", () => {
    expect(
      mergeChoice(
        "detect",
        {
          provider: "presidio",
          settings: {
            endpoint: " http://localhost:5002 ",
            language: "",
            entities: "PERSON, IBAN_CODE,\n",
            scoreThreshold: "0.6",
            somethingElse: "x",
          },
          secrets: { apiKey: " p-key ", token: "not a field of Presidio" },
        },
        undefined,
      ),
    ).toEqual({
      ok: true,
      choice: {
        provider: "presidio",
        settings: {
          endpoint: "http://localhost:5002",
          entities: ["PERSON", "IBAN_CODE"],
          scoreThreshold: 0.6,
        },
        secrets: { apiKey: "p-key" },
      },
    });
    expect(
      mergeChoice(
        "detect",
        { provider: "presidio", settings: { endpoint: "http://p", scoreThreshold: "high" } },
        undefined,
      ),
    ).toEqual({ ok: false, message: "Check Minimum score." });
    expect(
      mergeChoice(
        "ocr",
        {
          provider: "azureDocumentIntelligence",
          settings: { endpoint: "https://a.example", model: "prebuilt-other" },
          secrets: { apiKey: "k" },
        },
        undefined,
      ),
    ).toEqual({ ok: false, message: "Check Model." });
  });

  it("keeps a stored secret that was not sent, for the same provider only", () => {
    const stored = {
      provider: "googleCloudDlp",
      settings: { projectId: "acme" },
      secrets: { serviceAccountKey: '{"client_email":"a@b"}' },
    };
    const again = mergeChoice(
      "detect",
      { provider: "googleCloudDlp", settings: { projectId: "acme", location: "me-central2" } },
      stored,
    );
    expect(again).toMatchObject({ ok: true, choice: { secrets: stored.secrets } });
    // One of the three credentials is needed, and removing the only one leaves none.
    expect(
      mergeChoice(
        "detect",
        {
          provider: "googleCloudDlp",
          settings: { projectId: "acme" },
          secrets: { serviceAccountKey: null },
        },
        stored,
      ),
    ).toEqual({
      ok: false,
      message: "Enter one of: Service account key (JSON), API key, Access token.",
    });
    expect(
      mergeChoice(
        "detect",
        { provider: "azureLanguagePii", settings: { endpoint: "https://a" } },
        {
          ...stored,
          secrets: { apiKey: "another provider's key" },
        },
      ),
    ).toEqual({ ok: false, message: "Enter Resource key." });
  });

  it("is shown without its secrets, and DoeDesk Cloud asks for none", () => {
    const shown = publicChoice("worker", {
      provider: "openaiCompatible",
      settings: { baseUrl: "http://llm/v1", model: "m", structured: "jsonObject" },
      secrets: { apiKey: "sk-secret", headers: { "x-team": "legal" } },
    });
    expect(shown).toEqual({
      provider: "openaiCompatible",
      settings: { baseUrl: "http://llm/v1", model: "m" },
      secretsSet: { apiKey: true, headers: true },
    });
    expect(JSON.stringify(shown)).not.toMatch(/sk-secret|legal/);
    for (const service of ["ocr", "detect", "worker"] as const) {
      expect(providerCatalog(service).find((entry) => entry.id === "doedeskCloud")?.fields).toEqual(
        [],
      );
    }
  });

  it("is not used as stored when a hand-edited file left it unusable", () => {
    expect(
      readStoredChoice("ocr", { provider: "azureDocumentIntelligence", settings: {} }),
    ).toBeUndefined();
    expect(readStoredChoice("ocr", { provider: "retiredProvider" })).toBeUndefined();
    expect(
      readStoredChoice("worker", {
        provider: "openaiCompatible",
        settings: { baseUrl: "http://llm/v1", model: "m", structured: "jsonObject" },
        secrets: {},
      })?.settings,
    ).toEqual({ baseUrl: "http://llm/v1", model: "m", structured: "jsonObject" });
  });
});

describe("a config.json from before the services were chosen one by one", () => {
  it("turns one's own detection service into detection and reading", () => {
    const { providers, rest } = migrateProviders({
      mode: "selfHosted",
      endpoint: "http://detector.test",
      token: "svc-token",
      usageReports: false,
    });
    const own = {
      provider: "custom",
      settings: { endpoint: "http://detector.test" },
      secrets: { token: "svc-token" },
    };
    expect(providers).toEqual({ detect: own, ocr: own });
    // The service's token is not an account's: it does not stay where an account's is kept.
    expect(rest).toEqual({ mode: "selfHosted", usageReports: false });
  });

  it("keeps the worker that was chosen, and an account's token where it was", () => {
    const worker = { kind: "custom", baseUrl: "http://llm/v1", model: "m", apiKey: "sk" };
    expect(migrateProviders({ mode: "cloud", token: "dd", worker }).providers).toEqual({
      worker: {
        provider: "openaiCompatible",
        settings: { baseUrl: "http://llm/v1", model: "m" },
        secrets: { apiKey: "sk" },
      },
    });
    expect(migrateProviders({ mode: "cloud", token: "dd", worker }).rest).toEqual({
      mode: "cloud",
      token: "dd",
    });
    expect(migrateProviders({ mode: "cloud", workerChoice: "cloud" }).providers).toEqual({
      worker: { provider: "doedeskCloud", settings: {}, secrets: {} },
    });
    expect(migrateProviders({ mode: "cloud", workerChoice: "off", worker }).providers).toEqual({
      worker: { provider: "off", settings: {}, secrets: {} },
    });
    // Nothing was chosen: nothing is, so DoeDesk Cloud's stays the default for an account.
    expect(migrateProviders({ mode: "cloud", token: "dd" }).providers).toEqual({});
  });

  it("reads a file that already has the three choices as it is", () => {
    const detect = { provider: "localOnly", settings: {}, secrets: {} };
    expect(
      migrateProviders({
        mode: "unconfigured",
        providers: { detect, ocr: { provider: "retiredProvider" } },
        workerChoice: "cloud",
      }),
    ).toEqual({ providers: { detect }, rest: { mode: "unconfigured" } });
  });
});
