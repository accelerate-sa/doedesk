import type { DetectedEntity } from "./detect.ts";

/*
 * A name detector reads code as prose and reports its words as people and organisations. Once
 * such a word is in the vault it is replaced everywhere, and the agent reads and writes broken
 * code. These rules tell the words of code from names, by spelling and by what stands around them.
 */

/**
 * Words of programming languages, shells and data formats, in exactly this spelling. Languages
 * and tools that share a name with people (Ruby, Julia, Ada, Pascal, Swift) are left out.
 */
const CODE_WORDS = new Set(
  [
    "import from export require include using namespace package module",
    "def class function func fn lambda return yield async await",
    "if else for while do switch case default break continue goto pass",
    "try except catch finally raise throw throws assert with as in is not and or",
    "const let var static public private protected readonly final abstract",
    "interface enum struct impl trait type typeof instanceof extends implements new delete void",
    "null undefined none true false None True False NULL TRUE FALSE NaN",
    "self this super cls argv args kwargs",
    "int str float bool dict list tuple set bytes string number boolean object array char byte",
    "echo exit printf print println sudo cd ls cat grep sed awk curl wget chmod chown mkdir rm cp",
    "mv tar git npm npx pip pip3 python python3 node bun deno bash sh zsh env export source",
    "json JSON yaml YAML yml xml XML html HTML css CSS csv CSV toml sql SQL utf8 utf-8 UTF-8 ascii",
    "stdin stdout stderr sys os re io math time datetime pathlib subprocess",
    "select insert update where join group order limit",
    "http https localhost api url uri uuid regex",
  ].flatMap((line) => line.split(" ")),
);

/**
 * Words of code that are also given names. Each is code only where its own line says so, and
 * only alone: a longer span that holds one is left to the detector.
 */
const NAME_LIKE_WORDS: Readonly<Record<string, (before: string, after: string) => boolean>> = {
  // `elif <condition>:` to the end of the line.
  elif: (_before, after) => /^[ \t]+\S.*:[ \t]*(?:#.*)?$/u.test(after),
  // `!= nil`, `return nil`, `(nil, err)`.
  nil: (before, after) =>
    /(?:[=!<>]=|[=(,:]|return)[ \t]*$/u.test(before) || /^[ \t]*[,);}\]]/u.test(after),
};

/** Kinds found by their format or named as a record's number: never code, whatever the words. */
const NEVER_CODE = new Set(["ID", "IBAN", "PHONE", "EMAIL", "ACCOUNT", "CASE", "DEED", "PARCEL"]);
/** The only words of code that take a bare number after them, and how long that number may be. */
const TAKES_A_NUMBER = new Set(["exit", "return"]);
const SMALL_NUMBER = /^[0-9]{1,3}$/;
const LOWER_IDENTIFIER = /^[a-z_][a-z0-9_.]*,?$/;
const LOWER_CALL = /^[a-z_][a-z0-9_]*(?:\.[A-Za-z_]\w*)?$/;
const UNICODE_ESCAPE = /^u[0-9a-fA-F]{4}$/;

/** True when the span is a piece of code and not a name. */
export const isCodeToken = (text: string, entity: DetectedEntity): boolean => {
  const surface = text.slice(entity.start, entity.end);
  // `\u0646` in escaped text, reported without its backslash.
  if (UNICODE_ESCAPE.test(surface) && text[entity.start - 1] === "\\") return true;
  if (NEVER_CODE.has(entity.kind)) return false;

  const words = surface.split(/\s+/u).filter((word) => word.length > 0);
  const [first] = words;
  if (first === undefined) return false;
  const lineStart = text.lastIndexOf("\n", entity.start - 1) + 1;
  const lineBreak = text.indexOf("\n", entity.end);
  const before = text.slice(lineStart, entity.start);
  const after = text.slice(entity.end, lineBreak === -1 ? text.length : lineBreak);

  if (words.length === 1) {
    const inCode = NAME_LIKE_WORDS[surface];
    if (inCode !== undefined) return inCode(before, after);
  }
  // `import`, `json`, `import sys`.
  if (words.every((word) => CODE_WORDS.has(word))) return true;
  // `exit 1`, `return 0`: a status, never a longer number, and after no other word.
  if (
    words.length === 2 &&
    TAKES_A_NUMBER.has(first) &&
    SMALL_NUMBER.test(words[1] ?? "") &&
    after.trim() === ""
  ) {
    return true;
  }

  // `import hijridate`, and the `convertdate import islamic` of `from convertdate import islamic`.
  // Module names are lower case; a capital could start a name, so it is left to the detector.
  const modules = words.every((word) => CODE_WORDS.has(word) || LOWER_IDENTIFIER.test(word));
  if (modules) {
    if (first === "import") return true;
    // `from noura` is prose unless an `import` follows on the line.
    if (first === "from" && (words.includes("import") || /^\s+import\s/u.test(after))) return true;
    if (words.includes("import") && /from[ \t]+$/u.test(before)) return true;
  }

  // A call: `re.search(`, `print(`. A capital before the dot could be `Dr.Smith(`.
  return LOWER_CALL.test(surface) && text[entity.end] === "(";
};

const FILE_NAME = /^([^\s:]+\.[A-Za-z0-9]{1,8})(?::[0-9]+){0,2}$/u;

/** The file a span names, without a line number after it, when it has the shape of a file name. */
export const fileNameOf = (surface: string): string | undefined => FILE_NAME.exec(surface)?.[1];

/**
 * The words of a file's path, folders included, for asking whether one of them is a known name:
 * `clients/noura/NouraContract2026.md` gives clients, noura, noura, contract, 2026.
 */
export const wordsOfFileName = (name: string): ReadonlyArray<string> =>
  name
    .replace(/\.[A-Za-z0-9]{1,8}$/u, "")
    .replace(/(\p{Ll})(\p{Lu})/gu, "$1 $2")
    .replace(/(\p{L})(\p{N})|(\p{N})(\p{L})/gu, "$1$3 $2$4")
    .split(/[\s._/\\-]+/u)
    .filter((word) => word.length > 0);
