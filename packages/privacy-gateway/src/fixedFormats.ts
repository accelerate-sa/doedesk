import type { EntityKind } from "./placeholders.ts";

/**
 * The identifiers that follow a fixed format, found by pattern alone: no network, no Node API,
 * so a client can run the same rules on a file before anything is sent anywhere.
 */

/** A span of personal data inside one text. Offsets are UTF-16 code units, as in JS strings. */
export interface DetectedEntity {
  readonly start: number;
  readonly end: number;
  readonly kind: EntityKind;
}

const DIGIT = "[0-9٠-٩]";
const SEPARATOR = "[\\s.-]?";

const PATTERNS: ReadonlyArray<{ readonly kind: EntityKind; readonly source: string }> = [
  { kind: "EMAIL", source: "[\\p{L}\\p{N}._%+-]+@[\\p{L}\\p{N}.-]+\\.[\\p{L}]{2,}" },
  // Saudi mobile numbers in local and international form. A phone number has no check digit:
  // its shape is all there is to test, so a mistyped one of the right length is masked as it is.
  {
    kind: "PHONE",
    source: `(?<!${DIGIT})(?:\\+|00|٠٠)?(?:966|٩٦٦)${SEPARATOR}[5٥]${DIGIT}${SEPARATOR}${DIGIT}{3}${SEPARATOR}${DIGIT}{4}(?!${DIGIT})`,
  },
  {
    kind: "PHONE",
    source: `(?<!${DIGIT})[0٠][5٥]${DIGIT}${SEPARATOR}${DIGIT}{3}${SEPARATOR}${DIGIT}{4}(?!${DIGIT})`,
  },
  {
    kind: "PHONE",
    source: `(?<![\\p{L}${DIGIT.slice(1, -1)}])\\+${DIGIT}{1,3}(?:${SEPARATOR}${DIGIT}{2,4}){2,4}(?!${DIGIT})`,
  },
];

export const toLatinDigits = (value: string): string =>
  value.replace(/[٠-٩]/g, (digit) => String(digit.charCodeAt(0) - 0x0660));

/**
 * How long each country's IBAN is, from SWIFT's registry. One of that length is an IBAN whatever
 * its check digits say; a country missing here is held to its check digits.
 */
const IBAN_LENGTHS = new Map(
  (
    "AD24 AE23 AL28 AT20 AZ28 BA20 BE16 BG22 BH22 BI27 BR29 BY28 CH21 CR22 CY28 CZ24 DE22 DJ27 " +
    "DK18 DO28 EE20 EG29 ES24 FI18 FK18 FO18 FR27 GB22 GE22 GI23 GL18 GR27 GT28 HR21 HU28 IE22 " +
    "IL23 IQ23 IS26 IT27 JO30 KW30 KZ20 LB28 LC32 LI21 LT20 LU20 LV21 LY25 MC27 MD24 ME22 MK19 " +
    "MN20 MR27 MT31 MU30 NI28 NL18 NO15 OM23 PK24 PL28 PS29 PT25 QA29 RO24 RS22 RU33 SA24 SC31 " +
    "SD18 SE24 SI19 SK24 SM27 SO23 ST25 SV28 TL23 TN24 TR26 UA29 VA22 VG24 XK20 YE30"
  )
    .split(" ")
    .map((entry) => [entry.slice(0, 2), Number(entry.slice(2))]),
);
const IBAN_MIN_LENGTH = 15;
const IBAN_MAX_LENGTH = 34;
const SAUDI_IBAN_LENGTH = 24;
/** A Saudi IBAN may be this many digits short or over: a dropped or doubled digit is a typo too. */
const SAUDI_IBAN_SLACK = 2;

/**
 * Where an IBAN may start, with what follows captured: whole or in groups split by one space or
 * dash, never by a tab or a line break (in a table the next cell is another value). Upper or
 * lower case, Latin or Arabic-Indic digits; "SA" may stand apart from its check digits.
 */
const IBAN_CANDIDATE = new RegExp(
  `(?<![\\p{Script=Latin}\\p{N}])(?=((?:[Ss][Aa][ \\u00A0-]?|[A-Za-z]{2})${DIGIT}{2}[0-9٠-٩A-Za-z]{0,30}(?:[ \\u00A0-][0-9٠-٩A-Za-z]{1,30}){0,12}(?![\\p{Script=Latin}\\p{N}])))`,
  "gu",
);
/** Letters only where a bank's code stands: what tells a mistyped IBAN from a part number or a key. */
const IBAN_BANK_LETTERS_ONLY = /^[A-Z]{2}[0-9]{2}[A-Z]{0,4}[0-9]+$/;
const SAUDI_IBAN_DIGITS = /^SA[0-9]+$/;

const ibanChecks = (compact: string): boolean => {
  let remainder = 0;
  for (const character of compact.slice(4) + compact.slice(0, 4)) {
    const value = Number.parseInt(character, 36);
    remainder = (remainder * (value > 9 ? 100 : 10) + value) % 97;
  }
  return remainder === 1;
};

/** A candidate cut after one of its groups: the characters so far, and where that is in the text. */
interface IbanRun {
  readonly compact: string;
  readonly end: number;
}

/*
 * Wrong check digits do not unmask an IBAN: contracts and payroll sheets carry mistyped ones, and
 * they still name the account. "SA" and digits of about the right length is masked; so is any
 * country's form at its registered length with letters only in the bank code.
 */
const ibanInForm = (runs: ReadonlyArray<IbanRun>): IbanRun | undefined => {
  const offBy = (run: IbanRun) => Math.abs(run.compact.length - SAUDI_IBAN_LENGTH);
  // An amount after a space is not more of the account: the run nearest the right length wins.
  const saudi = runs
    .filter((run) => SAUDI_IBAN_DIGITS.test(run.compact) && offBy(run) <= SAUDI_IBAN_SLACK)
    .toSorted((left, right) => offBy(left) - offBy(right))[0];
  if (saudi !== undefined) return saudi;
  const length = IBAN_LENGTHS.get(runs[0]?.compact.slice(0, 2) ?? "");
  return runs.find(
    (run) =>
      run.compact.length === length &&
      (IBAN_BANK_LETTERS_ONLY.test(run.compact) || ibanChecks(run.compact)),
  );
};

/**
 * IBANs in the form of their country, and others whose check digits are right. Any other shape
 * (a country not listed, a wrong length, letters in the account) needs right check digits and
 * capitals without dashes: without them it is as often a serial number, a licence key or a hash.
 */
const findIbans = (text: string): ReadonlyArray<DetectedEntity> => {
  const found: Array<DetectedEntity> = [];
  for (const match of text.matchAll(IBAN_CANDIDATE)) {
    const candidate = match[1] ?? "";
    const runs: Array<IbanRun> = [];
    let compact = "";
    for (const group of candidate.matchAll(/[^  -]+/g)) {
      compact += toLatinDigits(group[0]).toUpperCase();
      if (compact.length > IBAN_MAX_LENGTH) break;
      const end = match.index + group.index + group[0].length;
      // A dash after a group joins it to more of the same token, as in a GUID: not an end.
      if (text[end] !== "-") runs.push({ compact, end });
    }
    const asPrinted = (run: IbanRun) => !/[a-z-]/.test(text.slice(match.index, run.end));
    const iban =
      ibanInForm(runs) ??
      runs.findLast(
        (run) => run.compact.length >= IBAN_MIN_LENGTH && asPrinted(run) && ibanChecks(run.compact),
      );
    if (iban !== undefined) found.push({ start: match.index, end: iban.end, kind: "IBAN" });
  }
  return [...found, ...findMisreadSaudiIbans(text, found)];
};

/** What a reader of pictures takes a digit for: O for 0, l for 1, S for 5, B for 8, Z for 2. */
const MISREAD_DIGITS: Readonly<Record<string, string>> = {
  O: "0",
  o: "0",
  D: "0",
  Q: "0",
  I: "1",
  l: "1",
  "|": "1",
  S: "5",
  s: "5",
  B: "8",
  Z: "2",
  z: "2",
};
const MISREAD = "[0-9٠-٩OoDQIl|SsBZz]";
/** "SA", or "5A" as a reader writes it, then twenty-two digits whole or in groups. */
const MISREAD_SAUDI_IBAN = new RegExp(
  `(?<![\\p{Script=Latin}\\p{N}])[Ss5][Aa][ \\u00A0-]?${MISREAD}{2}(?:[ \\u00A0-]?${MISREAD}){20}(?![\\p{Script=Latin}\\p{N}])`,
  "gu",
);
/** Fewer true digits than this and the run is a word in capitals, not an account. */
const MIN_TRUE_DIGITS = 16;

/**
 * Saudi IBANs as a scan gives them, a few digits read as the letters they look like. Only the
 * exact length counts here: with letters allowed among the digits, slack would take in words.
 */
const findMisreadSaudiIbans = (
  text: string,
  found: ReadonlyArray<DetectedEntity>,
): ReadonlyArray<DetectedEntity> => {
  const misread: Array<DetectedEntity> = [];
  for (const match of text.matchAll(MISREAD_SAUDI_IBAN)) {
    const end = match.index + match[0].length;
    if (found.some((iban) => match.index < iban.end && end > iban.start)) continue;
    const digits = toLatinDigits(match[0].slice(2)).replace(/[ \u00A0-]/g, "");
    const trueDigits = digits.match(/[0-9]/g)?.length ?? 0;
    const read = [...digits].map((character) => MISREAD_DIGITS[character] ?? character).join("");
    if (trueDigits >= MIN_TRUE_DIGITS && /^[0-9]{22}$/.test(read)) {
      misread.push({ start: match.index, end, kind: "IBAN" });
    }
  }
  return misread;
};

/*
 * A ten-digit number starting with 1 or 2 has the shape of a Saudi ID, and so do many amounts and
 * references: the words of its clause, a currency after it, or its column's header decide. The
 * check digit is not used: people's documents carry IDs with a wrong one, and they are still IDs.
 */
const IDENTIFIER_WORDS = new RegExp(
  [
    "هوي[ةته]",
    "[إا]قام[ةته]",
    "سجل(?:ه|ها)? المدني",
    "سجل مدني",
    "الحدود",
    "سجل(?:ها|ه)? تجاري",
    "السجل التجاري",
    "س\\s?\\.\\s?ت",
    "ضريبي",
    "القيمة المضافة",
    "الوطني الموحد",
    "بطاق[ةته]",
    "(?<![a-z])(?:national|civil|resident|residence|identity|iqama|id|border|commercial|registration|unified national|c\\.\\s?r|cr|vat|trn|tin|tax)(?![a-z])",
  ].join("|"),
  "giu",
);
/** One pattern from Arabic word stems (matched inside words) and English whole words. */
const wordsPattern = (words: {
  readonly arabic: ReadonlyArray<string>;
  readonly english: ReadonlyArray<string>;
}): RegExp =>
  new RegExp(
    [...words.arabic, `(?<![a-z])(?:${words.english.join("|")})(?![a-z])`].join("|"),
    "giu",
  );

/** Words for a sum of money: the number after them stays readable, so it can be computed with. */
const AMOUNT_WORDS = {
  arabic: [
    "ريال",
    "ر\\s?\\.\\s?س",
    "مبلغ",
    "قيم[ةته]",
    "رأس ?مال",
    "رصيد",
    "إجمالي",
    "اجمالي",
    "سعر",
    "إيجار",
  ],
  english: [
    "amount",
    "value",
    "total",
    "balance",
    "price",
    "capital",
    "sar",
    "sr",
    "riyals?",
    "usd",
    "payment",
    "rent",
  ],
};
/** References that point to a person: their policy, case, deed, account as a customer, claim. */
const PERSON_REFERENCE_WORDS = {
  arabic: ["دعوى", "قضي[ةه]", "صك", "العميل", "بوليص[ةه]", "مطالب[ةه]"],
  english: ["case", "customer", "deed", "policy", "claim"],
};
/** References to a business record, which people may sort and search by. */
const RECORD_REFERENCE_WORDS = {
  arabic: [
    "فاتور[ةه]",
    "حوال[ةه]",
    "تحويل",
    "مرجع",
    "أمر (?:ال)?(?:شراء|صرف|عمل)",
    "طلب",
    "عقد",
    "شحن[ةه]",
    "كشف حساب",
    "عملي[ةه]",
    "معامل[ةه]",
    "سند",
  ],
  english: [
    "invoice",
    "inv",
    "transfer",
    "transaction",
    "reference",
    "ref",
    "order",
    "po",
    "purchase",
    "receipt",
    "contract",
    "shipment",
    "tracking",
    "statement",
    "ticket",
  ],
};
type WordList = typeof AMOUNT_WORDS;
const joinWords = (lists: ReadonlyArray<WordList>): RegExp =>
  wordsPattern({
    arabic: lists.flatMap((words) => words.arabic),
    english: lists.flatMap((words) => words.english),
  });

const REFERENCE_WORD_LISTS = [PERSON_REFERENCE_WORDS, RECORD_REFERENCE_WORDS];
/** References whose bare numbers of five digits or more are masked; the rest stay readable. */
const MASKED_REFERENCE_WORD_LISTS = REFERENCE_WORD_LISTS;

const AMOUNT_PATTERN = wordsPattern(AMOUNT_WORDS);
const REFERENCE_WORDS = joinWords(MASKED_REFERENCE_WORD_LISTS);
const READABLE_WORDS = joinWords([
  AMOUNT_WORDS,
  ...REFERENCE_WORD_LISTS.filter((words) => !MASKED_REFERENCE_WORD_LISTS.includes(words)),
]);
/** Between an amount word and the reference it is the amount of, in Arabic: "إجمالي الفاتورة". */
const AMOUNT_OF_REFERENCE_GAP = /^\s+(?:ال|لل)?$/u;
/** Words that name a bank account: the long number beside them is the account. */
const ACCOUNT_WORDS =
  /رقم\s+ال?حساب|ال?حساب\s+ال?بنكي|(?<![a-z])(?:account\s*(?:number|num|no|#)|bank\s+account|a\/c|acct)(?![a-z])/giu;
/** The same words standing after the number, as an Arabic line read left to right has them. */
const ACCOUNT_WORDS_AFTER = /^\s{0,3}(?:رقم\s+ال?حساب|ال?حساب\s+ال?بنكي)/u;
/** Words for a way to reach someone: the number after them is a phone number, never readable. */
const CONTACT_WORDS =
  /جوال|هاتف|تواصل|اتصال|واتس|فاكس|(?<![a-z])(?:phone|mobile|tel|call|fax|whatsapp|contact)(?![a-z])/giu;
const CURRENCY_AFTER = /^\s*(?:ريال|ر\s?\.\s?س|SAR|SR|riyals?|USD|dollars?)(?![a-z])/iu;
const CONTEXT_REACH = 48;

/**
 * "readable" is an amount or a reference left readable; "reference" is one whose bare number of
 * five digits or more is masked, while a shorter one (an ordinal, a year) stays readable;
 * "account" is a bank account's own number.
 */
type NumberContext = "identifier" | "contact" | "readable" | "reference" | "account" | undefined;

const lastMatch = (pattern: RegExp, text: string): { start: number; end: number } => {
  let found = { start: -1, end: -1 };
  for (const match of text.matchAll(pattern)) {
    found = { start: match.index, end: match.index + match[0].length };
  }
  return found;
};

const contextOfWords = (words: string): NumberContext => {
  const reference = lastMatch(REFERENCE_WORDS, words);
  const nearest = (
    [
      ["identifier", lastMatch(IDENTIFIER_WORDS, words).end],
      ["contact", lastMatch(CONTACT_WORDS, words).end],
      ["account", lastMatch(ACCOUNT_WORDS, words).end],
      ["readable", lastMatch(READABLE_WORDS, words).end],
      ["reference", reference.end],
    ] as const
  ).reduce((best, next) => (next[1] > best[1] ? next : best));
  // The nearer word wins: "transfer to the holder of ID 1…" is an ID.
  if (nearest[1] === -1) return undefined;
  if (nearest[0] === "reference") {
    const amount = lastMatch(AMOUNT_PATTERN, words.slice(0, reference.start));
    if (
      amount.end !== -1 &&
      AMOUNT_OF_REFERENCE_GAP.test(words.slice(amount.end, reference.start))
    ) {
      return "readable";
    }
  }
  return nearest[0];
};

/** What a text says about the numbers in it. Each table column's header is looked up once. */
export const numberContexts = (text: string) => {
  // Keyed by the end of a line and a column: the header found above that line, if any.
  const headers = new Map<string, string | undefined>();
  const headerOfColumn = (lineStart: number, column: number): string | undefined => {
    const visited: Array<string> = [];
    let header: string | undefined;
    for (let end = lineStart - 1; end > 0;) {
      const key = `${end}:${column}`;
      if (headers.has(key)) {
        header = headers.get(key);
        break;
      }
      visited.push(key);
      const start = text.lastIndexOf("\n", end - 1) + 1;
      const line = text.slice(start, end);
      if (!line.includes("\t")) break;
      const cell = line.split("\t")[column]?.trim() ?? "";
      if (/\p{L}/u.test(cell) && !/[0-9٠-٩]/.test(cell)) {
        header = cell;
        break;
      }
      end = start - 1;
    }
    for (const key of visited) headers.set(key, header);
    return header;
  };

  return (start: number, end: number): NumberContext => {
    const lineStart = text.lastIndexOf("\n", start - 1) + 1;
    const lineBreak = text.indexOf("\n", end);
    const lineEnd = lineBreak === -1 ? text.length : lineBreak;
    const cellStart = Math.max(lineStart, text.lastIndexOf("\t", start - 1) + 1);
    // The words of the number's own clause: a comma ends what an earlier word can say about it.
    const clause = text.slice(Math.max(cellStart, start - CONTEXT_REACH), start).split(/[,،;؛]/u);
    const tab = text.indexOf("\t", end);
    const after = text.slice(end, tab === -1 || tab > lineEnd ? lineEnd : tab);
    const before = contextOfWords(clause[clause.length - 1] ?? "");
    // A currency after it makes a number an amount, whatever record it belongs to.
    if (before === "reference" && CURRENCY_AFTER.test(after)) return "readable";
    if (before !== undefined) return before;
    if (CURRENCY_AFTER.test(after)) return "readable";
    const cells = text.slice(lineStart, lineEnd).split("\t");
    if (cells.length === 1) return undefined;
    const column = text.slice(lineStart, start).split("\t").length - 1;
    // A two-cell row is a label and its value ("Customer no. <tab> 1…"); a wider row is a record
    // under a header row.
    if (cells.length === 2 && column === 1) return contextOfWords(cells[0] ?? "");
    const header = headerOfColumn(lineStart, column);
    return header === undefined ? undefined : contextOfWords(header);
  };
};

/**
 * Five digits or more standing alone: not part of a word, a lettered record number, a negative,
 * or an amount written with separators or decimals.
 */
const REFERENCE_DIGITS = new RegExp(
  `(?<![\\p{L}\\p{N}_.,٫٬-])${DIGIT}{5,}(?![\\p{L}\\p{N}_]|[.,٫٬]${DIGIT})`,
  "gu",
);
export const isReferenceNumber = (surface: string): boolean => /^[0-9٠-٩]{5,}$/u.test(surface);
/** How long a bank's own account numbers run. Only the text's words make a shorter one an account. */
const isAccountLength = (digits: number): boolean => digits >= 10 && digits <= 20;
const TEN_DIGITS = new RegExp(`(?<!${DIGIT})${DIGIT}{10}(?!${DIGIT})`, "gu");
const FIFTEEN_DIGITS = new RegExp(`(?<!${DIGIT})${DIGIT}{15}(?!${DIGIT})`, "gu");
/** Digits in groups split by single spaces or dashes ("1087-654-321", "300 123 456 789 003"). */
const GROUPED_DIGITS = new RegExp(
  `(?<!${DIGIT}[ -]?)${DIGIT}+(?:[ -]${DIGIT}+)+(?![ -]?${DIGIT})`,
  "gu",
);

/**
 * National IDs and iqamas, registration numbers named as such, VAT numbers (fifteen digits, 3
 * first and last), ten digits after a phone word, references of five digits or more, and the
 * number called a bank account. No check digit is used: the words say what a mistyped one is too.
 */
const findIdentifiers = (text: string): ReadonlyArray<DetectedEntity> => {
  const found: Array<DetectedEntity> = [];
  const contextOfNumber = numberContexts(text);
  const lineAfter = (end: number): string => {
    const lineBreak = text.indexOf("\n", end);
    return text.slice(end, lineBreak === -1 ? text.length : lineBreak);
  };
  for (const match of text.matchAll(REFERENCE_DIGITS)) {
    const end = match.index + match[0].length;
    const context = contextOfNumber(match.index, end);
    if (context === "reference") {
      found.push({ start: match.index, end, kind: "ID" });
    } else if (
      context === "account" ||
      // An Arabic line read left to right: the number stands before the words that name it.
      (context === undefined &&
        isAccountLength(match[0].length) &&
        ACCOUNT_WORDS_AFTER.test(lineAfter(end)))
    ) {
      found.push({ start: match.index, end, kind: "ACCOUNT" });
    }
  }
  for (const match of text.matchAll(TEN_DIGITS)) {
    const end = match.index + match[0].length;
    const context = contextOfNumber(match.index, end);
    // 1 and 2 start a person's ID or iqama; 70 starts an establishment's unified national number.
    const idShaped = /^(?:[12]|70)/.test(toLatinDigits(match[0]));
    if (context === "identifier" || (context === undefined && idShaped)) {
      found.push({ start: match.index, end, kind: "ID" });
    } else if (context === "contact") {
      found.push({ start: match.index, end, kind: "PHONE" });
    }
  }
  // Written in groups, an identifier is masked only where the text names it as one: grouped
  // digits are as often a phone number or an amount.
  for (const match of text.matchAll(GROUPED_DIGITS)) {
    const digits = match[0].replace(/[ -]/g, "").length;
    const end = match.index + match[0].length;
    const context = contextOfNumber(match.index, end);
    if ((digits === 10 || digits === 15) && context === "identifier") {
      found.push({ start: match.index, end, kind: "ID" });
    } else if (isAccountLength(digits) && context === "account") {
      found.push({ start: match.index, end, kind: "ACCOUNT" });
    }
  }
  for (const match of text.matchAll(FIFTEEN_DIGITS)) {
    const end = match.index + match[0].length;
    const vatShaped = /^3[0-9]{13}3$/.test(toLatinDigits(match[0]));
    if (vatShaped || contextOfNumber(match.index, end) === "identifier") {
      found.push({ start: match.index, end, kind: "ID" });
    }
  }
  return found;
};

/**
 * A record's number in capitals, a hyphen and digits (`MRN-1788876`, `NID-44820193`), which name
 * detectors pass over. A token joined on by a slash, dot or hyphen is part of an address or a
 * longer name, and standards keep their numbers.
 */
const LETTERED_RECORD = new RegExp(
  `(?<![\\p{L}\\p{N}_/.-])([A-Z]{2,5})-${DIGIT}{5,}(?![\\p{L}\\p{N}_]|[-/.][\\p{L}\\p{N}])`,
  "gu",
);
export const STANDARDS = new Set(["ISO", "IEC", "RFC", "IEEE", "SASO", "NIST", "CVE"]);

const findLetteredRecords = (text: string): ReadonlyArray<DetectedEntity> =>
  [...text.matchAll(LETTERED_RECORD)].flatMap((match) =>
    STANDARDS.has(match[1] ?? "")
      ? []
      : [{ start: match.index, end: match.index + match[0].length, kind: "ID" as const }],
  );

/**
 * A bank's or a document's serial: two to four capitals and ten digits or more, no hyphen
 * (`IB09876543210987654321098`). Ten digits is longer than a model number or a version runs.
 */
const LETTERED_SERIAL = new RegExp(
  `(?<![\\p{L}\\p{N}_/.-])([A-Z]{2,4})${DIGIT}{10,}(?![\\p{L}\\p{N}_]|[-/.][\\p{L}\\p{N}])`,
  "gu",
);

const findLetteredSerials = (
  text: string,
  ibans: ReadonlyArray<DetectedEntity>,
): ReadonlyArray<DetectedEntity> =>
  [...text.matchAll(LETTERED_SERIAL)].flatMap((match) => {
    const end = match.index + match[0].length;
    return STANDARDS.has(match[1] ?? "") ||
      ibans.some((iban) => match.index < iban.end && end > iban.start)
      ? []
      : [{ start: match.index, end, kind: "ID" as const }];
  });

/** Hosts that only shorten a link: where one leads cannot be told from the link itself. */
const SHORTLINK_HOSTS = new Set(
  "alah.li bit.ly tinyurl.com t.co goo.gl is.gd ow.ly rb.gy cutt.ly t.ly qrco.de s.id shorturl.at".split(
    " ",
  ),
);
const VERIFY_IN_ADDRESS =
  /verif|validat|authenti|certificat|attest|inquir|e-?service|(?<![a-z])qr(?![a-z])/iu;
/** A part of an address that points at one record: a number, a long code, a parameter's value. */
const RECORD_IN_ADDRESS = /[0-9]{5,}|[A-Za-z0-9_-]*[0-9][A-Za-z0-9_-]{5,}|[?&][^=&#]+=[^&#]{4,}/u;
/** Words that say a link is there to check the document it is printed on. */
const VERIFY_WORDS =
  /التحقق|للتحقق|تحقق|توثيق|للتأكد|(?<![a-z])(?:verify|verification|verified|verifying|validate|validation|authenticity|scan the qr)(?![a-z])/iu;
const VERIFY_REACH = 96;

/** The host and the rest of a web address, read without a URL parser: clients share this file. */
const partsOfAddress = (address: string): { readonly host: string; readonly rest: string } => {
  const bare = address.replace(/^[a-z][a-z0-9+.-]*:\/\//iu, "");
  const cut = bare.search(/[/?#]/u);
  const host = (cut === -1 ? bare : bare.slice(0, cut)).replace(/:\d+$/u, "").toLowerCase();
  return { host: host.replace(/^www\./u, ""), rest: cut === -1 ? "" : bare.slice(cut) };
};

const hostIs = (host: string, domain: string): boolean =>
  host === domain || host.endsWith(`.${domain}`);

/**
 * True for a link that opens the document it stands on, or a record of it, as issued: a bank's
 * or a ministry's verification link, a shortened link, a link with "verify" and a record in it.
 * Whoever opens it reads the unmasked original, so it is personal data whatever it looks like.
 */
export const isVerificationUrl = (address: string): boolean => {
  const { host, rest } = partsOfAddress(address.trim());
  if (!host.includes(".")) return false;
  const path = rest.replace(/^\/+$/u, "");
  if (path === "") return false;
  if ([...SHORTLINK_HOSTS].some((domain) => hostIs(host, domain))) return true;
  if (/^(?:qr|verify|verification|validate)\./u.test(host)) return true;
  const record = RECORD_IN_ADDRESS.test(path);
  const verifies = VERIFY_IN_ADDRESS.test(`${host}${path}`);
  // A ministry's link to a record or to a service about one; its front page names nobody.
  if (hostIs(host, "gov.sa")) return record || verifies;
  return record && verifies;
};

const ADDRESS_CHARACTERS = "[^\\s<>\"'`()\\[\\]{}|\\u0600-\\u06FF]";
/** A web address: with its scheme, or without one on a host that is known to carry records. */
const WEB_ADDRESS = new RegExp(
  `(?<![\\p{L}\\p{N}@./-])(?:https?:\\/\\/${ADDRESS_CHARACTERS}+|(?:[a-z0-9-]+\\.)*(?:gov\\.sa|${[
    ...SHORTLINK_HOSTS,
  ]
    .map((host) => host.replace(".", "\\."))
    .join("|")})\\/${ADDRESS_CHARACTERS}+)`,
  "giu",
);

/**
 * Links that verify a document: by where they point (`isVerificationUrl`), or by the words
 * beside them ("To verify the letter … visit", "للتحقق"). Other links are left to the detection
 * service: a page of documentation is full of links that name nobody.
 */
const findVerificationUrls = (text: string): ReadonlyArray<DetectedEntity> => {
  const found: Array<DetectedEntity> = [];
  for (const match of text.matchAll(WEB_ADDRESS)) {
    const address = match[0].replace(/[.,;:!?،؛]+$/u, "");
    const end = match.index + address.length;
    const lineStart = text.lastIndexOf("\n", match.index - 1) + 1;
    const lineBreak = text.indexOf("\n", end);
    const around =
      text.slice(Math.max(lineStart, match.index - VERIFY_REACH), match.index) +
      " " +
      text.slice(end, Math.min(lineBreak === -1 ? text.length : lineBreak, end + VERIFY_REACH));
    const pointsSomewhere = partsOfAddress(address).rest.replace(/^\/+$/u, "") !== "";
    if (isVerificationUrl(address) || (pointsSomewhere && VERIFY_WORDS.test(around))) {
      found.push({ start: match.index, end, kind: "URL" });
    }
  }
  return found;
};

/**
 * Every fixed-format identifier in a text: IBANs, account, identity, record and serial numbers,
 * phones, emails, and the links that verify a document.
 */
export const findFixedFormats = (text: string): ReadonlyArray<DetectedEntity> => {
  const ibans = findIbans(text);
  const entities: Array<DetectedEntity> = [
    ...ibans,
    ...findIdentifiers(text),
    ...findLetteredRecords(text),
    ...findLetteredSerials(text, ibans),
    ...findVerificationUrls(text),
  ];
  for (const { kind, source } of PATTERNS) {
    for (const match of text.matchAll(new RegExp(source, "gu"))) {
      entities.push({ start: match.index, end: match.index + match[0].length, kind });
    }
  }
  return entities;
};
