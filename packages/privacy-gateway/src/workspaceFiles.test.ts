import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { expect, it } from "vite-plus/test";

import { makeWorkspaceFiles } from "./workspaceFiles.ts";

it("finds files of the folders agents work in, by name or by path, and nothing outside them", async () => {
  const base = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "workspace-"));
  const root = NodePath.join(base, "project");
  NodeFS.mkdirSync(NodePath.join(root, "docs", "drafts"), { recursive: true });
  NodeFS.mkdirSync(NodePath.join(root, "node_modules", "pkg"), { recursive: true });
  NodeFS.writeFileSync(NodePath.join(root, "docs", "drafts", "dd_memo.md"), "");
  NodeFS.writeFileSync(NodePath.join(root, "node_modules", "pkg", "vendored.js"), "");
  NodeFS.writeFileSync(NodePath.join(base, "outside.md"), "");
  let clock = 0;
  const files = makeWorkspaceFiles(
    () => [root],
    () => clock,
  );

  const found = await files.find([
    "dd_memo.md",
    "docs/drafts/dd_memo.md",
    NodePath.join(root, "docs", "drafts", "dd_memo.md"),
    "vendored.js",
    "../outside.md",
    NodePath.join(base, "outside.md"),
    "later.md",
  ]);
  expect([...found]).toEqual([
    "dd_memo.md",
    "docs/drafts/dd_memo.md",
    NodePath.join(root, "docs", "drafts", "dd_memo.md"),
  ]);

  // A file the agent made since: the listing is kept for a few seconds, then read again.
  NodeFS.writeFileSync(NodePath.join(root, "docs", "later.md"), "");
  expect([...(await files.find(["later.md"]))]).toEqual([]);
  clock = 6_000;
  expect([...(await files.find(["later.md"]))]).toEqual(["later.md"]);
  NodeFS.rmSync(base, { recursive: true, force: true });
});
