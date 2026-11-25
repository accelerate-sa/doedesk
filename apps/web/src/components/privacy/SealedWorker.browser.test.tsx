import type { PrivacySealedListing, PrivacyStatus } from "@t3tools/contracts";
import { page, userEvent } from "vite-plus/test/browser";
import { describe, expect, it, vi } from "vite-plus/test";

import { render } from "../../../test/render";
import { EgressSection, SealedDocumentsSection, WorkerSection } from "./SealedWorker";
import {
  egressOf,
  parseHosts,
  WORKER_CHOICES,
  workerChoicesFor,
  workerOf,
  workerRequest,
} from "./SealedWorker.logic";
import { m } from "~/i18n/messages";
import { useSealPrompt } from "~/privacy/sealPrompt";

const client = vi.hoisted(() => ({
  accountAction: vi.fn(),
  changeSealedDocuments: vi.fn(),
  configurePrivacyWorker: vi.fn(),
  // The finished file viewer can highlight known values: masking is not set up here, so none.
  fetchKnownValues: vi.fn(),
  usePrivacyStatus: vi.fn(),
  reloadPrivacyStatus: vi.fn(),
  setPrivacyPreference: vi.fn(),
  useSealedAnswers: vi.fn(),
  useSealedDocuments: vi.fn(),
}));
vi.mock("~/privacy/privacyClient", () => client);

const status = (overrides: Partial<PrivacyStatus> = {}): PrivacyStatus => ({
  mode: "selfHosted",
  active: true,
  accountLabel: null,
  endpoint: "http://localhost:8080",
  vaultSize: 4,
  problem: null,
  profileAnswered: true,
  ...overrides,
});

const listing = (overrides: Partial<PrivacySealedListing> = {}): PrivacySealedListing => ({
  documents: [],
  outputs: [],
  clear: { mostOnOneDocument: 0, perDocument: 100 },
  ...overrides,
});

const setup = () => {
  for (const mock of Object.values(client)) mock.mockReset();
  client.setPrivacyPreference.mockResolvedValue(undefined);
  client.useSealedDocuments.mockReturnValue(listing());
  client.useSealedAnswers.mockReturnValue(null);
  client.fetchKnownValues.mockResolvedValue({ values: [], turns: [] });
};

describe("the worker's settings", () => {
  it("turns a filled form into a request, and says what is missing", () => {
    const form = {
      kind: "custom",
      apiKey: " ",
      baseUrl: " http://localhost:11434/v1 ",
      model: " qwen3 ",
      driver: "responses",
      reasoningEffort: "",
    } as const;
    expect(workerRequest(form)).toEqual({
      request: {
        kind: "custom",
        baseUrl: "http://localhost:11434/v1",
        model: "qwen3",
        driver: "responses",
      },
    });
    expect(workerRequest({ ...form, model: "" })).toEqual({ problem: "Enter the model's name." });
    // The person's own server leads; DoeDesk Cloud's worker is offered only to a signed-in account that has it.
    expect(WORKER_CHOICES.map((choice) => m(choice.label))).toEqual([
      "My own server",
      "DoeDesk Cloud",
      "None",
    ]);
    expect(workerChoicesFor(status()).map((choice) => choice.value)).toEqual(["custom", "off"]);
    expect(workerChoicesFor(status({ mode: "cloud" })).map((choice) => choice.value)).toEqual([
      "custom",
      "off",
    ]);
    expect(
      workerChoicesFor(status({ mode: "cloud", hostedWorkerEntitled: true })).map(
        (choice) => choice.value,
      ),
    ).toEqual(["custom", "cloud", "off"]);
    expect(workerRequest({ ...form, kind: "cloud" })).toEqual({ request: { kind: "cloud" } });
    // A server from before the worker existed reports no worker and an open rule.
    expect(workerOf(status()).kind).toBe("off");
    expect(egressOf(status())).toEqual({ policy: "open", hosts: [] });
    expect(
      parseHosts("https://GitHub.com/acme, registry.npmjs.org\nnot a host  github.com"),
    ).toEqual(["github.com", "registry.npmjs.org"]);
  });

  it("says where sealed documents go before anything is connected", async () => {
    setup();
    client.configurePrivacyWorker.mockResolvedValue({ ok: true, message: null, status: status() });
    await using screen = await render(
      <WorkerSection
        status={status({
          worker: {
            kind: "custom",
            address: "http://localhost:11434/v1",
            model: "qwen3",
            driver: "chatCompletions",
            reasoningEffort: null,
            available: true,
            servedFrom: null,
          },
        })}
      />,
      // No route is read: the section is rendered on its own.
      { router: false },
    );
    await expect
      .element(
        screen.getByText(
          "Sealed files are sent whole, with nothing masked, to http://localhost:11434/v1. If that is not a server you control, they leave your control.",
        ),
      )
      .toBeInTheDocument();
    // Masking is on the person's own server here, so the line does not say DoeDesk Cloud masks.
    await expect
      .element(
        screen.getByText(
          "Sealed files are read by a separate model you connect here. On your own computer or company server, they are read on hardware you control; under an API key, they go to that service. Organizations without their own model hardware yet can ask for a managed in-region worker at hello@doedesk.com.",
        ),
      )
      .toBeInTheDocument();
    await userEvent.fill(screen.getByLabelText("Model"), "qwen3.8");
    await userEvent.click(screen.getByRole("button", { name: "Connect" }));
    await vi.waitFor(() =>
      expect(client.configurePrivacyWorker).toHaveBeenCalledWith({
        kind: "custom",
        baseUrl: "http://localhost:11434/v1",
        model: "qwen3.8",
        driver: "chatCompletions",
      }),
    );
  });

  it("names the region of DoeDesk Cloud's worker, and says a region that is down is not replaced", async () => {
    setup();
    await using screen = await render(
      <WorkerSection
        status={status({
          mode: "cloud",
          accountRegion: "eu",
          hostedWorkerEntitled: true,
          worker: {
            kind: "cloud",
            address: "https://api.doedesk.com/v1/worker",
            model: "qwen/qwen3.8-27b",
            driver: "chatCompletions",
            reasoningEffort: null,
            available: false,
            servedFrom: "eu",
            region: "eu",
          },
        })}
      />,
      // No route is read: the section is rendered on its own.
      { router: false },
    );
    await expect
      .element(
        screen.getByText(
          "Sealed files are sent whole, with nothing masked, through DoeDesk Cloud in Saudi Arabia to the worker model for the European Union region. DoeDesk Cloud does not store them.",
        ),
      )
      .toBeInTheDocument();
    await expect.element(screen.getByText("Region: European Union.")).toBeInTheDocument();
    await expect
      .element(
        screen.getByText("Not answering. DoeDesk does not route sealed files to another region."),
      )
      .toBeInTheDocument();
    await expect.element(screen.getByText("Model: qwen/qwen3.8-27b.")).toBeInTheDocument();
    await expect
      .element(screen.getByText("Last answer came from European Union."))
      .toBeInTheDocument();
    // Already the worker in use: there is nothing to connect.
    expect(screen.getByRole("button", { name: "Connect" }).query()).toBeNull();
    await expect.element(screen.getByLabelText("Account region")).toBeInTheDocument();
    expect(screen.getByText(/managed in-region worker/).query()).toBeNull();
  });

  it("offers a signed-in account without DoeDesk Cloud's worker its own server or none, and says how to ask for a managed one", async () => {
    setup();
    await using screen = await render(
      <WorkerSection
        status={status({
          mode: "cloud",
          accountRegion: "sa",
          sealedDocuments: 2,
          worker: {
            kind: "off",
            address: null,
            model: null,
            driver: null,
            reasoningEffort: null,
            available: false,
            servedFrom: null,
            notIncluded: true,
          },
        })}
      />,
      // No route is read: the section is rendered on its own.
      { router: false },
    );
    await expect
      .element(
        screen.getByText(
          "Masking runs automatically on DoeDesk Cloud. Sealed files are read by a separate model you connect here. On your own computer or company server, they are read on hardware you control; under an API key, they go to that service. Organizations without their own model hardware yet can ask for a managed in-region worker at hello@doedesk.com.",
        ),
      )
      .toBeInTheDocument();
    // Files were sealed while DoeDesk Cloud's worker read them: the person is told where they stand.
    await expect
      .element(
        screen.getByText(
          "DoeDesk Cloud's worker is not included in this account. Your sealed files stay sealed and encrypted on this computer, and nothing is sent anywhere else. Connect your own server to ask about them again.",
        ),
      )
      .toBeInTheDocument();
    expect(screen.getByLabelText("Account region").query()).toBeNull();
    await userEvent.click(screen.getByLabelText("Who reads sealed files"));
    await expect.element(page.getByRole("option", { name: "My own server" })).toBeVisible();
    await expect.element(page.getByRole("option", { name: "None" })).toBeVisible();
    expect(page.getByRole("option", { name: "DoeDesk Cloud" }).query()).toBeNull();
  });

  it("shows why the worker was not connected, in the server's words", async () => {
    setup();
    client.configurePrivacyWorker.mockResolvedValue({
      ok: false,
      message: "The worker answered 401: Invalid API Key",
      status: status(),
    });
    await using screen = await render(
      <WorkerSection
        status={status({
          worker: {
            kind: "custom",
            address: "https://api.example.com/openai/v1",
            model: "small-model",
            driver: "chatCompletions",
            reasoningEffort: "none",
            available: false,
            servedFrom: "dmm",
          },
        })}
      />,
      // No route is read: the section is rendered on its own.
      { router: false },
    );
    await expect
      .element(screen.getByLabelText("Server address"))
      .toHaveValue("https://api.example.com/openai/v1");
    await userEvent.fill(screen.getByLabelText("API key"), "wrong");
    await userEvent.click(screen.getByRole("button", { name: "Connect" }));
    expect(client.configurePrivacyWorker).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "custom", baseUrl: "https://api.example.com/openai/v1" }),
    );
    await expect
      .element(screen.getByText("The worker answered 401: Invalid API Key"))
      .toBeInTheDocument();
    await expect
      .element(screen.getByText(/Its last answer came from region dmm/))
      .toBeInTheDocument();
  });
});

describe("other hosts", () => {
  it("shows the list under the listed-hosts rule, with nothing about sealing, and saves it", async () => {
    setup();
    await using screen = await render(
      <EgressSection status={status({ egress: { policy: "allowlist", hosts: ["github.com"] } })} />,
      // No route is read: the section is rendered on its own.
      { router: false },
    );
    expect(screen.getByText(/until you remove those documents/).query()).toBeNull();
    await userEvent.fill(
      screen.getByLabelText("Hosts that may be reached"),
      "github.com, pypi.org",
    );
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    await vi.waitFor(() =>
      expect(client.setPrivacyPreference).toHaveBeenCalledWith({
        kind: "egress",
        policy: "allowlist",
        hosts: ["github.com", "pypi.org"],
      }),
    );
  });
});

describe("sealed documents", () => {
  it("lists the folder's files by handle, and asks before unsealing one", async () => {
    setup();
    client.useSealedDocuments.mockReturnValue(
      listing({
        documents: [
          {
            handle: "DOC_1",
            name: "agreement.docx",
            mediaType: "text/plain",
            characters: 12_480,
            lines: 210,
            addedAt: "2026-11-22T08:00:00.000Z",
          },
        ],
      }),
    );
    client.changeSealedDocuments.mockResolvedValue({
      ok: true,
      message: null,
      listing: listing(),
      handle: null,
      output: null,
    });
    const projects = [{ id: "project-1", title: "Matter 8419" }];
    await using screen = await render(<SealedDocumentsSection projects={projects} />, {
      // No route is read: the section is rendered on its own.
      router: false,
    });
    expect(client.useSealedDocuments).toHaveBeenCalledWith("project-1");
    await expect.element(screen.getByText("agreement.docx")).toBeInTheDocument();
    await expect.element(screen.getByText("DOC_1")).toBeInTheDocument();
    // The record of what reached the AI as it is opens on request.
    client.useSealedAnswers.mockImplementation((projectId: string | null) =>
      projectId === null
        ? null
        : [
            {
              at: "2026-11-22T09:00:00.000Z",
              handle: "DOC_1",
              document: "agreement.docx",
              asked: "auto_renewal: Does the agreement renew by itself?",
              kind: "no",
              value: null,
            },
          ],
    );
    // Nothing is read until the person asks to see the record.
    expect(client.useSealedAnswers).not.toHaveBeenCalledWith("project-1");
    await userEvent.click(screen.getByRole("button", { name: "Show answers" }));
    const record = screen.getByRole("list", { name: "Answers that reached your AI as they are" });
    await expect.element(record.getByText("No", { exact: true })).toBeInTheDocument();
    await expect
      .element(record.getByText("auto_renewal: Does the agreement renew by itself?"))
      .toBeInTheDocument();
    expect(client.useSealedAnswers).toHaveBeenCalledWith("project-1");
    // Unseal only asks here: the dialog host mounted at the app's root does the rest.
    await userEvent.click(screen.getByRole("button", { name: "Unseal" }));
    expect(useSealPrompt.getState()).toMatchObject({
      open: true,
      prompt: {
        kind: "unseal",
        request: { projectId: "project-1", handle: "DOC_1", name: "agreement.docx" },
      },
    });
  });
});
