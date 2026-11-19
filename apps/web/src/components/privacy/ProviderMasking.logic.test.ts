import type { PrivacyStatus, ServerProvider } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { isProviderOffered, maskedRowText, providerWords } from "~/doedesk/providerConnections";
import { maskedProviders, pendingNotice } from "./ProviderMasking.logic";

const status = (overrides: Partial<PrivacyStatus> = {}): PrivacyStatus => ({
  mode: "cloud",
  active: true,
  accountLabel: null,
  endpoint: null,
  vaultSize: 0,
  problem: null,
  profileAnswered: true,
  directProviders: [],
  noticesRead: [],
  ...overrides,
});

/** What a server from before this setting answers: the newer fields are absent. */
const {
  noticesRead: _noticesRead,
  directProviders: _directProviders,
  ...olderServerStatus
} = status();

const provider = (driver: string, signedIn = true, enabled = true) =>
  ({
    driver,
    enabled,
    installed: true,
    auth: { status: signedIn ? "authenticated" : "unauthenticated" },
  }) as never as ServerProvider;

describe("pendingNotice", () => {
  const providers = [provider("claudeAgent"), provider("codex")];

  it("is due for the first signed-in provider whose requests are masked and unread", () => {
    expect(pendingNotice(status(), providers)?.driver).toBe("claudeAgent");
    expect(pendingNotice(status({ noticesRead: ["claudeAgent"] }), providers)?.driver).toBe(
      "codex",
    );
    expect(
      pendingNotice(
        status({ noticesRead: ["claudeAgent"], directProviders: ["codex"] }),
        providers,
      ),
    ).toBeUndefined();
  });

  it.each([
    ["masking is off", status({ mode: "off" }), providers],
    ["no detection service is connected yet", status({ mode: "unconfigured" }), providers],
    ["the user is not signed in to the provider", status(), [provider("claudeAgent", false)]],
    ["the provider is switched off", status(), [provider("claudeAgent", true, false)]],
    ["the server is too old to remember it", olderServerStatus, providers],
  ] as const)("is not due when %s", (_name, current, list) => {
    expect(pendingNotice(current, list)).toBeUndefined();
  });
});

describe("isProviderOffered", () => {
  it.each(["antigravity", "pi"])("offers %s only in Developer mode", (driver) => {
    expect(isProviderOffered(driver, false)).toBe(false);
    expect(isProviderOffered(driver, true)).toBe(true);
  });

  it.each(["claudeAgent", "codex", "cursor"])("always offers %s", (driver) => {
    expect(isProviderOffered(driver, false)).toBe(true);
  });
});

describe("maskedProviders", () => {
  it("counts a provider as set up only when it is installed and not signed out", () => {
    const listed = (auth: string, installed: boolean) =>
      maskedProviders([
        { driver: "codex", enabled: true, installed, auth: { status: auth } } as never,
      ])[0]?.setUp;
    expect(listed("authenticated", true)).toBe(true);
    // An API key gives no sign-in to check.
    expect(listed("unknown", true)).toBe(true);
    expect(listed("unauthenticated", true)).toBe(false);
    expect(listed("authenticated", false)).toBe(false);
  });

  it("names who receives a provider's requests without repeating the provider", () => {
    expect(maskedRowText(providerWords("acpRegistry", "ACP Registry"))).toBe(
      "DoeDesk masks personal details in what an agent from the ACP Registry sends to the AI company that agent uses.",
    );
    expect(maskedRowText(providerWords("claudeAgent", "Claude"))).toBe(
      "DoeDesk masks personal details in what Claude Code sends to Anthropic.",
    );
  });
});
