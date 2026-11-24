import { describe, expect, it } from "vite-plus/test";

import { sealedFilesAsked, standInKindLabel, valuesByKind } from "./TurnPrivacy.logic";

const value = (token: string, kind: string) => ({ token, kind, value: token, sealed: false });

describe("valuesByKind", () => {
  it("follows the order of the turn's counts and loses no value", () => {
    const groups = valuesByKind(
      [{ kind: "PERSON" }, { kind: "IBAN" }, { kind: "PHONE" }],
      [value("i1", "IBAN"), value("p1", "PERSON"), value("o1", "ORG"), value("p2", "PERSON")],
    );
    expect(groups.map((group) => [group.kind, group.values.map((entry) => entry.token)])).toEqual([
      ["PERSON", ["p1", "p2"]],
      ["IBAN", ["i1"]],
      ["ORG", ["o1"]],
    ]);
  });
});

describe("standInKindLabel", () => {
  it("names a kind this build does not know as Other", () => {
    expect(standInKindLabel("PASSPORT")).toBe(standInKindLabel("OTHER"));
    expect(standInKindLabel("IBAN")).not.toBe(standInKindLabel("OTHER"));
  });
});

describe("sealedFilesAsked", () => {
  const document = (handle: string, name: string) => ({
    handle,
    name,
    mediaType: "text/plain",
    characters: 10,
    lines: 1,
    addedAt: "2026-11-24T09:00:00.000Z",
  });
  const listing = {
    documents: [document("DOC_1", "lease.pdf"), document("DOC_3", "payroll.csv")],
    outputs: [],
    clear: { mostOnOneDocument: 0, perDocument: 40 },
  };

  it("names the first files and counts the rest, by handle where the name is not known here", () => {
    const asked = { asked: ["DOC_1", "DOC_2", "DOC_3"], askedCount: 3, clear: 1 };
    // DOC_2 was unsealed since: it is still named, by its handle.
    expect(sealedFilesAsked(asked, listing)).toEqual({
      count: 3,
      names: ["lease.pdf", "DOC_2"],
      more: 1,
    });
    // On another computer no name is known.
    expect(sealedFilesAsked(asked, null).names).toEqual(["DOC_1", "DOC_2"]);
    // A turn that asked more files than its record lists still counts them all.
    expect(sealedFilesAsked({ asked: ["DOC_1"], askedCount: 60, clear: 0 }, listing)).toEqual({
      count: 60,
      names: ["lease.pdf"],
      more: 59,
    });
  });
});
