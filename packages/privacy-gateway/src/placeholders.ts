/**
 * Placeholders are what the model sees in place of a real value, for example `[PERSON_FBJD2]`.
 *
 * The shape is fixed and distinctive on purpose: the gateway has to find placeholders again in
 * model output, including when one is split across two streamed chunks.
 */
export const ENTITY_KINDS = [
  "PERSON",
  "ORG",
  "LOCATION",
  "ADDRESS",
  "PHONE",
  "EMAIL",
  "ID",
  "IBAN",
  "ACCOUNT",
  "DATE",
  "URL",
  // A number that is confidential in itself: an amount, a measurement, a computed result.
  "AMOUNT",
  // Identifiers of a thing, not a person, that still point to its owner when combined.
  "PARCEL",
  "DEED",
  "CASE",
  "OTHER",
] as const;

export type EntityKind = (typeof ENTITY_KINDS)[number];

/** No I, O, 0 or 1, so a code read aloud or retyped is unambiguous. */
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const CODE_LENGTH = 5;
const CODE_CLASS = "[A-HJ-NP-Z2-9]";
const KIND_ALTERNATION = ENTITY_KINDS.join("|");

export const PLACEHOLDER_SOURCE = `\\[(?:${KIND_ALTERNATION})_${CODE_CLASS}{${CODE_LENGTH}}\\]`;

export const placeholderPattern = (): RegExp => new RegExp(PLACEHOLDER_SOURCE, "g");

const PARTIAL_PLACEHOLDER = new RegExp(
  `^\\[(?:[A-Z]{0,8}|(?:${KIND_ALTERNATION})_${CODE_CLASS}{0,${CODE_LENGTH}})$`,
);

/**
 * True when `text` could still grow into a placeholder: it starts one and has not been closed.
 * Streamed output is held back while this is true so a split placeholder is restored whole.
 */
export const isPartialPlaceholder = (text: string): boolean => {
  if (!PARTIAL_PLACEHOLDER.test(text)) return false;
  const body = text.slice(1);
  const underscore = body.indexOf("_");
  if (underscore !== -1) return true;
  return ENTITY_KINDS.some((kind) => kind.startsWith(body));
};

export const makePlaceholder = (kind: EntityKind, randomBytes: Uint8Array): string => {
  let code = "";
  for (let index = 0; index < CODE_LENGTH; index += 1) {
    code += CODE_ALPHABET[(randomBytes[index] ?? 0) % CODE_ALPHABET.length];
  }
  return `[${kind}_${code}]`;
};

export const isEntityKind = (value: unknown): value is EntityKind =>
  typeof value === "string" && (ENTITY_KINDS as ReadonlyArray<string>).includes(value);
