import type { UsageDataStatus } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import { type Locator, page } from "vite-plus/test/browser";

import { render } from "../../../test/render";
import { PrivacyPrompts } from "./PrivacyPrompts";
import {
  settleUsageDataFirstRun,
  UsageDataChoice,
  usageDataChoiceDue,
  UsageDataChoiceOnce,
  UsageDataSettings,
} from "./UsageData";

const client = vi.hoisted(() => ({
  reloadPrivacyStatus: vi.fn(),
  setUsageData: vi.fn(),
  useConsentLocale: vi.fn(),
  usePrivacyStatus: vi.fn(),
  useUsageData: vi.fn(),
}));
vi.mock("~/privacy/privacyClient", () => client);
vi.mock("./ProviderMasking", () => ({
  ProviderMaskingNoticeOnce: () => null,
}));
vi.mock("./TermsAcceptanceSheet", () => ({
  TermsAcceptanceSheet: () => null,
  termsAcceptanceDue: () => false,
}));

const usage = (overrides: Partial<UsageDataStatus> = {}): UsageDataStatus => ({
  state: "unset",
  basis: "ask",
  installId: null,
  sending: false,
  blockedBy: null,
  ...overrides,
});

const press = async (locator: Locator) => {
  await expect.element(locator).toBeVisible();
  (locator.element() as HTMLElement).click();
};

// A box or a switch with nothing in it has no size without the app's stylesheet, so it is
// pressed without first being looked for on the screen.
const toggle = async (locator: Locator) => {
  await expect.element(locator).toBeInTheDocument();
  (locator.element() as HTMLElement).click();
};

const setup = (locale: "en" | "ar" = "en") => {
  for (const mock of Object.values(client)) mock.mockReset();
  client.reloadPrivacyStatus.mockResolvedValue(undefined);
  client.useConsentLocale.mockReturnValue([locale, vi.fn(), locale === "ar"]);
  client.usePrivacyStatus.mockReturnValue({ kind: "loading" });
  client.useUsageData.mockReturnValue(null);
  client.setUsageData.mockImplementation(async () => usage());
};

describe("usage data at first run", () => {
  it("is due only when the rule is known, nothing turns it off, and nobody has chosen", () => {
    expect(usageDataChoiceDue(usage())).toBe(true);
    expect(usageDataChoiceDue(usage({ basis: "notice" }))).toBe(true);
    // The server could not be asked, or has not decided: nothing is shown and nothing is sent.
    expect(usageDataChoiceDue(null)).toBe(false);
    expect(usageDataChoiceDue(usage({ basis: null }))).toBe(false);
    expect(usageDataChoiceDue(usage({ state: "off" }))).toBe(false);
    expect(usageDataChoiceDue(usage({ state: "on_consented", sending: true }))).toBe(false);
    expect(usageDataChoiceDue(usage({ blockedBy: "policy" }))).toBe(false);
  });

  it("shows an unticked box where agreement comes first, and sends only what the person ticks", async () => {
    setup();
    await using screen = await render(<UsageDataChoice status={usage()} />, { router: false });

    await expect.element(screen.getByText(/Send usage data to help improve DoeDesk/)).toBeVisible();
    await expect.element(screen.getByRole("checkbox")).not.toBeChecked();
    expect(screen.getByRole("switch").query()).toBeNull();
    expect(client.setUsageData).not.toHaveBeenCalled();

    await toggle(screen.getByRole("checkbox"));
    await vi.waitFor(() =>
      expect(client.setUsageData).toHaveBeenCalledWith({
        action: "choose",
        on: true,
        wordingId: "usage-data-2026-11",
        locale: "en",
      }),
    );
  });

  it("shows the notice with the switch on elsewhere, and turns off on the spot", async () => {
    setup("ar");
    await using screen = await render(<UsageDataChoice status={usage({ basis: "notice" })} />, {
      router: false,
    });

    await expect.element(screen.getByText("بيانات الاستخدام مفعّلة.")).toBeVisible();
    await expect.element(screen.getByRole("switch")).toBeChecked();
    expect(screen.getByRole("checkbox").query()).toBeNull();

    await toggle(screen.getByRole("switch"));
    await vi.waitFor(() =>
      expect(client.setUsageData).toHaveBeenCalledWith({
        action: "choose",
        on: false,
        wordingId: "usage-data-notice-2026-11",
        locale: "ar",
      }),
    );
  });

  it("records what leaving the screen untouched means under each rule", async () => {
    setup();
    await settleUsageDataFirstRun(usage({ basis: "notice" }), "en");
    await settleUsageDataFirstRun(usage({ basis: "ask" }), "ar");
    // Already answered, or nothing to answer: leaving records nothing more.
    await settleUsageDataFirstRun(usage({ state: "on_consented" }), "en");
    await settleUsageDataFirstRun(null, "en");

    expect(client.setUsageData.mock.calls).toEqual([
      [{ action: "noticeShown", wordingId: "usage-data-notice-2026-11", locale: "en" }],
      [{ action: "choose", on: false, wordingId: "usage-data-2026-11", locale: "ar" }],
    ]);
  });

  it("asks an installation that is already set up once, and closes on Continue", async () => {
    setup();
    const onDone = vi.fn();
    await using _screen = await render(
      <UsageDataChoiceOnce status={usage({ basis: "notice" })} onDone={onDone} />,
      { router: false },
    );

    await expect.element(page.getByText("Usage data is on.")).toBeVisible();
    await press(page.getByRole("button", { name: "Continue" }));
    await vi.waitFor(() => expect(onDone).toHaveBeenCalled());
    expect(client.setUsageData).toHaveBeenCalledWith({
      action: "noticeShown",
      wordingId: "usage-data-notice-2026-11",
      locale: "en",
    });
  });

  it("hides the usage-data dialog when entering /welcome and re-evaluates on return", async () => {
    setup();
    client.useUsageData.mockReturnValue(usage({ basis: "notice" }));
    await using screen = await render(<PrivacyPrompts onWelcome={false} />, { router: false });

    await expect.element(page.getByText("Usage data is on.")).toBeVisible();

    await screen.rerender(<PrivacyPrompts onWelcome />);
    expect(page.getByText("Usage data is on.").query()).toBeNull();

    // After the user answers the usage-data step during setup, leaving /welcome must not reopen it.
    client.useUsageData.mockReturnValue(
      usage({ state: "on_by_default_notice_shown", basis: "notice", sending: true }),
    );
    await screen.rerender(<PrivacyPrompts onWelcome={false} />);
    expect(page.getByText("Usage data is on.").query()).toBeNull();
  });

  it("opens the usage-data dialog after leaving /welcome when the choice becomes due late, and stays quiet if answered in setup", async () => {
    setup();
    // Choice not yet known during setup (country detection still in flight).
    client.useUsageData.mockReturnValue(null);
    {
      await using _welcome = await render(<PrivacyPrompts onWelcome />, { router: false });
      expect(page.getByText("Usage data is on.").query()).toBeNull();
    }

    // Remounts in the app shell after setup; once country detection settles as due, it asks.
    await using app = await render(<PrivacyPrompts onWelcome={false} />, { router: false });
    expect(page.getByText(/Send usage data to help improve DoeDesk/).query()).toBeNull();

    client.useUsageData.mockReturnValue(usage({ basis: "ask" }));
    await app.rerender(<PrivacyPrompts onWelcome={false} />);
    await expect.element(page.getByText(/Send usage data to help improve DoeDesk/)).toBeVisible();
  });

  it("does not reopen the usage-data dialog after remounting when setup already answered it", async () => {
    setup();
    client.useUsageData.mockReturnValue(
      usage({ state: "on_consented", basis: "ask", sending: true }),
    );
    await using _app = await render(<PrivacyPrompts onWelcome={false} />, { router: false });
    expect(page.getByText(/Send usage data to help improve DoeDesk/).query()).toBeNull();
    expect(page.getByText("Usage data is on.").query()).toBeNull();
  });
});

describe("usage data in Settings", () => {
  it("shows the identifier while usage data is on, and records a switch-off", async () => {
    setup();
    await using screen = await render(
      <UsageDataSettings
        status={usage({
          state: "on_consented",
          sending: true,
          installId: "1b4e28ba-2fa1-4d3b-9c1e-0a1b2c3d4e5f",
        })}
      />,
      { router: false },
    );

    await expect.element(screen.getByText(/Not linked to your account/)).toBeVisible();
    await expect.element(screen.getByText("1b4e28ba-2fa1-4d3b-9c1e-0a1b2c3d4e5f")).toBeVisible();
    await expect
      .element(screen.getByRole("button", { name: "Copy the installation identifier" }))
      .toBeVisible();
    await toggle(screen.getByRole("switch"));
    await vi.waitFor(() =>
      expect(client.setUsageData).toHaveBeenCalledWith({
        action: "choose",
        on: false,
        wordingId: "usage-data-settings-2026-11",
        locale: "en",
      }),
    );
  });

  it("offers no switch where the computer's own settings turn usage data off", async () => {
    setup();
    await using screen = await render(
      <UsageDataSettings status={usage({ blockedBy: "environment" })} />,
      { router: false },
    );

    await expect.element(screen.getByText(/settings turn usage data off/)).toBeVisible();
    expect(screen.getByRole("switch").query()).toBeNull();
  });
});
