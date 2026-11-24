import { isPartialPlaceholder, placeholderPattern } from "./placeholders.ts";
import type { Restorations } from "./restorations.ts";
import type { Vault } from "./vault.ts";
import { carriesUnit, isVaultSafe, UNIT_REACH, withoutRepeatedUnit } from "./worker/seal.ts";

type Json = unknown;
type JsonObject = Record<string, Json>;

const isObject = (value: Json): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Longest tail that can still be the start of a placeholder: `[LOCATION_ABCDE` is 15. */
const MAX_HELD_LENGTH = 16;

/** Text that has to follow a stand-in at the end of a piece before its unit can be told. */
const UNIT_WAIT = 24;

/**
 * How a value is written in text the person reads: without the unit it carries when the model
 * wrote that unit beside its stand-in. A model knows a value only as a stand-in, not whether it
 * says "SAR", and writes "[AMOUNT_K2M4P] ريال": restored whole, that read "SAR 12500 ريال".
 * `leading` is the text that came before this piece.
 */
const unitOnce =
  (vault: Vault, leading = "") =>
  (token: string, value: string, before: string, after: string): string => {
    const shorter = withoutRepeatedUnit(
      value,
      (leading + before).slice(-UNIT_REACH),
      after.slice(0, UNIT_REACH),
      (item) => vault.resolve(item),
    );
    if (shorter === value) return value;
    return vault.writtenAs(token, shorter, isVaultSafe(shorter, "number")) ? shorter : value;
  };

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

/** Fields that hold what a tool is run with. Sealed values are not restored under them. */
const TOOL_INPUT_KEYS = new Set([
  "input",
  "arguments",
  "partial_json",
  "args",
  "functionCall",
  "function_call",
  "function",
  "tool_calls",
]);

/** Items that are a tool call or a tool's answer, in any of the wire formats. */
const TOOL_TYPE = /tool|function_call|computer_call|shell_call|mcp_call/;

/**
 * Restores one piece of text the person will read. A sealed value is restored only when
 * `sealed` is set, and the text is then remembered so that its stand-ins can be put back when
 * the client sends its history again.
 */
const restoreText = (
  text: string,
  vault: Vault,
  jsonFragment: boolean,
  sealed: boolean,
  restorations: Restorations | undefined,
  restoredTokens: Set<string> | undefined,
): string => {
  // Text for the person, as opposed to what a tool is run with, which takes values as they are.
  const restored = vault.unmask(
    text,
    jsonFragment,
    sealed,
    restoredTokens,
    sealed && !jsonFragment ? unitOnce(vault) : undefined,
  );
  if (sealed && restored !== text && vault.holdsSealedToken(text)) {
    restorations?.record(restored, text);
  }
  return restored;
};

/**
 * Restores real values in a complete (non-streamed) JSON value, in place. Values of sealed
 * documents are restored in text only, never in what a tool is run with: `sealed` is false
 * below a tool call. `restoredTokens` collects the stand-ins that were restored.
 */
export const unmaskDeep = (
  value: Json,
  vault: Vault,
  restorations?: Restorations,
  sealed = true,
  restoredTokens?: Set<string>,
): Json => {
  if (typeof value === "string") {
    return restoreText(value, vault, false, sealed, restorations, restoredTokens);
  }
  if (Array.isArray(value)) {
    value.forEach((child, index) => {
      value[index] = unmaskDeep(child, vault, restorations, sealed, restoredTokens);
    });
    return value;
  }
  if (!isObject(value)) return value;
  if (typeof value.type === "string" && UNTOUCHED_TYPES.has(value.type)) return value;
  if (value.thought === true) return value;
  const here = sealed && !(typeof value.type === "string" && TOOL_TYPE.test(value.type));
  for (const key of Object.keys(value)) {
    if (UNTOUCHED_KEYS.has(key)) continue;
    const child = value[key];
    const below = here && !TOOL_INPUT_KEYS.has(key);
    value[key] =
      typeof child === "string"
        ? restoreText(
            child,
            vault,
            JSON_FRAGMENT_KEYS.has(key),
            below,
            restorations,
            restoredTokens,
          )
        : unmaskDeep(child, vault, restorations, below, restoredTokens);
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
  /** The end of what was passed on, as the model wrote it: what stands before the next piece. */
  #tail = "";
  /** The whole piece as the model wrote it, and as it was passed on. */
  #masked = "";
  #restored = "";
  readonly #vault: Vault;
  readonly #jsonFragment: boolean;
  /** The piece is text for the person, so values of sealed documents are restored in it. */
  readonly #sealed: boolean;
  readonly #restoredTokens: Set<string> | undefined;

  constructor(
    vault: Vault,
    jsonFragment: boolean,
    sealed: boolean,
    restoredTokens: Set<string> | undefined,
  ) {
    this.#vault = vault;
    this.#jsonFragment = jsonFragment;
    this.#sealed = sealed;
    this.#restoredTokens = restoredTokens;
  }

  /**
   * Where the first stand-in stands whose file label may still be completed by text to come: a
   * label is turned back into the file's name only when all of it is here.
   */
  #labelStart(text: string): number | undefined {
    const labels = this.#vault.fileLabels;
    if (labels.reach === 0 || !text.includes("[")) return undefined;
    for (const match of text.matchAll(placeholderPattern())) {
      const before = this.#tail + text.slice(0, match.index);
      if (labels.awaits(match[0], before, text.slice(match.index + match[0].length))) {
        return match.index;
      }
    }
    return undefined;
  }

  push(piece: string): string {
    this.#masked += piece;
    const text = this.#held + piece;
    const open = text.lastIndexOf("[");
    const label = this.#labelStart(text);
    let ready = text;
    if (label !== undefined) {
      this.#held = text.slice(label);
      ready = text.slice(0, label);
    } else if (
      open !== -1 &&
      text.length - open <= MAX_HELD_LENGTH &&
      isPartialPlaceholder(text.slice(open))
    ) {
      this.#held = text.slice(open);
      ready = text.slice(0, open);
    } else {
      this.#held = "";
      // A value's unit may follow it in the next piece: a stand-in at the end waits for it, when
      // its value is written with a unit. Any other value is passed on at once.
      const last = this.#forPerson ? [...ready.matchAll(placeholderPattern())].at(-1) : undefined;
      if (
        last !== undefined &&
        ready.length - (last.index + last[0].length) < UNIT_WAIT &&
        carriesUnit(this.#vault.resolve(last[0]) ?? "")
      ) {
        this.#held = ready.slice(last.index);
        ready = ready.slice(0, last.index);
      }
    }
    return this.#restore(ready);
  }

  get #forPerson(): boolean {
    return this.#sealed && !this.#jsonFragment;
  }

  #restore(ready: string): string {
    const restored = this.#vault.unmask(
      ready,
      this.#jsonFragment,
      this.#sealed,
      this.#restoredTokens,
      this.#forPerson ? unitOnce(this.#vault, this.#tail) : undefined,
      this.#tail,
    );
    this.#tail = (this.#tail + ready).slice(-Math.max(UNIT_REACH, this.#vault.fileLabels.reach));
    this.#restored += restored;
    return restored;
  }

  /** Whatever is still held: the end of a placeholder that never came, or a last stand-in. */
  flush(): string {
    const held = this.#held;
    this.#held = "";
    return this.#restore(held);
  }

  /** Once the piece has ended: remembers it if a sealed value was restored in it. */
  remember(restorations: Restorations | undefined): void {
    if (this.#sealed && this.#vault.holdsSealedToken(this.#masked)) {
      restorations?.record(this.#restored, this.#masked);
    }
  }
}

interface PieceSlot {
  /** Identifies the block the piece belongs to, so the right tail is flushed when it ends. */
  readonly block: string;
  readonly key: string;
  readonly jsonFragment: boolean;
  /** Text for the person, as opposed to what a tool is run with. */
  readonly sealed: boolean;
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
  /** Parts that arrive whole beside the streamed text and are restored as a complete value. */
  readonly whole?: ReadonlyArray<Json>;
} => {
  const type = event.type;

  // Anthropic Messages
  if (type === "content_block_delta" && isObject(event.delta)) {
    const delta = event.delta;
    const block = `a:${String(event.index)}`;
    if (delta.type === "text_delta") {
      return { slots: [slot(block, `${block}:text`, false, delta, "text", true)] };
    }
    if (delta.type === "input_json_delta") {
      return { slots: [slot(block, `${block}:json`, true, delta, "partial_json", false)] };
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
      return { slots: [slot(block, key, false, event, "delta", true)] };
    }
    if (type === "response.custom_tool_call_input.delta") {
      return { slots: [slot(block, `${block}:input`, false, event, "delta", false)] };
    }
    if (type === "response.function_call_arguments.delta") {
      return { slots: [slot(block, `${block}:args`, true, event, "delta", false)] };
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
        slots.push(slot(block, `${block}:content`, false, delta, "content", true));
      }
      if (Array.isArray(delta.tool_calls)) {
        for (const call of delta.tool_calls) {
          if (!isObject(call) || !isObject(call.function)) continue;
          if (typeof call.function.arguments !== "string") continue;
          const key = `${block}:tool:${String(call.index ?? 0)}`;
          slots.push(slot(block, key, true, call.function, "arguments", false));
        }
      }
    }
    return finished ? { slots, closes: "*", inline: true } : { slots };
  }

  // Gemini, bare or wrapped as { response: { candidates } }
  const gemini = isObject(event.response) ? event.response : event;
  if (Array.isArray(gemini.candidates)) {
    const slots: Array<PieceSlot> = [];
    const whole: Array<Json> = [];
    let finished = false;
    gemini.candidates.forEach((candidate, candidateIndex) => {
      if (!isObject(candidate)) return;
      if (candidate.finishReason !== undefined) finished = true;
      const parts = isObject(candidate.content) ? candidate.content.parts : undefined;
      if (!Array.isArray(parts)) return;
      for (const part of parts) {
        if (!isObject(part) || part.thought === true) continue;
        // A tool call arrives whole, in the same event as text or alone.
        if (isObject(part.functionCall)) whole.push(part.functionCall);
        if (typeof part.text !== "string") continue;
        const block = `g:${candidateIndex}`;
        slots.push(slot(block, `${block}:text`, false, part, "text", true));
      }
    });
    return finished ? { slots, closes: "*", inline: true, whole } : { slots, whole };
  }

  return { slots: [] };
};

const slot = (
  block: string,
  key: string,
  jsonFragment: boolean,
  holder: JsonObject,
  field: string,
  sealed: boolean,
): PieceSlot => ({
  block,
  key,
  jsonFragment,
  sealed,
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
  readonly #restorations: Restorations | undefined;
  readonly #restoredTokens: Set<string> | undefined;
  readonly #open = new Map<string, OpenPiece>();

  /** `restoredTokens` collects the stand-ins restored anywhere in the stream. */
  constructor(vault: Vault, restorations?: Restorations, restoredTokens?: Set<string>) {
    this.#vault = vault;
    this.#restorations = restorations;
    this.#restoredTokens = restoredTokens;
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

    const { slots, closes, inline, untouched, whole } = inspectEvent(event);
    if (untouched === true) return [raw];
    const output: Array<string> = [];
    const pieceKeys = new Set(slots.map((piece) => piece.key));

    for (const piece of slots) {
      let open = this.#open.get(piece.key);
      if (open === undefined) {
        open = {
          block: piece.block,
          unmasker: new PieceUnmasker(
            this.#vault,
            piece.jsonFragment,
            piece.sealed,
            this.#restoredTokens,
          ),
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
        open.unmasker.remember(this.#restorations);
        this.#open.delete(key);
        if (tail.length === 0) continue;
        const piece = slots.find((candidate) => candidate.key === key);
        // The closing event itself carries this piece, so the tail rides along with it.
        if (inline === true && piece !== undefined) piece.write(piece.read() + tail);
        else if (!pieceKeys.has(key)) output.push(open.remake(tail));
      }
    }

    if (slots.length === 0) {
      unmaskDeep(event, this.#vault, this.#restorations, true, this.#restoredTokens);
    } else {
      // A tool call that arrives whole beside text: what a tool is run with, so nothing sealed.
      for (const value of whole ?? []) {
        unmaskDeep(value, this.#vault, this.#restorations, false, this.#restoredTokens);
      }
    }
    output.push(JSON.stringify(event));
    return output;
  }

  /** Tails still held when the stream ends without a closing event. */
  finish(): ReadonlyArray<string> {
    const output: Array<string> = [];
    for (const open of this.#open.values()) {
      const tail = open.unmasker.flush();
      open.unmasker.remember(this.#restorations);
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

  constructor(vault: Vault, restorations?: Restorations, restoredTokens?: Set<string>) {
    this.#events = new EventStreamUnmasker(vault, restorations, restoredTokens);
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
