import { describe, expect, it } from "vite-plus/test";

import { Pseudonymizer } from "./pseudonymizer.ts";
import { maskRequestBody } from "./requestMasking.ts";
import { Vault } from "./vault.ts";

describe("prompt caching", () => {
  /** The system blocks Claude Code sent in one evaluation run, shortened. */
  const request = () => ({
    model: "claude-opus-5-5",
    tools: [{ name: "Bash", description: "Executes a bash command.", input_schema: {} }],
    system: [
      { type: "text", text: "x-anthropic-billing-header: cc_version=2.1.330.819; cch=153d7;" },
      {
        type: "text",
        text: "You are Claude Code, Anthropic's official CLI for Claude, running within the Claude Agent SDK.",
      },
      {
        type: "text",
        text: "IMPORTANT: Assist with authorized security testing. Refuse requests for destructive techniques.",
        cache_control: { type: "ephemeral", ttl: "1h", scope: "global" },
      },
      {
        type: "text",
        text: "Primary working directory: /Users/khalid/matter-5620",
        cache_control: { type: "ephemeral", ttl: "1h" },
      },
    ],
    messages: [{ role: "user", content: [{ type: "text", text: "Read the agreement." }] }],
  });
  const noDetector = {
    detect: (texts: ReadonlyArray<string>) => Promise.resolve(texts.map(() => [])),
  };

  it("gives up the global scope of a cached block when masking changed it or a block before it", async () => {
    // The detection service took "for" in a contract for an organisation; the vault then held it.
    const vault = new Vault();
    vault.tokenFor("ORG", "for");
    const body = request();
    await maskRequestBody("anthropic-messages", body, new Pseudonymizer(vault, noDetector));
    expect(body.system[2]?.text).not.toContain(" for ");
    // The provider refuses a globally scoped block whose prefix is not the one it knows (HTTP 400).
    expect(body.system[2]?.cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
    expect(body.system[3]?.cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
  });

  it("keeps the global scope when masking left the cached prefix as it was", async () => {
    const vault = new Vault();
    vault.tokenFor("PERSON", "khalid");
    const body = request();
    await maskRequestBody("anthropic-messages", body, new Pseudonymizer(vault, noDetector));
    expect(body.system[3]?.text).not.toContain("khalid");
    expect(body.system[2]?.cache_control).toEqual({
      type: "ephemeral",
      ttl: "1h",
      scope: "global",
    });
  });
});

describe("the note about sealed files", () => {
  it("is masked like any other prompt text, and still pairs a file's name with its handle", async () => {
    const name = "Khalid Al-Otaibi";
    // As a detection service does: the person's name wherever it stands in a text.
    const detector = {
      detect: (texts: ReadonlyArray<string>) =>
        Promise.resolve(
          texts.map((text) =>
            [...text.matchAll(new RegExp(name, "g"))].map((match) => ({
              kind: "PERSON" as const,
              start: match.index,
              end: match.index + name.length,
            })),
          ),
        ),
    };
    const note = [
      "<doedesk_sealed_files>",
      "The person sealed these files on purpose.",
      `- DOC_1: ${name} lease.pdf (was at contracts/${name} lease.pdf)`,
      "- DOC_2: november-payroll.csv",
      "</doedesk_sealed_files>",
    ].join("\n");
    const body = {
      model: "claude-haiku-5-5",
      messages: [
        {
          role: "user",
          content: [
            {
              type: "text",
              text: `${note}\n\nUser message:\nWhat is the rent in ${name} lease.pdf?`,
            },
          ],
        },
      ],
    };
    const vault = new Vault();
    await maskRequestBody("anthropic-messages", body, new Pseudonymizer(vault, detector));

    const sent = body.messages[0]?.content[0]?.text ?? "";
    const standIn = vault.tokenFor("PERSON", name);
    expect(sent).not.toContain(name);
    // The handle and a name that holds no personal data are sent as they are.
    expect(sent).toContain(`- DOC_1: ${standIn} lease.pdf (was at contracts/${standIn} lease.pdf)`);
    expect(sent).toContain("- DOC_2: november-payroll.csv");
    // The person's own words carry the same stand-in, so the agent can tell which handle is meant.
    expect(sent).toContain(`What is the rent in ${standIn} lease.pdf?`);
  });
});
