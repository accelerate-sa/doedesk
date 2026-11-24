import type { PrivacyStatus, PrivacyTurnRecord, RunId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  chatMaskingState,
  markedRunIds,
  threadRunPrivacy,
  turnPrivacyHeadline,
  type ThreadRunPrivacy,
} from "./threadPrivacy.ts";

const status = (fields: Partial<PrivacyStatus> = {}): PrivacyStatus => ({
  mode: "cloud",
  active: true,
  accountLabel: null,
  endpoint: null,
  vaultSize: 0,
  problem: null,
  profileAnswered: true,
  directProviders: [],
  ...fields,
});

const masked = (fields: Partial<Extract<PrivacyTurnRecord, { state: "masked" }>> = {}) =>
  ({
    state: "masked",
    replaced: [
      { kind: "PERSON", count: 2 },
      { kind: "IBAN", count: 1 },
    ],
    rewritten: 3,
    refused: 0,
    redacted: 0,
    read: 0,
    withheld: 0,
    sealed: 0,
    attribution: "session",
    ...fields,
  }) satisfies PrivacyTurnRecord;

const turns = (...records: ReadonlyArray<PrivacyTurnRecord>): ReadonlyArray<ThreadRunPrivacy> =>
  records.map((privacy, index) => ({ runId: `run-${index}` as RunId, privacy }));

describe("chatMaskingState", () => {
  it.each([
    [
      "masking on, a measured tool",
      status(),
      "claudeAgent",
      turns(),
      { kind: "masked", sealed: 2 },
    ],
    [
      "masking turned off",
      status({ mode: "off", active: false }),
      "claudeAgent",
      turns(masked()),
      { kind: "notMasked", reason: "off" },
    ],
    [
      "masking turned off for this tool only",
      status({ directProviders: ["codex"] }),
      "codex",
      turns(masked()),
      { kind: "notMasked", reason: "direct" },
    ],
    [
      "another tool is direct, this one is not",
      status({ directProviders: ["codex"] }),
      "claudeAgent",
      turns(),
      { kind: "masked", sealed: 2 },
    ],
    [
      "masking turned back on after an unmasked turn",
      status(),
      "claudeAgent",
      turns({ state: "unmasked", reason: "off" }),
      { kind: "masked", sealed: 2 },
    ],
    [
      "not set up yet: requests are refused",
      status({ mode: "unconfigured" }),
      "claudeAgent",
      turns(),
      { kind: "notSending", reason: "notSetUp" },
    ],
    [
      "the gateway did not start",
      status({ active: false, problem: "The privacy gateway could not start" }),
      "claudeAgent",
      turns(),
      { kind: "notSending", reason: "stopped" },
    ],
    [
      "DoeDesk Cloud refuses until the Terms are accepted",
      status({
        acceptance: {
          outstanding: true,
          blocked: true,
          termsVersion: null,
          privacyVersion: null,
          acceptedAt: null,
        },
      }),
      "claudeAgent",
      turns(),
      { kind: "notSending", reason: "terms" },
    ],
    [
      "a tool whose model hosts the gateway refuses",
      status(),
      "cursor",
      turns(),
      { kind: "notSending", reason: "blocked" },
    ],
    [
      "a tool nobody measured, before any turn",
      status(),
      "kiro",
      turns(),
      { kind: "unconfirmed", reason: "unmeasured" },
    ],
    [
      "a tool nobody measured, after a turn that was rewritten",
      status(),
      "kiro",
      turns(masked()),
      { kind: "masked", sealed: 2 },
    ],
    [
      "a measured tool whose last turn the gateway did not see",
      status(),
      "claudeAgent",
      turns(masked(), { state: "unseen" }),
      { kind: "unconfirmed", reason: "unseen" },
    ],
    [
      "a turn where every request was refused proves nothing about masking",
      status(),
      "kiro",
      turns(masked({ rewritten: 0, refused: 2, replaced: [] })),
      { kind: "unconfirmed", reason: "unmeasured" },
    ],
  ] as const)("%s", (_name, privacyStatus, driver, records, expected) => {
    expect(chatMaskingState({ status: privacyStatus, driver, turns: records, sealed: 2 })).toEqual(
      expected,
    );
  });

  it("says only what the chat's own last turn shows when it runs on another computer", () => {
    const remote = (records: ReadonlyArray<ThreadRunPrivacy>) =>
      chatMaskingState({ status: null, driver: "claudeAgent", turns: records, sealed: 2 });
    expect(remote(turns())).toBeNull();
    expect(remote(turns(masked()))).toEqual({ kind: "masked", sealed: 0 });
    expect(remote(turns(masked(), { state: "unmasked", reason: "direct" }))).toEqual({
      kind: "notMasked",
      reason: "direct",
    });
    expect(remote(turns({ state: "unseen" }))).toEqual({ kind: "unconfirmed", reason: "unseen" });
  });
});

describe("turnPrivacyHeadline", () => {
  it.each([
    [masked(), { kind: "replaced", count: 3 }],
    [masked({ replaced: [] }), { kind: "nothingFound" }],
    [masked({ replaced: [], rewritten: 0, refused: 2 }), { kind: "notSent", count: 2 }],
    [{ state: "unmasked", reason: "off" }, { kind: "unmasked" }],
    [{ state: "unseen" }, { kind: "unseen" }],
  ] as const)("%j", (record, expected) => {
    expect(turnPrivacyHeadline(record)).toEqual(expected);
  });
});

describe("markedRunIds", () => {
  it("marks turns with a replacement, and none from before a turn sent without masking", () => {
    const nothingFound = masked({ replaced: [] });
    const unmasked: PrivacyTurnRecord = { state: "unmasked", reason: "direct" };
    expect(markedRunIds(turns(masked(), nothingFound, { state: "unseen" }, masked()))).toEqual([
      "run-0",
      "run-3",
    ]);
    // The unmasked turn resent the first two as written.
    expect(markedRunIds(turns(masked(), masked(), unmasked, masked()))).toEqual(["run-3"]);
    expect(markedRunIds(turns(masked(), unmasked))).toEqual([]);
  });
});

describe("threadRunPrivacy", () => {
  it("lists recorded runs oldest first and skips the rest", () => {
    const run = (id: string, ordinal: number, privacy?: PrivacyTurnRecord) =>
      ({ id, ordinal, ...(privacy === undefined ? {} : { privacy }) }) as never;
    expect(
      threadRunPrivacy([
        run("run-3", 3, { state: "unseen" }),
        run("run-2", 2),
        run("run-1", 1, { state: "unmasked", reason: "off" }),
      ]),
    ).toEqual([
      { runId: "run-1", privacy: { state: "unmasked", reason: "off" } },
      { runId: "run-3", privacy: { state: "unseen" } },
    ]);
  });
});
