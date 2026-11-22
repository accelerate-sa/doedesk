import type { PrivacyStatus } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import { type Locator, page, userEvent } from "vite-plus/test/browser";

import { CLOUD_MESSAGES } from "~/doedesk/privacyMessages";
import { render } from "../../../test/render";
import { AccountRightsSection, LegalDocumentsSection } from "./AccountRights";

const client = vi.hoisted(() => ({
  accountAction: vi.fn(),
  configurePrivacy: vi.fn(),
  refreshSignInOptions: vi.fn(),
  savePrivacyProfile: vi.fn(),
  setPrivacyStatus: vi.fn(),
  signInToCloud: vi.fn(),
  useConsentLocale: vi.fn(),
  usePrivacyStatus: vi.fn(),
  useSignInOptions: vi.fn(),
}));
vi.mock("~/privacy/privacyClient", () => client);

const status = (overrides: Partial<PrivacyStatus> = {}): PrivacyStatus => ({
  mode: "cloud",
  active: true,
  accountLabel: "+96655•••567",
  endpoint: null,
  vaultSize: 0,
  problem: null,
  profileAnswered: true,
  accountId: "acct-1",
  profile: { field: "legal", workplace: "self" },
  legal: {
    terms: {
      version: "1.1",
      url: { en: "https://doedesk.com/terms", ar: "https://doedesk.com/ar/terms" },
    },
    privacy: {
      version: "1.1",
      url: { en: "https://doedesk.com/privacy", ar: "https://doedesk.com/ar/privacy" },
    },
  },
  acceptance: {
    outstanding: false,
    blocked: false,
    termsVersion: "1.1",
    privacyVersion: "1.1",
    acceptedAt: "2026-11-18T18:00:00.000Z",
  },
  ...overrides,
});

const DELETED = {
  accountId: "acct-1",
  deletedAt: "2026-11-19T09:00:00.000Z",
  kept: [{ record: "terms_acceptance", until: "2031-11-19T09:00:00.000Z" }],
};
const result = (overrides: Record<string, unknown> = {}) => ({
  ok: true,
  code: null,
  message: null,
  exported: null,
  deleted: null,
  status: status(),
  ...overrides,
});

const press = async (locator: Locator) => {
  await expect.element(locator).toBeVisible();
  (locator.element() as HTMLElement).click();
};

const setup = async (current = status()) => {
  for (const mock of Object.values(client)) mock.mockReset();
  client.useConsentLocale.mockReturnValue(["en", vi.fn(), false]);
  client.usePrivacyStatus.mockReturnValue({ kind: "ready", status: current });
  client.useSignInOptions.mockReturnValue({
    methods: ["phone", "email"],
    signUpAvailable: true,
    reached: true,
  });
  return render(
    <>
      <AccountRightsSection status={current} />
      <LegalDocumentsSection status={current} />
    </>,
  );
};

describe("account rights in Settings", () => {
  it("saves a copy of the account's data as a file", async () => {
    await using screen = await setup();
    client.accountAction.mockResolvedValue(result({ exported: `{"account":{"id":"acct-1"}}` }));
    const saved: Array<{ name: string; href: string }> = [];
    using _click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      saved.push({ name: this.download, href: this.href });
    });

    await press(screen.getByRole("button", { name: "Download" }));
    await vi.waitFor(() => expect(saved).toHaveLength(1));
    expect(client.accountAction).toHaveBeenCalledWith({ action: "export" });
    expect(saved[0]?.name).toMatch(/^doedesk-account-\d{4}-\d{2}-\d{2}\.json$/);
    expect(saved[0]?.href).toMatch(/^blob:/);
  });

  it("says when the service allows no more copies for now", async () => {
    await using screen = await setup();
    client.accountAction.mockResolvedValue(
      result({ ok: false, code: "too_many_requests", message: "Too many requests." }),
    );

    await press(screen.getByRole("button", { name: "Download" }));
    await expect
      .element(screen.getByRole("alert"))
      .toHaveTextContent(CLOUD_MESSAGES.too_many_requests!);
  });

  it("explains the deletion, then deletes with a sign-in the service still accepts", async () => {
    await using screen = await setup();
    client.accountAction.mockResolvedValue(
      result({ deleted: DELETED, status: status({ mode: "unconfigured" }) }),
    );

    await press(screen.getByRole("button", { name: "Delete" }));
    // What goes, what stays, and what was never the account's.
    await expect.element(page.getByText("DoeDesk Cloud deletes, at once")).toBeVisible();
    await expect
      .element(page.getByText(/For five years, the record that this account accepted/))
      .toBeVisible();
    await expect
      .element(page.getByText(/Usage data, which is not linked to your account/))
      .toBeVisible();
    expect(client.accountAction).not.toHaveBeenCalled();

    await press(page.getByRole("button", { name: "Delete my account" }));
    await expect.element(page.getByText("DoeDesk Cloud deleted the account")).toBeVisible();
    await expect.element(page.getByText("acct-1")).toBeVisible();
    await expect.element(page.getByText(/kept until/)).toBeVisible();
    expect(client.accountAction).toHaveBeenCalledWith({ action: "delete" });
  });

  it("asks for a new sign-in when this one is too old, and deletes once it is confirmed", async () => {
    await using screen = await setup();
    client.accountAction.mockResolvedValue(
      result({ ok: false, code: "recent_sign_in_required", message: "Sign in again first." }),
    );
    client.signInToCloud.mockImplementation(async (payload: { step: string }) =>
      payload.step === "phoneStart"
        ? { ...result(), methods: null, requestId: "r9", resendIn: 60, signedIn: false }
        : {
            ...result({ deleted: DELETED, status: status({ mode: "unconfigured" }) }),
            methods: null,
            requestId: null,
            resendIn: null,
            signedIn: false,
          },
    );

    await press(screen.getByRole("button", { name: "Delete" }));
    await press(page.getByRole("button", { name: "Delete my account" }));
    await expect.element(page.getByText(/within 10 minutes of signing in/)).toBeVisible();
    // The account was made with a number, so it signs in with one; nobody is asked to agree.
    expect(page.getByRole("checkbox").query()).toBeNull();
    expect(page.getByRole("button", { name: "Email" }).query()).toBeNull();
    await userEvent.type(page.getByLabelText("Mobile number"), "0551234567");
    await press(page.getByRole("button", { name: "Send code" }));
    await userEvent.type(page.getByLabelText("Verification code"), "123456");

    await expect.element(page.getByText("DoeDesk Cloud deleted the account")).toBeVisible();
    expect(client.signInToCloud).toHaveBeenNthCalledWith(1, {
      step: "phoneStart",
      phone: "0551234567",
      purpose: "deleteAccount",
    });
  });

  it("corrects the stored answers, and removes them", async () => {
    await using screen = await setup();
    client.savePrivacyProfile.mockResolvedValue(status({ profile: null }));

    await expect.element(screen.getByText("Legal · On my own")).toBeVisible();
    await press(screen.getByRole("button", { name: "Change" }));
    await expect.element(page.getByRole("radio", { name: "Legal" })).toBeChecked();
    await press(page.getByRole("radio", { name: "Finance" }));
    await press(page.getByRole("button", { name: "Save" }));
    await vi.waitFor(() =>
      expect(client.savePrivacyProfile).toHaveBeenCalledWith({
        field: "finance",
        fieldOther: null,
        workplace: "self",
      }),
    );

    await press(screen.getByRole("button", { name: "Change" }));
    await press(page.getByRole("button", { name: "Remove my answers" }));
    await vi.waitFor(() =>
      expect(client.savePrivacyProfile).toHaveBeenLastCalledWith({
        field: null,
        fieldOther: null,
        workplace: null,
      }),
    );
  });

  it("shows each document's version, and when this account accepted the Terms", async () => {
    await using screen = await setup();

    await expect
      .element(screen.getByText(/Version 1\.1\. This account accepted version 1\.1 on/))
      .toBeVisible();
    for (const link of screen.getByRole("link", { name: "Open" }).elements()) {
      expect(link.getAttribute("href")).toMatch(/^https:\/\/doedesk\.com\/(terms|privacy)$/);
    }
  });
});
