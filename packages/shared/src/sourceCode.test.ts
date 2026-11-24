import { describe, expect, it } from "vite-plus/test";

import { SOURCE_REPOSITORY_URL, sourceCodeUrl } from "./sourceCode.ts";

describe("sourceCodeUrl", () => {
  it.each([
    ["a release", "2026.11.2", `${SOURCE_REPOSITORY_URL}/tree/v2026.11.2`],
    ["a build from source", "0.1.11", SOURCE_REPOSITORY_URL],
    ["a version that is not a tag name", "2026.11.2/../../evil", SOURCE_REPOSITORY_URL],
    ["no version", undefined, SOURCE_REPOSITORY_URL],
  ])("links %s to its source", (_label, version, url) => {
    expect(sourceCodeUrl(version)).toBe(url);
  });
});
