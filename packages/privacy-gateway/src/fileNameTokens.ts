/**
 * Finds what is written like a file's name or a path in a text, so that the words a name joins
 * (`Sara_AlDossari_bank_letter.txt`) can be read apart. What marks one, and what is left alone,
 * is told in this package's README under "Names of files and paths".
 */

/** One folder of a path, or a file's name without its type: where it stands in the text. */
export interface NamePart {
  readonly start: number;
  readonly end: number;
}

/** A path or a file's name as it stands in the text, and the parts of it that hold words. */
export interface NameToken extends NamePart {
  readonly parts: ReadonlyArray<NamePart>;
}

const FILE_TYPES = new Set(
  [
    "txt md markdown rtf pdf doc docx odt pages xls xlsx xlsm ods numbers csv tsv ppt pptx odp key",
    "json jsonl ndjson xml yaml yml toml ini cfg conf env log sql db sqlite parquet",
    "html htm css js jsx mjs cjs ts tsx py ipynb rb go rs java kt swift c cc cpp h hpp cs php",
    "sh bash zsh ps1 bat r lua pl scala dart vue svelte",
    "png jpg jpeg gif webp svg bmp tif tiff heic ico mp3 wav m4a mp4 mov avi mkv webm",
    "zip tar gz tgz bz2 xz 7z rar dmg iso eml msg ics vcf bak tmp lock map patch diff tex bib epub",
  ].flatMap((line) => line.split(" ")),
);

const SLASH = 0x2f;
const BACKSLASH = 0x5c;
const DOT = 0x2e;
const UNDERSCORE = 0x5f;
const COLON = 0x3a;

/** Characters that end a token. Others outside ASCII are looked up one by one below. */
const ENDS_TOKEN = new Uint8Array(128);
for (const character of " \t\n\r\f\v\"'`()<>[]{},;=|*?!&:") {
  ENDS_TOKEN[character.charCodeAt(0)] = 1;
}
const ENDS_TOKEN_BEYOND_ASCII = new Set(
  [..."   　«»“”‘’،؛؟…"].map((character) => character.charCodeAt(0)),
);

/** Longer than a path is: a blob of encoded bytes holds `/` too. */
const MAX_TOKEN_LENGTH = 400;
const MAX_PART_LENGTH = 120;

const TYPE = /\.([A-Za-z0-9]{1,8})$/u;
const HAS_LETTER = /\p{L}/u;
/** `Sara_AlDossari`, `خالد_العتيبي`: never `snake_case`, `MAX_RETRY` or `camelCase`. */
const JOINED_NAME =
  /^(?:\p{Lu}\p{Ll}[\p{L}\p{N}]*|\p{Script=Arabic}+)(?:_(?:\p{Lu}\p{Ll}[\p{L}\p{N}]*|\p{Script=Arabic}+))+$/u;
/** A run that is a digest, an identifier or a number says nothing a detector reads. */
const OPAQUE = /^(?:[0-9a-f]{16,}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f-]{20,}|[\d.,-]+|u[0-9a-f]{4})$/iu;
/** `8042.pdf`, `2026/`: a name that is one number may be the serial of a known record. */
const NUMBER_NAME = /^[0-9]{3,}$/u;
/** `01/08/1447هـ`, `3/4`, `120/80`: a date or a ratio, each of its parts a number first. */
const STARTS_WITH_NUMBER = /^\p{N}/u;

/**
 * A backslash parts folders only in a path that starts as a Windows one: after a drive letter
 * (`C:` ends a token, so the path starts at its `\`), or with two of them. Elsewhere it is an
 * escape of quoted text, which source code and JSON are full of.
 */
const startsWindowsPath = (text: string, start: number): boolean => {
  if (text.charCodeAt(start) !== BACKSLASH) return false;
  if (text.charCodeAt(start + 1) === BACKSLASH) return true;
  return (
    text.charCodeAt(start - 1) === COLON &&
    /[A-Za-z]/u.test(text.charAt(start - 2)) &&
    !/[\p{L}\p{N}]/u.test(text.charAt(start - 3))
  );
};

const pushPart = (parts: Array<NamePart>, text: string, start: number, end: number): void => {
  if (end - start < 3 || end - start > MAX_PART_LENGTH) return;
  const part = text.slice(start, end);
  // A backslash left in a part is an escape in quoted text (`\n`, `\t`), not a folder's edge.
  if (!NUMBER_NAME.test(part)) {
    if (!HAS_LETTER.test(part) || OPAQUE.test(part) || part.includes("\\")) return;
  }
  parts.push({ start, end });
};

const partsOfToken = (
  tokens: Array<NameToken>,
  text: string,
  from: number,
  to: number,
  slashes: number,
  /** Backslashes part folders here: the token is a Windows path. */
  windows: boolean,
): void => {
  const parts: Array<NamePart> = [];
  let start = from;
  let end = to;
  // `@hr/notes.txt` in a mention; a sentence's full stop after a name.
  while (start < end && text.charCodeAt(start) === 0x40) start += 1;
  while (end > start && text.charCodeAt(end - 1) === DOT) end -= 1;
  if (end - start < 3) return;
  const token = text.slice(start, end);
  const type = TYPE.exec(token)?.[1];
  if (slashes === 0) {
    if (type !== undefined) {
      // `rows.map(` is a call, and `user.name` no file type.
      if (!FILE_TYPES.has(type.toLowerCase()) || text.charCodeAt(to) === 0x28) return;
      pushPart(parts, text, start, end - type.length - 1);
    } else if (JOINED_NAME.test(token)) {
      pushPart(parts, text, start, end);
    }
    if (parts.length > 0) tokens.push({ start, end, parts });
    return;
  }
  // A web address is found whole, as one: its host and path are not folders of this computer.
  if (token.startsWith("//") && text.charCodeAt(from - 1) === COLON) return;
  const first = token.charCodeAt(0);
  const last = token.charCodeAt(token.length - 1);
  const pathLike =
    slashes >= 2 ||
    first === SLASH ||
    windows ||
    first === 0x7e ||
    first === DOT ||
    last === SLASH ||
    (windows && last === BACKSLASH) ||
    (type !== undefined && HAS_LETTER.test(type));
  if (!pathLike) return;
  const stop = type === undefined ? end : end - type.length - 1;
  let segment = start;
  let named = false;
  for (let index = start; index <= stop; index += 1) {
    const code = index === stop ? SLASH : text.charCodeAt(index);
    if (code !== SLASH && !(windows && code === BACKSLASH)) continue;
    if (index > segment && !STARTS_WITH_NUMBER.test(text.charAt(segment))) named = true;
    pushPart(parts, text, segment, index);
    segment = index + 1;
  }
  if (named && parts.length > 0) tokens.push({ start, end, parts });
};

/**
 * The folders and the file names written in `text`, each once for every place it stands. One
 * pass over the text: only a token that holds `/`, `\`, `.` or `_` is looked at again.
 */
export const fileNameTokens = (text: string): ReadonlyArray<NameToken> => {
  const tokens: Array<NameToken> = [];
  let start = -1;
  let marked = false;
  let slashes = 0;
  let backslashes = 0;
  const length = text.length;
  for (let index = 0; index <= length; index += 1) {
    const code = index === length ? 0x20 : text.charCodeAt(index);
    const ends = code < 128 ? ENDS_TOKEN[code] === 1 : ENDS_TOKEN_BEYOND_ASCII.has(code);
    if (!ends) {
      if (start === -1) start = index;
      if (code === SLASH) {
        slashes += 1;
        marked = true;
      } else if (code === BACKSLASH) {
        backslashes += 1;
        marked = true;
      } else if (code === DOT || code === UNDERSCORE) {
        marked = true;
      }
      continue;
    }
    if (start !== -1 && marked && index - start <= MAX_TOKEN_LENGTH) {
      const windows = backslashes > 0 && startsWindowsPath(text, start);
      partsOfToken(tokens, text, start, index, slashes + (windows ? backslashes : 0), windows);
    }
    start = -1;
    marked = false;
    slashes = 0;
    backslashes = 0;
  }
  return tokens;
};
