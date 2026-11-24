/**
 * Finds the values the privacy gateway replaces, where they stand in a text a client shows. It
 * follows `Vault.findKnown` in `@t3tools/privacy-gateway` rule for rule, and a test in
 * `apps/server` holds the two together: a change to one that the other lacks fails there.
 */

/** A stand-in and every spelling of the value it replaces. */
export interface KnownValue {
  readonly token: string;
  readonly surfaces: ReadonlyArray<string>;
}

export interface KnownValueSpan {
  readonly start: number;
  readonly end: number;
  readonly token: string;
}

export interface KnownValueMatcher {
  readonly find: (text: string) => ReadonlyArray<KnownValueSpan>;
}

const MIN_SURFACE_LENGTH = 3;
const ATTACHED_PREFIX = "(?:[وف]?[بلك]|[وف])(?=\\p{Script=Arabic})";
const MIN_PREFIXED_WORD_LENGTH = 4;
const PLACEHOLDER = /\[[A-Z]{2,8}_[A-HJ-NP-Z2-9]{5}\]/g;

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const takesPrefix = (surface: string): boolean =>
  /\s/u.test(surface) || surface.length >= MIN_PREFIXED_WORD_LENGTH;

/** The kind a stand-in names, such as `PERSON` for `[PERSON_FBJD2]`. */
export const standInKind = (token: string): string => token.slice(1, token.lastIndexOf("_"));

/**
 * A matcher for these values, or null when none of them can be searched for. Where two values
 * share a spelling, the later one in the list is found.
 */
export const makeKnownValueMatcher = (
  values: ReadonlyArray<KnownValue>,
): KnownValueMatcher | null => {
  const tokens = new Map<string, string>();
  for (const value of values) {
    for (const surface of value.surfaces) {
      if (surface.length >= MIN_SURFACE_LENGTH) tokens.set(surface, value.token);
    }
  }
  if (tokens.size === 0) return null;
  // Longest first, so a full name wins over the first name it contains.
  const alternation = [...tokens.keys()]
    .sort((left, right) => right.length - left.length)
    .map(escapeRegExp)
    .join("|");
  const pattern = new RegExp(
    `(?<![\\p{L}\\p{N}])(${ATTACHED_PREFIX})?(${alternation})(?![\\p{L}\\p{N}])`,
    "gu",
  );
  const scan = (segment: string, offset: number, found: Array<KnownValueSpan>) => {
    if (segment.length < MIN_SURFACE_LENGTH) return;
    for (const match of segment.matchAll(pattern)) {
      const prefix = match[1] ?? "";
      const surface = match[2] ?? "";
      const token = tokens.get(surface);
      if (token === undefined || (prefix !== "" && !takesPrefix(surface))) continue;
      const start = offset + match.index + prefix.length;
      found.push({ start, end: start + surface.length, token });
    }
  };
  return {
    find: (text) => {
      const found: Array<KnownValueSpan> = [];
      let cursor = 0;
      // A stand-in written out in the text is not searched: it is not the person's value.
      for (const match of text.matchAll(PLACEHOLDER)) {
        scan(text.slice(cursor, match.index), cursor, found);
        cursor = match.index + match[0].length;
      }
      scan(text.slice(cursor), cursor, found);
      return found;
    },
  };
};
