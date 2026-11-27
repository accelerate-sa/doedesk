import type { DetectedEntity } from "./fixedFormats.ts";
import type { EntityKind } from "./placeholders.ts";

/**
 * Values found by the label beside them: the name after "Full Name" or "السيد", the address
 * after "Business Address". A form says what each field holds, so a value is found even when no
 * name detector knows its spelling. Pattern only, like `fixedFormats.ts`: no network, no Node API.
 */

/** What a field's value must look like before it is taken for one. */
type Shape = "person" | "organisation" | "address" | "date" | "box" | "postcode";

interface LabelRule {
  readonly kind: EntityKind;
  readonly shape: Shape;
  readonly english: ReadonlyArray<string>;
  readonly arabic: ReadonlyArray<string>;
}

const RULES: ReadonlyArray<LabelRule> = [
  {
    kind: "PERSON",
    shape: "person",
    english: ["full name", "name in full", "owner name", "owner's name", "owner"],
    arabic: ["الاسم الكامل", "اسم الشخص", "اسم المالك", "المالك"],
  },
  {
    kind: "ORG",
    shape: "organisation",
    english: [
      "facility name in english",
      "facility name in arabic",
      "facility name",
      "establishment name",
    ],
    arabic: [
      "اسم المنشأة باللغة الإنجليزية",
      "اسم المنشأة باللغة العربية",
      "اسم المنشأة",
      "اسم المؤسسة",
    ],
  },
  {
    kind: "ADDRESS",
    shape: "address",
    english: ["business address"],
    arabic: ["عنوان المنشأة"],
  },
  {
    kind: "DATE",
    shape: "date",
    english: ["date of birth", "birth date", "dob"],
    arabic: ["تاريخ الميلاد"],
  },
  {
    kind: "ADDRESS",
    shape: "box",
    english: ["p.o. box", "p.o.box", "p.o box", "po box"],
    arabic: ["الصندوق البريدي", "صندوق البريد", "ص.ب"],
  },
  {
    kind: "ADDRESS",
    shape: "postcode",
    english: ["postal code", "post code", "zip code"],
    arabic: ["الرمز البريدي"],
  },
];

/** Column headers that say as much of every cell under them. Too common in prose to be labels. */
const HEADER_ONLY: ReadonlyArray<LabelRule> = [
  {
    kind: "PERSON",
    shape: "person",
    english: ["name", "first name", "last name", "customer name", "employee name", "client name"],
    arabic: ["الاسم", "الاسم الأول", "اسم العائلة", "اسم العميل", "اسم الموظف"],
  },
  {
    kind: "ADDRESS",
    shape: "address",
    english: ["address", "home address", "national address"],
    arabic: ["العنوان", "العنوان الوطني"],
  },
];

const escapeForPattern = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** A label as people and scans write it: any run of spaces, and Arabic letters in either spelling. */
const labelSource = (label: string): string =>
  escapeForPattern(label)
    .replace(/[أإآا]/gu, "[أإآا]")
    .replace(/ة/gu, "[ةه]")
    .replace(/[يى]/gu, "[يى]")
    .replace(/ /gu, "\\s+");

const alternation = (labels: ReadonlyArray<string>): string =>
  labels
    .toSorted((left, right) => right.length - left.length)
    .map(labelSource)
    .join("|");

/** One pattern for a rule's labels: English whole words, Arabic with no letter joined on. */
const rulePattern = (rule: LabelRule, flags: string): RegExp =>
  new RegExp(
    `(?<![\\p{L}\\p{N}])(?:${alternation(rule.english)})(?![\\p{L}\\p{N}])|(?<!\\p{L})(?:${alternation(rule.arabic)})(?!\\p{L})`,
    flags,
  );

const RULE_PATTERNS = RULES.map((rule) => ({ rule, pattern: rulePattern(rule, "giu") }));
const WHOLE_LABELS = [...RULES, ...HEADER_ONLY].map((rule) => ({
  rule,
  pattern: new RegExp(`^(?:${rulePattern(rule, "iu").source})$`, "iu"),
}));

/** A note beside a label: "(As of Official Documents) *", closed or cut off by the cell's edge. */
const NOTES = /\([^)]*\)?|[*:：]/gu;

const withoutNotes = (text: string): string =>
  text.replace(NOTES, " ").replace(/\s+/gu, " ").trim();

const ruleOfWholeLabel = (text: string): LabelRule | undefined => {
  const bare = withoutNotes(text);
  return bare === "" ? undefined : WHOLE_LABELS.find(({ pattern }) => pattern.test(bare))?.rule;
};

/**
 * The kind of value a column holds, when its header is one of the labels and nothing else: the
 * cells under "Full Name" are names whatever they look like.
 */
export const kindOfHeader = (header: string): EntityKind | undefined =>
  ruleOfWholeLabel(header)?.kind;

/** Words no name holds. A "value" with one of them in it is the rest of a sentence. */
const FUNCTION_WORDS = new Set(
  (
    "the a an of to and or for in on at by with from as is are was were be been it this that " +
    "these those who whom which what when where why how not no if then than can may must " +
    "should will would has have had do does did its their his her our your my we you they he " +
    "she i me us them " +
    "في من على إلى الى عن مع هو هي هم أن ان إن التي الذي الذين هذا هذه ذلك تلك قد لم لن لا ما " +
    "كان كانت يكون ثم أو او حتى بعد قبل عند كل بين"
  ).split(" "),
);
/** What stands in a field that was left as it came: a type, a hint, a blank. */
const PLACEHOLDER_WORDS = new Set(
  (
    "string text required optional none null undefined unknown n/a na tbd here value name " +
    "example sample true false yes no enter type field column header label user users " +
    "information details data number phone mobile email address date signature stamp contact"
  ).split(" "),
);
/**
 * Words a form's labels are made of. A "value" made of nothing else is another label: the next
 * header of a table, not a name.
 */
const FIELD_WORDS = new Set(
  (
    "name id no number national iqama passport iban account bank mobile phone telephone tel fax " +
    "email e-mail mail address city country nationality gender date birth dob age salary amount " +
    "total notes note status type department position title job code postal zip box website " +
    "signature stamp authority manager owner tenant contact commercial register registration " +
    "certificate facility business description monthly income branch serial reference ref " +
    "customer client employee company greeting full first last unit role " +
    "الاسم اسم رقم الهوية الجوال الهاتف البريد الإلكتروني العنوان عنوان البنك الحساب التاريخ " +
    "تاريخ المدينة الجنسية الراتب ملاحظات الوظيفة المنشأة الشخص التواصل الميلاد الرمز البريدي " +
    "الصندوق السجل التجاري المالك الكامل"
  ).split(" "),
);
/** Small words inside a name that carry no capital: "bin", "al", "de". */
const NAME_PARTICLES = new Set(
  "bin bint ibn al el abu abo abd abdul de la van von der bn".split(" "),
);

const NAME_WORD = /^\p{L}[\p{L}\p{M}'’.-]*$/u;
const CAPITALISED = /^\p{Lu}/u;
const ARABIC = /\p{Script=Arabic}/u;
const DIGITS = "[0-9٠-٩]";
const DATE_VALUE = new RegExp(
  `${DIGITS}{1,4}\\s?[/.\\-]\\s?${DIGITS}{1,2}\\s?[/.\\-]\\s?${DIGITS}{1,4}|${DIGITS}{1,2}\\s+\\p{L}{3,12}\\s+${DIGITS}{4}`,
  "u",
);
const BOX_VALUE = new RegExp(`^${DIGITS}{1,7}(?!${DIGITS})`, "u");
const POSTCODE_VALUE = new RegExp(`^${DIGITS}{4,6}(?:-${DIGITS}{4})?(?!${DIGITS})`, "u");

interface Span {
  readonly start: number;
  readonly end: number;
}

interface Token extends Span {
  readonly text: string;
}

const tokensOf = (text: string): ReadonlyArray<Token> =>
  [...text.matchAll(/\S+/gu)].map((match) => ({
    text: match[0],
    start: match.index,
    end: match.index + match[0].length,
  }));

const bare = (word: string): string => word.replace(/[.,،;؛]+$/u, "");
const lower = (word: string): string => bare(word).toLowerCase();

/** A capital, or a particle between capitals: the words of a name written in Latin letters. */
const isNameCase = (word: string): boolean =>
  CAPITALISED.test(word) || NAME_PARTICLES.has(lower(word));

/**
 * The leading words of `tokens` that could be a name written with capitals, cut before the first
 * word that could not. A name does not end on a particle.
 */
const capitalisedRun = (tokens: ReadonlyArray<Token>, most: number): ReadonlyArray<Token> => {
  const run: Array<Token> = [];
  for (const token of tokens.slice(0, most)) {
    if (!NAME_WORD.test(bare(token.text)) || ARABIC.test(token.text) || !isNameCase(token.text)) {
      break;
    }
    run.push(token);
    // A comma or a full stop after a whole word ends the name.
    if (/[,،;؛]$/u.test(token.text)) break;
  }
  while (run.length > 0 && NAME_PARTICLES.has(lower((run.at(-1) as Token).text))) run.pop();
  return run;
};

const spanOf = (tokens: ReadonlyArray<Token>): Span | undefined => {
  const first = tokens[0];
  const last = tokens.at(-1);
  return first === undefined || last === undefined
    ? undefined
    : { start: first.start, end: last.start + bare(last.text).length };
};

const holdsAny = (tokens: ReadonlyArray<Token>, words: ReadonlySet<string>): boolean =>
  tokens.some((token) => words.has(lower(token.text)));

const isFieldWord = (token: Token | undefined): boolean =>
  token !== undefined && FIELD_WORDS.has(lower(token.text));

/** True for wording made of a form's own words: "National ID", "Date of Birth". */
const isFieldWording = (tokens: ReadonlyArray<Token>): boolean =>
  tokens.every((token) => isFieldWord(token) || FUNCTION_WORDS.has(lower(token.text)));

/**
 * The part of `text` that is the field's value, or nothing. `sure`: the form itself says the
 * text is the value (its own cell, a colon before it, the same label on both sides), so it is
 * taken as written. Otherwise it has to look like the value: capitals for a name.
 */
const valueIn = (shape: Shape, text: string, sure: boolean): Span | undefined => {
  if (shape === "date") {
    const match = DATE_VALUE.exec(text.slice(0, 48));
    return match === null ? undefined : { start: match.index, end: match.index + match[0].length };
  }
  const leading = text.length - text.replace(/^[\s:：*.\-–—_]+/u, "").length;
  const trimmed = text.slice(leading).replace(/(?:\s*\([^)]*\)?|[\s:：*\-–—_])+$/u, "");
  const within = (span: Span | undefined): Span | undefined =>
    span === undefined ? undefined : { start: span.start + leading, end: span.end + leading };
  if (shape === "box" || shape === "postcode") {
    const match = (shape === "box" ? BOX_VALUE : POSTCODE_VALUE).exec(trimmed);
    return match === null ? undefined : within({ start: 0, end: match[0].length });
  }
  const tokens = tokensOf(trimmed);
  if (tokens.length === 0) return undefined;
  const latin = !ARABIC.test(trimmed);
  // A label followed by another label is a table's header row, whatever follows.
  if (shape !== "address" && (sure ? isFieldWording(tokens) : isFieldWord(tokens[0]))) {
    return undefined;
  }
  if (shape === "person") {
    if (!sure) {
      const run = latin ? capitalisedRun(tokens, 6) : [];
      return run.length >= 2 ? within(spanOf(run)) : undefined;
    }
    if (tokens.length > 6 || !tokens.every((token) => NAME_WORD.test(bare(token.text)))) {
      return undefined;
    }
    if (holdsAny(tokens, FUNCTION_WORDS) || holdsAny(tokens, PLACEHOLDER_WORDS)) return undefined;
    // One word in lower case is a word, not a name: "phone", left beside a label by a table.
    const [only] = tokens;
    if (tokens.length === 1 && only !== undefined) {
      if (bare(only.text).length < 3 || (latin && !CAPITALISED.test(only.text))) return undefined;
    }
    return within(spanOf(tokens));
  }
  if (shape === "organisation") {
    if (!sure) {
      const run = latin ? capitalisedRun(tokens, 8) : [];
      return run.length >= 1 ? within(spanOf(run)) : undefined;
    }
    if (tokens.length > 10 || !tokens.some((token) => /\p{L}{2}/u.test(token.text))) {
      return undefined;
    }
    if (tokens.every((token) => FUNCTION_WORDS.has(lower(token.text)))) return undefined;
    if (holdsAny(tokens, PLACEHOLDER_WORDS)) return undefined;
    return within(spanOf(tokens));
  }
  // An address runs to the end of its field: commas, numbers and all.
  if (tokens.length > 16 || !tokens.some((token) => /\p{L}{2}/u.test(token.text))) return undefined;
  if (holdsAny(tokens, PLACEHOLDER_WORDS)) return undefined;
  if (!sure && !(latin && CAPITALISED.test(tokens[0]?.text ?? ""))) return undefined;
  return within(spanOf(tokens));
};

interface Cell extends Span {
  readonly text: string;
}

/** The cells of a line: split by tabs, or by the bars of a table written as text. */
const cellsOf = (line: string): ReadonlyArray<Cell> => {
  const cells: Array<Cell> = [];
  let start = 0;
  for (const match of line.matchAll(/\t|\|/gu)) {
    cells.push({ start, end: match.index, text: line.slice(start, match.index) });
    start = match.index + 1;
  }
  cells.push({ start, end: line.length, text: line.slice(start) });
  return cells.filter((cell) => cell.text.trim() !== "");
};

/**
 * Label and value in neighbouring cells: "Full Name | <value> | اسم الشخص". Only in a row that
 * is nothing but labels and their values: a table's header row has a label and, beside it, the
 * headers of other columns, which are no value of it.
 */
const inRow = (cells: ReadonlyArray<Cell>): ReadonlyArray<DetectedEntity> => {
  const rules = cells.map((cell) => ruleOfWholeLabel(cell.text));
  const claimed = new Map<number, LabelRule>();
  const found: Array<DetectedEntity> = [];
  rules.forEach((rule, index) => {
    if (rule === undefined || HEADER_ONLY.includes(rule)) return;
    // The value follows its label; after an Arabic label read left to right, it stands before.
    for (const beside of [index + 1, index - 1]) {
      const cell = cells[beside];
      if (cell === undefined || rules[beside] !== undefined) continue;
      // The same field named on both sides, in two languages, shares the value between.
      if (claimed.has(beside)) {
        if (claimed.get(beside) === rule) return;
        continue;
      }
      const value = valueIn(rule.shape, cell.text, true);
      if (value === undefined) continue;
      claimed.set(beside, rule);
      found.push({ start: cell.start + value.start, end: cell.start + value.end, kind: rule.kind });
      return;
    }
  });
  const unclaimed = cells.some((_, index) => rules[index] === undefined && !claimed.has(index));
  return unclaimed ? [] : found;
};

interface LabelMatch extends Span {
  readonly rule: LabelRule;
}

const labelsIn = (text: string): ReadonlyArray<LabelMatch> => {
  const all: Array<LabelMatch> = [];
  for (const { rule, pattern } of RULE_PATTERNS) {
    for (const match of text.matchAll(pattern)) {
      all.push({ rule, start: match.index, end: match.index + match[0].length });
    }
  }
  const kept: Array<LabelMatch> = [];
  for (const match of all.toSorted(
    (left, right) => right.end - right.start - (left.end - left.start) || left.start - right.start,
  )) {
    if (kept.every((other) => match.end <= other.start || match.start >= other.end)) {
      kept.push(match);
    }
  }
  return kept.toSorted((left, right) => left.start - right.start);
};

const SEPARATOR = /^\s*(?:[:：=]|[-–—]\s|\.{3,}|_{3,})|^\s{2,}/u;
/** Shapes exact enough to be taken after their label wherever it stands in a line. */
const EXACT_SHAPES: ReadonlySet<Shape> = new Set(["date", "box", "postcode"]);

/** Label and value in one cell: "Full Name: <value>", "<value> اسم الشخص". */
const inCell = (cell: Cell): ReadonlyArray<DetectedEntity> => {
  const labels = labelsIn(cell.text);
  const found: Array<DetectedEntity> = [];
  const push = (rule: LabelRule, from: number, value: Span | undefined): boolean => {
    if (value === undefined) return false;
    found.push({
      start: cell.start + from + value.start,
      end: cell.start + from + value.end,
      kind: rule.kind,
    });
    return true;
  };
  labels.forEach((label, index) => {
    const next = labels[index + 1];
    const previous = labels[index - 1];
    const afterEnd = next?.start ?? cell.text.length;
    const raw = cell.text.slice(label.end, afterEnd);
    // "Owner/Manager", "owner's": the label is part of a longer wording, not a field's name.
    if (/^[/\\'’]/u.test(raw)) return;
    const notes = /^(?:\s*\([^)]*\)?|\s*\*)*/u.exec(raw)?.[0].length ?? 0;
    const after = raw.slice(notes);
    const separated = SEPARATOR.test(after);
    const atStart = !/[\p{L}\p{N}]/u.test(cell.text.slice(0, label.start));
    // The same field named again after the value, in the other language.
    const between = next !== undefined && next.rule === label.rule;
    const here = separated || atStart || between || EXACT_SHAPES.has(label.rule.shape);
    if (
      here &&
      push(label.rule, label.end + notes, valueIn(label.rule.shape, after, separated || between))
    ) {
      return;
    }
    // Nothing after the last label: the value stands before it.
    if (next !== undefined || withoutNotes(after) !== "") return;
    const beforeStart = previous?.end ?? 0;
    if (previous !== undefined && previous.rule === label.rule) return;
    push(
      label.rule,
      beforeStart,
      valueIn(label.rule.shape, cell.text.slice(beforeStart, label.start), false),
    );
  });
  return found;
};

const LATIN_TITLE =
  /(?<![\p{L}\p{N}])(?:(?:Mr|MR|Mrs|MRS|Ms|Miss|Mister|Dr|Messrs)(?:\.[ \t]*|[ \t]*[/:][ \t]*|[ \t]+)|Eng\.[ \t]*)(?=\p{L})/gu;
const ARABIC_TITLE =
  /(?<!\p{L})(السيد[ةه]?|الس[اأ]د[ةه]|ال[أا]ستاذ[ةه]?|المهندس[ةه]?|الدكتور[ةه]?|المكرم[ةه]?)(?!\p{Script=Arabic})[ \t]*[/:]?[ \t]*(?=\p{L})/gu;
/** What follows a name in a letter's greeting: the name ends before it. */
const AFTER_A_NAME = new Set(
  "المحترم المحترمة المحترمين الموقر الموقرة حفظه حفظها وفقه وفقها سلمه سلمها تحية السلام المذكور".split(
    " ",
  ),
);
const ORGANISATION_WORDS = new Set(
  "مؤسسة شركة مصنع مكتب مجموعة بنك مصرف جمعية هيئة وزارة مركز".split(" "),
);
const ARABIC_WORD = /^[\p{Script=Arabic}\p{M}]+$/u;

/** The name after a title: "Mr. <name>", "السيد/ <name>". */
const afterTitles = (line: string): ReadonlyArray<DetectedEntity> => {
  const found: Array<DetectedEntity> = [];
  const restOf = (from: number): string => {
    const cut = line.slice(from).search(/[\t|]/u);
    return cut === -1 ? line.slice(from) : line.slice(from, from + cut);
  };
  for (const match of line.matchAll(LATIN_TITLE)) {
    const from = match.index + match[0].length;
    const tokens = tokensOf(restOf(from));
    let run = capitalisedRun(tokens, 6);
    // A bank writes a name as its system holds it, lower case and misspelt: taken where the
    // title opens its line and the line holds nothing but the name.
    const opensLine = !/[\p{L}\p{N}]/u.test(
      line.slice(0, match.index).split(/[\t|]/u).at(-1) ?? "",
    );
    if (
      run.length === 0 &&
      opensLine &&
      tokens.length >= 2 &&
      tokens.length <= 6 &&
      tokens.every((token) => NAME_WORD.test(bare(token.text))) &&
      !holdsAny(tokens, FUNCTION_WORDS) &&
      !holdsAny(tokens, PLACEHOLDER_WORDS)
    ) {
      run = tokens;
    }
    const span = spanOf(run);
    if (span !== undefined) {
      found.push({ start: from + span.start, end: from + span.end, kind: "PERSON" });
    }
  }
  for (const match of line.matchAll(ARABIC_TITLE)) {
    const from = match.index + match[0].length;
    const tokens = tokensOf(restOf(from));
    const first = tokens[0];
    if (first === undefined) continue;
    let run: ReadonlyArray<Token>;
    if (ARABIC.test(first.text)) {
      const words: Array<Token> = [];
      for (const token of tokens.slice(0, 6)) {
        const word = bare(token.text);
        if (!ARABIC_WORD.test(word) || AFTER_A_NAME.has(word) || FUNCTION_WORDS.has(word)) break;
        words.push(token);
        if (/[,،;؛.]$/u.test(token.text)) break;
      }
      // In running prose the words after a name are the sentence: four, unless the line ends.
      run = words.length === tokens.length ? words : words.slice(0, 4);
    } else {
      run = capitalisedRun(tokens, 6);
    }
    const span = spanOf(run);
    if (span === undefined) continue;
    const company =
      /^الس[اأ]د[ةه]$/u.test(match[1] ?? "") || ORGANISATION_WORDS.has(bare(first.text));
    found.push({
      start: from + span.start,
      end: from + span.end,
      kind: company ? "ORG" : "PERSON",
    });
  }
  return found;
};

/** Every value a label or a title in the text points at, each with the kind its label names. */
export const findLabelledValues = (text: string): ReadonlyArray<DetectedEntity> => {
  const found: Array<DetectedEntity> = [];
  const add = (lineStart: number, entities: ReadonlyArray<DetectedEntity>) => {
    for (const entity of entities) {
      const start = lineStart + entity.start;
      const end = lineStart + entity.end;
      if (end <= start) continue;
      if (found.every((other) => end <= other.start || start >= other.end)) {
        found.push({ start, end, kind: entity.kind });
      }
    }
  };
  let lineStart = 0;
  for (const line of text.split("\n")) {
    if (/\p{L}/u.test(line)) {
      const cells = cellsOf(line);
      if (cells.length >= 2) add(lineStart, inRow(cells));
      for (const cell of cells) add(lineStart, inCell(cell));
      add(lineStart, afterTitles(line));
    }
    lineStart += line.length + 1;
  }
  return found.toSorted((left, right) => left.start - right.start);
};
