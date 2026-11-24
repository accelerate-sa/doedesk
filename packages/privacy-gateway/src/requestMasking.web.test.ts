import { describe, expect, it } from "vite-plus/test";

import type { Detector } from "./detect.ts";
import { Pseudonymizer } from "./pseudonymizer.ts";
import { maskRequestBody, type MaskRequestOptions, type WireFormat } from "./requestMasking.ts";
import { Vault } from "./vault.ts";
import { isPublicWebResult } from "./webResults.ts";

const PAGE = "By Khalid Al-Otaibi. Noura Al-Harbi is quoted, and the total was 4,200.";
/** Another tool's result: it is checked as before. Its name is already known, so the page keeps its own. */
const SHELL = "shell: Noura Al-Harbi called.";
const STAND_IN = /\[[A-Z]+_[A-HJ-NP-Z2-9]{5}\]/g;

/** Finds the two names wherever they stand, and records every text it was asked about. */
const setup = () => {
  const asked: Array<string> = [];
  const detector: Detector = {
    detect: (texts) => {
      asked.push(...texts);
      return Promise.resolve(
        texts.map((text) =>
          ["Khalid Al-Otaibi", "Noura Al-Harbi"].flatMap((name) => {
            const start = text.indexOf(name);
            return start === -1
              ? []
              : [{ start, end: start + name.length, kind: "PERSON" as const }];
          }),
        ),
      );
    },
  };
  const vault = new Vault();
  // A value of a sealed document: never looked for in what a tool returned.
  vault.sealedTokenFor("AMOUNT", "4,200", true);
  const mask = (format: WireFormat, body: unknown, options: MaskRequestOptions = {}) =>
    maskRequestBody(format, body, new Pseudonymizer(vault, detector), undefined, {
      webResults: "known",
      ...options,
    });
  return { asked, mask };
};

/** A request in which the person names Noura, and a tool is called and answers with the page. */
const anthropic = (name: string, input: unknown, result: unknown = PAGE) => ({
  messages: [
    { role: "user", content: "Find what Noura Al-Harbi said." },
    { role: "assistant", content: [{ type: "tool_use", id: "t1", name, input }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: result }] },
  ],
});
const resultOf = (body: unknown): string => {
  const { messages } = body as { messages: ReadonlyArray<{ content: unknown }> };
  const blocks = messages[2]?.content as ReadonlyArray<{ content?: unknown }>;
  return JSON.stringify(blocks.map((block) => block.content)).replace(STAND_IN, "[X]");
};

describe("results of web fetch and web search", () => {
  it("replaces only values already known on a plainly public page, and checks nothing new", async () => {
    const { asked, mask } = setup();
    const { body } = await mask(
      "anthropic-messages",
      anthropic("WebFetch", { url: "https://news.example.org/story" }),
    );
    // Noura is known from what the person typed; the page's own author is not looked for.
    expect(resultOf(body)).toBe(
      JSON.stringify(["By Khalid Al-Otaibi. [X] is quoted, and the total was 4,200."]),
    );
    expect(asked).toEqual(["Find what Noura Al-Harbi said."]);
  });

  it("checks the page as before when the person asks for that, or when no setting is given", async () => {
    for (const webResults of ["detect", undefined] as const) {
      const { asked, mask } = setup();
      const { body } = await mask(
        "anthropic-messages",
        anthropic("WebFetch", { url: "https://news.example.org/story" }),
        { webResults },
      );
      expect(resultOf(body)).toBe(
        JSON.stringify(["By [X]. [X] is quoted, and the total was 4,200."]),
      );
      expect(asked).toContain(PAGE);
    }
  });

  it("still withholds a page that holds sealed text", async () => {
    const { asked, mask } = setup();
    const calls: Array<readonly [string, boolean]> = [];
    const { body, sealed } = await mask(
      "anthropic-messages",
      anthropic("WebFetch", { url: "https://news.example.org/story" }),
      {
        withholdSealedText: (text, typed) => {
          calls.push([text, typed]);
          return text === PAGE ? "[withheld]" : undefined;
        },
        // What the model wrote is put back for text it wrote; a page is not such a text.
        remask: (text) => (text === PAGE ? "remasked" : undefined),
      },
    );
    expect(resultOf(body)).toBe(JSON.stringify(["[withheld]"]));
    expect(sealed).toBe(1);
    expect(calls).toContainEqual([PAGE, false]);
    expect(asked).not.toContain(PAGE);
  });

  it("keeps checking everything that is not plainly a public page", async () => {
    const checked: ReadonlyArray<readonly [string, unknown, unknown?]> = [
      ["WebFetch", { url: "http://news.example.org/story" }],
      ["WebFetch", { url: "https://localhost/admin" }],
      ["WebFetch", { url: "https://app.localhost/admin" }],
      ["WebFetch", { url: "https://intranet/wiki" }],
      ["WebFetch", { url: "https://wiki.corp/page" }],
      ["WebFetch", { url: "https://build.internal/log" }],
      ["WebFetch", { url: "https://printer.local/" }],
      ["WebFetch", { url: "https://host.tailnet.ts.net/" }],
      ["WebFetch", { url: "https://10.0.0.8/report" }],
      ["WebFetch", { url: "https://2130706433/" }],
      ["WebFetch", { url: "https://0x7f.1/" }],
      ["WebFetch", { url: "https://[::1]/" }],
      ["WebFetch", { url: "https://[::ffff:10.0.0.8]/" }],
      ["WebFetch", { url: "https://news.example.org:8443/story" }],
      ["WebFetch", { url: "https://ada:secret@news.example.org/story" }],
      ["WebFetch", { url: "file:///Users/ada/notes.txt" }],
      ["WebFetch", { url: "https://a.example.org https://b.example.org" }],
      ["WebFetch", { prompt: "no address" }],
      ["WebFetch", { url: "https://api.example.org/me", headers: { Authorization: "Bearer x" } }],
      ["WebFetch", { url: "https://api.example.org/me", cookies: "sid=1" }],
      // The page says it ended somewhere else.
      [
        "WebFetch",
        { url: "https://news.example.org/go" },
        JSON.stringify({ final_url: "https://wiki.corp/x", text: PAGE }),
      ],
      // Names that only look like a fetch or a search.
      ["fetch", { url: "https://news.example.org/story" }],
      ["mcp__jira__fetch_issue", { url: "https://news.example.org/story" }],
      ["search_emails", { query: "Noura" }],
      ["Bash", { command: "curl https://news.example.org/story" }],
    ];
    for (const [name, input, result] of checked) {
      const { asked, mask } = setup();
      await mask("anthropic-messages", anthropic(name, input, result ?? PAGE));
      expect(asked.join("\n"), `${name} ${JSON.stringify(input)}`).toContain("Khalid Al-Otaibi");
    }
    // A result whose call is gone, as after the history was compacted.
    const { asked, mask } = setup();
    await mask("anthropic-messages", {
      messages: [
        { role: "user", content: [{ type: "tool_result", tool_use_id: "gone", content: PAGE }] },
      ],
    });
    expect(asked).toContain(PAGE);
  });

  it("knows the fetch and search tools by exact name, in any case", () => {
    const publicInput = { url: "https://news.example.org/story" };
    for (const name of [
      "WebFetch",
      "web_fetch",
      "webfetch",
      "fetch_url",
      "fetch_webpage",
      "WEBFETCH",
    ]) {
      expect(isPublicWebResult({ name, input: publicInput }, PAGE), name).toBe(true);
    }
    for (const name of [
      "WebSearch",
      "web_search",
      "websearch",
      "search_web",
      "google_web_search",
    ]) {
      expect(isPublicWebResult({ name, input: { query: "anything" } }, PAGE), name).toBe(true);
    }
    expect(
      isPublicWebResult({ name: "WebFetch", input: { url: "https://News.Example.ORG./a" } }, PAGE),
    ).toBe(true);
    expect(
      isPublicWebResult(
        { name: "WebFetch", input: { url: "https://news.example.org:443/a" } },
        PAGE,
      ),
    ).toBe(true);
    expect(isPublicWebResult(undefined, PAGE)).toBe(false);
  });

  it("matches a result to its call in the other request formats", async () => {
    const input = { url: "https://news.example.org/story" };
    const cases: ReadonlyArray<readonly [WireFormat, unknown]> = [
      [
        "openai-responses",
        {
          input: [
            { type: "message", role: "user", content: "Find what Noura Al-Harbi said." },
            {
              type: "function_call",
              call_id: "c1",
              name: "web_fetch",
              arguments: JSON.stringify(input),
            },
            { type: "function_call_output", call_id: "c1", output: PAGE },
            { type: "function_call", call_id: "c2", name: "shell", arguments: "{}" },
            { type: "function_call_output", call_id: "c2", output: SHELL },
          ],
        },
      ],
      [
        "openai-chat",
        {
          messages: [
            { role: "user", content: "Find what Noura Al-Harbi said." },
            {
              role: "assistant",
              tool_calls: [
                { id: "c1", function: { name: "web_fetch", arguments: JSON.stringify(input) } },
                { id: "c2", function: { name: "shell", arguments: "{}" } },
              ],
            },
            { role: "tool", tool_call_id: "c1", content: PAGE },
            { role: "tool", tool_call_id: "c2", content: SHELL },
          ],
        },
      ],
      [
        "gemini",
        {
          contents: [
            { role: "user", parts: [{ text: "Find what Noura Al-Harbi said." }] },
            {
              role: "model",
              parts: [
                { functionCall: { name: "web_fetch", args: input } },
                { functionCall: { name: "shell", args: {} } },
              ],
            },
            {
              role: "user",
              parts: [
                { functionResponse: { name: "web_fetch", response: { output: PAGE } } },
                { functionResponse: { name: "shell", response: { output: SHELL } } },
              ],
            },
          ],
        },
      ],
    ];
    for (const [format, body] of cases) {
      const { asked, mask } = setup();
      const { body: sent } = await mask(format, body);
      expect(asked, format).not.toContain(PAGE);
      expect(asked, format).toContain(SHELL);
      const text = JSON.stringify(sent).replace(STAND_IN, "[X]");
      expect(text, format).toContain(
        "By Khalid Al-Otaibi. [X] is quoted, and the total was 4,200.",
      );
      expect(text, format).toContain("shell: [X] called.");
    }
  });
});
