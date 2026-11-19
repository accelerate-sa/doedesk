import sharp from "sharp";
import { describe, expect, it } from "vite-plus/test";

import { IMAGES_OFF_NOTE } from "./attachments.ts";
import type { Reader } from "./reader.ts";
import { makeImageRedactor } from "./redaction/redactImage.ts";
import {
  makePseudonymizer,
  paintPage,
  type Planted,
  plantedReader,
  pngOf,
  shows,
} from "./redaction/testkit.ts";
import {
  type AttachmentHandling,
  maskRequestBody,
  type ReplacedAttachment,
  type WireFormat,
} from "./requestMasking.ts";

const WIDTH = 800;
const HEIGHT = 300;
const WORDS: ReadonlyArray<Planted> = [
  { text: "Owner", x: 60, y: 80, width: 70, height: 24 },
  { text: "0551234567", x: 150, y: 80, width: 150, height: 24 },
  { text: "confirmed", x: 320, y: 80, width: 120, height: 24 },
];
const PHONE = WORDS[1] as Planted;
const KEPT = WORDS[0] as Planted;

/** A reader for both ways an image can be read: with positions, and as text alone. */
const makeReader = (): Reader & {
  readonly layoutCalls: () => number;
  readonly textCalls: () => number;
} => {
  const planted = plantedReader(WIDTH, WORDS);
  let textCalls = 0;
  return {
    read: () => {
      textCalls += 1;
      return Promise.resolve("Owner 0551234567 confirmed");
    },
    readLayout: planted.readLayout,
    layoutCalls: planted.calls,
    textCalls: () => textCalls,
  };
};

const setup = async (images: AttachmentHandling["images"] = "redacted") => {
  const pseudonymizer = makePseudonymizer();
  const reader = makeReader();
  const replaced: Array<ReplacedAttachment> = [];
  const attachments: AttachmentHandling = {
    images,
    redactor: makeImageRedactor({
      reader: { readLayout: reader.readLayout as NonNullable<Reader["readLayout"]> },
      pseudonymizer,
    }),
    onReplaced: (entry) => replaced.push(entry),
  };
  const png = await pngOf(paintPage(WIDTH, HEIGHT, WORDS));
  const mask = (format: WireFormat, body: unknown) =>
    maskRequestBody(format, body, pseudonymizer, reader, { attachments });
  return {
    png,
    base64: png.toString("base64"),
    mask,
    pseudonymizer,
    reader,
    replaced,
    attachments,
  };
};

/** Checks that an image leaving in a request is the redacted one, by looking at its pixels. */
const expectRedacted = async (sent: string, original: string) => {
  expect(sent).not.toBe(original);
  const bytes = Buffer.from(sent, "base64");
  const metadata = await sharp(bytes).metadata();
  expect(metadata).toMatchObject({ format: "png", hasAlpha: false, width: WIDTH, height: HEIGHT });
  expect(await shows(bytes, WIDTH, PHONE)).toBe("hidden");
  expect(await shows(bytes, WIDTH, KEPT)).toBe("shown");
};

/** The blocks of the first message, after an image in it has been replaced by text. */
const textBlocks = (body: { readonly messages: ReadonlyArray<{ readonly content: unknown }> }) =>
  (body.messages[0]?.content ?? []) as ReadonlyArray<Record<string, string>>;

const LEGEND = /^\[Image redacted by DoeDesk before it was sent\./;

describe("an image is sent redacted, in every request format", () => {
  it("Anthropic: in a user message, keeping the block's other fields", async () => {
    const { base64, mask } = await setup();
    const body = {
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "What is in this?" },
            {
              type: "image",
              source: { type: "base64", media_type: "image/jpeg", data: base64 },
              cache_control: { type: "ephemeral" },
            },
            { type: "text", text: "Thanks" },
          ],
        },
      ],
    };
    const masked = await mask("anthropic-messages", body);
    expect(masked).toMatchObject({ redacted: 1, read: 0, withheld: 0 });
    const content = body.messages[0]?.content as Array<Record<string, unknown>>;
    expect(content.map((block) => block.type)).toEqual(["text", "image", "text", "text"]);
    const image = content[1] as { source: Record<string, string>; cache_control: unknown };
    // The media type is what the bytes now are, not what the request claimed.
    expect(image.source).toMatchObject({ type: "base64", media_type: "image/png" });
    expect(image.cache_control).toEqual({ type: "ephemeral" });
    await expectRedacted(image.source.data ?? "", base64);
    expect(content[2]?.text).toMatch(LEGEND);
    expect(content[3]?.text).toBe("Thanks");
    expect(JSON.stringify(body)).not.toContain("0551234567");
  });

  it("Anthropic: in a tool result, as a screenshot from a tool arrives", async () => {
    const { base64, mask } = await setup();
    const body = {
      messages: [
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "toolu_1",
              content: [
                { type: "text", text: "Screenshot taken. Caller 0551234567." },
                {
                  type: "image",
                  source: { type: "base64", media_type: "image/png", data: base64 },
                },
              ],
            },
          ],
        },
      ],
    };
    expect(await mask("anthropic-messages", body)).toMatchObject({ redacted: 1 });
    const result = body.messages[0]?.content[0]?.content as Array<Record<string, unknown>>;
    expect(result.map((block) => block.type)).toEqual(["text", "image", "text"]);
    await expectRedacted((result[1] as { source: { data: string } }).source.data, base64);
    // The number in the tool's text and the number in its picture get one stand-in.
    const token = /\[PHONE_\w{5}\]/.exec(String(result[0]?.text))?.[0];
    expect(token).toBeDefined();
    expect(JSON.stringify(body)).not.toContain("0551234567");
  });

  it("OpenAI Responses: input_image in a message and in a tool's output", async () => {
    const { base64, mask } = await setup();
    const url = `data:image/png;base64,${base64}`;
    const body = {
      input: [
        { role: "user", content: [{ type: "input_image", image_url: url, detail: "high" }] },
        {
          type: "function_call_output",
          call_id: "call_1",
          output: [{ type: "input_image", image_url: url }],
        },
      ],
    };
    expect(await mask("openai-responses", body)).toMatchObject({ redacted: 2 });
    const message = (body.input[0] as { content: Array<Record<string, string>> }).content;
    expect(message.map((part) => part.type)).toEqual(["input_image", "input_text"]);
    expect(message[0]?.detail).toBe("high");
    await expectRedacted(
      (message[0]?.image_url ?? "").replace("data:image/png;base64,", ""),
      base64,
    );
    expect(message[1]?.text).toMatch(LEGEND);
    const output = (body.input[1] as { output: Array<Record<string, string>> }).output;
    expect(output.map((part) => part.type)).toEqual(["input_image", "input_text"]);
    await expectRedacted(
      (output[0]?.image_url ?? "").replace("data:image/png;base64,", ""),
      base64,
    );
  });

  it("OpenAI Chat: image_url as an object and as a string", async () => {
    const { base64, mask } = await setup();
    const url = `data:image/png;base64,${base64}`;
    const body = {
      messages: [
        {
          role: "user",
          content: [
            { type: "image_url", image_url: { url, detail: "low" } },
            { type: "image_url", image_url: url },
          ],
        },
      ],
    };
    expect(await mask("openai-chat", body)).toMatchObject({ redacted: 2 });
    const parts = body.messages[0]?.content as Array<Record<string, unknown>>;
    expect(parts.map((part) => part.type)).toEqual(["image_url", "text", "image_url", "text"]);
    const first = parts[0]?.image_url as { url: string; detail: string };
    expect(first.detail).toBe("low");
    await expectRedacted(first.url.replace("data:image/png;base64,", ""), base64);
    await expectRedacted(String(parts[2]?.image_url).replace("data:image/png;base64,", ""), base64);
  });

  it("Gemini: inline data in either spelling, and inside a tool's answer", async () => {
    const { base64, mask } = await setup();
    const body = {
      contents: [
        {
          role: "user",
          parts: [
            { inlineData: { mimeType: "image/png", data: base64 } },
            { inline_data: { mime_type: "image/png", data: base64 } },
            {
              functionResponse: {
                name: "screenshot",
                response: { note: "Caller 0551234567" },
                parts: [{ inlineData: { mimeType: "image/png", data: base64 } }],
              },
            },
          ],
        },
      ],
    };
    expect(await mask("gemini", body)).toMatchObject({ redacted: 3 });
    const parts = body.contents[0]?.parts as Array<Record<string, Record<string, unknown>>>;
    await expectRedacted(String(parts[0]?.inlineData?.data), base64);
    expect(String(parts[1]?.text)).toMatch(LEGEND);
    expect(parts[2]?.inline_data?.mime_type).toBe("image/png");
    await expectRedacted(String(parts[2]?.inline_data?.data), base64);
    const inner = parts[4]?.functionResponse?.parts as Array<
      Record<string, Record<string, string>>
    >;
    await expectRedacted(String(inner[0]?.inlineData?.data), base64);
    expect(JSON.stringify(body)).not.toContain("0551234567");
    expect(JSON.stringify(body)).not.toContain(base64);
  });
});

describe("the other two ways an image can be sent", () => {
  it("masked text only: today's behaviour, with no picture and no positions asked for", async () => {
    const { base64, mask, reader, replaced, png } = await setup("text");
    const body = {
      messages: [
        {
          role: "user",
          content: [
            { type: "image", source: { type: "base64", media_type: "image/png", data: base64 } },
          ],
        },
      ],
    };
    expect(await mask("anthropic-messages", body)).toMatchObject({
      read: 1,
      redacted: 0,
      withheld: 0,
    });
    const content = textBlocks(body);
    expect(content).toHaveLength(1);
    expect(content[0]?.text).toMatch(
      /^\[Text read from an attached image by DoeDesk\. The image itself was not sent\.\]\nOwner \[PHONE_\w{5}\] confirmed$/,
    );
    expect(reader.layoutCalls()).toBe(0);
    // The text that was sent is what the user can download afterwards.
    expect(replaced).toEqual([{ kind: "image", original: png, text: content[0]?.text }]);
  });

  it("withheld: a note, and nothing is read", async () => {
    const { base64, mask, reader } = await setup("withheld");
    const body = {
      input: [
        {
          role: "user",
          content: [{ type: "input_image", image_url: `data:image/png;base64,${base64}` }],
        },
      ],
    };
    expect(await mask("openai-responses", body)).toMatchObject({
      withheld: 1,
      read: 0,
      redacted: 0,
    });
    expect(body.input[0]?.content).toEqual([{ type: "input_text", text: IMAGES_OFF_NOTE }]);
    expect(reader.layoutCalls()).toBe(0);
    expect(reader.textCalls()).toBe(0);
  });
});

describe("an image that cannot be sent redacted", () => {
  const anthropicBody = (base64: string) => ({
    messages: [
      {
        role: "user",
        content: [
          { type: "image", source: { type: "base64", media_type: "image/png", data: base64 } },
        ],
      },
    ],
  });

  it("is replaced by its masked text, with the reason, when redaction gives up", async () => {
    const pseudonymizer = makePseudonymizer();
    const body = anthropicBody((await pngOf(paintPage(WIDTH, HEIGHT, WORDS))).toString("base64"));
    const masked = await maskRequestBody(
      "anthropic-messages",
      body,
      pseudonymizer,
      { read: () => Promise.resolve("Owner 0551234567 confirmed") },
      {
        attachments: {
          images: "redacted",
          redactor: {
            redact: () =>
              Promise.resolve({
                kind: "withheld",
                reason: "The reading service gave no word positions.",
              }),
          },
        },
      },
    );
    expect(masked).toMatchObject({ read: 1, redacted: 0, withheld: 0 });
    const text = textBlocks(body)[0]?.text ?? "";
    expect(text).toMatch(
      /^\[DoeDesk did not send this image: The reading service gave no word positions\. What follows is the text read from it instead\.\]\n\[Text read from an attached image.*\]\nOwner \[PHONE_\w{5}\] confirmed$/s,
    );
    expect(JSON.stringify(body)).not.toContain("0551234567");
  });

  it("masks the text the reader already gave, without reading the image a second time", async () => {
    const pseudonymizer = makePseudonymizer();
    const png = await pngOf(paintPage(WIDTH, HEIGHT, WORDS));
    let textReads = 0;
    // A service from before word positions: text and pages, no layout.
    const redactor = makeImageRedactor({
      pseudonymizer,
      reader: {
        readLayout: () =>
          Promise.resolve({ text: "Owner 0551234567 confirmed", pages: 1, layout: undefined }),
      },
    });
    const body = anthropicBody(png.toString("base64"));
    const masked = await maskRequestBody(
      "anthropic-messages",
      body,
      pseudonymizer,
      {
        read: () => {
          textReads += 1;
          return Promise.resolve("never asked for");
        },
      },
      { attachments: { images: "redacted", redactor } },
    );
    expect(masked).toMatchObject({ read: 1, redacted: 0, withheld: 0 });
    expect(textReads).toBe(0);
    expect(textBlocks(body)[0]?.text).toMatch(
      /^\[DoeDesk did not send this image: The reading service gave no word positions\. What follows is the text read from it instead\.\]\n\[Text read from an attached image.*\]\nOwner \[PHONE_\w{5}\] confirmed$/s,
    );
    expect(JSON.stringify(body)).not.toContain("0551234567");
    expect(JSON.stringify(body)).not.toContain(png.toString("base64").slice(0, 200));
  });

  it("is withheld with a note when it cannot be read as text either", async () => {
    const pseudonymizer = makePseudonymizer();
    const base64 = (await pngOf(paintPage(WIDTH, HEIGHT, WORDS))).toString("base64");
    const body = anthropicBody(base64);
    const masked = await maskRequestBody(
      "anthropic-messages",
      body,
      pseudonymizer,
      { read: () => Promise.reject(new Error("The reading service answered 502.")) },
      {
        attachments: {
          images: "redacted",
          redactor: {
            redact: () =>
              Promise.resolve({ kind: "withheld", reason: "The reading service answered 502." }),
          },
        },
      },
    );
    expect(masked).toMatchObject({ withheld: 1, read: 0, redacted: 0 });
    expect(body.messages[0]?.content).toEqual([
      {
        type: "text",
        text: "[Image withheld by DoeDesk: it could not be checked for personal data before sending. (The reading service answered 502.)]",
      },
    ]);
    expect(JSON.stringify(body)).not.toContain(base64);
  });

  it("is withheld when no reader is connected at all", async () => {
    const pseudonymizer = makePseudonymizer();
    const base64 = (await pngOf(paintPage(WIDTH, HEIGHT, WORDS))).toString("base64");
    const body = anthropicBody(base64);
    const masked = await maskRequestBody("anthropic-messages", body, pseudonymizer, undefined, {
      attachments: { images: "redacted" },
    });
    expect(masked).toMatchObject({ withheld: 1 });
    expect(JSON.stringify(body)).not.toContain(base64);
  });

  it("is never forwarded by reference: a URL or a file id is withheld", async () => {
    const { mask } = await setup();
    const body = {
      messages: [
        {
          role: "user",
          content: [
            { type: "image", source: { type: "url", url: "https://example.com/id-card.png" } },
            { type: "image", source: { type: "file", file_id: "file_123" } },
          ],
        },
      ],
    };
    expect(await mask("anthropic-messages", body)).toMatchObject({ withheld: 2, redacted: 0 });
    expect(JSON.stringify(body)).not.toContain("example.com");
  });

  it("a PDF stays on the text path whatever the image setting says", async () => {
    const { mask, reader } = await setup("redacted");
    const body = {
      messages: [
        {
          role: "user",
          content: [
            {
              type: "document",
              source: {
                type: "base64",
                media_type: "application/pdf",
                data: Buffer.from("%PDF-1.7").toString("base64"),
              },
            },
          ],
        },
      ],
    };
    expect(await mask("anthropic-messages", body)).toMatchObject({ read: 1, redacted: 0 });
    expect(textBlocks(body)[0]?.text).toMatch(
      /^\[Text read from an attached file by DoeDesk\. The file itself was not sent\.\]\nOwner \[PHONE_\w{5}\] confirmed$/,
    );
    expect(reader.layoutCalls()).toBe(0);
  });
});
