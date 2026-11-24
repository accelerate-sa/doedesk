import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { describe, expect, it } from "vite-plus/test";

import type { GatewayRecord } from "./gateway.ts";
import { sessionsNamedIn, standInsByKind, TurnLedger } from "./turns.ts";

const SESSION = "f4206ace-2856-4b36-950d-7168209aca03";

const masked = (fields: Partial<GatewayRecord> = {}): GatewayRecord => ({
  at: "2026-11-23T00:00:00.000Z",
  host: "api.anthropic.com",
  path: "/v1/messages",
  outcome: "masked",
  format: "anthropic-messages",
  sessions: [SESSION],
  ...fields,
});

describe("sessionsNamedIn", () => {
  it.each([
    // Claude Code 2.1, as recorded on 22 November 2026: a JSON document inside the string.
    [
      {},
      {
        metadata: {
          user_id: JSON.stringify({ device_id: "c2d0", account_uuid: "5085", session_id: SESSION }),
        },
      },
      [SESSION],
    ],
    // Claude Code before that.
    [{}, { metadata: { user_id: `user_ab12_account_5085_session_${SESSION}` } }, [SESSION]],
    // Codex 0.170 names both headers; which one the server knows the chat by is not assumed.
    [
      { session_id: "codex-session", thread_id: "codex-thread" },
      { prompt_cache_key: "codex-thread" },
      ["codex-thread", "codex-session"],
    ],
    [{}, { metadata: { user_id: "someone" } }, []],
    [{}, { messages: [{ role: "user", content: `session_id ${SESSION}` }] }, []],
    [{}, "not an object", []],
  ])("reads the chat's names from %j %j", (headers, body, expected) => {
    expect(sessionsNamedIn(headers, body)).toEqual(expected);
  });
});

describe("TurnLedger", () => {
  it("counts each chat apart, and a turn only once", () => {
    const ledger = new TurnLedger();
    // A client sends the whole chat again with every request: the same value, the same image.
    ledger.add(masked({ replaced: ["[PERSON_AAAAA]"], redacted: 1 }));
    ledger.add(masked({ replaced: ["[PERSON_AAAAA]", "[IBAN_BBBBB]"], redacted: 1, read: 2 }));
    ledger.add(masked({ outcome: "refused", reason: "The detection service did not answer." }));
    // A chat is found by any of the names its requests carried.
    ledger.add(
      masked({ sessions: ["another-thread", "another-chat"], replaced: ["[PERSON_CCCCC]"] }),
    );
    ledger.add(masked({ sessions: ["another-chat"], replaced: ["[PERSON_CCCCC]"] }));
    // A value the model used from an earlier turn: no request of this turn wrote its stand-in,
    // and the reply the person read had it restored.
    ledger.restored([SESSION], ["[EMAIL_EEEEE]", "[PERSON_AAAAA]"]);
    // Usage reports and other requests the gateway only forwards say nothing about a turn.
    ledger.add({
      at: "",
      host: "api.anthropic.com",
      path: "/api/event_logging",
      outcome: "passed",
    });

    expect(ledger.take(["never-seen", SESSION])).toEqual({
      rewritten: 2,
      refused: 1,
      replaced: ["[PERSON_AAAAA]", "[IBAN_BBBBB]", "[EMAIL_EEEEE]"],
      redacted: 1,
      read: 2,
      withheld: 0,
      sealed: 0,
      attribution: "session",
    });
    expect(ledger.take([SESSION])).toBeUndefined();
    expect(ledger.take(["another-thread"])).toMatchObject({
      rewritten: 2,
      replaced: ["[PERSON_CCCCC]"],
    });
  });

  it("says so when the requests named no chat", () => {
    const ledger = new TurnLedger();
    const { sessions: _sessions, ...unnamed } = masked({ replaced: ["[ORG_DDDDD]"] });
    ledger.add(unnamed);
    ledger.add(masked({ replaced: ["[PERSON_AAAAA]"] }));
    // A chat whose own requests were counted never takes the unnamed ones.
    expect(ledger.take([SESSION])?.attribution).toBe("session");
    expect(ledger.take(["a-provider-that-names-nothing"])).toMatchObject({
      replaced: ["[ORG_DDDDD]"],
      attribution: "time",
    });
  });

  it("keeps the stand-ins of the latest turns across a restart, and no more than its limit", () => {
    const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "doedesk-turns-"));
    try {
      const filePath = NodePath.join(directory, "turns.json");
      const ledger = new TurnLedger(filePath, { kept: 2 });
      ledger.keep("run-1", ["[PERSON_AAAAA]"]);
      ledger.keep("run-2", ["[IBAN_BBBBB]"]);
      ledger.keep("run-3", ["[ORG_DDDDD]"]);
      ledger.flush();
      const reopened = new TurnLedger(filePath);
      expect(reopened.kept("run-1")).toBeUndefined();
      expect(reopened.kept("run-3")).toEqual(["[ORG_DDDDD]"]);
      // Stand-ins only: the file never holds a value.
      expect(NodeFS.readFileSync(filePath, "utf8")).toBe(
        JSON.stringify({ "run-2": ["[IBAN_BBBBB]"], "run-3": ["[ORG_DDDDD]"] }),
      );
    } finally {
      NodeFS.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("forgets chats nobody asks about", () => {
    const ledger = new TurnLedger(undefined, { open: 2 });
    for (const session of ["title-1", "title-2", "title-3"]) {
      ledger.add(masked({ sessions: [session] }));
    }
    expect(ledger.take(["title-1"])).toBeUndefined();
    expect(ledger.take(["title-3"])?.rewritten).toBe(1);
  });
});

describe("standInsByKind", () => {
  it("counts stand-ins by kind, most first", () => {
    expect(standInsByKind(["[IBAN_BBBBB]", "[PERSON_AAAAA]", "[PERSON_CCCCC]"])).toEqual([
      { kind: "PERSON", count: 2 },
      { kind: "IBAN", count: 1 },
    ]);
  });
});
