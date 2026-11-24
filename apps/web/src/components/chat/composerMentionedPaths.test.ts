import { describe, expect, it } from "vite-plus/test";

import { mentionedPathList, replaceMentionedPath } from "./composerMentionedPaths";

describe("the files a message mentions", () => {
  // As the path picker writes one, as typed with quotes, and as typed bare.
  const prompt =
    'Compare [q4.csv](payroll/q4.csv) with @"notes/board minutes.txt" and @summary.md then [q4.csv](payroll/q4.csv) again, cc ali@example.com';

  it("lists each mentioned path once, in the order written", () => {
    expect(mentionedPathList(prompt).split("\n")).toEqual([
      "payroll/q4.csv",
      "notes/board minutes.txt",
      "summary.md",
    ]);
    expect(mentionedPathList("No file here, only ali@example.com")).toBe("");
  });

  it("puts a sealed file's handle where its mentions were and leaves the rest as written", () => {
    expect(replaceMentionedPath(prompt, "payroll/q4.csv", "DOC_3")).toBe(
      'Compare DOC_3 with @"notes/board minutes.txt" and @summary.md then DOC_3 again, cc ali@example.com',
    );
    expect(replaceMentionedPath(prompt, "other.csv", "DOC_3")).toBe(prompt);
  });
});
