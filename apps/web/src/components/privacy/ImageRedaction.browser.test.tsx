import type { PrivacyRedaction, PrivacyStatus } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import type { Locator } from "vite-plus/test/browser";

import { render } from "../../../test/render";
import { ImageHandlingSection, RedactionsSection } from "./ImageRedaction";
import { describeRedaction, imageHandlingOf } from "./ImageRedaction.logic";

const client = vi.hoisted(() => ({
  clearPrivacyRedactions: vi.fn(),
  fetchRedactionFile: vi.fn(),
  refreshPrivacyRedactions: vi.fn(),
  setPrivacyPreference: vi.fn(),
  usePrivacyRedactions: vi.fn(),
}));
vi.mock("~/privacy/privacyClient", () => client);

const status = (overrides: Partial<PrivacyStatus> = {}): PrivacyStatus => ({
  mode: "cloud",
  active: true,
  accountLabel: "person@example.com",
  endpoint: null,
  vaultSize: 4,
  problem: null,
  profileAnswered: true,
  imageHandling: "redacted",
  readingTool: true,
  ...overrides,
});

const record = (overrides: Partial<PrivacyRedaction> = {}): PrivacyRedaction => ({
  id: "a".repeat(24),
  at: "2026-11-19T08:00:00.000Z",
  kind: "image",
  outcome: "redacted",
  hasImage: true,
  hasText: true,
  width: 1000,
  height: 1300,
  valueBoxes: 13,
  unreadableBoxes: 2,
  ...overrides,
});

const press = async (locator: Locator) => {
  await expect.element(locator).toBeInTheDocument();
  (locator.element() as HTMLElement).click();
};

const setup = () => {
  for (const mock of Object.values(client)) mock.mockReset();
  client.setPrivacyPreference.mockResolvedValue(undefined);
  client.clearPrivacyRedactions.mockResolvedValue(undefined);
  client.usePrivacyRedactions.mockReturnValue([]);
};

describe("how images are sent", () => {
  it("says what a record holds, and what an older server does with images", () => {
    expect(describeRedaction(record())).toBe("Image sent redacted, 15 boxes");
    expect(describeRedaction(record({ valueBoxes: 1, unreadableBoxes: 0 }))).toBe(
      "Image sent redacted, 1 box",
    );
    expect(describeRedaction(record({ kind: "file", outcome: "text" }))).toBe(
      "Document sent as masked text",
    );
    expect(describeRedaction(record({ outcome: "withheld" }))).toBe("Image withheld");
    // A server from before this setting sends the text read from an image.
    const { imageHandling: _unset, ...older } = status();
    expect(imageHandlingOf(older)).toBe("text");
  });

  it("shows the choice in force and says plainly what is not covered", async () => {
    setup();
    await using screen = await render(<ImageHandlingSection status={status()} />, {
      router: false,
    });
    await expect.element(screen.getByText("How images are sent")).toBeVisible();
    await expect.element(screen.getByText(/a black box over each personal detail/)).toBeVisible();
    await expect
      .element(
        screen.getByText(
          /Faces, signatures, logos and anything that is not writing are not covered/,
        ),
      )
      .toBeVisible();
    await expect.element(screen.getByText(/PDFs are always sent as masked text/)).toBeVisible();
    await expect
      .element(screen.getByRole("switch", { name: "Reading tool for agents" }))
      .toBeChecked();
  });

  it("turns the reading tool off when its switch is pressed", async () => {
    setup();
    await using screen = await render(<ImageHandlingSection status={status()} />, {
      router: false,
    });
    await press(screen.getByRole("switch", { name: "Reading tool for agents" }));
    await vi.waitFor(() =>
      expect(client.setPrivacyPreference).toHaveBeenCalledWith({
        kind: "readingTool",
        offered: false,
      }),
    );
  });

  it("describes masked text only when that is the choice, and locks both controls while masking is off", async () => {
    setup();
    await using screen = await render(
      <ImageHandlingSection
        status={status({ imageHandling: "text", mode: "off", active: false })}
      />,
      { router: false },
    );
    await expect.element(screen.getByText(/No part of the picture is sent/)).toBeVisible();
    await expect
      .element(screen.getByRole("switch", { name: "Reading tool for agents" }))
      .toBeDisabled();
  });
});

describe("what was sent in place of files", () => {
  it("offers both files of a redacted image and only the text of a document", async () => {
    setup();
    client.usePrivacyRedactions.mockReturnValue([
      record(),
      record({ id: "b".repeat(24), kind: "file", outcome: "text", hasImage: false }),
    ]);
    client.fetchRedactionFile.mockResolvedValue({
      fileName: "redacted-aaaaaaaa.png",
      blob: new Blob(["x"]),
    });
    await using screen = await render(<RedactionsSection />, { router: false });
    await expect.element(screen.getByText(/Image sent redacted, 15 boxes/)).toBeVisible();
    await expect.element(screen.getByText(/Document sent as masked text/)).toBeVisible();
    expect(screen.getByRole("button", { name: "Redacted image" }).elements()).toHaveLength(1);
    expect(screen.getByRole("button", { name: "Masked text" }).elements()).toHaveLength(2);

    await press(screen.getByRole("button", { name: "Redacted image" }));
    await vi.waitFor(() =>
      expect(client.fetchRedactionFile).toHaveBeenCalledWith("a".repeat(24), "image"),
    );
  });

  it("says so when a file is no longer kept, and reads the list again", async () => {
    setup();
    client.usePrivacyRedactions.mockReturnValue([record()]);
    client.fetchRedactionFile.mockResolvedValue(null);
    await using screen = await render(<RedactionsSection />, { router: false });
    await press(screen.getByRole("button", { name: "Masked text" }));
    await expect.element(screen.getByText("That file is no longer kept.")).toBeVisible();
    expect(client.refreshPrivacyRedactions).toHaveBeenCalled();
  });

  it("deletes everything when asked, and shows nothing yet for an empty list", async () => {
    setup();
    client.usePrivacyRedactions.mockReturnValue([record()]);
    await using screen = await render(<RedactionsSection />, { router: false });
    await press(screen.getByRole("button", { name: "Delete all" }));
    await vi.waitFor(() => expect(client.clearPrivacyRedactions).toHaveBeenCalled());

    client.usePrivacyRedactions.mockReturnValue([]);
    await using empty = await render(<RedactionsSection />, { router: false });
    await expect.element(empty.getByText("Nothing yet.")).toBeVisible();
  });
});
