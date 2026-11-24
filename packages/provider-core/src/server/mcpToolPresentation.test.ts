import { describe, expect, it } from "@effect/vitest";
import { mcpToolPresentation } from "./mcpToolPresentation.ts";

describe("mcpToolPresentation", () => {
  it("names DoeDesk's own server by the product for a tool it has no sentence for", () => {
    expect(mcpToolPresentation({ toolName: "mcp__t3-code__ask_documents" }).toolSource).toEqual({
      key: "mcp:t3-code",
      name: "DoeDesk",
      kind: "integration",
    });
  });

  it.each([
    "javascript:alert(1)",
    "file:///tmp/logo.png",
    "not a URL",
    "https://example.com/" + "x".repeat(4096),
  ])("ignores an invalid logo %s", (iconUrl) => {
    expect(
      mcpToolPresentation({
        serverName: "weather",
        toolName: "get_weather",
        iconUrl,
        title: "x".repeat(161),
      }),
    ).toEqual({
      title: "get weather",
      toolSource: { key: "mcp:weather", name: "weather", kind: "integration" },
    });
  });
});
