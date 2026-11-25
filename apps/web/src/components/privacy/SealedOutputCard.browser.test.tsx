import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, type PrivacySealedProvenanceSpan, ThreadId } from "@t3tools/contracts";
import { type Locator, page, userEvent } from "vite-plus/test/browser";
import { describe, expect, it, vi } from "vite-plus/test";

import { useComposerDraftStore } from "~/composerDraftStore";
import { act, render } from "../../../test/render";
import { SealedOutputFile } from "./SealedOutputCard";

const mocks = vi.hoisted(() => ({ changeSealedDocuments: vi.fn() }));
vi.mock("~/privacy/privacyClient", () => ({
  changeSealedDocuments: mocks.changeSealedDocuments,
  // The viewer the card opens can highlight known values: masking is not set up here, so none.
  fetchKnownValues: () => Promise.resolve({ values: [], turns: [] }),
  usePrivacyStatus: () => undefined,
}));

const card = <SealedOutputFile projectId="project-1" name="letter.txt" />;

const setup = () => {
  mocks.changeSealedDocuments.mockReset();
};

// Tests load no stylesheet, so Base UI's fixed inert layer covers the dialog's unpositioned
// header and inspector; a pointer click lands on it. These controls are pressed through the DOM.
const press = (locator: Locator) =>
  act(async () => {
    (locator.element() as HTMLElement).click();
  });

const OUTPUT = "The fee is SAR 84,000. With VAT the total is SAR 96,600.";
const FEE: PrivacySealedProvenanceSpan = {
  start: 11,
  end: 21,
  written: "SAR 84,000",
  kind: "document",
  handle: "DOC_1",
  documentName: "engagement.pdf",
  field: "fee_amount",
  quote: "The professional fee shall be sar 84,000 payable on signing.",
  line: 14,
};
const TOTAL: PrivacySealedProvenanceSpan = {
  start: 45,
  end: 55,
  written: "SAR 96,600",
  kind: "computed",
  handle: "DOC_1",
  documentName: "engagement.pdf",
  field: "total_with_vat",
  reference: "CALC_1.total_with_vat",
  program: "total = fee * 1.15",
  inputs: [
    {
      handle: "DOC_1",
      documentName: "engagement.pdf",
      field: "fee_amount",
      written: "SAR 84,000",
      quote: "The professional fee shall be SAR 84,000 payable on signing.",
      line: 14,
    },
  ],
};

const openWithSpans = async (props: Partial<Parameters<typeof SealedOutputFile>[0]> = {}) => {
  mocks.changeSealedDocuments.mockResolvedValue({
    ok: true,
    output: OUTPUT,
    provenance: [TOTAL, FEE],
    hasTemplate: true,
  });
  const screen = await render(
    <SealedOutputFile projectId="project-1" name="letter.txt" {...props} />,
  );
  await userEvent.click(screen.getByRole("button", { name: "Open" }));
  const dialog = page.getByRole("dialog", { name: "letter.txt" });
  await expect.element(dialog).toBeVisible();
  return { screen, dialog };
};

describe("a finished file in the reply", () => {
  it("opens in a viewer, read from the person's own server only when asked", async () => {
    setup();
    mocks.changeSealedDocuments.mockResolvedValue({ ok: true, output: "The fee is SAR 84,000." });
    await using screen = await render(card);
    await expect.element(screen.getByText("letter.txt")).toBeVisible();
    expect(mocks.changeSealedDocuments).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole("button", { name: "Open" }));
    // With no verified values, the file opens in the plain viewer, which has no Verify mode.
    const dialog = page.getByRole("dialog", { name: "letter.txt" });
    await expect.element(dialog).toBeVisible();
    expect(dialog.getByRole("button", { name: "Verify" }).query()).toBeNull();
    expect(mocks.changeSealedDocuments).toHaveBeenCalledWith({
      action: "output",
      projectId: "project-1",
      name: "letter.txt",
    });
  });

  it("shows where each value came from: the quote it was read from, or its calculation", async () => {
    setup();
    const { screen, dialog } = await openWithSpans();
    await using _screen = screen;
    await expect.element(dialog.getByText("2 verified values")).toBeVisible();
    const inspector = dialog.getByRole("complementary", { name: "Where this value came from" });

    await userEvent.click(dialog.getByRole("button", { name: "SAR 84,000" }));
    await expect.element(inspector.getByText("From sealed file")).toBeVisible();
    await expect.element(inspector.getByText("engagement.pdf")).toBeVisible();
    await expect.element(inspector.getByText("14", { exact: true })).toBeVisible();
    await expect.element(inspector.getByText("fee_amount")).toBeVisible();
    await expect
      .element(inspector.getByRole("blockquote"))
      .toHaveTextContent("The professional fee shall be sar 84,000 payable on signing.");
    // The value is marked in its quote, even where the case differs.
    await expect.element(inspector.getByRole("mark")).toHaveTextContent("sar 84,000");
    await expect.element(inspector.getByText("1 / 2")).toBeVisible();

    await userEvent.click(dialog.getByRole("button", { name: "SAR 96,600" }));
    await expect.element(inspector.getByText("Calculated locally")).toBeVisible();
    await expect.element(inspector.getByText("CALC_1.total_with_vat")).toBeVisible();
    await expect.element(inspector.getByText("total = fee * 1.15")).toBeVisible();
    await expect.element(inspector.getByText("Line 14")).toBeVisible();
    await expect
      .element(inspector.getByRole("blockquote"))
      .toHaveTextContent("The professional fee shall be SAR 84,000 payable on signing.");
    await expect.element(inspector.getByText("2 / 2")).toBeVisible();
  });

  it("steps through the values in order and switches to the preview", async () => {
    setup();
    const { screen, dialog } = await openWithSpans();
    await using _screen = screen;
    await expect
      .element(
        dialog.getByText("Select any highlighted value to check its source quote or calculation."),
      )
      .toBeVisible();

    await press(dialog.getByRole("button", { name: "Next value" }));
    await expect.element(dialog.getByText("1 / 2")).toBeVisible();
    await expect
      .element(dialog.getByRole("button", { name: "SAR 84,000" }))
      .toHaveAttribute("aria-pressed", "true");
    await press(dialog.getByRole("button", { name: "Next value" }));
    await expect.element(dialog.getByText("2 / 2")).toBeVisible();
    await press(dialog.getByRole("button", { name: "Next value" }));
    await expect.element(dialog.getByText("1 / 2")).toBeVisible();
    await press(dialog.getByRole("button", { name: "Previous value" }));
    await expect.element(dialog.getByText("2 / 2")).toBeVisible();

    await press(dialog.getByRole("button", { name: "Preview" }));
    await expect.element(dialog.getByText("Calculated locally")).not.toBeInTheDocument();
    await expect.element(dialog.getByRole("button", { name: "Save file" })).toBeVisible();
    await press(dialog.getByRole("button", { name: "Verify" }));
    await expect.element(dialog.getByRole("button", { name: "SAR 84,000" })).toBeVisible();
  });

  it("puts a revise request for the file in the chat's message box, and closes", async () => {
    setup();
    const threadRef = scopeThreadRef(EnvironmentId.make("env-1"), ThreadId.make("thread-revise"));
    useComposerDraftStore.getState().setPrompt(threadRef, "");
    const { screen, dialog } = await openWithSpans({ threadRef });
    await using _screen = screen;

    await press(dialog.getByRole("button", { name: "Revise" }));
    await expect.element(dialog).not.toBeInTheDocument();
    expect(useComposerDraftStore.getState().getComposerDraft(threadRef)?.prompt).toBe(
      "Revise letter.txt: ",
    );

    // A draft already in the box is kept, with the request on its own line.
    useComposerDraftStore.getState().setPrompt(threadRef, "Also check the dates.");
    await userEvent.click(screen.getByRole("button", { name: "Revise" }));
    expect(useComposerDraftStore.getState().getComposerDraft(threadRef)?.prompt).toBe(
      "Also check the dates.\nRevise letter.txt: ",
    );
    useComposerDraftStore.getState().setPrompt(threadRef, "");
  });

  it("says so when the file is gone", async () => {
    setup();
    mocks.changeSealedDocuments.mockResolvedValue({ ok: false, output: null });
    await using screen = await render(card);
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    await expect
      .element(screen.getByRole("alert"))
      .toHaveTextContent("This finished file is no longer stored.");
  });

  it("offers nothing to open in a chat on another machine", async () => {
    setup();
    await using screen = await render(<SealedOutputFile projectId={null} name="letter.txt" />);
    await expect.element(screen.getByText("Finished file")).toBeVisible();
    expect(screen.getByRole("button", { name: "Open" }).query()).toBeNull();
  });
});
