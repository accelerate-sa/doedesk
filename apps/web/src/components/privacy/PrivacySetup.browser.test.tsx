import type {
  PrivacyLegal,
  PrivacyLocale,
  PrivacySignInResult,
  PrivacyStatus,
} from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import { type Locator, userEvent } from "vite-plus/test/browser";

import { CLOUD_MESSAGES, SIGN_UP_UNAVAILABLE } from "~/doedesk/privacyMessages";
import { render } from "../../../test/render";
import { PrivacySetup } from "./PrivacySetup";

const client = vi.hoisted(() => ({
  configurePrivacy: vi.fn(),
  signInToCloud: vi.fn(),
  useSignInOptions: vi.fn(),
  useConsentLocale: vi.fn(),
  refreshSignInOptions: vi.fn(),
}));
vi.mock("~/privacy/privacyClient", () => client);

const LEGAL: PrivacyLegal = {
  terms: {
    version: "1.1",
    url: { en: "https://doedesk.com/terms", ar: "https://doedesk.com/ar/terms" },
  },
  privacy: {
    version: "1.1",
    url: { en: "https://doedesk.com/privacy", ar: "https://doedesk.com/ar/privacy" },
  },
};

const status = (overrides: Partial<PrivacyStatus> = {}): PrivacyStatus => ({
  mode: "unconfigured",
  active: true,
  accountLabel: null,
  endpoint: null,
  vaultSize: 0,
  problem: null,
  profileAnswered: false,
  legal: LEGAL,
  ...overrides,
});

const answer = (overrides: Partial<PrivacySignInResult> = {}): PrivacySignInResult => ({
  ok: true,
  message: null,
  methods: null,
  requestId: null,
  resendIn: null,
  signedIn: false,
  status: status(),
  ...overrides,
});

const refusal = (code: string, overrides: Partial<PrivacySignInResult> = {}) =>
  answer({ ok: false, code, message: `The service said ${code}.`, ...overrides });

// A DOM click, not a pointer click: the test is about what the form submits, not hit-testing.
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

const setup = async (
  methods: ReadonlyArray<"phone" | "email">,
  initial = status(),
  options: {
    readonly locale?: PrivacyLocale;
    readonly signUpAvailable?: boolean;
    readonly reached?: boolean;
  } = {},
) => {
  client.configurePrivacy.mockReset();
  client.signInToCloud.mockReset();
  client.refreshSignInOptions.mockReset();
  client.useSignInOptions.mockReturnValue({
    methods,
    signUpAvailable: options.signUpAvailable ?? true,
    reached: options.reached ?? true,
  });
  client.useConsentLocale.mockReturnValue([
    options.locale ?? "en",
    vi.fn(),
    options.locale === "ar",
  ]);
  const onStatus = vi.fn();
  const screen = await render(<PrivacySetup status={initial} onStatus={onStatus} />, {
    // The component has no links or navigation.
    router: false,
  });
  return { screen, onStatus };
};

const ACCEPTED = {
  termsVersion: "1.1",
  privacyVersion: "1.1",
  locale: "en",
  wordingId: "signup-2026-11-19",
};

describe("PrivacySetup", () => {
  it("signs in with a phone code where phone sign-in is offered", async () => {
    const signedIn = status({ mode: "cloud", accountLabel: "+96655•••567" });
    const { screen, onStatus } = await setup(["phone", "email"]);
    await using _ = screen;
    client.signInToCloud.mockImplementation(async (payload: { step: string }) =>
      payload.step === "phoneStart"
        ? answer({ requestId: "r1", resendIn: 60 })
        : answer({ signedIn: true, status: signedIn }),
    );

    await userEvent.type(screen.getByLabelText("Mobile number"), "0551234567");
    await toggle(screen.getByRole("checkbox"));
    await press(screen.getByRole("button", { name: "Agree and send code" }));
    await expect.element(screen.getByText("0551234567")).toBeVisible();
    await expect.element(screen.getByRole("button", { name: /Resend in/ })).toBeDisabled();
    // The sixth digit submits the code without a press.
    await userEvent.type(screen.getByLabelText("Verification code"), "123456");

    await vi.waitFor(() => expect(onStatus).toHaveBeenCalledWith(signedIn));
    // What was on the screen goes with the request: these versions, this language, this wording.
    expect(client.signInToCloud).toHaveBeenNthCalledWith(1, {
      step: "phoneStart",
      phone: "0551234567",
      purpose: "signIn",
      acceptance: ACCEPTED,
    });
    expect(client.signInToCloud).toHaveBeenNthCalledWith(2, {
      step: "phoneVerify",
      requestId: "r1",
      code: "123456",
    });
  });

  it("asks for no code or link until the box is ticked, and starts unticked every time", async () => {
    const { screen } = await setup(["phone", "email"]);
    await using _ = screen;
    client.signInToCloud.mockResolvedValue(answer({ requestId: "r1", resendIn: 60 }));
    const send = screen.getByRole("button", { name: "Agree and send code" });

    await userEvent.type(screen.getByLabelText("Mobile number"), "0551234567");
    await expect.element(screen.getByRole("checkbox")).not.toBeChecked();
    await expect.element(send).toBeDisabled();
    // Enter in the field sends nothing either: a form whose button is disabled is not submitted.
    await userEvent.keyboard("{Enter}");
    expect(client.signInToCloud).not.toHaveBeenCalled();

    await toggle(screen.getByRole("checkbox"));
    await press(send);
    await press(screen.getByRole("button", { name: "Use another number" }));
    await expect.element(screen.getByRole("checkbox")).not.toBeChecked();
    await expect.element(send).toBeDisabled();
  });

  it("links to both documents without ticking the box or sending the form", async () => {
    const { screen } = await setup(["email"]);
    await using _ = screen;
    const terms = screen.getByRole("link", { name: "Terms of Use" });
    await expect.element(terms).toHaveAttribute("href", "https://doedesk.com/terms");
    await expect.element(terms).toHaveAttribute("target", "_blank");
    for (const link of screen.getByRole("link", { name: "Privacy Policy" }).elements()) {
      expect(link.getAttribute("href")).toBe("https://doedesk.com/privacy");
    }

    // Followed in place of opening a tab, to see what else the press does.
    const element = terms.element() as HTMLAnchorElement;
    element.addEventListener("click", (event) => event.preventDefault(), { once: true });
    element.click();
    await expect.element(screen.getByRole("checkbox")).not.toBeChecked();
    expect(client.signInToCloud).not.toHaveBeenCalled();
  });

  it("shows the consent texts in Arabic and says so in what it sends", async () => {
    const { screen } = await setup(["email"], status(), { locale: "ar" });
    await using _ = screen;
    client.signInToCloud.mockResolvedValue(answer({ requestId: "r2" }));

    const box = screen.getByRole("checkbox");
    const sentence = screen.getByText(/عمري 18 عامًا أو أكثر/);
    await expect.element(sentence).toBeVisible();
    expect((sentence.element() as HTMLElement).closest("[dir]")?.getAttribute("dir")).toBe("rtl");
    await expect
      .element(screen.getByRole("link", { name: "شروط الاستخدام" }))
      .toHaveAttribute("href", "https://doedesk.com/ar/terms");
    await expect.element(screen.getByRole("button", { name: "English" })).toBeVisible();

    await userEvent.type(screen.getByLabelText("Email"), "sara@example.com");
    await toggle(box);
    await press(screen.getByRole("button", { name: "موافق، أرسل الرابط" }));
    await vi.waitFor(() =>
      expect(client.signInToCloud).toHaveBeenCalledWith({
        step: "emailStart",
        email: "sara@example.com",
        locale: "ar",
        purpose: "signIn",
        acceptance: { ...ACCEPTED, locale: "ar" },
      }),
    );
  });

  it("offers only email elsewhere, and signs in once the emailed link is opened", async () => {
    const signedIn = status({ mode: "cloud", accountLabel: "sara@example.com" });
    const { screen, onStatus } = await setup(["email"]);
    await using _ = screen;
    let opened = false;
    client.signInToCloud.mockImplementation(async (payload: { step: string }) => {
      if (payload.step === "emailStart") return answer({ requestId: "r2" });
      return opened ? answer({ signedIn: true, status: signedIn }) : answer();
    });

    expect(screen.getByLabelText("Mobile number").query()).toBeNull();
    expect(screen.getByRole("button", { name: "Phone" }).query()).toBeNull();
    await userEvent.type(screen.getByLabelText("Email"), "sara@example.com");
    await toggle(screen.getByRole("checkbox"));
    await press(screen.getByRole("button", { name: "Agree and send link" }));
    await expect
      .element(screen.getByText(/Check your inbox and open the sign-in link sent to/))
      .toBeVisible();
    expect(onStatus).not.toHaveBeenCalled();

    opened = true;
    await vi.waitFor(() => expect(onStatus).toHaveBeenCalledWith(signedIn), { timeout: 6000 });
    expect(client.signInToCloud).toHaveBeenCalledWith({ step: "emailCheck", requestId: "r2" });
  });

  it.each([
    ["terms_required", "Tick the box to continue."],
    ["invalid_acceptance", CLOUD_MESSAGES.invalid_acceptance!],
    ["terms_outdated", CLOUD_MESSAGES.terms_outdated!],
    ["too_many_requests", CLOUD_MESSAGES.too_many_requests!],
    // A code DoeDesk has no words for keeps the service's own.
    ["invalid_email", "The service said invalid_email."],
  ] as const)("says what to do when the service answers %s", async (code, message) => {
    const { screen } = await setup(["email"]);
    await using _ = screen;
    using _error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    client.signInToCloud.mockResolvedValue(refusal(code));

    await userEvent.type(screen.getByLabelText("Email"), "sara@example.com");
    await toggle(screen.getByRole("checkbox"));
    await press(screen.getByRole("button", { name: "Agree and send link" }));

    await expect.element(screen.getByRole("alert")).toHaveTextContent(message);
    await expect.element(screen.getByLabelText("Email")).toBeVisible();
  });

  it("shows the new documents and asks again when the Terms changed under the form", async () => {
    const newer = { ...LEGAL, terms: { ...LEGAL.terms, version: "1.2" } };
    const { screen, onStatus } = await setup(["email"]);
    await using _ = screen;
    client.signInToCloud.mockResolvedValue(
      refusal("terms_outdated", { status: status({ legal: newer }) }),
    );

    await userEvent.type(screen.getByLabelText("Email"), "sara@example.com");
    await toggle(screen.getByRole("checkbox"));
    await press(screen.getByRole("button", { name: "Agree and send link" }));

    // The parent now holds the versions in force; the tick for the old ones does not carry over.
    await vi.waitFor(() => expect(onStatus).toHaveBeenCalledWith(status({ legal: newer })));
    await expect.element(screen.getByRole("checkbox")).not.toBeChecked();
  });

  it("says where no account can be created, and what still works there", async () => {
    const { screen } = await setup(["phone", "email"], status(), { signUpAvailable: false });
    await using _ = screen;
    client.signInToCloud.mockImplementation(async (payload: { step: string }) =>
      payload.step === "phoneStart"
        ? answer({ requestId: "r1", resendIn: 60 })
        : refusal("signup_unavailable"),
    );
    client.configurePrivacy.mockResolvedValue({
      ok: true,
      message: null,
      status: status({ mode: "off" }),
    });
    const notice = SIGN_UP_UNAVAILABLE;

    await expect.element(screen.getByText(notice)).toBeVisible();
    await expect
      .element(screen.getByRole("button", { name: "Use my own detection service" }))
      .toBeVisible();
    // An existing account can still sign in, so the form stays; a new one is refused at the code.
    await userEvent.type(screen.getByLabelText("Mobile number"), "0551234567");
    await toggle(screen.getByRole("checkbox"));
    await press(screen.getByRole("button", { name: "Agree and send code" }));
    await userEvent.type(screen.getByLabelText("Verification code"), "123456");
    await expect.element(screen.getByRole("alert")).toHaveTextContent(notice);
    await expect.element(screen.getByLabelText("Mobile number")).toBeVisible();

    await press(screen.getByRole("button", { name: "Use DoeDesk without de-identification" }));
    await vi.waitFor(() => expect(client.configurePrivacy).toHaveBeenCalledWith({ mode: "off" }));
  });

  it("shows no checkbox when the service did not say which documents apply", async () => {
    const { screen } = await setup(["email"], status(), { reached: false });
    await using _ = screen;

    await expect.element(screen.getByText(/to load the current Terms of Use/)).toBeVisible();
    expect(screen.getByRole("checkbox").query()).toBeNull();
    await expect
      .element(screen.getByRole("button", { name: "Agree and send link" }))
      .toBeDisabled();
    await press(screen.getByRole("button", { name: "Try again" }));
    expect(client.refreshSignInOptions).toHaveBeenCalled();
  });

  it("shows the service's reason for a wrong code and keeps the code form", async () => {
    const { screen } = await setup(["phone", "email"]);
    await using _ = screen;
    client.signInToCloud.mockImplementation(async (payload: { step: string }) =>
      payload.step === "phoneStart"
        ? answer({ requestId: "r1", resendIn: 60 })
        : answer({ ok: false, message: "That code is not right." }),
    );

    await userEvent.type(screen.getByLabelText("Mobile number"), "0551234567");
    await toggle(screen.getByRole("checkbox"));
    await press(screen.getByRole("button", { name: "Agree and send code" }));
    await userEvent.type(screen.getByLabelText("Verification code"), "000000");

    await expect.element(screen.getByRole("alert")).toHaveTextContent("That code is not right.");
    await expect.element(screen.getByLabelText("Verification code")).toBeVisible();
  });

  it("connects a self-hosted service with the address the user typed", async () => {
    const { screen } = await setup(["email"]);
    await using _ = screen;
    client.configurePrivacy.mockResolvedValue({
      ok: true,
      message: null,
      status: status({ mode: "selfHosted", endpoint: "http://localhost:8080" }),
    });

    await press(screen.getByRole("button", { name: "Use my own detection service" }));
    // That path creates no account, so it asks nobody to agree to anything.
    expect(screen.getByRole("checkbox").query()).toBeNull();
    await userEvent.type(screen.getByLabelText("Service address"), "http://localhost:8080");
    await press(screen.getByRole("button", { name: "Connect" }));

    await vi.waitFor(() =>
      expect(client.configurePrivacy).toHaveBeenCalledWith({
        mode: "selfHosted",
        endpoint: "http://localhost:8080",
      }),
    );
  });

  it("says masking is on, who is signed in, and signs out", async () => {
    const { screen, onStatus } = await setup(
      ["email"],
      status({ mode: "cloud", accountLabel: "sara@example.com" }),
    );
    await using _ = screen;
    client.configurePrivacy.mockResolvedValue({ ok: true, message: null, status: status() });

    await expect.element(screen.getByText("De-identification is on")).toBeVisible();
    await expect.element(screen.getByText("sara@example.com")).toBeVisible();
    await press(screen.getByRole("button", { name: "Sign out" }));

    await vi.waitFor(() => expect(onStatus).toHaveBeenCalledWith(status()));
    expect(client.configurePrivacy).toHaveBeenCalledWith({ mode: "unconfigured" });
  });
});
