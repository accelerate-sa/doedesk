import type { PrivacyStatus } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { render } from "../../../test/render";
import { WhatLeavesOverview } from "./WhatLeavesOverview";

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

const OWN_SERVER = {
  kind: "custom",
  address: "http://localhost:11434/v1",
  model: "qwen3",
  driver: "chatCompletions",
  reasoningEffort: null,
  available: true,
  servedFrom: null,
} as const;

describe("what leaves your computer", () => {
  it("says what masking still sends and where names are found", async () => {
    await using screen = await render(
      <WhatLeavesOverview status={status({ mode: "cloud", worker: OWN_SERVER })} />,
      // No route is read: the section is rendered on its own.
      { router: false },
    );
    await expect
      .element(
        screen.getByText(
          "Amounts, dates and the wording of your documents still reach your AI company as written, so your AI works as it normally does.",
        ),
      )
      .toBeInTheDocument();
    await expect
      .element(screen.getByText("Names are found by DoeDesk Cloud in Saudi Arabia."))
      .toBeInTheDocument();
    // The sealed column names the reader in use, and where a PDF is read first.
    await expect
      .element(screen.getByText("Sealed files are read by your own server at localhost:11434."))
      .toBeInTheDocument();
    await expect
      .element(
        screen.getByText(
          "PDFs and images are first read by DoeDesk Cloud in Saudi Arabia, without storing them, to get their text.",
        ),
      )
      .toBeInTheDocument();
  });

  it("does not describe masking as running while it is off", async () => {
    await using screen = await render(<WhatLeavesOverview status={status({ mode: "off" })} />, {
      router: false,
    });
    await expect
      .element(
        screen.getByText(
          "Masking is off, so everything in your chats reaches your AI company as written.",
        ),
      )
      .toBeInTheDocument();
    expect(screen.getByText(/swapped for stand-ins/).query()).toBeNull();
    await expect
      .element(
        screen.getByText("No worker is connected, so your AI cannot ask about sealed files."),
      )
      .toBeInTheDocument();
    await expect
      .element(
        screen.getByText(
          "PDFs and images are first read by your reading service to get their text.",
        ),
      )
      .toBeInTheDocument();
  });
});
