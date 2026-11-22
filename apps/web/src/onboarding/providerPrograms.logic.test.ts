import {
  ProviderDriverKind,
  type ProviderFind,
  ProviderInstanceId,
  type ServerProvider,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  groupProviderPrograms,
  manualProgramPlaceholder,
  volumesToOffer,
} from "./providerPrograms.logic";

function provider(driver: string, overrides: Partial<ServerProvider> = {}): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make(driver),
    driver: ProviderDriverKind.make(driver),
    enabled: true,
    installed: true,
    version: "1.0.0",
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-11-19T00:00:00.000Z",
    models: [],
    slashCommands: [],
    skills: [],
    ...overrides,
  };
}

const find = (driver: string, path: string, source: ProviderFind["source"]): ProviderFind => ({
  driver: ProviderDriverKind.make(driver),
  path,
  source,
  version: "2.0.0",
});

const FINDS = [
  find("claudeAgent", "/Users/sam/.local/bin/claude", "path"),
  find("claudeAgent", "/Volumes/work/tools/bin/claude", "volume"),
  find("claudeAgent", "/Users/sam/.local/bin/claude", "knownLocation"),
  find("codex", "/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex", "appBundle"),
];

describe("groupProviderPrograms", () => {
  it("marks the PATH program in use when nothing else is set", () => {
    const groups = groupProviderPrograms({
      providers: [
        provider("claudeAgent"),
        provider("codex", { installed: false }),
        provider("grok"),
      ],
      finds: FINDS,
      settings: null,
    });
    expect(groups.map((group) => [group.provider.driver, group.finds.length, group.inUse])).toEqual(
      [
        ["claudeAgent", 2, "/Users/sam/.local/bin/claude"],
        ["codex", 1, null],
      ],
    );
  });

  it("marks the chosen program in use, as remembered in the provider's settings", () => {
    const [claude] = groupProviderPrograms({
      providers: [provider("claudeAgent")],
      finds: FINDS,
      settings: {
        providerInstances: {
          [ProviderInstanceId.make("claudeAgent")]: {
            driver: ProviderDriverKind.make("claudeAgent"),
            config: { binaryPath: "/Volumes/work/tools/bin/claude" },
          },
        },
      },
    });
    expect(claude?.inUse).toBe("/Volumes/work/tools/bin/claude");
  });

  it("recognizes Windows configured binary paths with backslashes", () => {
    const winPath = "C:\\Users\\sam\\.local\\bin\\claude.exe";
    const [claude] = groupProviderPrograms({
      providers: [provider("claudeAgent")],
      finds: [find("claudeAgent", winPath, "knownLocation")],
      settings: {
        providerInstances: {
          [ProviderInstanceId.make("claudeAgent")]: {
            driver: ProviderDriverKind.make("claudeAgent"),
            config: { binaryPath: winPath },
          },
        },
      },
    });
    expect(claude?.inUse).toBe(winPath);
  });
});

describe("manualProgramPlaceholder", () => {
  it("matches the target computer's operating system", () => {
    expect(manualProgramPlaceholder("win32")).toBe("C:\\Users\\name\\.local\\bin\\claude.exe");
    expect(manualProgramPlaceholder("darwin")).toBe("/usr/local/bin/claude");
    expect(manualProgramPlaceholder("linux")).toBe("/usr/local/bin/claude");
    expect(manualProgramPlaceholder(undefined)).toBe("/usr/local/bin/claude");
  });
});

describe("volumesToOffer", () => {
  it("offers local drives, and the rest only when asked", () => {
    const volumes = [
      { path: "/Volumes/work", name: "work", kind: "local" },
      { path: "/Volumes/Team", name: "Team", kind: "network" },
      { path: "/Volumes/Setup", name: "Setup", kind: "diskImage" },
    ] as const;
    expect(volumesToOffer(volumes, false).map((volume) => volume.name)).toEqual(["work"]);
    expect(volumesToOffer(volumes, true)).toHaveLength(3);
  });
});
