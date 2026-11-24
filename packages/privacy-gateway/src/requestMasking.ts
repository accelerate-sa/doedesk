import {
  attachmentText,
  type ImageHandling,
  IMAGES_OFF_NOTE,
  readAttachmentText,
  redactionFailedNote,
} from "./attachments.ts";
import {
  type MaskMode,
  type MaskStats,
  type Pseudonymizer,
  standInsWritten,
} from "./pseudonymizer.ts";
import type { Reader } from "./reader.ts";
import type { ImageRedactor } from "./redaction/redactImage.ts";
import type { Vault } from "./vault.ts";
import { isPublicWebResult, type ToolCall } from "./webResults.ts";

/**
 * The request formats the gateway rewrites. `json-text` is text in a shape of its own (a token
 * count, an embedding): every string in it is checked. See `routes.ts` for every other path.
 */
export type WireFormat =
  | "anthropic-messages"
  | "openai-responses"
  | "openai-chat"
  | "gemini"
  | "json-text";

export const wireFormatForPath = (path: string): WireFormat | undefined => {
  const pathname = path.split("?")[0] ?? path;
  if (/\/v1\/messages(?:\/count_tokens)?$/.test(pathname)) return "anthropic-messages";
  if (/\/responses(?:\/compact)?$/.test(pathname)) return "openai-responses";
  if (/\/chat\/completions$/.test(pathname)) return "openai-chat";
  if (/:(?:streamGenerateContent|generateContent|countTokens)$/.test(pathname)) return "gemini";
  return undefined;
};

type Json = unknown;
type JsonObject = Record<string, Json>;

const isObject = (value: Json): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Keys of the wire format itself, at the top of an item, that must survive byte for byte. */
const OPAQUE_KEYS = new Set([
  "id",
  "type",
  "role",
  "status",
  "signature",
  "encrypted_content",
  "data",
  "call_id",
  "tool_use_id",
  "name",
  "model",
  "media_type",
  "cache_control",
]);

/** An image as it is sent: its bytes and what kind of file they are. */
interface SentImage {
  readonly bytes: Buffer;
  readonly mediaType: string;
}

interface PlannedAttachment {
  readonly blocks: Array<Json>;
  readonly index: number;
  readonly attachment: Attachment | undefined;
  readonly kind: "image" | "file";
  readonly textBlock: (text: string) => JsonObject;
  /** The same block with another picture in it. Absent where a block cannot carry one. */
  readonly imageBlock: ((image: SentImage) => JsonObject) | undefined;
}

/** Several blocks standing where one stood, until the list is written out flat. */
const SEVERAL = Symbol("several blocks");
type Several = { readonly [SEVERAL]: ReadonlyArray<JsonObject> };

/** What is done with the images and files of a request. */
export interface AttachmentHandling {
  readonly images: ImageHandling;
  /** Draws the boxes. Without one, `redacted` is carried out as `text`. */
  readonly redactor?: ImageRedactor | undefined;
  /** Told what took each attachment's place, for the user to look at afterwards. */
  readonly onReplaced?: ((replaced: ReplacedAttachment) => void) | undefined;
}

export interface ReplacedAttachment {
  readonly kind: "image" | "file";
  readonly original: Buffer;
  /** The masked text that was sent in the attachment's place. */
  readonly text: string;
}

/**
 * Collects every string that needs masking, masks them in one batch, then writes them back.
 * One batch means one round trip to the detector per request.
 */
class MaskPlan {
  readonly #items: Array<{ text: string; mode: MaskMode; write: (value: string) => void }> = [];
  readonly #attachments: Array<PlannedAttachment> = [];
  /** The tool calls met so far, by the id their result names. */
  readonly #calls = new Map<string, ToolCall>();
  /** Gemini calls that carry no id, by name, in the order their results come. */
  readonly #unnamedCalls = new Map<string, Array<ToolCall>>();
  readonly #webResultsKnown: boolean;

  constructor(webResults: "known" | "detect") {
    this.#webResultsKnown = webResults === "known";
  }

  /** Remembers a tool call, so that its result can be told from any other tool's. */
  call(id: Json, name: Json, input: Json): void {
    if (typeof name !== "string") return;
    if (typeof id === "string") this.#calls.set(id, { name, input });
    else this.#unnamedCalls.set(name, [...(this.#unnamedCalls.get(name) ?? []), { name, input }]);
  }

  /**
   * How a tool's result is masked: checked like any new material, unless it is what a web search
   * or a fetch of a plainly public page returned (see `webResults.ts`). A result whose call is
   * not in the request is checked.
   */
  resultMode(id: Json, name: Json, result: Json): MaskMode {
    if (!this.#webResultsKnown) return "detect";
    const call =
      typeof id === "string"
        ? this.#calls.get(id)
        : typeof name === "string"
          ? this.#unnamedCalls.get(name)?.shift()
          : undefined;
    return isPublicWebResult(call, result) ? "toolKnown" : "detect";
  }

  withheld = 0;
  /** Texts replaced by a note because they held sealed document text. */
  sealed = 0;
  /** Images and files turned into text. */
  read = 0;
  /** Images sent with their personal data covered. */
  redacted = 0;

  /**
   * An image or file in the request. An image is sent redacted, or replaced by the text read
   * from it, as the user chose; a file is replaced by its text. That text is then masked like
   * any other. What cannot be read is replaced by a note saying it was withheld.
   */
  attachment(
    blocks: Array<Json>,
    index: number,
    attachment: Attachment | undefined,
    kind: "image" | "file",
    textBlock: (text: string) => JsonObject,
    imageBlock?: (image: SentImage) => JsonObject,
  ): void {
    this.#attachments.push({ blocks, index, attachment, kind, textBlock, imageBlock });
  }

  text(holder: JsonObject | Array<Json>, key: string | number, mode: MaskMode): void {
    const value = (holder as Record<string | number, Json>)[key];
    if (typeof value !== "string" || value.length === 0) return;
    this.#items.push({
      text: value,
      mode,
      write: (next) => {
        (holder as Record<string | number, Json>)[key] = next;
      },
    });
  }

  /** A JSON document carried inside a string, such as tool call arguments. */
  jsonString(holder: JsonObject, key: string, mode: MaskMode): void {
    const value = holder[key];
    if (typeof value !== "string" || value.length === 0) return;
    let parsed: Json;
    try {
      parsed = JSON.parse(value);
    } catch {
      this.text(holder, key, mode);
      return;
    }
    if (typeof parsed === "string") {
      this.text(holder, key, mode);
      return;
    }
    const box: JsonObject = { parsed };
    let touched = false;
    const before = this.#items.length;
    this.deep(box, "parsed", mode);
    for (const item of this.#items.slice(before)) {
      const write = item.write;
      item.write = (next) => {
        if (next !== item.text) touched = true;
        write(next);
      };
    }
    this.#finishers.push(() => {
      // Re-serialising unchanged arguments would alter spacing and break prompt caching.
      if (touched) holder[key] = JSON.stringify(box.parsed);
    });
  }

  /**
   * Every string under `holder[key]`. What is under it is a tool's own data, not the wire
   * format, so no key is skipped: a contact's `name` or a record's `id` is a value like any other.
   */
  deep(holder: JsonObject | Array<Json>, key: string | number, mode: MaskMode): void {
    const value = (holder as Record<string | number, Json>)[key];
    if (typeof value === "string") {
      this.text(holder, key, mode);
    } else if (Array.isArray(value)) {
      value.forEach((_, index) => this.deep(value, index, mode));
    } else if (isObject(value)) {
      for (const childKey of Object.keys(value)) this.deep(value, childKey, mode);
    }
  }

  readonly #finishers: Array<() => void> = [];

  async apply(
    pseudonymizer: Pseudonymizer,
    neverMask: ReadonlyArray<string>,
    reader: Reader | undefined,
    attachmentsOnly: boolean,
    handling: AttachmentHandling,
    withholdSealedText: ((text: string, typed: boolean) => string | undefined) | undefined,
    remask: ((text: string) => string | undefined) | undefined,
  ): Promise<MaskStats> {
    const replacedText: Array<{ block: JsonObject; planned: PlannedAttachment }> = [];
    await Promise.all(
      this.#attachments.map(async (planned) => {
        const { blocks, index, attachment, kind, textBlock, imageBlock } = planned;
        if (kind === "image" && handling.images === "withheld") {
          blocks[index] = textBlock(IMAGES_OFF_NOTE);
          this.withheld += 1;
          return;
        }
        let failed: string | undefined;
        /** What the reader already read from the image, so that it is not read and paid for twice. */
        let alreadyRead: string | undefined;
        if (
          kind === "image" &&
          handling.images === "redacted" &&
          handling.redactor !== undefined &&
          attachment !== undefined &&
          imageBlock !== undefined &&
          // Evaluation only: the arm that measures reading sends text, never a picture.
          !attachmentsOnly
        ) {
          const result = await handling.redactor.redact(attachment.bytes, neverMask);
          if (result.kind === "redacted") {
            // The legend holds stand-ins and fixed words only; it is not masked again.
            const several: Several = {
              [SEVERAL]: [
                imageBlock(result.image),
                ...(result.legend.length === 0 ? [] : [textBlock(result.legend)]),
              ],
            };
            blocks[index] = several as unknown as Json;
            this.redacted += 1;
            return;
          }
          failed = result.reason;
          alreadyRead = result.readText;
        }
        // The text path: what the reader finds in the file, masked like any other text.
        const replacement =
          alreadyRead === undefined
            ? await attachmentText(kind, reader, attachment)
            : readAttachmentText(kind, alreadyRead);
        const text =
          failed === undefined || !replacement.read
            ? replacement.text
            : `${redactionFailedNote(failed)}\n${replacement.text}`;
        const block = textBlock(text);
        blocks[index] = block;
        if (!replacement.read) {
          this.withheld += 1;
          return;
        }
        this.read += 1;
        const key = typeof block.text === "string" ? "text" : undefined;
        if (key !== undefined) {
          this.text(block, key, "detect");
          replacedText.push({ block, planned });
        }
      }),
    );
    // One block became two where a redacted image has a legend: write the lists out flat.
    for (const blocks of new Set(this.#attachments.map((planned) => planned.blocks))) {
      if (!blocks.some((block) => isObject(block) && SEVERAL in block)) continue;
      const flat = blocks.flatMap((block): ReadonlyArray<Json> =>
        isObject(block) && SEVERAL in block ? (block as unknown as Several)[SEVERAL] : [block],
      );
      blocks.length = 0;
      blocks.push(...flat);
    }
    // The stand-ins put back below. The client sent the real values, so they count as replaced
    // in this request like any other: a turn whose values all came from earlier replies would
    // otherwise say nothing was replaced.
    const putBack: Array<string> = [];
    if (remask !== undefined) {
      // Text the person read with sealed values restored goes back exactly as the model wrote
      // it. That also puts back the stand-ins of values too short to be searched for.
      for (const item of this.#items) {
        if (item.mode !== "known") continue;
        const asWritten = remask(item.text);
        if (asWritten === undefined) continue;
        putBack.push(...standInsWritten(item.text, asWritten));
        item.text = asWritten;
      }
    }
    if (withholdSealedText !== undefined) {
      // New material only: what a tool returned or the person typed. The same text gives the
      // same result every time it is sent, so the request stays the same turn after turn.
      for (const item of this.#items) {
        // A public page is new material too: it can quote a sealed document.
        if (item.mode === "known") continue;
        const kept = withholdSealedText(item.text, item.mode === "typed");
        if (kept === undefined) continue;
        item.text = kept;
        // What the person typed loses the copied passages and is still checked like any text.
        if (item.mode !== "typed") item.mode = "known";
        this.sealed += 1;
      }
    }
    if (attachmentsOnly) {
      this.#items.forEach((item) => item.write(item.text));
      return { checked: 0, masked: 0, replaced: [] };
    }
    const { texts, stats } = await pseudonymizer.mask(this.#items, neverMask);
    this.#items.forEach((item, index) => item.write(texts[index] ?? item.text));
    for (const finish of this.#finishers) finish();
    for (const { block, planned } of replacedText) {
      if (planned.attachment !== undefined && typeof block.text === "string") {
        handling.onReplaced?.({
          kind: planned.kind,
          original: planned.attachment.bytes,
          text: block.text,
        });
      }
    }
    return putBack.length === 0
      ? stats
      : {
          ...stats,
          masked: stats.masked + putBack.length,
          replaced: [...new Set([...stats.replaced, ...putBack])],
        };
  }
}

const modeForRole = (role: Json): MaskMode =>
  role === "user" ? "typed" : role === "tool" ? "detect" : "known";

interface Attachment {
  readonly bytes: Buffer;
  readonly mediaType: string;
}

const fromBase64 = (data: Json, mediaType: Json): Attachment | undefined =>
  typeof data === "string" && data.length > 0
    ? {
        bytes: Buffer.from(data, "base64"),
        mediaType: typeof mediaType === "string" ? mediaType : "application/octet-stream",
      }
    : undefined;

const fromDataUrl = (url: Json): Attachment | undefined => {
  if (typeof url !== "string") return undefined;
  const match = /^data:([^;,]+);base64,(.*)$/s.exec(url);
  return match === null ? undefined : fromBase64(match[2], match[1]);
};

const toDataUrl = (image: SentImage): string =>
  `data:${image.mediaType};base64,${image.bytes.toString("base64")}`;

const planAnthropicBlocks = (plan: MaskPlan, blocks: Array<Json>, mode: MaskMode): void => {
  blocks.forEach((block, index) => {
    if (!isObject(block)) return;
    switch (block.type) {
      case "text":
        plan.text(block, "text", mode);
        break;
      case "tool_use":
        plan.call(block.id, block.name, block.input);
        plan.deep(block, "input", "known");
        break;
      case "server_tool_use":
      case "mcp_tool_use":
        plan.deep(block, "input", "known");
        break;
      case "tool_result":
      case "mcp_tool_result": {
        // A tool of an MCP server is never taken for a web tool, whatever its name.
        const result =
          block.type === "tool_result"
            ? plan.resultMode(block.tool_use_id, undefined, block.content)
            : "detect";
        if (typeof block.content === "string") plan.text(block, "content", result);
        else if (Array.isArray(block.content)) planAnthropicBlocks(plan, block.content, result);
        break;
      }
      case "image": {
        const source = isObject(block.source) ? block.source : {};
        plan.attachment(
          blocks,
          index,
          fromBase64(source.data, source.media_type),
          "image",
          (text) => ({
            type: "text",
            text,
          }),
          // Everything else on the block, `cache_control` included, stays as it was.
          (image) => ({
            ...block,
            source: {
              type: "base64",
              media_type: image.mediaType,
              data: image.bytes.toString("base64"),
            },
          }),
        );
        break;
      }
      case "document": {
        const source = block.source;
        if (isObject(source) && source.type === "text") {
          plan.text(source, "data", "detect");
          plan.text(block, "title", "detect");
          plan.text(block, "context", "detect");
        } else if (isObject(source) && source.type === "content" && Array.isArray(source.content)) {
          planAnthropicBlocks(plan, source.content, "detect");
        } else {
          plan.attachment(
            blocks,
            index,
            isObject(source) ? fromBase64(source.data, source.media_type) : undefined,
            "file",
            (text) => ({ type: "text", text }),
          );
        }
        break;
      }
      // Thinking blocks are signed. Changing a byte invalidates them, so they pass untouched;
      // they only ever contain text the model wrote from already-masked input.
      default:
        break;
    }
  });
};

/**
 * A block cached with `scope: "global"` is shared by everyone who sends the same prefix, and the
 * provider refuses the request when that prefix is not one it knows. From the first system block
 * masking changed, no block keeps that scope; the cache is then the account's own, as for any block.
 */
const giveUpGlobalScope = (system: Array<Json>, before: ReadonlyArray<Json | undefined>): void => {
  let changed = false;
  system.forEach((block, index) => {
    if (!isObject(block)) return;
    if (block.text !== before[index]) changed = true;
    const cache = block.cache_control;
    if (!changed || !isObject(cache) || cache.scope !== "global") return;
    const { scope: _scope, ...rest } = cache;
    block.cache_control = rest;
  });
};

const planAnthropic = (plan: MaskPlan, body: JsonObject): void => {
  if (typeof body.system === "string") plan.text(body, "system", "known");
  else if (Array.isArray(body.system)) planAnthropicBlocks(plan, body.system, "known");
  if (!Array.isArray(body.messages)) return;
  for (const message of body.messages) {
    if (!isObject(message)) continue;
    const mode = modeForRole(message.role);
    if (typeof message.content === "string") plan.text(message, "content", mode);
    else if (Array.isArray(message.content)) planAnthropicBlocks(plan, message.content, mode);
  }
};

const planResponsesParts = (plan: MaskPlan, parts: Array<Json>, mode: MaskMode): void => {
  parts.forEach((part, index) => {
    if (!isObject(part)) return;
    switch (part.type) {
      case "input_text":
      case "text":
        plan.text(part, "text", mode);
        break;
      case "output_text":
      case "refusal":
        plan.text(part, "text", "known");
        plan.text(part, "refusal", "known");
        break;
      case "input_image":
        plan.attachment(
          parts,
          index,
          fromDataUrl(part.image_url),
          "image",
          (text) => ({ type: "input_text", text }),
          (image) => ({ ...part, image_url: toDataUrl(image) }),
        );
        break;
      case "image_url":
        plan.attachment(
          parts,
          index,
          fromDataUrl(isObject(part.image_url) ? part.image_url.url : part.image_url),
          "image",
          (text) => ({ type: "text", text }),
          (image) => ({
            ...part,
            image_url: isObject(part.image_url)
              ? { ...part.image_url, url: toDataUrl(image) }
              : toDataUrl(image),
          }),
        );
        break;
      case "input_file":
        plan.attachment(parts, index, fromDataUrl(part.file_data), "file", (text) => ({
          type: "input_text",
          text,
        }));
        break;
      default:
        break;
    }
  });
};

const planResponses = (plan: MaskPlan, body: JsonObject): void => {
  plan.text(body, "instructions", "known");
  if (typeof body.input === "string") {
    plan.text(body, "input", "typed");
    return;
  }
  if (!Array.isArray(body.input)) return;
  for (const item of body.input) {
    if (!isObject(item)) continue;
    const type = item.type ?? (item.role !== undefined ? "message" : undefined);
    switch (type) {
      case "message": {
        const mode = modeForRole(item.role);
        if (typeof item.content === "string") plan.text(item, "content", mode);
        else if (Array.isArray(item.content)) planResponsesParts(plan, item.content, mode);
        break;
      }
      case "function_call":
        plan.call(item.call_id, item.name, item.arguments);
        plan.jsonString(item, "arguments", "known");
        break;
      case "function_call_output":
      case "custom_tool_call_output":
      case "mcp_tool_call_output": {
        const result =
          type === "function_call_output"
            ? plan.resultMode(item.call_id, undefined, item.output)
            : "detect";
        if (typeof item.output === "string") plan.text(item, "output", result);
        else if (Array.isArray(item.output)) planResponsesParts(plan, item.output, result);
        else plan.deep(item, "output", result);
        break;
      }
      case "custom_tool_call":
        plan.text(item, "input", "known");
        break;
      // The reasoning itself is encrypted and passes untouched. Its readable summary is masked
      // again in case a client restored it for display.
      case "reasoning":
        if (Array.isArray(item.summary)) {
          for (const part of item.summary) if (isObject(part)) plan.text(part, "text", "known");
        }
        break;
      // Compaction items are opaque.
      case "compaction":
      case "compaction_summary":
        break;
      default:
        for (const key of Object.keys(item)) {
          if (!OPAQUE_KEYS.has(key)) plan.deep(item, key, "known");
        }
        break;
    }
  }
};

const planChat = (plan: MaskPlan, body: JsonObject): void => {
  if (!Array.isArray(body.messages)) return;
  for (const message of body.messages) {
    if (!isObject(message)) continue;
    const mode =
      message.role === "tool"
        ? plan.resultMode(message.tool_call_id, undefined, message.content)
        : modeForRole(message.role);
    if (typeof message.content === "string") plan.text(message, "content", mode);
    else if (Array.isArray(message.content)) planResponsesParts(plan, message.content, mode);
    if (Array.isArray(message.tool_calls)) {
      for (const call of message.tool_calls) {
        if (isObject(call) && isObject(call.function)) {
          plan.call(call.id, call.function.name, call.function.arguments);
          plan.jsonString(call.function, "arguments", "known");
        }
      }
    }
  }
};

const planGeminiParts = (plan: MaskPlan, parts: Json, mode: MaskMode): void => {
  if (!Array.isArray(parts)) return;
  parts.forEach((part, index) => {
    if (!isObject(part)) return;
    // Thought parts carry a signature over their text, like Anthropic thinking blocks.
    if (part.thought === true) return;
    if (typeof part.text === "string") plan.text(part, "text", mode);
    if (isObject(part.functionCall)) {
      plan.call(part.functionCall.id, part.functionCall.name, part.functionCall.args);
      plan.deep(part.functionCall, "args", "known");
    }
    if (isObject(part.functionResponse)) {
      const { id, name, response } = part.functionResponse;
      plan.deep(part.functionResponse, "response", plan.resultMode(id, name, response));
      // A tool's answer can carry pictures of its own, beside `response`.
      planGeminiParts(plan, part.functionResponse.parts, "detect");
    }
    // The API takes both spellings of each field; a file by reference is never forwarded.
    const inlineKey = part.inlineData !== undefined ? "inlineData" : "inline_data";
    if (
      part[inlineKey] !== undefined ||
      part.fileData !== undefined ||
      part.file_data !== undefined
    ) {
      const inline = isObject(part[inlineKey]) ? part[inlineKey] : {};
      const typeKey = inline.mimeType !== undefined ? "mimeType" : "mime_type";
      const attachment = fromBase64(inline.data, inline[typeKey]);
      const kind = attachment?.mediaType.startsWith("image/") === false ? "file" : "image";
      plan.attachment(
        parts,
        index,
        attachment,
        kind,
        (text) => ({ text }),
        (image) => ({
          ...part,
          [inlineKey]: {
            ...inline,
            [typeKey]: image.mediaType,
            data: image.bytes.toString("base64"),
          },
        }),
      );
    }
  });
};

const planGemini = (plan: MaskPlan, body: JsonObject): void => {
  // Some clients wrap the request: { model, project, request: { contents } }.
  const request = isObject(body.request) ? body.request : body;
  const system = request.systemInstruction ?? request.system_instruction;
  if (isObject(system)) planGeminiParts(plan, system.parts, "known");
  if (!Array.isArray(request.contents)) return;
  for (const content of request.contents) {
    if (!isObject(content)) continue;
    planGeminiParts(plan, content.parts, content.role === "model" ? "known" : "typed");
  }
};

/** The names of the tools a request offers. A detector must not take them for organizations. */
/** Every string of a body whose shape is not known, but for the model's name. */
const planJsonText = (plan: MaskPlan, body: JsonObject): void => {
  for (const key of Object.keys(body)) if (key !== "model") plan.deep(body, key, "detect");
};

const BASE64_JSON = /^eyJ[A-Za-z0-9+/]+={0,2}$/;

/**
 * Replaces the values the vault knows in every string of a usage report, in place, and answers
 * how many strings changed. Nothing is looked for: a report is measured to hold no text of the
 * session, and this keeps a later version of the vendor's program from changing that unseen.
 * Claude Code writes an event's details as JSON in base64, which is read through.
 */
export const replaceKnownValues = (body: Json, vault: Vault): number => {
  let changed = 0;
  const walk = (holder: JsonObject | Array<Json>, key: string | number): void => {
    const value = (holder as Record<string | number, Json>)[key];
    if (Array.isArray(value)) value.forEach((_, index) => walk(value, index));
    else if (isObject(value)) for (const childKey of Object.keys(value)) walk(value, childKey);
    if (typeof value !== "string") return;
    if (BASE64_JSON.test(value)) {
      try {
        const inner: Json = JSON.parse(Buffer.from(value, "base64").toString("utf8"));
        const before = changed;
        const wrapper = { inner };
        walk(wrapper, "inner");
        if (changed > before) {
          (holder as Record<string | number, Json>)[key] = Buffer.from(
            JSON.stringify(wrapper.inner),
            "utf8",
          ).toString("base64");
        }
        return;
      } catch {
        // Not JSON after all: read as the text it is.
      }
    }
    // No file is looked for beside a report: a name sent as a handle is one wherever it stands.
    const replaced = vault.fileLabels.writeNeutral(vault.maskKnown(value, true));
    if (replaced === value) return;
    changed += 1;
    (holder as Record<string | number, Json>)[key] = replaced;
  };
  const root = { body };
  walk(root, "body");
  return changed;
};

const toolNames = (body: Json): ReadonlyArray<string> => {
  if (!isObject(body)) return [];
  const request = isObject(body.request) ? body.request : body;
  if (!Array.isArray(request.tools)) return [];
  const names: Array<string> = [];
  for (const tool of request.tools) {
    if (!isObject(tool)) continue;
    if (typeof tool.name === "string") names.push(tool.name);
    if (isObject(tool.function) && typeof tool.function.name === "string") {
      names.push(tool.function.name);
    }
    if (Array.isArray(tool.functionDeclarations)) {
      for (const declaration of tool.functionDeclarations) {
        if (isObject(declaration) && typeof declaration.name === "string") {
          names.push(declaration.name);
        }
      }
    }
  }
  return names;
};

export interface MaskedRequest {
  readonly body: Json;
  readonly stats: MaskStats;
  /** Images and files removed because they could not be checked. */
  readonly withheld: number;
  /** Images and files replaced by the text read from them. */
  readonly read: number;
  /** Images sent with their personal data covered. */
  readonly redacted: number;
  /** Texts replaced by a note because they held sealed document text. */
  readonly sealed: number;
}

export interface MaskRequestOptions {
  /**
   * Evaluation only: images and files are still replaced by the text read from them, but no
   * value is replaced by a placeholder. Personal data reaches the model.
   */
  readonly attachmentsOnly?: boolean;
  /** How images are sent. Without it they are replaced by the text read from them. */
  readonly attachments?: AttachmentHandling | undefined;
  /**
   * What to send in place of a text that holds wording of a sealed document, or undefined when
   * it holds none. `typed`: the person wrote it, and only the copied passages should go.
   */
  readonly withholdSealedText?: ((text: string, typed: boolean) => string | undefined) | undefined;
  /** The model's own wording of a text it was shown with sealed values restored, if it is one. */
  readonly remask?: ((text: string) => string | undefined) | undefined;
  /**
   * `known`: what a web search returned, or a fetch of a plainly public page, is not checked for
   * new personal data; only values already known are replaced in it. `detect`, and without the
   * option: such a result is checked like any other tool's.
   */
  readonly webResults?: "known" | "detect" | undefined;
}

/** Rewrites a request body in place so that no personal data in it reaches the model. */
export const maskRequestBody = async (
  format: WireFormat,
  body: Json,
  pseudonymizer: Pseudonymizer,
  reader?: Reader,
  options?: MaskRequestOptions,
): Promise<MaskedRequest> => {
  const plan = new MaskPlan(options?.webResults ?? "detect");
  const system = format === "anthropic-messages" && isObject(body) ? body.system : undefined;
  const systemBefore = Array.isArray(system)
    ? system.map((block) => (isObject(block) ? block.text : undefined))
    : undefined;
  if (isObject(body)) {
    switch (format) {
      case "anthropic-messages":
        planAnthropic(plan, body);
        break;
      case "openai-responses":
        planResponses(plan, body);
        break;
      case "openai-chat":
        planChat(plan, body);
        break;
      case "gemini":
        planGemini(plan, body);
        break;
      case "json-text":
        planJsonText(plan, body);
        break;
    }
  }
  const stats = await plan.apply(
    pseudonymizer,
    toolNames(body),
    reader,
    options?.attachmentsOnly === true,
    options?.attachments ?? { images: "text" },
    options?.withholdSealedText,
    options?.remask,
  );
  if (Array.isArray(system) && systemBefore !== undefined) giveUpGlobalScope(system, systemBefore);
  return {
    body,
    stats,
    withheld: plan.withheld,
    read: plan.read,
    redacted: plan.redacted,
    sealed: plan.sealed,
  };
};
