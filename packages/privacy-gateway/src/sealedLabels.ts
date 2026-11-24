import { typeOf } from "./fileLabels.ts";
import { knownPartsIn, knownPartsOf, withOwnRecords } from "./knownParts.ts";
import type { Pseudonymizer } from "./pseudonymizer.ts";
import { sealedIdentifierToken } from "./worker/seal.ts";

/**
 * What a provider is told a sealed file is called. Agents use a file by its handle; its name is
 * sent so they can tell the person's files apart, and a name can hold what the file is sealed
 * for: `Adel_AlAmri_1293040015_PulmonaryEmbolism.txt`.
 */

/** The handle and the file type: a label that says nothing the name said. */
export const neutralLabel = (handle: string, name: string): string => `${handle}${typeOf(name)}`;

const SEPARATOR = /[\s_\-.+~,;:=#&()[\]{}'"`!?@|/\\]/u;
const UPPER = /\p{Lu}/u;
const LOWER = /\p{Ll}/u;
const LETTER = /\p{L}/u;
const DIGIT = /\p{N}/u;
const ARABIC = /\p{Script=Arabic}/u;

/** Whether two characters that touch belong to different words: `lA`, `a1`, `1a`, `aخ`. */
const startsWord = (before: string, here: string, after: string | undefined): boolean => {
  if (LOWER.test(before) && UPPER.test(here)) return true;
  // "PDFReport": the last capital of a run starts the next word.
  if (UPPER.test(before) && UPPER.test(here) && after !== undefined && LOWER.test(after)) {
    return true;
  }
  if (LETTER.test(before) !== LETTER.test(here) && (DIGIT.test(before) || DIGIT.test(here))) {
    return true;
  }
  return LETTER.test(before) && LETTER.test(here) && ARABIC.test(before) !== ARABIC.test(here);
};

/**
 * A name with its joined words opened, as prose writes them: a separator becomes a space, and a
 * space is put where a capital letter, a digit or another script starts a word. A name detector
 * reads words. `at` says where each character stood in the name; -1 for a space that was put in.
 */
export const openName = (
  name: string,
): { readonly text: string; readonly at: ReadonlyArray<number> } => {
  const characters = [...name];
  let text = "";
  const at: Array<number> = [];
  let offset = 0;
  characters.forEach((character, index) => {
    const before = characters[index - 1];
    if (SEPARATOR.test(character)) {
      text += " ";
      at.push(offset);
    } else {
      if (
        before !== undefined &&
        !SEPARATOR.test(before) &&
        startsWord(before, character, characters[index + 1])
      ) {
        text += " ";
        at.push(-1);
      }
      text += character;
      for (let unit = 0; unit < character.length; unit += 1) at.push(offset + unit);
    }
    offset += character.length;
  });
  return { text, at };
};

export interface Replacement {
  readonly start: number;
  readonly end: number;
  readonly token: string;
}

/** Where a span of a name's opened form stands in the name as written. */
const placedInName = (
  opened: ReturnType<typeof openName>,
  span: Replacement,
): Replacement | undefined => {
  const stood = opened.at.slice(span.start, span.end).filter((position) => position >= 0);
  const first = stood[0];
  const last = stood.at(-1);
  return first === undefined || last === undefined
    ? undefined
    : { start: first, end: last + 1, token: span.token };
};

/**
 * Where the values found in a name's opened form stand in the name as written, each with its
 * stand-in. The spelling the name joins (`Khalid_Al_Otaibi`) becomes another spelling of the
 * same value, known from now on: it is masked where a listing or a message writes it so.
 */
export const replacementsInName = (
  vault: Pseudonymizer["vault"],
  stem: string,
  opened: ReturnType<typeof openName>,
  found: ReadonlyArray<Replacement>,
): ReadonlyArray<Replacement> =>
  found.flatMap((span) => {
    const placed = placedInName(opened, span);
    if (placed === undefined) return [];
    const joined = stem.slice(placed.start, placed.end);
    if (joined !== opened.text.slice(span.start, span.end)) {
      vault.writtenAs(span.token, joined, true);
    }
    return [placed];
  });

/** The spans of `more` that touch none of `spans`, placed in the name as written. */
export const partsBeside = (
  opened: ReturnType<typeof openName>,
  spans: ReadonlyArray<Replacement>,
  more: ReadonlyArray<Replacement>,
): ReadonlyArray<Replacement> =>
  more.flatMap((part) => {
    if (spans.some((span) => part.start < span.end && part.end > span.start)) return [];
    return placedInName(opened, part) ?? [];
  });

/**
 * Each name or path with the values a detector finds in it replaced by stand-ins. A value is
 * looked for in the name as written and with its joined words opened, each folder of a path
 * apart, and the stand-in is written where the value stood. The file type is left: it is not a
 * word of the name. Rejects when the names could not be checked: the caller then sends none.
 */
export const maskedLabels = async (
  pseudonymizer: Pseudonymizer,
  names: ReadonlyArray<string>,
  /** For each name, the record numbers its file's own text holds: sealed values, as the worker's. */
  ownRecords: ReadonlyArray<ReadonlyArray<string>> = [],
): Promise<ReadonlyArray<string>> => {
  const { vault } = pseudonymizer;
  // Folders repeat from one path to the next: each distinct part is checked once.
  const parts = new Map<
    string,
    { readonly stem: string; readonly opened: ReturnType<typeof openName> }
  >();
  for (const name of names) {
    for (const part of name.split(/[\\/]/u)) {
      if (part === "" || parts.has(part)) continue;
      const stem = part.slice(0, part.length - typeOf(part).length);
      parts.set(part, { stem, opened: openName(stem) });
    }
  }
  const checked = [...parts.values()];
  const located = await pseudonymizer.locate([
    ...checked.map((part) => part.opened.text),
    ...checked.map((part) => part.stem),
  ]);
  const index = new Map([...parts.keys()].map((part, position) => [part, position]));
  const wordToken = (written: string): string | undefined =>
    vault.isReleased(written) ? undefined : vault.tokenFor("ORG", written);
  const inVault = knownPartsOf(vault.entries());
  return names.map((name, nameIndex) => {
    const known = withOwnRecords(inVault, ownRecords[nameIndex] ?? [], (value) =>
      sealedIdentifierToken(vault, value),
    );
    return name.replace(/[^\\/]+/gu, (part) => {
      const position = index.get(part);
      const { stem, opened } = checked[position ?? -1] ?? {};
      if (position === undefined || stem === undefined || opened === undefined) return part;
      const inOpened = located[position] ?? [];
      const found: Array<Replacement> = [
        ...(located[checked.length + position] ?? []),
        ...replacementsInName(vault, stem, opened, inOpened),
        ...partsBeside(opened, inOpened, knownPartsIn(opened, known, wordToken)),
      ].toSorted((left, right) => left.start - right.start || right.end - left.end);
      let label = "";
      let cursor = 0;
      for (const span of found) {
        if (span.start < cursor) continue;
        label += stem.slice(cursor, span.start) + span.token;
        cursor = span.end;
      }
      return label + stem.slice(cursor) + part.slice(stem.length);
    });
  });
};
