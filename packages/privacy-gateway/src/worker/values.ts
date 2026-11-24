/**
 * Reads numbers and dates out of text exactly as a document writes them. The worker model quotes
 * a value; this code turns the quote into a typed value, so no model does the conversion.
 */

const ARABIC_MARKS = /[ً-ْٰـ]/g;

/** Arabic-Indic and Persian digits as Latin digits. Lengths are kept, so offsets stay valid. */
export const foldDigits = (text: string): string =>
  text.replace(/[٠-٩۰-۹]/g, (digit) => {
    const code = digit.charCodeAt(0);
    return String(code >= 0x06f0 ? code - 0x06f0 : code - 0x0660);
  });

export const digitCount = (surface: string): number =>
  (foldDigits(surface).match(/\d/g) ?? []).length;

/**
 * A stated identifier's stand-in says `ID` when this holds and `OTHER` when not, so the model
 * holds it in clear and a trial run may draw to match it (`kindFor` in seal.ts).
 */
export const isReferenceLike = (surface: string): boolean => digitCount(surface) >= 4;

/**
 * One spelling for text that differs only in ways a reader would not notice: Unicode forms,
 * Arabic marks, alef and ya variants, digit script, quote and dash shapes, runs of white space,
 * letter case. Used to compare a quote with its source.
 */
export const canonicalText = (text: string): string =>
  foldDigits(text.normalize("NFKC"))
    .replace(ARABIC_MARKS, "")
    .replace(/[أإآٱ]/g, "ا")
    .replace(/ى/g, "ي")
    .replace(/ة/g, "ه")
    .replace(/[‐-―−]/g, "-")
    .replace(/[‘’‚‛`´]/g, "'")
    .replace(/[“”„‟«»]/g, '"')
    .replace(/٫/g, ".")
    .replace(/[٬،]/g, ",")
    .replace(/[‎‏‪-‮⁦-⁩]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();

/**
 * A number without the noise binary arithmetic leaves behind: 199477.22999999998 is 199477.23.
 * Fourteen digits where a computed number is compared, rounded or written: enough to keep the
 * halalas of an amount in the hundreds of billions, and to drop errors that added up over many
 * steps. Fifteen for a stated figure times its scale, which is one step.
 */
export const withoutNoise = (value: number, digits: 14 | 15): number =>
  Number.isFinite(value) && !Number.isInteger(value) ? Number(value.toPrecision(digits)) : value;

/** A computed number as a data file holds it: plain digits, no noise, no exponent. */
export const plainDigits = (value: number): string => {
  const settled = withoutNoise(value, 14);
  const text = String(settled);
  if (!text.includes("e") || !Number.isFinite(settled)) return text;
  return Math.abs(settled) < 1
    ? settled.toFixed(20).replace(/0+$/, "")
    : BigInt(settled).toString();
};

const ENGLISH_NUMBER_WORD =
  /^(?:zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|thousand|million|billion)$/;
/** Spellings after `canonicalText`. */
const ARABIC_NUMBER_WORD =
  /^(?:واحد|واحده|احد|احدي|اثنان|اثنين|اثنتان|اثنتين|اثنا|اثني|اثنتا|اثنتي|ثلاث|ثلاثه|اربع|اربعه|خمس|خمسه|ست|سته|سبع|سبعه|ثمان|ثماني|ثمانيه|تسع|تسعه|عشر|عشره|عشرون|عشرين|ثلاثون|ثلاثين|اربعون|اربعين|خمسون|خمسين|ستون|ستين|سبعون|سبعين|ثمانون|ثمانين|تسعون|تسعين|مئه|مائه|مئتان|مئتين|مائتان|مائتين|(?:ثلاث|اربع|خمس|ست|سبع|ثمان|تسع)ما?ئه|الف|الفان|الفين|الاف|مليون|مليونان|مليونين|ملايين|مليار)$/;
/** A word that a bracketed number numbers: "Article (7)", "المادة (12)". */
const REFERENCE_LABEL =
  /^(?:articles?|clauses?|sections?|schedules?|annex|appendix|paragraphs?|items?|no|nos|number|ref|page|(?:ال)?(?:ماده|مواد|بند|بنود|فقره|ملحق|جدول|صفحه)|رقم)$/;

const isNumberWord = (word: string): boolean =>
  word.split("-").every((part) => ENGLISH_NUMBER_WORD.test(part)) ||
  ARABIC_NUMBER_WORD.test(word) ||
  (word.startsWith("و") && ARABIC_NUMBER_WORD.test(word.slice(1)));

/**
 * Whether the brackets around the figure at `start`..`end` are the minus sign of an account.
 * They are not when the figure repeats a number in words ("forty-five (45) days"), numbers a
 * clause ("14(2)", "Article (7)") or a list item, or is followed by its unit ("(30) يوماً").
 */
export const bracketsAreSign = (text: string, start: number, end: number): boolean => {
  const opening = /\(\s{0,2}$/u.exec(text.slice(Math.max(0, start - 3), start));
  const closing = /^\s{0,2}\)/u.exec(text.slice(end, end + 3));
  if (opening === null || closing === null) return false;
  const open = start - opening[0].length;
  if (/[\p{L}\p{N}]/u.test(text[open - 1] ?? "")) return false;
  const lineStart = text.lastIndexOf("\n", open - 1) + 1;
  const word = /([\p{L}]+(?:-[\p{L}]+)*)[.:]?$/u.exec(
    canonicalText(text.slice(Math.max(lineStart, open - 60), open)),
  )?.[1];
  if (word !== undefined && (isNumberWord(word) || REFERENCE_LABEL.test(word))) return false;
  const close = end + closing[0].length;
  // One space and a word is a sentence going on; a tab or a wider gap is the next column.
  return !/^[ \u00a0]?-?\p{L}/u.test(text.slice(close, close + 3));
};

export interface ParsedNumber {
  readonly value: number;
  /** The text writes it as a percentage: 2.5% is `{ value: 2.5, percent: true }`. */
  readonly percent: boolean;
}

const SCALES: ReadonlyArray<readonly [RegExp, number]> = [
  [/^(?:billion|bn|مليار|مليارات|بليون)(?![\p{L}])/u, 1e9],
  [/^(?:million|mn|مليون|ملايين)(?![\p{L}])/u, 1e6],
  [/^(?:thousand|k|الف|الاف)(?![\p{L}])/u, 1e3],
];

/** A numeral: digits grouped by spaces in threes, or digits with `,` `.` `'` inside. */
const NUMBER_TOKEN = /\(?(?<!\d)[-+]?(?:\d{1,3}(?: \d{3})+(?:[.,]\d+)?|\d(?:[\d.,']*\d)?)\)?/gu;

/** The numeral with its grouping removed. Null when the digits cannot be read one way. */
const readNumeral = (raw: string): number | null => {
  let token = raw.replace(/[\s']/g, "");
  const negative = /^\(.*\)$/.test(token) || token.includes("-");
  token = token.replace(/[()+-]/g, "");
  const commas = (token.match(/,/g) ?? []).length;
  const dots = (token.match(/\./g) ?? []).length;
  let normal: string;
  if (commas > 0 && dots > 0) {
    // The last separator is the decimal point; the other kind groups thousands.
    const decimal = token.lastIndexOf(",") > token.lastIndexOf(".") ? "," : ".";
    const group = decimal === "," ? "." : ",";
    normal = token.split(group).join("").replace(decimal, ".");
  } else if (commas > 0) {
    normal = /^\d{1,3}(,\d{3})+$/.test(token)
      ? token.split(",").join("")
      : commas === 1
        ? token.replace(",", ".")
        : token.split(",").join("");
  } else if (dots > 1) {
    if (!/^\d{1,3}(\.\d{3})+$/.test(token)) return null;
    normal = token.split(".").join("");
  } else {
    normal = token;
  }
  if (!/^\d+(\.\d+)?$/.test(normal)) return null;
  const value = Number(normal);
  if (!Number.isFinite(value)) return null;
  return negative ? -value : value;
};

const worth = (words: string, of: (index: number) => number): Array<[string, number]> =>
  words.split(" ").map((word, index) => [word, of(index)]);

/** Number words after `canonicalText`, with what each is worth. */
const WORD_VALUES: Readonly<Record<string, number>> = Object.fromEntries([
  ...worth(
    "zero one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen",
    (index) => index,
  ),
  ...worth("twenty thirty forty fifty sixty seventy eighty ninety", (index) => (index + 2) * 10),
  ...worth("واحد واحده احد احدي", () => 1),
  ...worth("اثنان اثنين اثنتان اثنتين اثنا اثني اثنتا اثنتي", () => 2),
  ...worth("ثلاث ثلاثه", () => 3),
  ...worth("اربع اربعه", () => 4),
  ...worth("خمس خمسه", () => 5),
  ...worth("ست سته", () => 6),
  ...worth("سبع سبعه", () => 7),
  ...worth("ثمان ثماني ثمانيه", () => 8),
  ...worth("تسع تسعه", () => 9),
  ...worth("عشر عشره", () => 10),
  ...worth("عشرون عشرين", () => 20),
  ...worth("ثلاثون ثلاثين", () => 30),
  ...worth("اربعون اربعين", () => 40),
  ...worth("خمسون خمسين", () => 50),
  ...worth("ستون ستين", () => 60),
  ...worth("سبعون سبعين", () => 70),
  ...worth("ثمانون ثمانين", () => 80),
  ...worth("تسعون تسعين", () => 90),
  ...worth("مئتان مئتين مائتان مائتين", () => 200),
]);
const HUNDRED = new Set(["hundred", "مئه", "مائه"]);
const COMPOUND_HUNDRED = /^(ثلاث|اربع|خمس|ست|سبع|ثمان|تسع)ما?ئه$/;
const WORD_SCALES: Readonly<Record<string, number>> = {
  thousand: 1e3,
  million: 1e6,
  billion: 1e9,
  الف: 1e3,
  الفا: 1e3,
  الاف: 1e3,
  مليون: 1e6,
  مليونا: 1e6,
  ملايين: 1e6,
  مليار: 1e9,
};
const WORD_DUALS: Readonly<Record<string, number>> = {
  الفان: 2e3,
  الفين: 2e3,
  مليونان: 2e6,
  مليونين: 2e6,
};

/**
 * The number a run of number words states: "six hundred ninety-four thousand",
 * "ستمئة وأربعة وتسعون ألف". Null when the text holds no such run. `canonical` is the text
 * after `canonicalText`. Contracts state an amount in figures and in words, and say which
 * prevails when the two differ.
 */
const readNumberWords = (canonical: string): number | null => {
  let total = 0;
  let current = 0;
  let started = false;
  let unitBefore = false;
  for (const raw of canonical.split(/[^\p{L}]+/u)) {
    if (raw === "") continue;
    const isWord = (word: string) =>
      word in WORD_VALUES ||
      HUNDRED.has(word) ||
      COMPOUND_HUNDRED.test(word) ||
      word in WORD_SCALES ||
      word in WORD_DUALS;
    // Arabic joins its number words with و, written onto the next word.
    const joined = !isWord(raw) && raw.startsWith("و") && isWord(raw.slice(1));
    const word = joined ? raw.slice(1) : raw;
    if (!isWord(word)) {
      if (started && raw !== "and") break;
      continue;
    }
    started = true;
    const compound = COMPOUND_HUNDRED.exec(word)?.[1];
    if (compound !== undefined) current += (WORD_VALUES[compound] ?? 0) * 100;
    else if (HUNDRED.has(word)) {
      // "three hundred", "ثلاث مئة": the unit before multiplies. "خمسة ومئة" adds.
      const unit = current % 100;
      current = unitBefore && !joined && unit > 0 ? current - unit + unit * 100 : current + 100;
    } else if (word in WORD_DUALS) total += WORD_DUALS[word] ?? 0;
    else if (word in WORD_SCALES) {
      total += (current === 0 ? 1 : current) * (WORD_SCALES[word] ?? 1);
      current = 0;
    } else current += WORD_VALUES[word] ?? 0;
    unitBefore = (WORD_VALUES[word] ?? 0) >= 1 && (WORD_VALUES[word] ?? 0) <= 9;
  }
  return started ? total + current : null;
};

/**
 * Every number written in `text`, in order, with scale words applied ("1.2 million", "٣ آلاف").
 * A text with no figure in it is read as number words.
 * Digits that belong to a longer word or code (a reference such as 3421/A) are still read:
 * the caller decides which one it wanted.
 */
export const parseNumbers = (text: string): ReadonlyArray<ParsedNumber> => {
  const canonical = canonicalText(text);
  const found: Array<ParsedNumber> = [];
  for (const match of canonical.matchAll(NUMBER_TOKEN)) {
    const numeral = readNumeral(match[0]);
    if (numeral === null) continue;
    const after = canonical.slice(match.index + match[0].length).replace(/^\s+/, "");
    let value = numeral;
    let rest = after;
    for (const [pattern, factor] of SCALES) {
      const scale = pattern.exec(after);
      if (scale !== null) {
        value = withoutNoise(numeral * factor, 15);
        rest = after.slice(scale[0].length).replace(/^\s+/, "");
        break;
      }
    }
    const percent = /^(?:%|٪|percent|per cent|بالمئه|بالمايه|في المئه|في المايه)/u.test(rest);
    found.push({ value, percent });
  }
  if (found.length === 0) {
    const words = readNumberWords(canonical);
    if (words !== null) found.push({ value: words, percent: false });
  }
  return found;
};

/** The single number a quote states. Null when it states none. The first one wins. */
export const parseNumber = (text: string): ParsedNumber | null => parseNumbers(text)[0] ?? null;

export interface ParsedDate {
  /** The Gregorian day, as `YYYY-MM-DD`. */
  readonly iso: string;
  /** The calendar the text was written in. */
  readonly calendar: "gregorian" | "hijri";
}

const GREGORIAN_MONTHS: ReadonlyArray<ReadonlyArray<string>> = [
  ["january", "jan", "يناير", "كانون الثاني"],
  ["february", "feb", "فبراير", "شباط"],
  ["march", "mar", "مارس", "اذار"],
  ["april", "apr", "ابريل", "نيسان"],
  ["may", "مايو", "ايار"],
  ["june", "jun", "يونيو", "حزيران"],
  ["july", "jul", "يوليو", "تموز"],
  ["august", "aug", "اغسطس", "اب"],
  ["september", "sept", "sep", "سبتمبر", "ايلول"],
  ["october", "oct", "اكتوبر", "تشرين الاول"],
  ["november", "nov", "نوفمبر", "تشرين الثاني"],
  ["december", "dec", "ديسمبر", "كانون الاول"],
];

/** Spellings after `canonicalText`: ta marbuta is ه, alef has no hamza. */
const HIJRI_MONTHS: ReadonlyArray<ReadonlyArray<string>> = [
  ["محرم", "muharram"],
  ["صفر", "safar"],
  ["ربيع الاول", "rabi al-awwal", "rabi i", "rabi' al-awwal", "rabi al awwal"],
  [
    "ربيع الاخر",
    "ربيع الثاني",
    "rabi al-thani",
    "rabi ii",
    "rabi' al-thani",
    "rabi al-akhir",
    "rabi al thani",
  ],
  ["جمادي الاولي", "جمادي الاول", "jumada al-ula", "jumada i", "jumada al-awwal", "jumada al ula"],
  [
    "جمادي الاخره",
    "جمادي الثانيه",
    "جمادي الاخر",
    "jumada al-akhirah",
    "jumada ii",
    "jumada al-thani",
    "jumada al akhirah",
  ],
  ["رجب", "rajab"],
  ["شعبان", "shaban", "sha'ban", "shaaban"],
  ["رمضان", "ramadan", "ramadhan"],
  ["شوال", "shawwal"],
  ["ذو القعده", "ذي القعده", "dhu al-qadah", "dhu al-qa'dah", "dhul qadah", "dhu al qadah"],
  ["ذو الحجه", "ذي الحجه", "dhu al-hijjah", "dhul hijjah", "dhu al hijjah"],
];

const monthIn = (
  text: string,
  months: ReadonlyArray<ReadonlyArray<string>>,
): { readonly month: number; readonly name: string } | null => {
  let best: { month: number; name: string } | null = null;
  months.forEach((names, index) => {
    for (const name of names) {
      const pattern = new RegExp(
        `(?<![\\p{L}])(?:ال)?${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\p{L}])`,
        "u",
      );
      if (pattern.test(text) && (best === null || name.length > best.name.length)) {
        best = { month: index + 1, name };
      }
    }
  });
  return best;
};

const umalqura = new Intl.DateTimeFormat("en-u-ca-islamic-umalqura-nu-latn", {
  timeZone: "UTC",
  year: "numeric",
  month: "numeric",
  day: "numeric",
});

const DAY_MS = 86_400_000;

const hijriParts = (utcMs: number): { y: number; m: number; d: number } => {
  const parts = umalqura.formatToParts(new Date(utcMs));
  const read = (type: string) => Number(parts.find((part) => part.type === type)?.value ?? NaN);
  return { y: read("year"), m: read("month"), d: read("day") };
};

/** The Gregorian day of a date in the Umm al-Qura calendar, the one Saudi documents use. */
export const hijriToGregorian = (year: number, month: number, day: number): string | null => {
  if (!(year >= 1300 && year <= 1600 && month >= 1 && month <= 12 && day >= 1 && day <= 30)) {
    return null;
  }
  // 1 Muharram 1 AH is 19 July 622 in the proleptic Gregorian calendar; a lunar year is about
  // 354.367 days. The estimate lands within a few days, and the calendar itself settles it.
  const epoch = Date.UTC(622, 6, 19);
  const estimate =
    epoch + Math.round((year - 1) * 354.36667 + (month - 1) * 29.5306 + (day - 1)) * DAY_MS;
  for (let offset = 0; offset <= 6; offset += 1) {
    for (const sign of offset === 0 ? [1] : [1, -1]) {
      const candidate = estimate + sign * offset * DAY_MS;
      const parts = hijriParts(candidate);
      if (parts.y === year && parts.m === month && parts.d === day) {
        return new Date(candidate).toISOString().slice(0, 10);
      }
    }
  }
  return null;
};

const gregorianIso = (year: number, month: number, day: number): string | null => {
  if (!(year >= 1800 && year <= 2200 && month >= 1 && month <= 12 && day >= 1 && day <= 31)) {
    return null;
  }
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return date.toISOString().slice(0, 10);
};

const fullYear = (year: number): number =>
  year < 100 ? (year >= 70 ? 1900 + year : 2000 + year) : year;

/**
 * The date a quote states. Numeric dates are read day first (as in Saudi Arabia and most of the
 * world) unless only month first is possible. A year between 1300 and 1600, a Hijri month name,
 * or an "هـ"/"AH" mark makes it a Hijri date. Null when the quote states no whole date.
 */
export const parseDate = (text: string): ParsedDate | null => {
  const canonical = canonicalText(text);
  const hijriMonth = monthIn(canonical, HIJRI_MONTHS);
  const gregorianMonth = hijriMonth === null ? monthIn(canonical, GREGORIAN_MONTHS) : null;
  const marked =
    /\d\s?(?:ه|ah|a\.h\.?|h\.?)(?![\p{L}])/u.test(canonical) || /هجري/u.test(canonical);

  const resolve = (
    year: number,
    month: number,
    day: number,
    named: "hijri" | "gregorian" | null,
  ) => {
    const hijri =
      named === "hijri" || (named === null && (marked || (year >= 1300 && year <= 1600)));
    if (hijri) {
      const iso = hijriToGregorian(year, month, day);
      return iso === null ? null : ({ iso, calendar: "hijri" } as const);
    }
    const iso = gregorianIso(fullYear(year), month, day);
    return iso === null ? null : ({ iso, calendar: "gregorian" } as const);
  };

  const named = hijriMonth ?? gregorianMonth;
  if (named !== null) {
    const calendar = hijriMonth === null ? "gregorian" : "hijri";
    const numbers = [...canonical.matchAll(/\d+/g)].map((match) => Number(match[0]));
    const year = numbers.find((value) => value >= 1000);
    const day = numbers.find((value) => value >= 1 && value <= 31);
    if (year === undefined || day === undefined) return null;
    return resolve(year, named.month, day, calendar);
  }

  const ymd = /(?<!\d)(\d{4})\s?[-/.]\s?(\d{1,2})\s?[-/.]\s?(\d{1,2})(?!\d)/.exec(canonical);
  if (ymd !== null) return resolve(Number(ymd[1]), Number(ymd[2]), Number(ymd[3]), null);

  const dmy = /(?<!\d)(\d{1,2})\s?[-/.]\s?(\d{1,2})\s?[-/.]\s?(\d{4}|\d{2})(?!\d)/.exec(canonical);
  if (dmy !== null) {
    const first = Number(dmy[1]);
    const second = Number(dmy[2]);
    const year = Number(dmy[3]);
    return second > 12 && first <= 12
      ? resolve(year, first, second, null)
      : resolve(year, second, first, null);
  }
  return null;
};

/** Whole days from one day to another. Negative when `to` is earlier. */
export const daysBetween = (fromIso: string, toIso: string): number =>
  Math.round((Date.parse(`${toIso}T00:00:00Z`) - Date.parse(`${fromIso}T00:00:00Z`)) / DAY_MS);
