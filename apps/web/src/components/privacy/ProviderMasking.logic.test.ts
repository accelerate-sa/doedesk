import type { PrivacyStatus, ServerProvider } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { isProviderOffered, maskedRowText, providerWords } from "~/doedesk/providerConnections";
import {
  driversInUse,
  maskedProviders,
  pendingNotice,
  unreadNotices,
} from "./ProviderMasking.logic";

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

describe("a provider's notice", () => {
  const providers = [provider("claudeAgent"), provider("codex")];
  const drivers = (list: ReadonlyArray<{ readonly driver: string }>) =>
    list.map((entry) => entry.driver);

  it("is unread for each signed-in provider whose requests are masked, until it is read", () => {
    expect(drivers(unreadNotices(status(), providers))).toEqual(["claudeAgent", "codex"]);
    expect(drivers(unreadNotices(status({ noticesRead: ["claudeAgent"] }), providers))).toEqual([
      "codex",
    ]);
    expect(
      unreadNotices(
        status({ noticesRead: ["claudeAgent"], directProviders: ["codex"] }),
        providers,
      ),
    ).toEqual([]);
  });

  it.each([
    ["masking is off", status({ mode: "off" }), providers],
    ["no detection service is connected yet", status({ mode: "unconfigured" }), providers],
    ["the user is not signed in to the provider", status(), [provider("claudeAgent", false)]],
    ["the provider is switched off", status(), [provider("claudeAgent", true, false)]],
    ["the server is too old to remember it", olderServerStatus, providers],
  ] as const)("is not unread when %s", (_name, current, list) => {
    expect(unreadNotices(current, list)).toEqual([]);
  });

  it("is shown for the provider a chat is starting with, and for no other", () => {
    // Just set up, no chat yet: nothing opens over the app.
    expect(pendingNotice(status(), providers, new Set(), null)).toBeUndefined();
    // The person pressed Send in a chat with ChatGPT: that notice, before the message goes.
    expect(pendingNotice(status(), providers, new Set(), "codex")?.driver).toBe("codex");
    // A chat with a provider already exists (an agent or a schedule started it): its notice.
    expect(pendingNotice(status(), providers, new Set(["codex"]), null)?.driver).toBe("codex");
    expect(
      pendingNotice(status({ noticesRead: ["codex"] }), providers, new Set(["codex"]), "codex"),
    ).toBeUndefined();
  });

  it("counts a provider as in use once this computer has a chat with it", () => {
    const here = "this-computer";
    const instances = [
      { instanceId: "claude-1", driver: "claudeAgent" },
      { instanceId: "codex-1", driver: "codex" },
    ] as never as ReadonlyArray<ServerProvider>;
    const chat = (environmentId: string, providerInstanceId: string, latestRun: unknown = {}) =>
      ({ environmentId, providerInstanceId, latestRun }) as never;
    expect([...driversInUse([chat(here, "codex-1")], instances, here)]).toEqual(["codex"]);
    // A chat nothing was sent in yet, such as the one a new server opens with, is not a use.
    expect([...driversInUse([chat(here, "codex-1", null)], instances, here)]).toEqual([]);
    // A chat on another computer is masked by that computer, under its own notices.
    expect([...driversInUse([chat("office", "claude-1")], instances, here)]).toEqual([]);
    expect([...driversInUse([], instances, here)]).toEqual([]);
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
