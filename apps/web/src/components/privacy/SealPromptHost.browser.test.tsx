import type { PrivacySealedResult, PrivacyStatus } from "@t3tools/contracts";
import { type Locator, userEvent } from "vite-plus/test/browser";
import { describe, expect, it, vi } from "vite-plus/test";

import { render } from "../../../test/render";
import { toastManager } from "~/components/ui/toast";
import { fileNameInText, pathInText } from "~/lib/fileNameText";
import {
  requestSeal,
  requestSealFiles,
  requestSealFolder,
  requestUnseal,
  useSealPrompt,
} from "~/privacy/sealPrompt";
import { SealPromptHost } from "./SealPromptHost";

const client = vi.hoisted(() => ({
  accountAction: vi.fn(),
  changeSealedDocuments: vi.fn(),
  configurePrivacyWorker: vi.fn(),
  reloadPrivacyStatus: vi.fn(),
  usePrivacyStatus: vi.fn(),
}));
vi.mock("~/privacy/privacyClient", () => client);

const OWN_SERVER = {
  kind: "custom",
  address: "http://localhost:11434/v1",
  model: "qwen3",
  driver: "chatCompletions",
  reasoningEffort: null,
  available: true,
  servedFrom: null,
} as const;

/** DoeDesk Cloud's worker, for an account in the Saudi Arabia region. */
const HOSTED = {
  kind: "cloud",
  address: "https://api.doedesk.com/v1/worker",
  model: "qwen/qwen3.8-27b",
  driver: "chatCompletions",
  reasoningEffort: null,
  available: true,
  servedFrom: null,
  region: "sa",
} as const;

const status = (overrides: Partial<PrivacyStatus> = {}): PrivacyStatus => ({
  mode: "cloud",
  active: true,
  accountLabel: "a@example.com",
  endpoint: null,
  vaultSize: 0,
  problem: null,
  profileAnswered: true,
  ...overrides,
});

// The dialog's backdrop takes pointer events in the test page, so the box is ticked directly.
const tick = async (locator: Locator) => {
  await expect.element(locator).toBeInTheDocument();
  (locator.element() as HTMLElement).click();
};

// The dialog's own backdrop takes pointer events in the test page, so the button is pressed directly.
const press = async (locator: Locator) => {
  await expect.element(locator).toBeVisible();
  // A confirmation waits for what the server found before it can be pressed.
  await expect.element(locator).toBeEnabled();
  (locator.element() as HTMLElement).click();
};

const answer = (overrides: Partial<PrivacySealedResult> = {}): PrivacySealedResult => ({
  ok: true,
  message: null,
  listing: {
    documents: [],
    outputs: [],
    clear: { mostOnOneDocument: 0, perDocument: 100 },
  },
  handle: null,
  output: null,
  ...overrides,
});

const setup = (current: PrivacyStatus) => {
  for (const mock of Object.values(client)) mock.mockReset();
  useSealPrompt.setState({ prompt: null, open: false });
  let shown = current;
  client.usePrivacyStatus.mockImplementation(() => ({ kind: "ready", status: shown }));
  client.changeSealedDocuments.mockResolvedValue(answer());
  client.reloadPrivacyStatus.mockResolvedValue(undefined);
  return {
    setStatus: (next: PrivacyStatus) => {
      shown = next;
    },
  };
};

describe("sealing a file", () => {
  it("says who reads it, warns about Git and earlier chats, and moves the file out on confirming", async () => {
    setup(status({ worker: OWN_SERVER }));
    client.changeSealedDocuments.mockImplementation(async (request: { action: string }) =>
      request.action === "inspect"
        ? answer({ inGit: true, seenByChats: true })
        : answer({ handle: "DOC_4" }),
    );
    const onSealed = vi.fn();
    await using screen = await render(<SealPromptHost />);
    requestSeal({ projectId: "p", name: "lease.txt", path: "/case/lease.txt", onSealed });

    await expect.element(screen.getByText(`Seal ${fileNameInText("lease.txt")}?`)).toBeVisible();
    await expect
      .element(screen.getByText(/The model on your own server at localhost:11434 will read/))
      .toBeVisible();
    await expect.element(screen.getByText(/Git still holds earlier versions/)).toBeVisible();
    await expect.element(screen.getByText(/was already sent to your AI company/)).toBeVisible();

    await press(screen.getByRole("button", { name: "Seal", exact: true }));
    await vi.waitFor(() => expect(onSealed).toHaveBeenCalledWith("DOC_4"));
    expect(client.changeSealedDocuments).toHaveBeenCalledWith({
      action: "addPath",
      projectId: "p",
      path: "/case/lease.txt",
      move: true,
    });
  });

  it("seals an attached file where it lies in the folder, and says so when only the copy can be sealed", async () => {
    setup(status({ worker: OWN_SERVER }));
    let inspected = (_result: PrivacySealedResult) => {};
    const inFolder = { original: "contracts/lease.txt", readable: [], complete: true };
    client.changeSealedDocuments.mockImplementation(async (request: { action: string }) =>
      request.action === "inspectCopy"
        ? new Promise<PrivacySealedResult>((resolve) => {
            inspected = resolve;
          })
        : answer({ handle: "DOC_4", copy: inFolder }),
    );
    await using screen = await render(<SealPromptHost />);
    using toasts = vi.spyOn(toastManager, "add");
    requestSeal({ projectId: "p", name: "lease.txt", file: new File(["Rent"], "lease.txt") });

    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode("Rent"));
    const rentDigest = [...new Uint8Array(digest)]
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");
    // Nothing is promised until the folder has been looked through.
    const seal = screen.getByRole("button", { name: "Seal", exact: true });
    await expect.element(seal).toBeDisabled();
    await vi.waitFor(() =>
      expect(client.changeSealedDocuments).toHaveBeenCalledWith({
        action: "inspectCopy",
        projectId: "p",
        name: "lease.txt",
        // SHA-256 of "Rent": the file itself is not sent to be looked for.
        sha256: rentDigest,
        size: 4,
      }),
    );
    inspected(answer({ copy: inFolder, inGit: true }));
    await expect
      .element(
        screen.getByText(
          `This file is in the folder, at ${pathInText("contracts/lease.txt")}, and that is the file that is sealed`,
          { exact: false },
        ),
      )
      .toBeVisible();
    await expect.element(screen.getByText(/Git still holds earlier versions/)).toBeVisible();
    await press(seal);
    await vi.waitFor(() =>
      expect(toasts).toHaveBeenLastCalledWith(
        expect.objectContaining({
          type: "success",
          description: expect.stringContaining("It moved out of the folder"),
        }),
      ),
    );

    // Two files in the folder could be the one: the copy alone is sealed, and both are named.
    const twice = { original: null, readable: ["a/report.txt", "b/report.txt"], complete: true };
    client.changeSealedDocuments.mockImplementation(async (request: { action: string }) =>
      request.action === "inspectCopy"
        ? answer({ copy: twice })
        : answer({ handle: "DOC_5", copy: twice }),
    );
    requestSeal({ projectId: "p", name: "report.txt", file: new File(["Q1"], "report.txt") });
    await expect
      .element(screen.getByText(/Only the copy attached to your message is sealed\./))
      .toBeVisible();
    await expect
      .element(
        screen.getByText(
          `2 files in the folder stay readable by your AI: ${pathInText("a/report.txt")}, ${pathInText("b/report.txt")}.`,
          { exact: false },
        ),
      )
      .toBeVisible();
    await expect.element(screen.getByText(/choose Seal… on the file/).first()).toBeVisible();
    await press(screen.getByRole("button", { name: "Seal", exact: true }));
    await vi.waitFor(() =>
      expect(toasts).toHaveBeenLastCalledWith(
        expect.objectContaining({
          type: "warning",
          title: `Only the attached copy of ${fileNameInText("report.txt")} is sealed`,
        }),
      ),
    );
  });

  it("goes to the question when the server was connected from another window", async () => {
    const privacy = setup(status({ mode: "selfHosted" }));
    client.reloadPrivacyStatus.mockImplementation(async () => {
      privacy.setStatus(status({ worker: OWN_SERVER }));
    });
    await using screen = await render(<SealPromptHost />);
    requestSeal({ projectId: "p", name: "lease.txt", path: "/case/lease.txt" });

    await expect.element(screen.getByText(`Seal ${fileNameInText("lease.txt")}?`)).toBeVisible();
  });

  it("goes straight to the question for a signed-in account, naming the region and offering to change it first", async () => {
    setup(
      status({
        accountRegion: "sa",
        worker: {
          kind: "cloud",
          address: "https://api.doedesk.com/v1/worker",
          model: "qwen/qwen3.8-27b",
          driver: "chatCompletions",
          reasoningEffort: null,
          available: true,
          servedFrom: null,
          region: "sa",
        },
      }),
    );
    await using screen = await render(<SealPromptHost />);
    requestSeal({ projectId: "p", name: "scan.pdf", file: new File(["x"], "scan.pdf") });

    await expect.element(screen.getByText(`Seal ${fileNameInText("scan.pdf")}?`)).toBeVisible();
    // DoeDesk Cloud is said to receive the text, and where it sends it.
    await expect
      .element(
        screen.getByText(
          /DoeDesk Cloud \(in Saudi Arabia\) receives the file's text and, without storing it, sends it to the worker model at deep\.sa, in Saudi Arabia according to deep\.sa\./,
        ),
      )
      .toBeVisible();
    await expect
      .element(screen.getByText(/DoeDesk Cloud reads its text first in Saudi Arabia/))
      .toBeVisible();
    await expect.element(screen.getByText("Account region: Saudi Arabia")).toBeVisible();
    await press(screen.getByRole("button", { name: "Change", exact: true }));
    await expect.element(screen.getByLabelText("Account region")).toBeVisible();
    expect(client.configurePrivacyWorker).not.toHaveBeenCalled();
  });

  it("asks for the person's own server when nobody is connected to read, then goes on to the question", async () => {
    // No account is signed in, so DoeDesk Cloud's worker is not theirs to choose.
    const privacy = setup(status({ mode: "selfHosted" }));
    client.configurePrivacyWorker
      .mockResolvedValueOnce({ ok: false, message: "The worker answered 401.", status: status() })
      .mockImplementation(async () => {
        privacy.setStatus(status({ mode: "selfHosted", worker: OWN_SERVER }));
        return {
          ok: true,
          message: null,
          status: status({ mode: "selfHosted", worker: OWN_SERVER }),
        };
      });
    await using screen = await render(<SealPromptHost />);
    requestSeal({ projectId: "p", name: "id.png", file: new File(["x"], "id.png") });

    await expect.element(screen.getByText("Connect your own server to seal files")).toBeVisible();
    expect(screen.getByRole("button", { name: "Use DoeDesk Cloud's worker" }).query()).toBeNull();
    await expect.element(screen.getByText(/the file then goes to that service/)).toBeVisible();
    await expect
      .element(
        screen.getByText("Need a managed in-region worker for a team? Contact hello@doedesk.com."),
      )
      .toBeVisible();
    expect(screen.getByText(/is not included in this account/).query()).toBeNull();

    await press(screen.getByRole("button", { name: "Connect" }));
    await expect
      .element(screen.getByRole("alert"))
      .toHaveTextContent("Enter the server's address.");
    expect(client.configurePrivacyWorker).not.toHaveBeenCalled();

    await userEvent.fill(screen.getByLabelText("Server address"), "http://localhost:11434/v1");
    await userEvent.fill(screen.getByLabelText("Model"), "qwen3");
    await press(screen.getByRole("button", { name: "Connect" }));
    await expect.element(screen.getByRole("alert")).toHaveTextContent("The worker answered 401.");
    expect(client.configurePrivacyWorker).toHaveBeenCalledWith({
      kind: "custom",
      baseUrl: "http://localhost:11434/v1",
      model: "qwen3",
      driver: "chatCompletions",
    });

    await press(screen.getByRole("button", { name: "Connect" }));
    await expect.element(screen.getByText(`Seal ${fileNameInText("id.png")}?`)).toBeVisible();
    await expect
      .element(screen.getByText(/The model on your own server at localhost:11434 will read/))
      .toBeVisible();
    // The server did not say what the folder holds of this file, so nothing is promised of it.
    await expect
      .element(screen.getByText(/Only the copy attached to your message is sealed/))
      .toBeVisible();
  });

  it("offers DoeDesk Cloud's worker beside their own server only to a signed-in account that has it", async () => {
    // Signed in, with files sealed while DoeDesk Cloud's worker read them, and no longer with it.
    const lapsed = {
      ...OWN_SERVER,
      kind: "off",
      address: null,
      model: null,
      available: false,
      notIncluded: true,
    } as const;
    const privacy = setup(status({ accountRegion: "sa", worker: lapsed }));
    const included = { accountRegion: "sa", hostedWorkerEntitled: true } as const;
    client.configurePrivacyWorker.mockImplementation(async () => {
      privacy.setStatus(status({ ...included, worker: HOSTED }));
      return { ok: true, message: null, status: status({ ...included, worker: HOSTED }) };
    });
    await using screen = await render(<SealPromptHost />);
    requestSeal({ projectId: "p", name: "lease.txt", path: "/case/lease.txt" });

    await expect.element(screen.getByText("Connect your own server to seal files")).toBeVisible();
    await expect
      .element(
        screen.getByText(
          "DoeDesk Cloud's worker is not included in this account. Your sealed files stay sealed and encrypted on this computer, and nothing is sent anywhere else. Connect your own server to ask about them again.",
        ),
      )
      .toBeVisible();
    await expect.element(screen.getByText(/Need a managed in-region worker/)).toBeVisible();
    expect(screen.getByRole("button", { name: "Use DoeDesk Cloud's worker" }).query()).toBeNull();
    expect(screen.getByText(/Account region/).query()).toBeNull();

    // The organization takes the worker, and the person asks to seal again.
    privacy.setStatus(status(included));
    requestSeal({ projectId: "p", name: "lease.txt", path: "/case/lease.txt" });
    await expect.element(screen.getByText("Choose who reads sealed files")).toBeVisible();
    expect(screen.getByText(/Need a managed in-region worker/).query()).toBeNull();
    // Their own server is still there to connect.
    await expect.element(screen.getByLabelText("Server address")).toBeVisible();
    await press(screen.getByRole("button", { name: "Use DoeDesk Cloud's worker" }));
    expect(client.configurePrivacyWorker).toHaveBeenCalledWith({ kind: "cloud" });
    // Nothing is sealed by choosing: the question that says where the text goes comes next.
    await expect.element(screen.getByText(`Seal ${fileNameInText("lease.txt")}?`)).toBeVisible();
    await expect
      .element(screen.getByText(/DoeDesk Cloud \(in Saudi Arabia\) receives the file's text/))
      .toBeVisible();
    expect(client.changeSealedDocuments).not.toHaveBeenCalledWith(
      expect.objectContaining({ action: "addPath" }),
    );
  });

  it("says beforehand that a file it cannot read will be sealed without being asked about", async () => {
    setup(status({ worker: OWN_SERVER }));
    const unread = { kind: "unsupported" as const, message: "This kind of file cannot be read." };
    client.changeSealedDocuments.mockImplementation(async (request: { action: string }) =>
      request.action === "inspect"
        ? answer({ inspected: { files: 0, unsupported: 1, readFirst: 0, inGit: 0 } })
        : answer({
            handle: "DOC_7",
            listing: {
              documents: [
                {
                  handle: "DOC_7",
                  name: "signing.mp4",
                  mediaType: "application/octet-stream",
                  characters: 0,
                  lines: 0,
                  addedAt: "2026-11-24T09:00:00.000Z",
                  origin: "/case/signing.mp4",
                  unread,
                },
              ],
              outputs: [],
              clear: { mostOnOneDocument: 0, perDocument: 100 },
            },
          }),
    );
    await using screen = await render(<SealPromptHost />);
    requestSeal({ projectId: "p", name: "signing.mp4", path: "/case/signing.mp4" });

    await expect
      .element(
        screen.getByText(
          /DoeDesk cannot read this kind of file, so your AI will not be able to ask/,
        ),
      )
      .toBeVisible();
    // Nobody will read it, so no reader is named: not their server, and not DoeDesk Cloud.
    expect(screen.getByText(/will read this file|receives the file's text/).query()).toBeNull();
    await press(screen.getByRole("button", { name: "Seal", exact: true }));
    await vi.waitFor(() =>
      expect(client.changeSealedDocuments).toHaveBeenCalledWith({
        action: "addPath",
        projectId: "p",
        path: "/case/signing.mp4",
        move: true,
      }),
    );
  });

  it("names the person's own server, and keeps the file when sealing fails", async () => {
    setup(status({ mode: "selfHosted", worker: OWN_SERVER }));
    client.changeSealedDocuments.mockResolvedValue(
      answer({ ok: false, message: "No text was found in the file." }),
    );
    const onSealed = vi.fn();
    await using screen = await render(<SealPromptHost />);
    requestSeal({ projectId: "p", name: "scan.pdf", file: new File(["x"], "scan.pdf"), onSealed });

    await expect
      .element(screen.getByText(/The model on your own server at localhost:11434 will read/))
      .toBeVisible();
    await press(screen.getByRole("button", { name: "Seal", exact: true }));
    await expect
      .element(screen.getByRole("alert"))
      .toHaveTextContent("No text was found in the file.");
    expect(onSealed).not.toHaveBeenCalled();
  });
});

describe("sealing several files, or a folder", () => {
  const inspected = { files: 40, unsupported: 2, readFirst: 3, inGit: 0 };

  it("waits for the count, then states it and who reads the files under one confirmation", async () => {
    setup(status({ worker: OWN_SERVER }));
    let counted: (result: PrivacySealedResult) => void = () => undefined;
    client.changeSealedDocuments.mockImplementation((request: { action: string }) =>
      request.action === "inspectFolder"
        ? new Promise<PrivacySealedResult>((resolve) => (counted = resolve))
        : Promise.resolve(answer({ batch: { sealed: 40, failed: [] } })),
    );
    await using screen = await render(<SealPromptHost />);
    requestSealFolder({ projectId: "p", name: "contracts", path: "/case/contracts" });

    await expect
      .element(screen.getByText(`Seal the folder ${fileNameInText("contracts")}?`))
      .toBeVisible();
    // Nothing can be confirmed before the count is known.
    await expect.element(screen.getByRole("button", { name: "Seal", exact: true })).toBeDisabled();
    counted(answer({ inspected }));
    await expect
      .element(
        screen.getByText(
          /The model on your own server at localhost:11434 will read the 40 files in this folder, and every file added later/,
        ),
      )
      .toBeVisible();
    await expect.element(screen.getByText(/3 of them are PDFs or images/)).toBeVisible();
    // Nothing stays readable: what cannot be read is sealed too, and the person is told.
    await expect
      .element(screen.getByText(/2 files are of a kind DoeDesk cannot read. They are sealed too/))
      .toBeVisible();

    await press(screen.getByRole("button", { name: "Seal", exact: true }));
    await vi.waitFor(() =>
      expect(client.changeSealedDocuments).toHaveBeenCalledWith({
        action: "sealFolder",
        projectId: "p",
        path: "/case/contracts",
      }),
    );
  });

  it("shows what the AI company will be told the files are called, and sends a neutral label when the person chooses that", async () => {
    setup(status({ worker: OWN_SERVER }));
    client.changeSealedDocuments.mockImplementation(async (request: { action: string }) => {
      switch (request.action) {
        case "inspect":
          return answer({
            inspected: { files: 1, unsupported: 0, readFirst: 0, inGit: 0 },
            labels: [
              {
                name: "Adel_AlAmri_PulmonaryEmbolism.txt",
                label: "[PERSON_K2M4P]_PulmonaryEmbolism.txt",
              },
            ],
          });
        case "inspectCopy":
          // The detection service did not answer: the name cannot be checked now.
          return answer({ labels: [{ name: "KhalidAlOtaibi-diabetes.pdf", label: null }] });
        case "inspectFolder":
          return answer({
            inspected: { files: 7, unsupported: 0, readFirst: 0, inGit: 0 },
            labels: [{ name: "ward_notes.txt", label: "ward_notes.txt" }],
          });
        case "sealFolder":
          return answer({ batch: { sealed: 7, failed: [] } });
        default:
          return answer({ handle: "DOC_4" });
      }
    });
    await using screen = await render(<SealPromptHost />);
    const names = screen.getByRole("list", { name: "Names your AI company will receive" });
    const neutral = screen.getByRole("checkbox");

    // A file of the folder: the name as it will be sent, and what masking leaves in it.
    requestSeal({
      projectId: "p",
      name: "Adel_AlAmri_PulmonaryEmbolism.txt",
      path: "/case/Adel_AlAmri_PulmonaryEmbolism.txt",
    });
    await expect.element(names.getByText("[PERSON_K2M4P]_PulmonaryEmbolism.txt")).toBeVisible();
    await expect
      .element(
        screen.getByText(
          /Everything else is sent as it is, such as a date, a diagnosis or the name of a deal/,
        ),
      )
      .toBeVisible();
    await tick(neutral);
    await expect.element(names.getByText("DOC_….txt")).toBeVisible();
    await press(screen.getByRole("button", { name: "Seal", exact: true }));
    await vi.waitFor(() =>
      expect(client.changeSealedDocuments).toHaveBeenCalledWith({
        action: "addPath",
        projectId: "p",
        path: "/case/Adel_AlAmri_PulmonaryEmbolism.txt",
        move: true,
        neutralLabel: true,
      }),
    );
    await expect.element(screen.getByText(/Seal Adel_AlAmri/)).not.toBeInTheDocument();

    // An attached file whose name cannot be checked: a neutral label is what goes, and the
    // choice made for the last file is not carried over.
    requestSeal({
      projectId: "p",
      name: "KhalidAlOtaibi-diabetes.pdf",
      file: new File(["%PDF"], "KhalidAlOtaibi-diabetes.pdf"),
    });
    await expect.element(names.getByText("DOC_….pdf")).toBeVisible();
    await expect.element(screen.getByText(/cannot be checked now/)).toBeVisible();
    await expect.element(neutral).not.toBeChecked();
    expect(client.changeSealedDocuments).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "inspectCopy",
        projectId: "p",
        name: "KhalidAlOtaibi-diabetes.pdf",
        size: 4,
      }),
    );
    await press(screen.getByRole("button", { name: "Cancel" }));
    await expect.element(screen.getByText(/Seal KhalidAlOtaibi/)).not.toBeInTheDocument();

    // A folder: the choice is for its files now and later.
    requestSealFolder({ projectId: "p", name: "ward", path: "/case/ward" });
    await expect.element(names.getByText("ward_notes.txt")).toBeVisible();
    await expect.element(names.getByText("and 6 more")).toBeVisible();
    await tick(screen.getByRole("checkbox", { name: /every file in this folder, now and later/ }));
    await press(screen.getByRole("button", { name: "Seal", exact: true }));
    await vi.waitFor(() =>
      expect(client.changeSealedDocuments).toHaveBeenCalledWith({
        action: "sealFolder",
        projectId: "p",
        path: "/case/ward",
        neutralLabel: true,
      }),
    );
  });

  it("takes a signed-in account with DoeDesk Cloud's worker straight to the question for several files and for a folder", async () => {
    setup(status({ accountRegion: "sa", worker: HOSTED }));
    client.changeSealedDocuments.mockImplementation(async (request: { action: string }) =>
      request.action === "inspectPaths" || request.action === "inspectFolder"
        ? answer({ inspected })
        : answer({ batch: { sealed: 40, failed: [] } }),
    );
    await using screen = await render(<SealPromptHost />);
    requestSealFolder({ projectId: "p", name: "contracts", path: "/case/contracts" });

    await expect
      .element(screen.getByText(`Seal the folder ${fileNameInText("contracts")}?`))
      .toBeVisible();
    await expect
      .element(
        screen.getByText(
          /one of the 40 files in this folder, or about a file added later, DoeDesk Cloud \(in Saudi Arabia\) receives that file's text and, without storing it, sends it to the worker model at deep\.sa/,
        ),
      )
      .toBeVisible();
    await expect
      .element(
        screen.getByText(/3 of them are PDFs or images, so DoeDesk Cloud reads their text first/),
      )
      .toBeVisible();
    await expect.element(screen.getByText("Account region: Saudi Arabia")).toBeVisible();
    // Nowhere is the person asked for a server of their own.
    expect(screen.getByLabelText("Server address").query()).toBeNull();
    expect(client.configurePrivacyWorker).not.toHaveBeenCalled();

    requestSealFiles({ projectId: "p", paths: ["/case/a.txt", "/case/b.txt"] });
    await expect.element(screen.getByText("Seal 2 files?")).toBeVisible();
    await expect
      .element(screen.getByText(/one of these 40 files, DoeDesk Cloud \(in Saudi Arabia\)/))
      .toBeVisible();
    expect(screen.getByLabelText("Server address").query()).toBeNull();
  });

  it("seals the selected files in one request, and takes one file through the usual question", async () => {
    setup(status({ worker: OWN_SERVER }));
    client.changeSealedDocuments.mockImplementation(async (request: { action: string }) =>
      request.action === "inspectPaths"
        ? answer({ inspected: { files: 2, unsupported: 0, readFirst: 0, inGit: 1 } })
        : answer({ batch: { sealed: 2, failed: [] } }),
    );
    await using screen = await render(<SealPromptHost />);
    const paths = ["/case/a.txt", "/case/b.txt"];
    requestSealFiles({ projectId: "p", paths });

    await expect.element(screen.getByText("Seal 2 files?")).toBeVisible();
    await expect.element(screen.getByText(/will read these 2 files/)).toBeVisible();
    await expect.element(screen.getByText(/earlier versions of 1 of these files/)).toBeVisible();
    await press(screen.getByRole("button", { name: "Seal", exact: true }));
    await vi.waitFor(() =>
      expect(client.changeSealedDocuments).toHaveBeenCalledWith({
        action: "addPaths",
        projectId: "p",
        paths,
      }),
    );

    requestSealFiles({ projectId: "p", paths: ["/case/c.txt"] });
    await expect.element(screen.getByText(`Seal ${fileNameInText("c.txt")}?`)).toBeVisible();
  });
});

describe("unsealing a file", () => {
  it("asks first, then puts the file back", async () => {
    setup(status({ worker: OWN_SERVER }));
    client.changeSealedDocuments.mockResolvedValue(
      answer({ unsealed: { name: "lease.txt", path: "/case/lease.txt", renamed: false } }),
    );
    await using screen = await render(<SealPromptHost />);
    requestUnseal({ projectId: "p", handle: "DOC_4", name: "lease.txt", movedOut: true });

    await expect.element(screen.getByText(`Unseal ${fileNameInText("lease.txt")}?`)).toBeVisible();
    expect(client.changeSealedDocuments).not.toHaveBeenCalled();
    await press(screen.getByRole("button", { name: "Unseal" }));
    await vi.waitFor(() =>
      expect(client.changeSealedDocuments).toHaveBeenCalledWith({
        action: "remove",
        projectId: "p",
        handle: "DOC_4",
      }),
    );
  });
});
