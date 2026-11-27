import sharp from "sharp";
import { describe, expect, it } from "vite-plus/test";

import { combineDetectors, DetectorUnavailableError, patternDetector } from "../detect.ts";
import { placeholderPattern } from "../placeholders.ts";
import { Pseudonymizer } from "../pseudonymizer.ts";
import { Vault } from "../vault.ts";
import { makeImageRedactor, type RedactionResult, UNREADABLE_LABEL } from "./redactImage.ts";
import {
  codePixels,
  darkShare,
  layoutAnswer,
  makePseudonymizer,
  paintPage,
  type Planted,
  plantedReader,
  pngOf,
  shows,
  stampOn,
} from "./testkit.ts";

const WIDTH = 1000;
const HEIGHT = 600;

/** A line of words, each a block 22 pixels high, starting at `x`. */
const line = (y: number, texts: ReadonlyArray<string>, x = 60, extra: Partial<Planted> = {}) => {
  const words: Array<Planted> = [];
  let cursor = x;
  for (const text of texts) {
    const width = Math.max(14, text.length * 12);
    words.push({ text, x: cursor, y, width, height: 22, ...extra });
    cursor += width + 10;
  }
  return words;
};

const redacted = (result: RedactionResult) => {
  if (result.kind !== "redacted") throw new Error(`withheld: ${result.reason}`);
  return result;
};

const tokensIn = (text: string): ReadonlyArray<string> => text.match(placeholderPattern()) ?? [];

describe("what is covered", () => {
  it("covers a name and a phone number and leaves the rest of the page as it was", async () => {
    const words = [
      ...line(80, ["Contract", "of", "Khalid", "Al-Otaibi", "ends", "in", "March"]),
      ...line(140, ["Call", "0551234567", "after", "noon"]),
    ];
    const pseudonymizer = makePseudonymizer(["Khalid Al-Otaibi"]);
    const reader = plantedReader(WIDTH, words);
    const result = redacted(
      await makeImageRedactor({ reader, pseudonymizer }).redact(
        await pngOf(paintPage(WIDTH, HEIGHT, words)),
      ),
    );
    for (const word of words) {
      const sensitive = ["Khalid", "Al-Otaibi", "0551234567"].includes(word.text);
      expect(await shows(result.image.bytes, WIDTH, word), word.text).toBe(
        sensitive ? "hidden" : "shown",
      );
    }
    expect(result.stats.rounds).toBe(1);
    expect(reader.calls()).toBe(2);
    expect(result.maskedText).toMatch(
      /^Contract of \[PERSON_\w{5}\] ends in March\nCall \[PHONE_\w{5}\] after noon$/,
    );
  });

  it("puts on a box the stand-in the same value has in text", async () => {
    const words = line(80, ["Owner", "Khalid", "Al-Otaibi", "phone", "0551234567"]);
    const pseudonymizer = makePseudonymizer(["Khalid Al-Otaibi"]);
    const result = redacted(
      await makeImageRedactor({ reader: plantedReader(WIDTH, words), pseudonymizer }).redact(
        await pngOf(paintPage(WIDTH, HEIGHT, words)),
      ),
    );
    const inText = await pseudonymizer.mask([
      { text: "Khalid Al-Otaibi called from 0551234567.", mode: "detect" },
    ]);
    expect(tokensIn(result.maskedText)).toEqual(tokensIn(inText.texts[0] ?? ""));
    // The picture's own words never reach the legend or the text beside it.
    for (const said of [result.legend, result.maskedText]) {
      expect(said).not.toContain("Khalid");
      expect(said).not.toContain("0551234567");
    }
  });

  it("gives every part of a value that wraps onto the next line the same stand-in", async () => {
    const words = [
      ...line(80, ["Pay", "to", "Khalid"], 700),
      ...line(120, ["Al-Otaibi", "this", "week"]),
    ];
    const pseudonymizer = makePseudonymizer(["Khalid Al-Otaibi"]);
    const result = redacted(
      await makeImageRedactor({ reader: plantedReader(WIDTH, words), pseudonymizer }).redact(
        await pngOf(paintPage(WIDTH, HEIGHT, words)),
      ),
    );
    expect(pseudonymizer.vault.entries().map((entry) => entry.value)).toEqual(["Khalid Al-Otaibi"]);
    const token = pseudonymizer.vault.entries()[0]?.token ?? "";
    expect(result.maskedText).toBe(`Pay to ${token}\n${token} this week`);
    expect(result.stats.valueBoxes).toBe(2);
    expect(result.stats.tokens).toBe(1);
  });

  it("finds an account the reader returned last group first on an Arabic page", async () => {
    // As measured from the reader: numbers reversed, then the Latin words in their own order.
    const words = line(80, [
      "الحساب",
      "23",
      "5191",
      "0167",
      "0801",
      "0006",
      "8000",
      "IBAN:",
      "SA78",
      "لدى",
    ]);
    const pseudonymizer = makePseudonymizer();
    const result = redacted(
      await makeImageRedactor({ reader: plantedReader(WIDTH, words), pseudonymizer }).redact(
        await pngOf(paintPage(WIDTH, HEIGHT, words)),
      ),
    );
    for (const word of words) {
      const part = /^[0-9]+$|^SA78$/.test(word.text);
      expect(await shows(result.image.bytes, WIDTH, word), word.text).toBe(
        part ? "hidden" : "shown",
      );
    }
    // The stand-in is the one the account has when written in order in a text file.
    const inText = await pseudonymizer.mask([
      { text: "IBAN SA78 8000 0006 0801 0167 5191 23", mode: "detect" },
    ]);
    // One stand-in on both boxes: the reader put "IBAN:" between the number and its first group.
    expect([...new Set(tokensIn(result.maskedText))]).toEqual(tokensIn(inText.texts[0] ?? ""));
  });

  it("covers a phone number whose plus the reader left behind it", async () => {
    const words = line(80, ["للتواصل", "6543", "987", "55", "966+", "اليوم"]);
    const result = redacted(
      await makeImageRedactor({
        reader: plantedReader(WIDTH, words),
        pseudonymizer: makePseudonymizer(),
      }).redact(await pngOf(paintPage(WIDTH, HEIGHT, words))),
    );
    for (const word of words) {
      const part = /[0-9]/.test(word.text);
      expect(await shows(result.image.bytes, WIDTH, word), word.text).toBe(
        part ? "hidden" : "shown",
      );
    }
  });

  it("covers a letter-spaced name whole, however unevenly the reader cut it", async () => {
    const pieces = ["K", "h", "a", "lid", "Al", "-", "O", "t", "a", "i", "b", "i"];
    const words: Array<Planted> = [
      { text: "that", x: 60, y: 80, width: 48, height: 22 },
      ...pieces.map((text, index) => ({
        text,
        x: 130 + index * 34 + (index >= 4 ? 30 : 0),
        y: 80,
        width: 14 + (text.length - 1) * 10,
        height: 22,
      })),
      { text: "works", x: 640, y: 80, width: 60, height: 22 },
    ];
    const result = redacted(
      await makeImageRedactor({
        reader: plantedReader(WIDTH, words),
        pseudonymizer: makePseudonymizer(["Khalid Al-Otaibi", "Khalid"]),
      }).redact(await pngOf(paintPage(WIDTH, HEIGHT, words))),
    );
    for (const word of words) {
      const kept = word.text === "that" || word.text === "works";
      expect(await shows(result.image.bytes, WIDTH, word), word.text).toBe(
        kept ? "shown" : "hidden",
      );
    }
  });

  it("covers the digits of a number written one under another", async () => {
    const digits = [..."1087654321"];
    const words: Array<Planted> = [
      ...digits.map((text, index) => ({ text, x: 80, y: 60 + index * 40, width: 16, height: 24 })),
      { text: "Batch", x: 300, y: 80, width: 70, height: 24 },
    ];
    const result = redacted(
      await makeImageRedactor({
        reader: plantedReader(WIDTH, words),
        pseudonymizer: makePseudonymizer(),
      }).redact(await pngOf(paintPage(WIDTH, HEIGHT, words))),
    );
    for (const word of words) {
      expect(await shows(result.image.bytes, WIDTH, word), word.text).toBe(
        word.text === "Batch" ? "shown" : "hidden",
      );
    }
    expect(result.maskedText).toMatch(/^\[ID_\w{5}\]\nBatch$/);
  });

  it("joins a name hyphenated across two lines", async () => {
    const words = [
      ...line(80, ["Reviewed", "by", "Noura", "Al-Qah-"], 600),
      ...line(120, ["tani", "today"]),
    ];
    const result = redacted(
      await makeImageRedactor({
        reader: plantedReader(WIDTH, words),
        pseudonymizer: makePseudonymizer(["Noura Al-Qahtani"]),
      }).redact(await pngOf(paintPage(WIDTH, HEIGHT, words))),
    );
    for (const word of words) {
      const part = ["Noura", "Al-Qah-", "tani"].includes(word.text);
      expect(await shows(result.image.bytes, WIDTH, word), word.text).toBe(
        part ? "hidden" : "shown",
      );
    }
  });

  it("covers a value the vault already knows, however the picture spaces it", async () => {
    const words = line(80, ["Ref", "0551", "234", "567", "and", "Sara", "Nasser", "agreed"]);
    const pseudonymizer = new Pseudonymizer(new Vault(), {
      detect: (texts) => Promise.resolve(texts.map(() => [])),
    });
    const phone = pseudonymizer.vault.tokenFor("PHONE", "0551234567");
    const person = pseudonymizer.vault.tokenFor("PERSON", "Sara Nasser");
    const result = redacted(
      await makeImageRedactor({ reader: plantedReader(WIDTH, words), pseudonymizer }).redact(
        await pngOf(paintPage(WIDTH, HEIGHT, words)),
      ),
    );
    expect(result.maskedText).toBe(`Ref ${phone} and ${person} agreed`);
  });

  it("covers the piece of a number the detector left off, and a sign beside it", async () => {
    const words = line(80, ["Card", "(", "4421", "9000", "1177", "3382", ")", "expires", "soon"]);
    const pseudonymizer = new Pseudonymizer(new Vault(), {
      detect: (texts) =>
        Promise.resolve(
          texts.map((text) => {
            const start = text.indexOf("9000 1177");
            return start === -1 ? [] : [{ start, end: start + 9, kind: "ACCOUNT" as const }];
          }),
        ),
    });
    const result = redacted(
      await makeImageRedactor({ reader: plantedReader(WIDTH, words), pseudonymizer }).redact(
        await pngOf(paintPage(WIDTH, HEIGHT, words)),
      ),
    );
    expect(result.maskedText).toMatch(/^Card \[ACCOUNT_\w{5}\] expires soon$/);
  });
});

describe("what cannot be read is covered", () => {
  it("covers a word the reader is unsure of, without a stand-in", async () => {
    const words = [
      ...line(80, ["Signed", "by"]),
      ...line(80, ["Kha1id"], 200, { confidence: 0.31 }),
      ...line(80, ["yesterday"], 320),
    ];
    const pseudonymizer = makePseudonymizer();
    const result = redacted(
      await makeImageRedactor({ reader: plantedReader(WIDTH, words), pseudonymizer }).redact(
        await pngOf(paintPage(WIDTH, HEIGHT, words)),
      ),
    );
    expect(result.maskedText).toBe(`Signed by ${UNREADABLE_LABEL} yesterday`);
    expect(result.stats.unreadableBoxes).toBe(1);
    expect(pseudonymizer.vault.size).toBe(0);
    expect(result.legend).toContain("could not read reliably");
    expect(await shows(result.image.bytes, WIDTH, words[2] as Planted)).toBe("hidden");
  });

  it("covers print below the height the reader can be trusted at, whatever it says", async () => {
    const small: Array<Planted> = [
      { text: "Falsal", x: 60, y: 80, width: 40, height: 11 },
      { text: "Al-Harbl", x: 106, y: 80, width: 52, height: 11 },
    ];
    const words = [...small, ...line(140, ["Terms", "apply"])];
    const result = redacted(
      await makeImageRedactor({
        reader: plantedReader(WIDTH, words),
        pseudonymizer: makePseudonymizer(),
      }).redact(await pngOf(paintPage(WIDTH, HEIGHT, words))),
    );
    for (const word of small) expect(await shows(result.image.bytes, WIDTH, word)).toBe("hidden");
    expect(result.maskedText).toBe(`${UNREADABLE_LABEL}\nTerms apply`);
  });

  it("covers a row of letter-sized marks the reader returned no word for", async () => {
    const read = line(80, ["Invoice", "for", "services"]);
    const unread: Array<Planted> = Array.from({ length: 9 }, (_, index) => ({
      text: "",
      x: 80 + index * 22,
      y: 300,
      width: 12,
      height: 18,
    }));
    const page = paintPage(WIDTH, HEIGHT, [...read, ...unread]);
    const result = redacted(
      await makeImageRedactor({
        reader: plantedReader(WIDTH, read),
        pseudonymizer: makePseudonymizer(),
      }).redact(await pngOf(page)),
    );
    expect(result.stats.unreadInkBoxes).toBe(1);
    for (const mark of unread) expect(await shows(result.image.bytes, WIDTH, mark)).toBe("hidden");
    for (const word of read) expect(await shows(result.image.bytes, WIDTH, word)).toBe("shown");
  });
});

describe("the re-read of what would be sent", () => {
  it("covers what the first reading missed and the re-read found", async () => {
    const words = [
      ...line(80, ["Customer", "record"]),
      // One solid mark: nothing about its shape says writing, so only the re-read can find it.
      { text: "0551234567", x: 60, y: 200, width: 130, height: 22, late: true, solid: true },
    ];
    const reader = plantedReader(WIDTH, words);
    const result = redacted(
      await makeImageRedactor({ reader, pseudonymizer: makePseudonymizer() }).redact(
        await pngOf(paintPage(WIDTH, HEIGHT, words)),
      ),
    );
    expect(result.stats.rounds).toBe(2);
    expect(reader.calls()).toBe(3);
    expect(await shows(result.image.bytes, WIDTH, words[2] as Planted)).toBe("hidden");
    // The picture that was read last is, byte for byte, the picture that is sent.
    expect(reader.seen.at(-1)?.equals(result.image.bytes)).toBe(true);
  });

  it("withholds the image when a value is still legible after the second attempt", async () => {
    const words = line(80, ["Customer", "record"]);
    // A reader that keeps finding a phone number somewhere new in whatever it is shown.
    const reader = plantedReader(WIDTH, words, {
      alter: (_answer, call) =>
        call === 1
          ? undefined
          : layoutAnswer(WIDTH, HEIGHT, [
              ...words,
              { text: "0551234567", x: 60, y: 150 + call * 60, width: 130, height: 22 },
            ]),
    });
    const result = await makeImageRedactor({ reader, pseudonymizer: makePseudonymizer() }).redact(
      await pngOf(paintPage(WIDTH, HEIGHT, words)),
    );
    expect(result).toEqual({
      kind: "withheld",
      reason:
        "After redaction, personal data could still be read in the image, so it was not sent.",
      // The text of the first reading, for the caller to mask and send in the image's place.
      readText: "Customer record",
    });
    expect(reader.calls()).toBe(3);
  });

  it("covers a name the detector finds only on the re-read, without a third reading", async () => {
    const words = line(80, ["Bill", "to", "Sultan", "Mutairi", "mobile", "0551234567"]);
    // A detector that knows the name only once the number beside it is gone from the text.
    const pseudonymizer = new Pseudonymizer(
      new Vault(),
      combineDetectors([
        patternDetector,
        {
          detect: (texts) =>
            Promise.resolve(
              texts.map((text) => {
                const start = text.indexOf("Mutairi");
                return start === -1 || text.includes("0551234567")
                  ? []
                  : [{ start, end: start + 7, kind: "PERSON" as const }];
              }),
            ),
        },
      ]),
    );
    const reader = plantedReader(WIDTH, words);
    const result = redacted(
      await makeImageRedactor({ reader, pseudonymizer }).redact(
        await pngOf(paintPage(WIDTH, HEIGHT, words)),
      ),
    );
    expect(await shows(result.image.bytes, WIDTH, words[3] as Planted)).toBe("hidden");
    expect(await shows(result.image.bytes, WIDTH, words[2] as Planted)).toBe("shown");
    expect(result.maskedText).toMatch(/^Bill to Sultan \[PERSON_\w{5}\] mobile \[PHONE_\w{5}\]$/);
    // What is sent is the picture that was read, with one more box: black cannot reveal anything.
    expect(reader.calls()).toBe(2);
    expect(await shows(reader.seen[1] as Buffer, WIDTH, words[3] as Planted)).toBe("shown");
  });

  it("does not take a word it already judged for news because it reads worse beside a box", async () => {
    const words = line(80, ["Employee", "0551234567", "attended"]);
    const reader = plantedReader(WIDTH, words, {
      alter: (answer, call) => {
        if (call === 1) return undefined;
        for (const read of answer.layout.pages[0]?.words ?? []) {
          if (read.text === "attended") read.confidence = 0.2;
        }
        return answer;
      },
    });
    const result = redacted(
      await makeImageRedactor({ reader, pseudonymizer: makePseudonymizer() }).redact(
        await pngOf(paintPage(WIDTH, HEIGHT, words)),
      ),
    );
    expect(result.stats.rounds).toBe(1);
    expect(await shows(result.image.bytes, WIDTH, words[2] as Planted)).toBe("shown");
  });
});

type Answer = ReturnType<typeof layoutAnswer>;
/** The first page of a reader's answer, and one of its words, loosely typed to be damaged. */
const page = (answer: Answer) => answer.layout.pages[0] as unknown as Record<string, unknown>;
const word = (answer: Answer, index: number) =>
  (page(answer).words as Array<Record<string, unknown>>)[index] as Record<string, unknown>;

describe("an image is withheld, never sent as it came", () => {
  const words = line(80, ["Owner", "0551234567"]);
  const withheld = async (
    reader: Parameters<typeof makeImageRedactor>[0]["reader"],
    pseudonymizer = makePseudonymizer(),
    bytes?: Buffer,
  ) => {
    const result = await makeImageRedactor({ reader, pseudonymizer }).redact(
      bytes ?? (await pngOf(paintPage(WIDTH, HEIGHT, words))),
    );
    expect(result.kind).toBe("withheld");
    return result.kind === "withheld" ? result.reason : "";
  };

  it("when the reading service is down", async () => {
    expect(
      await withheld({
        readLayout: () => Promise.reject(new Error("The reading service answered 502.")),
      }),
    ).toBe("The reading service answered 502.");
  });

  it("when the reading service does not answer in time", async () => {
    expect(
      await withheld({
        readLayout: () =>
          Promise.reject(new DOMException("The operation timed out.", "TimeoutError")),
      }),
    ).toBe("The reading service took too long.");
  });

  it("when the reading service returns text without word positions", async () => {
    expect(
      await withheld({
        readLayout: () =>
          Promise.resolve({ text: "Owner 0551234567", pages: 1, layout: undefined }),
      }),
    ).toBe("The reading service gave no word positions.");
  });

  it.each([
    ["a word without a polygon", (answer: Answer) => delete word(answer, 0).polygon],
    [
      "a polygon that is not eight numbers",
      (answer: Answer) => (word(answer, 0).polygon = [1, 2, 3, 4]),
    ],
    ["a position outside the text", (answer: Answer) => (word(answer, 1).offset = 400)],
    [
      "a word that is not what the text says there",
      (answer: Answer) => (word(answer, 0).text = "Other"),
    ],
    [
      "text that no word accounts for",
      (answer: Answer) => (page(answer).words as Array<unknown>).pop(),
    ],
    ["a picture of another size", (answer: Answer) => (page(answer).width = 640)],
    ["a page measured in inches", (answer: Answer) => (page(answer).unit = "inch")],
    ["two pages", (answer: Answer) => answer.layout.pages.push(page(answer) as never)],
    ["no pages", (answer: Answer) => answer.layout.pages.splice(0)],
  ])("when the reading service returns %s", async (_name, damage) => {
    const reader = plantedReader(WIDTH, words, {
      alter: (answer) => {
        damage(answer);
        return answer;
      },
    });
    await withheld(reader);
    expect(reader.calls()).toBe(1);
  });

  it("when the detection service is down", async () => {
    const pseudonymizer = new Pseudonymizer(new Vault(), {
      detect: () =>
        Promise.reject(new DetectorUnavailableError("The detection service could not be reached.")),
    });
    expect(await withheld(plantedReader(WIDTH, words), pseudonymizer)).toBe(
      "The detection service could not be reached.",
    );
  });

  it.each([
    ["empty", Buffer.alloc(0)],
    ["text that calls itself an image", Buffer.from("Khalid Al-Otaibi 1087654321\n".repeat(20))],
    [
      "an SVG drawing",
      Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><text>Khalid</text></svg>'),
    ],
    ["a PDF", Buffer.from("%PDF-1.7\n1 0 obj\n<<>>\nendobj\n")],
    ["random bytes", Buffer.from(Array.from({ length: 4000 }, (_, index) => (index * 7919) % 251))],
  ])("when the file is %s, without asking the reader", async (_name, bytes) => {
    const reader = plantedReader(WIDTH, words);
    await withheld(reader, makePseudonymizer(), bytes);
    expect(reader.calls()).toBe(0);
  });

  it("when the file is cut off part way", async () => {
    const whole = await pngOf(paintPage(WIDTH, HEIGHT, words));
    const reader = plantedReader(WIDTH, words);
    expect(await withheld(reader, makePseudonymizer(), whole.subarray(0, whole.length / 2))).toBe(
      "The image is damaged or could not be opened.",
    );
    expect(reader.calls()).toBe(0);
  });

  it("and is tried again the next time, because the cause may have passed", async () => {
    let down = true;
    const inner = plantedReader(WIDTH, words);
    const redactor = makeImageRedactor({
      pseudonymizer: makePseudonymizer(),
      reader: {
        readLayout: (bytes, mediaType) =>
          down ? Promise.reject(new Error("down")) : inner.readLayout(bytes, mediaType),
      },
    });
    const bytes = await pngOf(paintPage(WIDTH, HEIGHT, words));
    expect((await redactor.redact(bytes)).kind).toBe("withheld");
    down = false;
    expect((await redactor.redact(bytes)).kind).toBe("redacted");
  });
});

describe("what is sent", () => {
  it("is flat pixels: no alpha, one frame, no metadata", async () => {
    const words = line(80, ["Owner", "0551234567"]);
    const page = paintPage(WIDTH, HEIGHT, words);
    const source = await sharp(page.data, { raw: { width: WIDTH, height: HEIGHT, channels: 3 } })
      .ensureAlpha(0.5)
      .withExif({ IFD0: { ImageDescription: "PLANTED-SECRET-0551234567", Artist: "Khalid" } })
      .png()
      .toBuffer();
    expect(source.includes("PLANTED-SECRET")).toBe(true);
    const result = redacted(
      await makeImageRedactor({
        reader: plantedReader(WIDTH, words),
        pseudonymizer: makePseudonymizer(),
      }).redact(source),
    );
    const metadata = await sharp(result.image.bytes).metadata();
    expect(metadata).toMatchObject({ format: "png", channels: 3, hasAlpha: false });
    expect(metadata.exif).toBeUndefined();
    expect(metadata.icc).toBeUndefined();
    expect(metadata.xmp).toBeUndefined();
    expect(metadata.pages ?? 1).toBe(1);
    expect(result.image.bytes.includes("PLANTED-SECRET")).toBe(false);
    // Every chunk of the file is one a plain picture needs.
    const chunks: Array<string> = [];
    for (let offset = 8; offset < result.image.bytes.length;) {
      chunks.push(result.image.bytes.toString("latin1", offset + 4, offset + 8));
      offset += 12 + result.image.bytes.readUInt32BE(offset);
    }
    // pHYs is the pixel density the encoder always writes: 72 to the inch, from no file.
    expect([...new Set(chunks)].toSorted()).toEqual(["IDAT", "IEND", "IHDR", "pHYs"]);
  });

  it("keeps a box on its value when a large picture is scaled down twice", async () => {
    const big = 5200;
    const words: Array<Planted> = [
      { text: "Owner", x: 300, y: 600, width: 500, height: 120, solid: true },
      { text: "0551234567", x: 1400, y: 600, width: 1100, height: 120, solid: true },
      { text: "Riyadh", x: 4100, y: 3300, width: 700, height: 120, solid: true },
      { text: "1087654321", x: 2300, y: 3300, width: 1100, height: 120, solid: true },
    ];
    const reader = plantedReader(big, words);
    const result = redacted(
      await makeImageRedactor({ reader, pseudonymizer: makePseudonymizer() }).redact(
        await pngOf(paintPage(big, 3900, words)),
      ),
    );
    // Read at no more than 4000 pixels, sent at no more than 1568 and 1.15 megapixels.
    expect((await sharp(reader.seen[0]).metadata()).width).toBe(4000);
    expect(Math.max(result.width, result.height)).toBeLessThanOrEqual(1568);
    expect(result.width * result.height).toBeLessThanOrEqual(1_150_000);
    for (const word of words) {
      const sensitive = /^\d+$/.test(word.text);
      expect(await shows(result.image.bytes, big, word), word.text).toBe(
        sensitive ? "hidden" : "shown",
      );
    }
  });

  it("sets a picture smaller than the reader accepts on a white canvas", async () => {
    const words: Array<Planted> = [{ text: "0551234567", x: 2, y: 4, width: 36, height: 16 }];
    const reader = plantedReader(40, words);
    const result = redacted(
      await makeImageRedactor({ reader, pseudonymizer: makePseudonymizer() }).redact(
        await pngOf(paintPage(40, 28, words)),
      ),
    );
    expect([result.width, result.height]).toEqual([50, 50]);
    expect(await shows(result.image.bytes, 50, words[0] as Planted)).toBe("hidden");
  });

  it("sends only the first frame of a picture with several, and says so", async () => {
    const first = line(80, ["Owner", "0551234567"]);
    const second = line(80, ["Guarantor", "1087654321"]);
    const frames = await Promise.all(
      [first, second].map((words) => pngOf(paintPage(WIDTH, HEIGHT, words))),
    );
    const gif = await sharp(frames, { join: { animated: true } })
      .gif()
      .toBuffer();
    expect((await sharp(gif).metadata()).pages).toBe(2);
    const reader = plantedReader(WIDTH, first);
    const result = redacted(
      await makeImageRedactor({ reader, pseudonymizer: makePseudonymizer() }).redact(gif),
    );
    expect(result.legend).toContain("Only the first of 2 frames or pages was sent.");
    expect((await sharp(result.image.bytes).metadata()).pages ?? 1).toBe(1);
  });

  it("is the same bytes on every turn, read once, until the vault learns a value in it", async () => {
    const words = line(80, ["Owner", "0551234567", "met", "Sara", "Nasser"]);
    const pseudonymizer = makePseudonymizer();
    const reader = plantedReader(WIDTH, words);
    const redactor = makeImageRedactor({ reader, pseudonymizer });
    const bytes = await pngOf(paintPage(WIDTH, HEIGHT, words));
    const first = redacted(await redactor.redact(bytes));
    const again = redacted(await redactor.redact(bytes));
    expect(again.image.bytes.equals(first.image.bytes)).toBe(true);
    expect(reader.calls()).toBe(2);

    // A later message names someone who is also in the picture.
    pseudonymizer.vault.tokenFor("PERSON", "Sara Nasser");
    const after = redacted(await redactor.redact(bytes));
    expect(after.image.bytes.equals(first.image.bytes)).toBe(false);
    expect(await shows(after.image.bytes, WIDTH, words[3] as Planted)).toBe("hidden");
    expect(after.maskedText).not.toContain("Sara");
  });
});

describe("labels", () => {
  it("numbers a box too small for its stand-in and says in words what the number stands for", async () => {
    const words = line(80, ["Call", "0551234567", "or", "0509876543"]).map((word) =>
      /^\d/.test(word.text) ? { ...word, width: 60 } : word,
    );
    const pseudonymizer = makePseudonymizer();
    const result = redacted(
      await makeImageRedactor({ reader: plantedReader(WIDTH, words), pseudonymizer }).redact(
        await pngOf(paintPage(WIDTH, HEIGHT, words)),
      ),
    );
    const [first, second] = pseudonymizer.vault.entries().map((entry) => entry.token);
    expect(result.legend).toContain(`Numbered boxes: 1 = ${first}; 2 = ${second}.`);
  });

  it("lists the stand-in of a box too small even for a number", async () => {
    const words: Array<Planted> = [
      { text: "0551234567", x: 60, y: 80, width: 5, height: 14 },
      ...line(80, ["is", "the", "number"], 100),
    ];
    const pseudonymizer = makePseudonymizer();
    const result = redacted(
      await makeImageRedactor({
        reader: plantedReader(WIDTH, words),
        pseudonymizer,
        policy: { maxGrowth: 0, padAlong: 0, padAlongPixels: 0, padAcross: 0, padAcrossPixels: 0 },
      }).redact(await pngOf(paintPage(WIDTH, HEIGHT, words))),
    );
    expect(result.legend).toContain(
      `Boxes too small to label hide: ${pseudonymizer.vault.entries()[0]?.token}.`,
    );
    expect(result.legend).not.toContain("Numbered boxes");
  });

  it("gives every stand-in written on a box as text too, for a reader that misreads a letter", async () => {
    const words = line(80, ["Owner", "0551234567"]).map((entry) =>
      /^\d/.test(entry.text) ? { ...entry, width: 260, height: 30 } : entry,
    );
    const pseudonymizer = makePseudonymizer();
    const result = redacted(
      await makeImageRedactor({ reader: plantedReader(WIDTH, words), pseudonymizer }).redact(
        await pngOf(paintPage(WIDTH, HEIGHT, words)),
      ),
    );
    expect(result.legend).toContain(
      `Stand-ins written on boxes: ${pseudonymizer.vault.entries()[0]?.token}.`,
    );
    expect(result.legend).not.toContain("Numbered boxes");
  });

  it("writes nothing on a picture that needs no box", async () => {
    const words = line(80, ["Quarterly", "report", "attached"]);
    const result = redacted(
      await makeImageRedactor({
        reader: plantedReader(WIDTH, words),
        pseudonymizer: makePseudonymizer(),
      }).redact(await pngOf(paintPage(WIDTH, HEIGHT, words))),
    );
    expect(result.legend).toBe("");
    expect(result.stats.coveredShare).toBe(0);
  });
});

describe("redacting instead of masking", () => {
  it("covers the same words, says [REDACTED], and writes nothing to the vault", async () => {
    const words = [
      ...line(80, ["Contract", "of", "Khalid", "Al-Otaibi", "ends", "in", "March"]),
      ...line(140, ["Call", "0551234567", "after", "noon"]),
    ];
    const pseudonymizer = makePseudonymizer(["Khalid Al-Otaibi"]);
    const result = redacted(
      await makeImageRedactor({ reader: plantedReader(WIDTH, words), pseudonymizer }).redact(
        await pngOf(paintPage(WIDTH, HEIGHT, words)),
        [],
        "redact",
      ),
    );
    for (const word of words) {
      const sensitive = ["Khalid", "Al-Otaibi", "0551234567"].includes(word.text);
      expect(await shows(result.image.bytes, WIDTH, word), word.text).toBe(
        sensitive ? "hidden" : "shown",
      );
    }
    expect(result.maskedText).toBe(
      "Contract of [REDACTED] ends in March\nCall [REDACTED] after noon",
    );
    expect(result.maskedText.match(placeholderPattern())).toBeNull();
    expect(result.legend).toContain("[REDACTED]");
    expect(result.legend.match(placeholderPattern())).toBeNull();
    expect(result.stats).toMatchObject({ valueBoxes: 2, tokens: 0 });
    expect(pseudonymizer.vault.entries()).toEqual([]);
    expect(pseudonymizer.vault.spellingCount).toBe(0);
    // Each box still says what it hides, for this computer alone.
    expect(
      result.regions.map((region) => [region.source, region.kind, region.surface, region.token]),
    ).toEqual([
      ["value", "PERSON", "Khalid Al-Otaibi", undefined],
      ["value", "PHONE", "0551234567", undefined],
    ]);
  });

  it("keeps a masked and a redacted copy of one picture apart", async () => {
    const words = line(80, ["Khalid", "Al-Otaibi", "signed"]);
    const pseudonymizer = makePseudonymizer(["Khalid Al-Otaibi"]);
    const redactor = makeImageRedactor({ reader: plantedReader(WIDTH, words), pseudonymizer });
    const bytes = await pngOf(paintPage(WIDTH, HEIGHT, words));
    const gone = redacted(await redactor.redact(bytes, [], "redact"));
    expect(pseudonymizer.vault.entries()).toEqual([]);
    const masked = redacted(await redactor.redact(bytes));
    expect(masked.maskedText).toMatch(/^\[PERSON_\w{5}\] signed$/);
    expect(gone.maskedText).toBe("[REDACTED] signed");
  });
});

describe("QR codes and barcodes", () => {
  const VERIFY = "https://alah.li/7Xk2PqR";
  const at = { x: 620, y: 260 };

  const pageWith = async (payload: string, words: ReadonlyArray<Planted>) => {
    const page = paintPage(WIDTH, HEIGHT, words);
    const code = await codePixels(payload);
    stampOn(page, code, at.x, at.y);
    // The symbol itself, inside the quiet zone the stamp carries around it.
    const symbol = { x: at.x + 20, y: at.y + 20, width: code.width - 40, height: code.height - 40 };
    return { bytes: await pngOf(page), symbol };
  };

  it("covers a code that opens the document, with the stand-in of what it held", async () => {
    const words = line(80, ["Scan", "the", "code", "below"]);
    const { bytes, symbol } = await pageWith(VERIFY, words);
    const pseudonymizer = makePseudonymizer();
    const result = redacted(
      await makeImageRedactor({ reader: plantedReader(WIDTH, words), pseudonymizer }).redact(bytes),
    );
    expect(await darkShare(result.image.bytes, symbol)).toBeGreaterThan(0.85);
    for (const word of words) expect(await shows(result.image.bytes, WIDTH, word)).toBe("shown");
    expect(result.stats).toMatchObject({ codeBoxes: 1, unreadInkBoxes: 0 });
    expect(result.legend).toContain("QR code");
    const [entry] = pseudonymizer.vault.entries();
    expect(entry).toMatchObject({ kind: "URL", value: VERIFY });
    expect(result.regions).toEqual([
      expect.objectContaining({
        source: "code",
        kind: "URL",
        covered: true,
        token: entry?.token,
        surface: VERIFY,
        code: expect.objectContaining({
          format: "QRCode",
          inspection: expect.objectContaining({ findings: ["verification-link"] }),
        }),
      }),
    ]);
    // What the code held is never said beside the picture.
    expect(result.legend).not.toContain("7Xk2PqR");
  });

  it("redacts a code to a plain box that holds nothing, and keeps no trace of its payload", async () => {
    const { bytes, symbol } = await pageWith(VERIFY, []);
    const pseudonymizer = makePseudonymizer();
    const result = redacted(
      await makeImageRedactor({ reader: plantedReader(WIDTH, []), pseudonymizer }).redact(
        bytes,
        [],
        "redact",
      ),
    );
    expect(await darkShare(result.image.bytes, symbol)).toBeGreaterThan(0.85);
    expect(pseudonymizer.vault.entries()).toEqual([]);
  });

  it("leaves a code that names nobody open, reports it, and covers it when every code is to be", async () => {
    const { bytes, symbol } = await pageWith("https://www.example.com/", []);
    const pseudonymizer = makePseudonymizer();
    const open = redacted(
      await makeImageRedactor({ reader: plantedReader(WIDTH, []), pseudonymizer }).redact(bytes),
    );
    // Still a code: half dark, half light, and not taken for marks nobody could read.
    expect(await darkShare(open.image.bytes, symbol)).toBeLessThan(0.7);
    expect(open.stats).toMatchObject({ codeBoxes: 0, unreadInkBoxes: 0 });
    expect(open.regions).toEqual([
      expect.objectContaining({
        source: "code",
        covered: false,
        surface: "https://www.example.com/",
      }),
    ]);
    expect(pseudonymizer.vault.entries()).toEqual([]);

    const all = redacted(
      await makeImageRedactor({
        reader: plantedReader(WIDTH, []),
        pseudonymizer,
        policy: { codes: "all" },
      }).redact(bytes),
    );
    expect(await darkShare(all.image.bytes, symbol)).toBeGreaterThan(0.85);
  });
});

describe("a form's rows", () => {
  it("covers the value beside a label the reader gave as a line of its own", async () => {
    // Three cells of one row, far apart: label, value, the label again in Arabic.
    const words: Array<Planted> = [
      ...line(80, ["Full", "Name"], 60),
      ...line(80, ["esrablishment", "alwaha"], 380),
      ...line(80, ["اسم", "الشخص"], 800),
      ...line(160, ["Bank", "Name"], 60),
      ...line(160, ["Example", "Bank"], 380),
    ];
    // Each cell comes back as its own line, as a reader gives a table.
    const cells = [
      words.slice(0, 2),
      words.slice(2, 4),
      words.slice(4, 6),
      words.slice(6, 8),
      words.slice(8),
    ];
    const reader = plantedReader(WIDTH, words, {
      alter: (answer) => {
        const page = answer.layout.pages[0];
        if (page === undefined) return answer;
        const lines = cells.flatMap((cell) => {
          const members = page.words.filter((word) =>
            cell.some((planted) => planted.text === word.text),
          );
          const first = members[0];
          const last = members.at(-1);
          if (first === undefined || last === undefined) return [];
          return [
            {
              polygon: first.polygon,
              offset: first.offset as number,
              length: (last.offset as number) + (last.length as number) - (first.offset as number),
            },
          ];
        });
        return { ...answer, layout: { ...answer.layout, pages: [{ ...page, lines }] } };
      },
    });
    const pseudonymizer = makePseudonymizer();
    const result = redacted(
      await makeImageRedactor({ reader, pseudonymizer }).redact(
        await pngOf(paintPage(WIDTH, HEIGHT, words)),
      ),
    );
    for (const word of words) {
      const sensitive = ["esrablishment", "alwaha"].includes(word.text);
      expect(await shows(result.image.bytes, WIDTH, word), word.text).toBe(
        sensitive ? "hidden" : "shown",
      );
    }
    expect(pseudonymizer.vault.entries().map((entry) => [entry.kind, entry.value])).toEqual([
      ["PERSON", "esrablishment alwaha"],
    ]);
  });
});
