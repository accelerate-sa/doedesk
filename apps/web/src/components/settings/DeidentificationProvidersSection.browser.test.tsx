import "~/index.css";

import type {
  PrivacyProviderCatalogEntry,
  PrivacyProviderConfig,
  PrivacyProviders,
  PrivacyStatus,
} from "@t3tools/contracts";
import { page, userEvent, type Locator } from "vite-plus/test/browser";
import { describe, expect, it, vi } from "vite-plus/test";

import { render } from "../../../test/render";
import { DeidentificationProvidersSection } from "./DeidentificationProvidersSection";
import {
  draftOf,
  fieldGroups,
  isDirty,
  missingField,
  offeredProviders,
  providerCaution,
  providerName,
  requestOf,
} from "./PrivacyProviders.logic";

const client = vi.hoisted(() => ({
  configurePrivacy: vi.fn(),
  configurePrivacyProvider: vi.fn(),
  refreshPrivacyProviders: vi.fn(),
  refreshSignInOptions: vi.fn(),
  setPrivacyStatus: vi.fn(),
  signInToCloud: vi.fn(),
  testPrivacyProvider: vi.fn(),
  useConsentLocale: vi.fn(),
  usePrivacyProviders: vi.fn(),
  useSignInOptions: vi.fn(),
}));
vi.mock("~/privacy/privacyClient", () => client);

const NONE = {
  supportsLayoutPolygons: false,
  supportsPdf: false,
  supportsArabic: false,
  offline: false,
};
const CLOUD: PrivacyProviderCatalogEntry = {
  id: "doedeskCloud",
  label: "DoeDesk Cloud",
  description: "",
  fields: [],
  capabilities: { ...NONE, supportsArabic: true },
};
const PRESIDIO: PrivacyProviderCatalogEntry = {
  id: "presidio",
  label: "Microsoft Presidio",
  description: "",
  capabilities: NONE,
  docsUrl: "https://microsoft.github.io/presidio/",
  fields: [
    { name: "endpoint", in: "settings", label: "Analyzer address", input: "url", required: true },
    { name: "language", in: "settings", label: "Language", input: "text", required: false },
    { name: "entities", in: "settings", label: "Entity types", input: "list", required: false },
    {
      name: "scoreThreshold",
      in: "settings",
      label: "Minimum score",
      input: "number",
      required: false,
    },
    { name: "apiKey", in: "secrets", label: "API key", input: "secret", required: false },
  ],
};
const GOOGLE: PrivacyProviderCatalogEntry = {
  id: "googleCloudDlp",
  label: "Google Cloud Sensitive Data Protection",
  description: "",
  capabilities: NONE,
  fields: [
    { name: "projectId", in: "settings", label: "Project ID", input: "text", required: true },
    {
      name: "serviceAccountKey",
      in: "secrets",
      label: "Service account key (JSON)",
      input: "secret",
      required: false,
      oneOf: "credentials",
    },
    {
      name: "apiKey",
      in: "secrets",
      label: "API key",
      input: "secret",
      required: false,
      oneOf: "credentials",
    },
  ],
};
const LOCAL: PrivacyProviderCatalogEntry = {
  id: "localOnly",
  label: "On this computer only",
  description: "",
  fields: [],
  capabilities: { ...NONE, supportsArabic: true, offline: true },
};
const OPENAI: PrivacyProviderCatalogEntry = {
  id: "openaiCompatible",
  label: "OpenAI-compatible model",
  description: "",
  capabilities: NONE,
  fields: [
    { name: "baseUrl", in: "settings", label: "API address", input: "url", required: true },
    { name: "model", in: "settings", label: "Model", input: "text", required: true },
    { name: "apiKey", in: "secrets", label: "API key", input: "secret", required: false },
    {
      name: "headers",
      in: "secrets",
      label: "Extra request headers",
      input: "headers",
      required: false,
    },
  ],
};
const OFF: PrivacyProviderCatalogEntry = {
  id: "off",
  label: "Off",
  description: "",
  fields: [],
  capabilities: NONE,
};

const cloudConfig: PrivacyProviderConfig = {
  provider: "doedeskCloud",
  settings: {},
  secretsSet: {},
};

const providers = (
  overrides: Partial<Record<keyof PrivacyProviders, PrivacyProviderConfig>> = {},
) =>
  ({
    ocr: { config: overrides.ocr ?? cloudConfig, catalog: [CLOUD] },
    detect: { config: overrides.detect ?? cloudConfig, catalog: [CLOUD, PRESIDIO, GOOGLE, LOCAL] },
    worker: {
      config: overrides.worker ?? { provider: "off", settings: {}, secretsSet: {} },
      catalog: [CLOUD, OPENAI, OFF],
    },
  }) satisfies PrivacyProviders;

const status = (overrides: Partial<PrivacyStatus> = {}): PrivacyStatus => ({
  mode: "unconfigured",
  active: true,
  accountLabel: null,
  endpoint: null,
  vaultSize: 0,
  problem: null,
  profileAnswered: true,
  providers: {
    ocr: { provider: "doedeskCloud", ready: false },
    detect: { provider: "doedeskCloud", ready: false },
    worker: { provider: "off", ready: true },
  },
  ...overrides,
});

const press = async (locator: Locator) => {
  await expect.element(locator).toBeVisible();
  (locator.element() as HTMLElement).click();
};

const setup = (current: PrivacyProviders = providers()) => {
  for (const mock of Object.values(client)) mock.mockReset();
  client.usePrivacyProviders.mockReturnValue({ kind: "ready", providers: current });
  client.useSignInOptions.mockReturnValue({
    methods: ["email"],
    signUpAvailable: true,
    reached: true,
  });
  client.useConsentLocale.mockReturnValue(["en", vi.fn(), false]);
};

describe("a provider's form", () => {
  const saved: PrivacyProviderConfig = {
    provider: "presidio",
    settings: { endpoint: "http://localhost:5002", entities: ["PERSON", "IBAN_CODE"] },
    secretsSet: { apiKey: true },
  };

  it("shows what is saved, and never a secret", () => {
    expect(draftOf(PRESIDIO, saved)).toEqual({
      endpoint: "http://localhost:5002",
      language: "",
      entities: "PERSON, IBAN_CODE",
      scoreThreshold: "",
      apiKey: "",
    });
    // Another provider starts empty: nothing of the saved one carries over.
    expect(draftOf(OPENAI, saved)).toEqual({ baseUrl: "", model: "", apiKey: "", headers: "" });
    expect(fieldGroups(PRESIDIO).main.map((field) => field.name)).toEqual(["endpoint", "apiKey"]);
    expect(fieldGroups(PRESIDIO).more.map((field) => field.name)).toEqual([
      "language",
      "entities",
      "scoreThreshold",
    ]);
    expect(providerName(PRESIDIO)).toBe("Microsoft Presidio");
    expect(providerName(LOCAL)).toBe("Local rules only");
  });

  it("says what a provider does not do, and offers DoeDesk Cloud's model only where it exists", () => {
    expect(providerCaution("detect", LOCAL)).toBe("Names are not masked.");
    expect(providerCaution("detect", PRESIDIO)).toBe("Arabic text may be missed.");
    expect(providerCaution("detect", CLOUD)).toBeNull();
    expect(providerCaution("worker", OFF)).toBeNull();
    const ids = (current: string, entitled: boolean) =>
      offeredProviders("worker", [CLOUD, OPENAI, OFF], current, entitled).map((entry) => entry.id);
    expect(ids("off", false)).toEqual(["openaiCompatible", "off"]);
    expect(ids("off", true)).toEqual(["doedeskCloud", "openaiCompatible", "off"]);
    // Still the choice of an account that lost it: it stays listed so the row can say so.
    expect(ids("doedeskCloud", false)).toEqual(["doedeskCloud", "openaiCompatible", "off"]);
    expect(offeredProviders("detect", [CLOUD, LOCAL], "localOnly", false)).toEqual([CLOUD, LOCAL]);
  });

  it("sends every setting, and only the secrets that were typed or removed", () => {
    const draft = { ...draftOf(PRESIDIO, saved), language: " ar ", scoreThreshold: "0.6" };
    expect(isDirty(PRESIDIO, draftOf(PRESIDIO, saved), saved)).toBe(false);
    expect(isDirty(PRESIDIO, draft, saved)).toBe(true);
    // The key is saved and was not typed again: it is not sent, so the server keeps it.
    expect(requestOf("detect", PRESIDIO, draft)).toEqual({
      service: "detect",
      provider: "presidio",
      settings: {
        endpoint: "http://localhost:5002",
        language: "ar",
        entities: ["PERSON", "IBAN_CODE"],
        scoreThreshold: 0.6,
      },
      secrets: {},
    });
    expect(requestOf("detect", PRESIDIO, { ...draft, apiKey: "new-key" }).secrets).toEqual({
      apiKey: "new-key",
    });
    expect(requestOf("detect", PRESIDIO, draft, new Set(["apiKey"])).secrets).toEqual({
      apiKey: null,
    });
    expect(
      requestOf("worker", OPENAI, {
        baseUrl: "http://localhost:11434/v1",
        model: "qwen3",
        apiKey: "",
        headers: "X-Team: legal\nnot a header\nX-Trace: on: yes",
      }).secrets,
    ).toEqual({ headers: { "X-Team": "legal", "X-Trace": "on: yes" } });
  });

  it("says what is still to fill in", () => {
    expect(missingField(PRESIDIO, draftOf(PRESIDIO, cloudConfig), cloudConfig)?.name).toBe(
      "endpoint",
    );
    expect(missingField(PRESIDIO, draftOf(PRESIDIO, saved), saved)).toBeUndefined();
    // One of the credentials is enough, and a saved one counts until it is removed.
    const google = { projectId: "acme", serviceAccountKey: "", apiKey: "" };
    expect(missingField(GOOGLE, google, cloudConfig)?.name).toBe("serviceAccountKey");
    expect(missingField(GOOGLE, { ...google, apiKey: "k" }, cloudConfig)).toBeUndefined();
    const savedGoogle: PrivacyProviderConfig = {
      provider: "googleCloudDlp",
      settings: { projectId: "acme" },
      secretsSet: { serviceAccountKey: true, apiKey: false },
    };
    expect(missingField(GOOGLE, google, savedGoogle)).toBeUndefined();
    expect(missingField(GOOGLE, google, savedGoogle, new Set(["serviceAccountKey"]))?.name).toBe(
      "serviceAccountKey",
    );
  });
});

describe("the de-identification settings", () => {
  it("lets a signed-out person choose and test their own detection service", async () => {
    setup();
    client.testPrivacyProvider.mockResolvedValue({
      ok: true,
      kind: "ok",
      message: "The detection service at localhost:5002 answered.",
      latencyMs: 12,
    });
    client.configurePrivacyProvider.mockResolvedValue({
      ok: true,
      message: null,
      providers: providers(),
      status: status({ mode: "selfHosted" }),
    });
    await using screen = await render(<DeidentificationProvidersSection status={status()} />, {
      router: false,
    });
    // Nobody is signed in, and nothing is in the way of the three services.
    await expect.element(screen.getByText("Masking isn't ready")).toBeVisible();
    await expect.element(screen.getByRole("button", { name: "Sign in" })).toBeVisible();
    await expect
      .element(screen.getByRole("img", { name: "Sign in to use DoeDesk Cloud" }).first())
      .toBeVisible();
    for (const title of ["Document reading", "Entity detection", "Sealed files model"]) {
      await expect.element(screen.getByRole("heading", { name: title })).toBeVisible();
    }
    // DoeDesk Cloud has nothing to fill in: no form is shown for it.
    expect(screen.getByRole("button", { name: "Save" }).query()).toBeNull();

    await press(screen.getByLabelText("Entity detection", { exact: true }));
    await press(page.getByRole("option", { name: "Microsoft Presidio" }));
    const save = screen.getByRole("button", { name: "Save" });
    await expect.element(save).toBeDisabled();
    await expect
      .element(screen.getByRole("button", { name: "Test Entity detection" }))
      .toBeDisabled();
    await userEvent.fill(screen.getByLabelText(/Analyzer address/), "http://localhost:5002");
    await userEvent.fill(screen.getByLabelText("API key"), "p-key");

    await userEvent.click(screen.getByRole("button", { name: "Test Entity detection" }));
    await expect.element(screen.getByRole("img", { name: "Connected" })).toBeVisible();
    const request = {
      service: "detect",
      provider: "presidio",
      settings: { endpoint: "http://localhost:5002" },
      secrets: { apiKey: "p-key" },
    };
    expect(client.testPrivacyProvider).toHaveBeenCalledWith(request);
    expect(client.configurePrivacyProvider).not.toHaveBeenCalled();

    await userEvent.click(save);
    await vi.waitFor(() => expect(client.configurePrivacyProvider).toHaveBeenCalledWith(request));
  });

  it("keeps a saved key masked, and says why a service was not saved", async () => {
    const saved: PrivacyProviderConfig = {
      provider: "presidio",
      settings: { endpoint: "http://localhost:5002" },
      secretsSet: { apiKey: true },
    };
    setup(providers({ detect: saved }));
    client.configurePrivacyProvider.mockResolvedValue({
      ok: false,
      message: "Presidio answered 401.",
      health: { ok: false, kind: "auth", message: "Presidio answered 401.", latencyMs: 9 },
      providers: providers({ detect: saved }),
      status: status({ mode: "selfHosted" }),
    });
    await using screen = await render(
      <DeidentificationProvidersSection
        status={status({
          mode: "cloud",
          accountLabel: "sara@example.com",
          providers: {
            ocr: { provider: "doedeskCloud", ready: true },
            detect: { provider: "presidio", ready: true },
            worker: { provider: "off", ready: true },
          },
        })}
      />,
      { router: false },
    );
    // Signed in to DoeDesk Cloud, and detection is still the person's own service.
    await expect.element(screen.getByText("Masking is on")).toBeVisible();
    await expect.element(screen.getByText("sara@example.com")).toBeVisible();
    await expect.element(screen.getByRole("button", { name: "Sign out" })).toBeVisible();
    await expect
      .element(screen.getByLabelText("Entity detection", { exact: true }))
      .toHaveTextContent("Microsoft Presidio");

    // The form is folded away until it is asked for.
    expect(screen.getByLabelText(/Analyzer address/).query()).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Entity detection settings" }));
    const key = screen.getByLabelText("API key", { exact: true });
    await expect.element(key).toHaveValue("");
    await expect.element(key).toHaveAttribute("placeholder", "Saved");
    await expect.element(key).toHaveAttribute("type", "password");

    await userEvent.fill(screen.getByLabelText(/Analyzer address/), "http://presidio.internal");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    await vi.waitFor(() =>
      expect(client.configurePrivacyProvider).toHaveBeenCalledWith({
        service: "detect",
        provider: "presidio",
        settings: { endpoint: "http://presidio.internal" },
        secrets: {},
      }),
    );
    await expect.element(screen.getByRole("alert")).toHaveTextContent("Key not accepted");
    // What was typed is still there to correct.
    await expect
      .element(screen.getByLabelText(/Analyzer address/))
      .toHaveValue("http://presidio.internal");
  });

  it("saves a provider with nothing to fill in as soon as it is chosen", async () => {
    setup();
    client.configurePrivacyProvider.mockResolvedValue({
      ok: true,
      message: null,
      providers: providers({ detect: { provider: "localOnly", settings: {}, secretsSet: {} } }),
      status: status({ mode: "selfHosted" }),
    });
    await using screen = await render(<DeidentificationProvidersSection status={status()} />, {
      router: false,
    });
    await press(screen.getByLabelText("Entity detection", { exact: true }));
    await press(page.getByRole("option", { name: "Local rules only" }));
    await vi.waitFor(() =>
      expect(client.configurePrivacyProvider).toHaveBeenCalledWith({
        service: "detect",
        provider: "localOnly",
      }),
    );
    // The row says what this choice leaves unmasked.
    client.usePrivacyProviders.mockReturnValue({
      kind: "ready",
      providers: providers({ detect: { provider: "localOnly", settings: {}, secretsSet: {} } }),
    });
    await screen.rerender(
      <DeidentificationProvidersSection status={status({ mode: "selfHosted" })} />,
    );
    await expect.element(screen.getByText("Names are not masked.")).toBeVisible();
  });

  it("asks before masking is turned off, and shows one row while it is off", async () => {
    setup();
    client.configurePrivacy.mockResolvedValue({
      ok: true,
      message: null,
      status: status({ mode: "off" }),
    });
    await using screen = await render(
      <DeidentificationProvidersSection status={status({ mode: "selfHosted" })} />,
      { router: false },
    );
    await userEvent.click(screen.getByRole("button", { name: "Turn off" }));
    await expect.element(page.getByText("Turn off masking?")).toBeVisible();
    expect(client.configurePrivacy).not.toHaveBeenCalled();
    await press(page.getByRole("alertdialog").getByRole("button", { name: "Turn off" }));
    await vi.waitFor(() => expect(client.configurePrivacy).toHaveBeenCalledWith({ mode: "off" }));

    await screen.rerender(<DeidentificationProvidersSection status={status({ mode: "off" })} />);
    await expect.element(screen.getByText("Masking is off")).toBeVisible();
    await expect.element(screen.getByRole("button", { name: "Turn on" })).toBeVisible();
    expect(screen.getByRole("heading", { name: "Entity detection" }).query()).toBeNull();
    expect(screen.getByRole("button", { name: "Sign in" }).query()).toBeNull();
  });
});
