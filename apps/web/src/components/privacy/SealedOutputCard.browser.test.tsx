import { page, userEvent } from "vite-plus/test/browser";
import { describe, expect, it, vi } from "vite-plus/test";

import { render } from "../../../test/render";
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

describe("a finished file in the reply", () => {
  it("opens in a viewer, read from the person's own server only when asked", async () => {
    setup();
    mocks.changeSealedDocuments.mockResolvedValue({ ok: true, output: "The fee is SAR 84,000." });
    await using screen = await render(card);
    await expect.element(screen.getByText("letter.txt")).toBeVisible();
    expect(mocks.changeSealedDocuments).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole("button", { name: "Open" }));
    // The viewer is portaled to the page and draws the text in its own shadow tree.
    await expect.element(page.getByRole("dialog", { name: "letter.txt" })).toBeVisible();
    expect(mocks.changeSealedDocuments).toHaveBeenCalledWith({
      action: "output",
      projectId: "project-1",
      name: "letter.txt",
    });
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
