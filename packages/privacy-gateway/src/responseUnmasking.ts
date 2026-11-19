import { isPartialPlaceholder } from "./placeholders.ts";
import type { Vault } from "./vault.ts";

type Json = unknown;
type JsonObject = Record<string, Json>;

const isObject = (value: Json): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Longest tail that can still be the start of a placeholder: `[LOCATION_ABCDE` is 15. */
const MAX_HELD_LENGTH = 16;

/** Fields that hold a JSON document as a string, so restored values must be JSON-escaped. */
const JSON_FRAGMENT_KEYS = new Set(["arguments", "partial_json"]);

/** Fields that are opaque or signed and must reach the client byte for byte. */
const UNTOUCHED_KEYS = new Set([
  "id",
  "type",
  "signature",
  "encrypted_content",
  "thinking",
  "data",
  "call_id",
  "item_id",
  "tool_use_id",
  "model",
  "thoughtSignature",
  "reasoning",
  "reasoning_content",
]);

/** Blocks whose text is covered by a signature, or is reasoning the model must get back intact. */
const UNTOUCHED_TYPES = new Set(["thinking", "redacted_thinking", "reasoning"]);

/** Restores real values in a complete (non-streamed) JSON value, in place. */
export const unmaskDeep = (value: Json, vault: Vault): Json => {
  if (typeof value === "string") return vault.unmask(value);
  if (Array.isArray(value)) {
    value.forEach((child, index) => {
      value[index] = unmaskDeep(child, vault);
    });
    return value;
  }
  if (!isObject(value)) return value;
  if (typeof value.type === "string" && UNTOUCHED_TYPES.has(value.type)) return value;
  if (value.thought === true) return value;
  for (const key of Object.keys(value)) {
    if (UNTOUCHED_KEYS.has(key)) continue;
    const child = value[key];
    value[key] =
      typeof child === "string"
        ? vault.unmask(child, JSON_FRAGMENT_KEYS.has(key))
        : unmaskDeep(child, vault);
  }
  return value;
};

/**
 * Restores placeholders in text that arrives in pieces.
 *
 * A placeholder can be cut anywhere between two pieces, so a tail that might still become one is
 * held until the next piece settles it.
 */
class PieceUnmasker {
  #held = "";
  readonly #vault: Vault;
  readonly #jsonFragment: boolean;

  constructor(vault: Vault, jsonFragment: boolean) {
    this.#vault = vault;
    this.#jsonFragment = jsonFragment;
  }

  push(piece: string): string {
    const text = this.#held + piece;
    const open = text.lastIndexOf("[");
    if (
      open !== -1 &&
      text.length - open <= MAX_HELD_LENGTH &&
      isPartialPlaceholder(text.slice(open))
    ) {
      this.#held = text.slice(open);
      return this.#vault.unmask(text.slice(0, open), this.#jsonFragment);
    }
    this.#held = "";
    return this.#vault.unmask(text, this.#jsonFragment);
  }

  /** Whatever is still held: by now it can no longer become a placeholder. */
  flush(): string {
    const held = this.#held;
    this.#held = "";
    return held;
  }
}

interface PieceSlot {
  /** Identifies the block the piece belongs to, so the right tail is flushed when it ends. */
  readonly block: string;
  readonly key: string;
  readonly jsonFragment: boolean;
  readonly read: () => string;
  readonly write: (value: string) => void;
}

/**
 * Finds the streamed text pieces in one event, for each wire format. Returns the pieces, and the
 * block that this event closes, if any (`"*"` closes every block).
 */
const inspectEvent = (
  event: JsonObject,
): {
  readonly slots: ReadonlyArray<PieceSlot>;
  readonly closes?: string;
  readonly inline?: boolean;
  /** The event passes through exactly as the model sent it. */
  readonly untouched?: boolean;
} => {
  const type = event.type;

  // Anthropic Messages
  if (type === "content_block_delta" && isObject(event.delta)) {
    const delta = event.delta;
    const block = `a:${String(event.index)}`;
    if (delta.type === "text_delta") {
      return { slots: [slot(block, `${block}:text`, false, delta, "text")] };
    }
    if (delta.type === "input_json_delta") {
      return { slots: [slot(block, `${block}:json`, true, delta, "partial_json")] };
    }
    return { slots: [] };
  }
  if (type === "content_block_stop") return { slots: [], closes: `a:${String(event.index)}` };
  if (type === "message_stop" || type === "message_delta") return { slots: [], closes: "*" };

  // OpenAI Responses
  if (typeof type === "string" && type.startsWith("response.")) {
    const block = `r:${String(event.item_id ?? event.output_index)}`;
    if (type === "response.output_text.delta" || type === "response.refusal.delta") {
      const key = `${block}:${String(event.content_index)}:text`;
      return { slots: [slot(block, key, false, event, "delta")] };
    }
    if (type === "response.custom_tool_call_input.delta") {
      return { slots: [slot(block, `${block}:input`, false, event, "delta")] };
    }
    if (type === "response.function_call_arguments.delta") {
      return { slots: [slot(block, `${block}:args`, true, event, "delta")] };
    }
    // Reasoning is returned to the model as written, so its streamed text stays masked too.
    if (type.includes("reasoning")) return { slots: [], untouched: true };
    if (type.endsWith(".delta")) return { slots: [] };
    if (event.item_id !== undefined || event.output_index !== undefined) {
      return { slots: [], closes: block };
    }
    return { slots: [], closes: "*" };
  }

  // OpenAI Chat Completions
  if (Array.isArray(event.choices)) {
    const slots: Array<PieceSlot> = [];
    let finished = false;
    for (const choice of event.choices) {
      if (!isObject(choice)) continue;
      const block = `c:${String(choice.index ?? 0)}`;
      if (choice.finish_reason !== null && choice.finish_reason !== undefined) finished = true;
      const delta = choice.delta;
      if (!isObject(delta)) continue;
      if (typeof delta.content === "string") {
        slots.push(slot(block, `${block}:content`, false, delta, "content"));
      }
      if (Array.isArray(delta.tool_calls)) {
        for (const call of delta.tool_calls) {
          if (!isObject(call) || !isObject(call.function)) continue;
          if (typeof call.function.arguments !== "string") continue;
          const key = `${block}:tool:${String(call.index ?? 0)}`;
          slots.push(slot(block, key, true, call.function, "arguments"));
        }
      }
    }
    return finished ? { slots, closes: "*", inline: true } : { slots };
  }

  // Gemini, bare or wrapped as { response: { candidates } }
  const gemini = isObject(event.response) ? event.response : event;
  if (Array.isArray(gemini.candidates)) {
    const slots: Array<PieceSlot> = [];
    let finished = false;
    gemini.candidates.forEach((candidate, candidateIndex) => {
      if (!isObject(candidate)) return;
      if (candidate.finishReason !== undefined) finished = true;
      const parts = isObject(candidate.content) ? candidate.content.parts : undefined;
      if (!Array.isArray(parts)) return;
      for (const part of parts) {
        if (!isObject(part) || part.thought === true || typeof part.text !== "string") continue;
        const block = `g:${candidateIndex}`;
        slots.push(slot(block, `${block}:text`, false, part, "text"));
      }
    });
    return finished ? { slots, closes: "*", inline: true } : { slots };
  }

  return { slots: [] };
};

const slot = (
  block: string,
  key: string,
  jsonFragment: boolean,
  holder: JsonObject,
  field: string,
): PieceSlot => ({
  block,
  key,
  jsonFragment,
  read: () => (typeof holder[field] === "string" ? holder[field] : ""),
  write: (value) => {
    holder[field] = value;
  },
});

interface OpenPiece {
  readonly block: string;
  readonly unmasker: PieceUnmasker;
  /** Rebuilds the event that last carried this piece, with different text, to flush a tail. */
  readonly remake: (text: string) => string;
}

/**
 * Rewrites a stream of server-sent events (or WebSocket messages) from a model so the client
 * receives real values where the model wrote placeholders.
 */
export class EventStreamUnmasker {
  readonly #vault: Vault;
  readonly #open = new Map<string, OpenPiece>();

  constructor(vault: Vault) {
    this.#vault = vault;
  }

  /**
   * Rewrites one JSON event. Returns the events to send in its place: usually one, sometimes a
   * flushed tail first.
   */
  transformEvent(raw: string): ReadonlyArray<string> {
    let event: Json;
    try {
      event = JSON.parse(raw);
    } catch {
      return [raw];
    }
    if (!isObject(event)) return [raw];

    const { slots, closes, inline, untouched } = inspectEvent(event);
    if (untouched === true) return [raw];
    const output: Array<string> = [];
    const pieceKeys = new Set(slots.map((piece) => piece.key));

    for (const piece of slots) {
      let open = this.#open.get(piece.key);
      if (open === undefined) {
        open = {
          block: piece.block,
          unmasker: new PieceUnmasker(this.#vault, piece.jsonFragment),
          remake: () => raw,
        };
      }
      const restored = open.unmasker.push(piece.read());
      piece.write(restored);
      this.#open.set(piece.key, {
        ...open,
        remake: (text) => {
          const previous = piece.read();
          piece.write(text);
          const remade = JSON.stringify(event);
          piece.write(previous);
          return remade;
        },
      });
    }

    if (closes !== undefined) {
      for (const [key, open] of this.#open) {
        if (closes !== "*" && open.block !== closes) continue;
        const tail = open.unmasker.flush();
        this.#open.delete(key);
        if (tail.length === 0) continue;
        const piece = slots.find((candidate) => candidate.key === key);
        // The closing event itself carries this piece, so the tail rides along with it.
        if (inline === true && piece !== undefined) piece.write(piece.read() + tail);
        else if (!pieceKeys.has(key)) output.push(open.remake(tail));
      }
    }

    if (slots.length === 0) unmaskDeep(event, this.#vault);
    output.push(JSON.stringify(event));
    return output;
  }

  /** Tails still held when the stream ends without a closing event. */
  finish(): ReadonlyArray<string> {
    const output: Array<string> = [];
    for (const open of this.#open.values()) {
      const tail = open.unmasker.flush();
      if (tail.length > 0) output.push(open.remake(tail));
    }
    this.#open.clear();
    return output;
  }
}

/** Splits a server-sent-event byte stream into events and rewrites each `data:` payload. */
export class SseUnmasker {
  readonly #events: EventStreamUnmasker;
  readonly #decoder = new TextDecoder();
  #buffer = "";

  constructor(vault: Vault) {
    this.#events = new EventStreamUnmasker(vault);
  }

  push(chunk: Uint8Array): string {
    this.#buffer += this.#decoder.decode(chunk, { stream: true });
    let output = "";
    for (;;) {
      const match = /\r?\n\r?\n/.exec(this.#buffer);
      if (match === null) break;
      const block = this.#buffer.slice(0, match.index);
      this.#buffer = this.#buffer.slice(match.index + match[0].length);
      output += this.#rewriteBlock(block);
    }
    return output;
  }

  end(): string {
    let output = this.#buffer.length > 0 ? this.#rewriteBlock(this.#buffer) : "";
    this.#buffer = "";
    for (const event of this.#events.finish()) output += `data: ${event}\n\n`;
    return output;
  }

  #rewriteBlock(block: string): string {
    const lines = block.split(/\r?\n/);
    const dataLines = lines.filter((line) => line.startsWith("data:"));
    if (dataLines.length === 0) return `${block}\n\n`;
    const payload = dataLines.map((line) => line.slice(5).replace(/^ /, "")).join("\n");
    if (payload === "[DONE]") {
      let output = "";
      for (const event of this.#events.finish()) output += `data: ${event}\n\n`;
      return `${output}${block}\n\n`;
    }
    const otherLines = lines.filter((line) => !line.startsWith("data:"));
    const prefix = otherLines.length > 0 ? `${otherLines.join("\n")}\n` : "";
    return this.#events
      .transformEvent(payload)
      .map((event) => `${prefix}data: ${event}\n\n`)
      .join("");
  }
}
