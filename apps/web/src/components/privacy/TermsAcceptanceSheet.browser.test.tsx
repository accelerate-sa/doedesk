import type { PrivacyStatus } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import { type Locator, page } from "vite-plus/test/browser";

import { CLOUD_MESSAGES } from "~/doedesk/privacyMessages";
import { render } from "../../../test/render";
import { TermsAcceptanceSheet } from "./TermsAcceptanceSheet";

const client = vi.hoisted(() => ({
  accountAction: vi.fn(),
  configurePrivacy: vi.fn(),
  setPrivacyStatus: vi.fn(),
  useConsentLocale: vi.fn(),
  // The form for a self-hosted service is imported with the sheet; these are its neighbours.
  signInToCloud: vi.fn(),
  useSignInOptions: vi.fn(),
  refreshSignInOptions: vi.fn(),
}));
vi.mock("~/privacy/privacyClient", () => client);

const status = (acceptance: Partial<NonNullable<PrivacyStatus["acceptance"]>>): PrivacyStatus => ({
  mode: "cloud",
  active: true,
  accountLabel: "sara@example.com",
  endpoint: null,
  vaultSize: 0,
  problem: null,
  profileAnswered: true,
  accountId: "acct-1",
  legal: {
    terms: {
      version: "1.2",
      url: { en: "https://doedesk.com/terms", ar: "https://doedesk.com/ar/terms" },
    },
    privacy: {
      version: "1.1",
      url: { en: "https://doedesk.com/privacy", ar: "https://doedesk.com/ar/privacy" },
    },
  },
  acceptance: {
    outstanding: true,
    blocked: false,
    termsVersion: null,
    privacyVersion: null,
    acceptedAt: null,
    ...acceptance,
  },
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

const setup = async (current: PrivacyStatus, locale: "en" | "ar" = "en") => {
  for (const mock of Object.values(client)) mock.mockReset();
  client.useConsentLocale.mockReturnValue([locale, vi.fn(), locale === "ar"]);
  const onLater = vi.fn();
  const screen = await render(
    <TermsAcceptanceSheet
      status={current}
      onLater={current.acceptance?.blocked === true ? undefined : onLater}
    />,
    // The sheet has no links into the app.
    { router: false },
  );
  return { screen, onLater };
};

describe("TermsAcceptanceSheet", () => {
  it("asks an account from before the checkbox to accept, and records what it showed", async () => {
    const { screen } = await setup(status({}));
    await using _ = screen;
    client.accountAction.mockResolvedValue({ ok: true, code: null, message: null });
    const agree = page.getByRole("button", { name: "Agree and continue" });

    await expect.element(page.getByRole("heading", { name: "Terms and privacy" })).toBeVisible();
    await expect.element(page.getByText(/DoeDesk now has Terms of Use/)).toBeVisible();
    await expect.element(page.getByRole("checkbox")).not.toBeChecked();
    await expect.element(agree).toBeDisabled();
    expect(client.accountAction).not.toHaveBeenCalled();

    await toggle(page.getByRole("checkbox"));
    await press(agree);
    await vi.waitFor(() =>
      expect(client.accountAction).toHaveBeenCalledWith({
        action: "accept",
        acceptance: {
          termsVersion: "1.2",
          privacyVersion: "1.1",
          locale: "en",
          wordingId: "terms-sheet-2026-11",
        },
      }),
    );
  });

  it("can be closed for now while the service still serves the account", async () => {
    const { screen, onLater } = await setup(status({ termsVersion: "1.1" }));
    await using _ = screen;

    // An earlier acceptance exists: the Terms changed since.
    await expect.element(page.getByRole("heading", { name: "Updated Terms of Use" })).toBeVisible();
    await press(page.getByRole("button", { name: "Close" }));
    expect(onLater).toHaveBeenCalled();
    expect(client.accountAction).not.toHaveBeenCalled();
  });

  it("stays, and says why, once the service refuses the account's requests", async () => {
    const { screen } = await setup(status({ blocked: true }));
    await using _ = screen;
    client.configurePrivacy.mockResolvedValue({ ok: true, message: null, status: status({}) });

    await expect.element(page.getByText(/will not check requests for this account/)).toBeVisible();
    expect(page.getByRole("button", { name: "Close" }).query()).toBeNull();
    // The two ways out that need no agreement.
    await expect
      .element(page.getByRole("button", { name: "Use my own detection service" }))
      .toBeVisible();
    await press(page.getByRole("button", { name: "Sign out" }));
    await vi.waitFor(() =>
      expect(client.configurePrivacy).toHaveBeenCalledWith({ mode: "unconfigured" }),
    );
  });

  it("empties the box again when the Terms changed under the sheet", async () => {
    const { screen } = await setup(status({}), "ar");
    await using _ = screen;
    client.accountAction.mockResolvedValue({
      ok: false,
      code: "terms_outdated",
      message: "The Terms of Use have changed.",
    });

    await expect.element(page.getByRole("heading", { name: "الشروط والخصوصية" })).toBeVisible();
    await toggle(page.getByRole("checkbox"));
    await press(page.getByRole("button", { name: "موافق، متابعة" }));
    await expect.element(page.getByRole("alert")).toHaveTextContent(CLOUD_MESSAGES.terms_outdated!);
    await expect.element(page.getByRole("checkbox")).not.toBeChecked();
    expect(client.accountAction.mock.calls[0]?.[0].acceptance.locale).toBe("ar");
  });
});
