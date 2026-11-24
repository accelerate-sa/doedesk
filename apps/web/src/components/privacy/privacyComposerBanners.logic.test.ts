import type { PrivacyStatus } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { refusedHostsToShow, watchesRefusedHosts } from "./privacyComposerBanners.logic";

const status = (egress: PrivacyStatus["egress"], mode: PrivacyStatus["mode"] = "cloud") =>
  ({ mode, egress }) as PrivacyStatus;

const refused = [
  { host: "github.com", at: "2026-11-23T10:00:02.000Z" },
  { host: "registry.npmjs.org", at: "2026-11-23T10:00:01.000Z" },
  { host: "example.com", at: "2026-11-23T10:00:00.000Z" },
];

describe("refused hosts by the composer", () => {
  it("shows the newest two, and offers a lasting allow only where there is a list", () => {
    expect(
      refusedHostsToShow(status({ policy: "allowlist", hosts: [], refused }), new Set()),
    ).toEqual([
      { host: "github.com", key: "github.com@2026-11-23T10:00:02.000Z", canAllowAlways: true },
      {
        host: "registry.npmjs.org",
        key: "registry.npmjs.org@2026-11-23T10:00:01.000Z",
        canAllowAlways: true,
      },
    ]);
    expect(
      refusedHostsToShow(status({ policy: "closed", hosts: [], refused }), new Set()).map(
        (entry) => entry.canAllowAlways,
      ),
    ).toEqual([false, false]);
  });

  it("leaves out a refusal that was waved away, until the host is refused again", () => {
    const rule = { policy: "allowlist", hosts: [] } as const;
    const dismissed = new Set(["github.com@2026-11-23T10:00:02.000Z"]);
    expect(
      refusedHostsToShow(status({ ...rule, refused }), dismissed).map((entry) => entry.host),
    ).toEqual(["registry.npmjs.org", "example.com"]);
    const again = [{ host: "github.com", at: "2026-11-23T10:05:00.000Z" }];
    expect(
      refusedHostsToShow(status({ ...rule, refused: again }), dismissed).map((entry) => entry.host),
    ).toEqual(["github.com"]);
  });

  it("shows nothing, and watches nothing, with any host allowed or masking off", () => {
    const open = status({ policy: "open", hosts: [], refused });
    const off = status({ policy: "closed", hosts: [], refused }, "off");
    for (const current of [open, off, status(undefined), null]) {
      expect(refusedHostsToShow(current, new Set())).toEqual([]);
      expect(watchesRefusedHosts(current)).toBe(false);
    }
    expect(watchesRefusedHosts(status({ policy: "closed", hosts: [] }))).toBe(true);
  });
});
