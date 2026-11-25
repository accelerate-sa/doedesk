import type { PrivacyStatus, PrivacyTurnRecord } from "@t3tools/contracts";
import { EnvironmentId, ProjectId, ProviderDriverKind, RunId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import type { Locator } from "vite-plus/test/browser";

import { fileNameInText } from "~/lib/fileNameText";

import { render } from "../../../test/render";
import { ChatPrivacyStatus } from "./ChatPrivacyStatus";
import { TurnPrivacyLine } from "./TurnPrivacy";

const client = vi.hoisted(() => ({
  fetchSealedTurn: vi.fn(),
  fetchTurnValues: vi.fn(),
  usePrivacyStatus: vi.fn(),
  useSealedDocuments: vi.fn(),
}));
vi.mock("~/privacy/privacyClient", () => client);
const entities = vi.hoisted(() => ({
  useQuietThreadShell: vi.fn(),
  useThreadRunPrivacy: vi.fn(),
}));
vi.mock("~/state/entities", () => entities);
const environments = vi.hoisted(() => ({ usePrimaryEnvironmentId: vi.fn() }));
vi.mock("~/state/environments", () => environments);

const environmentId = EnvironmentId.make("environment-here");
const threadRef = { environmentId, threadId: ThreadId.make("thread-1") };
const runId = RunId.make("run-1");
const projectId = ProjectId.make("project-1");

const status = (overrides: Partial<PrivacyStatus> = {}): PrivacyStatus => ({
  mode: "cloud",
  active: true,
  accountLabel: "person@example.com",
  endpoint: null,
  vaultSize: 4,
  problem: null,
  profileAnswered: true,
  directProviders: [],
  ...overrides,
});

const MASKED: PrivacyTurnRecord = {
  state: "masked",
  replaced: [
    { kind: "PERSON", count: 1 },
    { kind: "IBAN", count: 1 },
  ],
  rewritten: 3,
  refused: 0,
  redacted: 1,
  read: 0,
  withheld: 0,
  sealed: 0,
  attribution: "session",
};

const press = async (locator: Locator) => {
  await expect.element(locator).toBeInTheDocument();
  (locator.element() as HTMLElement).click();
};

const setup = (privacy: PrivacyStatus, record?: PrivacyTurnRecord) => {
  for (const mock of [...Object.values(client), ...Object.values(entities)]) mock.mockReset();
  environments.usePrimaryEnvironmentId.mockReturnValue(environmentId);
  client.usePrivacyStatus.mockReturnValue({ kind: "ready", status: privacy });
  client.useSealedDocuments.mockReturnValue(null);
  entities.useQuietThreadShell.mockReturnValue({ projectId });
  entities.useThreadRunPrivacy.mockReturnValue(
    record === undefined ? [] : [{ runId, privacy: record }],
  );
};

describe("the line under a turn and its Inspect view", () => {
  it("counts what was replaced and shows a real value only once asked", async () => {
    setup(status(), MASKED);
    client.fetchTurnValues.mockResolvedValue([
      { token: "[PERSON_FBJD2]", kind: "PERSON", value: "Khalid Al-Otaibi", sealed: false },
      { token: "[IBAN_K7QW3]", kind: "IBAN", value: "SA4420000001234567891234", sealed: true },
    ]);
    await using screen = await render(
      <TurnPrivacyLine threadRef={threadRef} runId={runId} environmentId={environmentId} />,
    );
    await press(
      screen.getByRole("button", {
        name: "2 values replaced with stand-ins before sending Inspect",
      }),
    );
    await expect.element(screen.getByText("What DoeDesk did in this turn")).toBeInTheDocument();
    // Counts by kind are on the turn; the values are not read until the person asks.
    await expect.element(screen.getByText("People 1")).toBeInTheDocument();
    await expect
      .element(screen.getByText("1 image sent with the details DoeDesk found covered"))
      .toBeInTheDocument();
    expect(client.fetchTurnValues).not.toHaveBeenCalled();
    expect(document.body.textContent).not.toContain("Khalid");

    await press(screen.getByRole("button", { name: "Show real values" }));
    await expect.element(screen.getByText("Khalid Al-Otaibi")).toBeInTheDocument();
    await expect.element(screen.getByText("[PERSON_FBJD2]")).toBeInTheDocument();
    await expect.element(screen.getByText("Sealed file")).toBeInTheDocument();
    expect(client.fetchTurnValues).toHaveBeenCalledExactlyOnceWith(runId);

    await press(screen.getByRole("button", { name: "Hide real values" }));
    await expect.element(screen.getByText("Khalid Al-Otaibi")).not.toBeInTheDocument();
  });

  it("names the sealed files the turn asked about, and lists the answers that reached the AI", async () => {
    const sealedFiles = { asked: ["DOC_1", "DOC_2"], askedCount: 2, clear: 1 };
    setup(status(), { ...MASKED, sealedFiles });
    client.useSealedDocuments.mockReturnValue({
      documents: [{ handle: "DOC_1", name: "lease.pdf" }],
      outputs: [],
      clear: { mostOnOneDocument: 1, perDocument: 40 },
    });
    client.fetchSealedTurn.mockResolvedValue({
      asked: [
        // A record made before labels has none; a later one says what the AI company was told.
        { handle: "DOC_1", name: "lease.pdf" },
        {
          handle: "DOC_2",
          name: "Sara_AlDossari_payroll.csv",
          label: "[PERSON_K2M4P]_payroll.csv",
        },
      ],
      answers: [
        {
          at: "2026-11-24T09:00:00.000Z",
          handle: "DOC_1",
          document: "lease.pdf",
          asked: "overdue: is the rent overdue?",
          kind: "yes",
          value: null,
        },
      ],
    });
    await using screen = await render(
      <TurnPrivacyLine threadRef={threadRef} runId={runId} environmentId={environmentId} />,
    );
    // DOC_2 was unsealed since, so the line knows it by its handle; the turn's record has its name.
    await press(
      screen.getByRole("button", {
        // Each name is kept left to right inside the sentence, whichever way the sentence runs.
        name: `2 values replaced with stand-ins before sending · 2 sealed files asked: ${fileNameInText("lease.pdf")}, ${fileNameInText("DOC_2")} · 1 answer reached your AI as it is Inspect`,
      }),
    );
    await expect.element(screen.getByText("Sara_AlDossari_payroll.csv")).toBeInTheDocument();
    // Beside the file's own name, which stays on this computer, the name that was sent for it.
    await expect.element(screen.getByText("[PERSON_K2M4P]_payroll.csv")).toBeInTheDocument();
    // Said once: a locator that found the line twice would not resolve.
    await expect.element(screen.getByText(/Your AI company was told:/)).toBeInTheDocument();
    await expect.element(screen.getByText("overdue: is the rent overdue?")).toBeInTheDocument();
    await expect.element(screen.getByText("Yes", { exact: true })).toBeInTheDocument();
    expect(client.fetchSealedTurn).toHaveBeenCalledExactlyOnceWith(projectId, runId);
  });

  it("shows a chat on another computer the handles and the counts, and reads nothing here", async () => {
    setup(status(), {
      state: "unseen",
      sealedFiles: { asked: ["DOC_1"], askedCount: 1, clear: 1 },
    });
    environments.usePrimaryEnvironmentId.mockReturnValue(EnvironmentId.make("another-computer"));
    await using screen = await render(
      <TurnPrivacyLine threadRef={threadRef} runId={runId} environmentId={environmentId} />,
    );
    await press(
      screen.getByRole("button", {
        name: `1 sealed file asked: ${fileNameInText("DOC_1")}`,
        exact: false,
      }),
    );
    await expect
      .element(
        screen.getByText(
          "The file names and the answers are kept on the computer this chat runs on. Open DoeDesk there to see them.",
        ),
      )
      .toBeInTheDocument();
    expect(client.fetchSealedTurn).not.toHaveBeenCalled();
    expect(client.useSealedDocuments).toHaveBeenCalledWith(null);
  });

  it("says nothing for a turn the gateway has no record of", async () => {
    setup(status());
    await using screen = await render(
      <TurnPrivacyLine threadRef={threadRef} runId={runId} environmentId={environmentId} />,
    );
    expect(screen.container.querySelector("[data-turn-privacy]")).toBeNull();
  });
});

describe("the status beside the message box", () => {
  const chip = (driver: string, compact = false) => (
    <ChatPrivacyStatus
      environmentId={environmentId}
      threadRef={threadRef}
      projectId={projectId}
      driver={ProviderDriverKind.make(driver)}
      compact={compact}
    />
  );

  it("follows the setting both ways, and keeps its words when it is a warning", async () => {
    setup(status({ mode: "off", active: false }));
    await using screen = await render(chip("claudeAgent", true));
    const trigger = screen.getByRole("button", { name: "Privacy of this chat: Not masked" });
    // Narrow, and still labelled: an unlabelled warning is too easy to miss before Send.
    await expect.element(trigger).toHaveTextContent("Not masked");
    await press(trigger);
    await expect
      .element(
        screen.getByText(
          "Masking is turned off. Your messages and files in this chat reach Anthropic as they are.",
        ),
      )
      .toBeInTheDocument();

    // Masking is turned back on in Settings: the same chat reads Masked again.
    client.usePrivacyStatus.mockReturnValue({ kind: "ready", status: status() });
    await screen.rerender(chip("claudeAgent", true));
    const masked = screen.getByRole("button", { name: "Privacy of this chat: Masked" });
    await expect.element(masked).toBeInTheDocument();
    await expect.element(masked).toHaveTextContent("");
    // Without sealed files, the open popover says what masking still sends.
    await expect
      .element(
        screen.getByText(
          "Amounts, dates and the wording of your documents still reach Anthropic. To keep a file's contents away from it, seal the file.",
        ),
      )
      .toBeInTheDocument();

    // The chat's provider changes to one DoeDesk was never tested with.
    await screen.rerender(chip("kiro"));
    await expect
      .element(screen.getByRole("button", { name: "Privacy of this chat: Masking not confirmed" }))
      .toBeInTheDocument();
  });

  it("speaks only through the chat's own turns when the chat runs on another computer", async () => {
    setup(status());
    environments.usePrimaryEnvironmentId.mockReturnValue(EnvironmentId.make("another-computer"));
    await using screen = await render(chip("claudeAgent"));
    // No turn yet: this computer's settings say nothing about that one.
    expect(screen.container.querySelector("[data-chat-privacy-status]")).toBeNull();

    entities.useThreadRunPrivacy.mockReturnValue([
      { runId, privacy: { state: "unmasked", reason: "direct" } },
    ]);
    await screen.rerender(chip("claudeAgent"));
    await expect
      .element(screen.getByRole("button", { name: "Privacy of this chat: Not masked" }))
      .toBeInTheDocument();
  });
});
