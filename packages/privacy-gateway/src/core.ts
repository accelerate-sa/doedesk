import { attachmentText } from "./attachments.ts";
import { DetectorUnavailableError } from "./detect.ts";
import type { GatewayRecord } from "./gateway.ts";
import type { Pseudonymizer } from "./pseudonymizer.ts";
import type { Reader } from "./reader.ts";
import type { Vault } from "./vault.ts";

/**
 * The one place that decides what is masked and how it is restored. Every front end calls it:
 * the network gateway on request bodies, the Claude and Codex front ends from the vendor's hooks
 * and from the app's own code before it hands content to the vendor's tool.
 */
export interface MaskingCore {
  readonly vault: Vault;
  /**
   * Masks content that is new to the model: what the user typed, what a tool returned. Every
   * string in `value` is checked for personal data. Rejects with `MaskingRefusedError`, having
   * produced nothing, when the content could not be checked.
   */
  readonly maskNew: <T>(value: T, route: MaskingRoute) => Promise<T>;
  /** Restores real values wherever a stand-in appears. Used on what the model wrote. */
  readonly restore: <T>(value: T) => T;
  /** The masked text that takes the place of an image or a file. */
  readonly readAttachment: (
    attachment: { readonly bytes: Buffer; readonly mediaType: string },
    kind: "image" | "file",
    route: MaskingRoute,
  ) => Promise<string>;
}

/** Where content was on its way to the model. Shown in the activity log. */
export interface MaskingRoute {
  /** The front end, for example `Claude Code hooks`. Takes the place of a host name. */
  readonly frontEnd: string;
  /** What was masked, for example `tool result: Bash`. Takes the place of a request path. */
  readonly what: string;
}

/** Content was not sent because it could not be checked. The message is written for the user. */
export class MaskingRefusedError extends Error {
  override readonly name = "MaskingRefusedError";
}

/** The sentence every front end shows when content could not be checked. */
export const describeMaskingFailure = (cause: unknown): string => {
  const detail =
    cause instanceof DetectorUnavailableError
      ? cause.message
      : `Masking failed unexpectedly (${String(cause)}).`;
  return `It could not be checked for personal data, so nothing left this device. ${detail}`;
};

/** Keys that name a kind or an identifier. Changing them breaks the shape a tool promised. */
const SHAPE_KEYS = new Set(["type", "id", "tool_use_id", "call_id", "media_type", "mimeType"]);

type Slot = { readonly text: string; readonly write: (value: string) => void };

/** A deep copy of `value` and one slot for each string in it that may be rewritten. */
const copyWithSlots = (value: unknown, slots: Array<Slot>): unknown => {
  if (Array.isArray(value)) {
    const copy: Array<unknown> = [];
    value.forEach((child, index) => {
      if (typeof child === "string") {
        copy[index] = child;
        slots.push({ text: child, write: (next) => (copy[index] = next) });
      } else {
        copy[index] = copyWithSlots(child, slots);
      }
    });
    return copy;
  }
  if (typeof value === "object" && value !== null) {
    const copy: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) {
      if (typeof child === "string" && !SHAPE_KEYS.has(key)) {
        copy[key] = child;
        slots.push({ text: child, write: (next) => (copy[key] = next) });
      } else {
        copy[key] = typeof child === "string" ? child : copyWithSlots(child, slots);
      }
    }
    return copy;
  }
  return value;
};

export interface MaskingCoreOptions {
  readonly pseudonymizer: Pseudonymizer;
  /** Reads text out of images and files. Without one they are withheld. Looked up per call. */
  readonly reader?: (() => Reader | undefined) | undefined;
  readonly onRecord?: ((record: GatewayRecord) => void) | undefined;
}

export const makeMaskingCore = (options: MaskingCoreOptions): MaskingCore => {
  const { pseudonymizer } = options;
  const record = (entry: Omit<GatewayRecord, "at">) =>
    options.onRecord?.({ at: new Date().toISOString(), ...entry });

  const maskNew = async <T>(value: T, route: MaskingRoute): Promise<T> => {
    const slots: Array<Slot> = [];
    const box = copyWithSlots({ value }, slots) as { value: T };
    try {
      const { texts, stats } = await pseudonymizer.mask(
        slots.map((slot) => ({ text: slot.text, mode: "detect" as const })),
      );
      slots.forEach((slot, index) => slot.write(texts[index] ?? slot.text));
      record({
        host: route.frontEnd,
        path: route.what,
        outcome: "masked",
        checked: stats.checked,
        masked: stats.masked,
      });
      return box.value;
    } catch (cause) {
      const reason = describeMaskingFailure(cause);
      record({ host: route.frontEnd, path: route.what, outcome: "refused", reason });
      throw new MaskingRefusedError(`DoeDesk did not send this. ${reason}`);
    }
  };

  return {
    vault: pseudonymizer.vault,
    maskNew,
    restore: <T>(value: T): T => {
      const slots: Array<Slot> = [];
      const box = copyWithSlots({ value }, slots) as { value: T };
      for (const slot of slots) slot.write(pseudonymizer.unmask(slot.text));
      return box.value;
    },
    readAttachment: async (attachment, kind, route) => {
      const replacement = await attachmentText(kind, options.reader?.(), attachment);
      if (!replacement.read) {
        record({ host: route.frontEnd, path: route.what, outcome: "masked", withheld: 1 });
        return replacement.text;
      }
      return maskNew(replacement.text, route);
    },
  };
};
