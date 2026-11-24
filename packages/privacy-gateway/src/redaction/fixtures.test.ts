import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeZlib from "node:zlib";

import sharp from "sharp";
import { describe, expect, it } from "vite-plus/test";

import {
  combineDetectors,
  type DetectedEntity,
  DetectorUnavailableError,
  patternDetector,
} from "../detect.ts";
import { placeholderPattern } from "../placeholders.ts";
import { Pseudonymizer } from "../pseudonymizer.ts";
import { Vault } from "../vault.ts";
import { makeImageRedactor } from "./redactImage.ts";
import { compactOf } from "./words.ts";

/**
 * Cases of the redaction corpus, replayed. Each folder holds a made-up document as an image, the
 * map of which pixels belong to which sensitive value, and the answers the real reading and
 * detection services gave when the case was recorded (the evaluation repository's
 * audit/redaction writes them). Nothing here touches a network.
 */
const FIXTURES = NodePath.join(import.meta.dirname, "fixtures");

interface Fixture {
  readonly id: string;
  readonly file: string;
  readonly expect: "redacted" | "withheld" | "either";
  readonly outcome: "redacted" | "withheld";
  readonly width: number;
  readonly height: number;
  readonly absent: ReadonlyArray<string>;
  readonly values: ReadonlyArray<{
    readonly label: number;
    readonly kind: string;
    readonly text: string;
  }>;
}

interface Recorded {
  readonly reads: ReadonlyArray<{
    readonly text: string;
    readonly pages: number;
    readonly layout: unknown;
  }>;
  readonly detects: ReadonlyArray<{
    readonly text: string;
    readonly entities: ReadonlyArray<DetectedEntity>;
  }>;
}

/**
 * Cases that leave sensitive ink showing, with the share that shows. Each is a known gap.
 * letter_spaced: the reader ran the "S" of a spaced "S A 5 5 …" into the word before it
 * ("AccountS"), so one letter of the account's country code stays visible.
 */
const KNOWN_BARE: Readonly<Record<string, number>> = { "disjointed--letter_spaced": 0.02 };

const index = JSON.parse(
  NodeFS.readFileSync(NodePath.join(FIXTURES, "index.json"), "utf8"),
) as ReadonlyArray<Fixture>;

const wordsOf = (text: string) =>
  [...text.matchAll(/\S+/gu)].map((match) => ({ text: match[0], start: match.index }));

/**
 * The recorded answer for a text that is a recorded one with some words taken out, each run of
 * them holding a number the local patterns mask since the recording (the reader's words around a
 * covered number go with it). The service's answer on the rest of the text stands.
 */
const answerWithoutNumbers = (
  asked: string,
  recorded: ReadonlyArray<Recorded["detects"][number]>,
): ReadonlyArray<DetectedEntity> | undefined => {
  const askedWords = wordsOf(asked);
  for (const { text, entities } of recorded) {
    const words = wordsOf(text);
    const shift = new Map<number, number>();
    let next = 0;
    let index = 0;
    while (index < words.length) {
      const word = words[index] as (typeof words)[number];
      if (word.text === askedWords[next]?.text) {
        shift.set(word.start, (askedWords[next]?.start ?? 0) - word.start);
        index += 1;
        next += 1;
        continue;
      }
      let end = index;
      while (end < words.length && words[end]?.text !== askedWords[next]?.text) end += 1;
      const dropped = words.slice(index, end).map((gone) => gone.text);
      // Joined: an IBAN in groups of four has no group of five digits.
      if (!/[0-9٠-٩]{5,}/u.test(dropped.join(""))) break;
      index = end;
    }
    if (index < words.length || next !== askedWords.length) continue;
    return entities.flatMap(({ start, end, kind }) => {
      const first = words.findLast((word) => word.start <= start);
      const delta = first === undefined ? undefined : shift.get(first.start);
      if (delta === undefined) return [];
      const moved = { start: start + delta, end: end + delta, kind };
      return asked.slice(moved.start, moved.end) === text.slice(start, end) ? [moved] : [];
    });
  }
  return undefined;
};

const replay = async (fixture: Fixture) => {
  const folder = NodePath.join(FIXTURES, fixture.id);
  const recorded = JSON.parse(
    NodeZlib.gunzipSync(NodeFS.readFileSync(NodePath.join(folder, "recorded.json.gz"))).toString(
      "utf8",
    ),
  ) as Recorded;
  const byText = new Map(recorded.detects.map((entry) => [entry.text, entry.entities]));
  let reads = 0;
  const pseudonymizer = new Pseudonymizer(
    new Vault(),
    combineDetectors([
      patternDetector,
      {
        // A text the recording does not hold means the code now asks something else: fail.
        detect: (texts) =>
          Promise.all(
            texts.map((text) => {
              const entities = byText.get(text) ?? answerWithoutNumbers(text, recorded.detects);
              if (entities === undefined) {
                throw new DetectorUnavailableError("This text was not in the recording.");
              }
              return entities;
            }),
          ),
      },
    ]),
  );
  const redactor = makeImageRedactor({
    pseudonymizer,
    reader: {
      readLayout: () => {
        const answer = recorded.reads[reads];
        reads += 1;
        return answer === undefined
          ? Promise.reject(new Error("The recording holds no further reading."))
          : Promise.resolve(answer);
      },
    },
  });
  const result = await redactor.redact(NodeFS.readFileSync(NodePath.join(folder, fixture.file)));
  return { result, pseudonymizer, lastRead: recorded.reads[reads - 1]?.text ?? "", folder };
};

describe("recorded cases from the real reading and detection services", () => {
  it.each(
    index
      .filter((entry) => entry.outcome === "withheld")
      .map((entry) => [entry.id, entry] as const),
  )("%s: withheld", async (_id, fixture) => {
    const { result } = await replay(fixture);
    expect(result.kind).toBe("withheld");
  });

  it.each(
    index
      .filter((entry) => entry.outcome === "redacted")
      .map((entry) => [entry.id, entry] as const),
  )("%s: no sensitive ink outside a box, no value legible, no metadata", async (_id, fixture) => {
    const { result, pseudonymizer, lastRead, folder } = await replay(fixture);
    if (result.kind !== "redacted") throw new Error(`withheld: ${result.reason}`);

    // Which pixels belong to which value, scaled as the picture was, or padded if it was tiny.
    const canvas = { width: Math.max(fixture.width, 50), height: Math.max(fixture.height, 50) };
    const truth = await sharp(NodePath.join(folder, "sens_label.png"))
      .extend({
        right: canvas.width - fixture.width,
        bottom: canvas.height - fixture.height,
        background: { r: 0, g: 0, b: 0 },
      })
      .toBuffer()
      .then((padded) =>
        sharp(padded)
          .resize(result.width, result.height, { kernel: "nearest", fit: "fill" })
          .extractChannel(0)
          .raw()
          .toBuffer(),
      );
    let ink = 0;
    let bare = 0;
    for (let pixel = 0; pixel < truth.length; pixel += 1) {
      if (truth[pixel] === 0) continue;
      ink += 1;
      if (result.coverage.data[pixel] !== 1) bare += 1;
    }
    expect(ink).toBeGreaterThan(0);
    expect(bare / ink, "share of sensitive ink left outside every box").toBeLessThan(
      KNOWN_BARE[fixture.id] ?? 0.001,
    );

    // Painted pixels are box or label, nothing of the picture.
    const pixels = await sharp(result.image.bytes).raw().toBuffer({ resolveWithObject: true });
    expect(pixels.info.channels).toBe(3);
    const greys = new Set(Array.from({ length: 10 }, (_, k) => Math.round((255 * k) / 9)));
    if (result.image.mediaType === "image/png") {
      for (let pixel = 0; pixel < result.coverage.data.length; pixel += 1) {
        if (result.coverage.data[pixel] !== 1) continue;
        const [r, g, b] = [0, 1, 2].map((channel) => pixels.data[pixel * 3 + channel]);
        if (r !== g || g !== b || !greys.has(r as number)) {
          throw new Error(`A covered pixel shows the picture (${r}, ${g}, ${b}).`);
        }
      }
    }

    // No value can be read in the reader's last look at the picture that is sent, in the text
    // beside it, or in the legend.
    const seen = compactOf(`${lastRead}\n${result.maskedText}\n${result.legend}`);
    for (const value of fixture.values) {
      expect(seen.includes(compactOf(value.text)), value.text).toBe(false);
    }

    // A value's stand-in on the picture is the one the vault gives it in text.
    for (const value of fixture.values) {
      for (const token of pseudonymizer.vault.maskKnown(value.text).match(placeholderPattern()) ??
        []) {
        expect(`${result.maskedText}\n${result.legend}`, value.text).toContain(token);
      }
    }

    const metadata = await sharp(result.image.bytes).metadata();
    expect(metadata.hasAlpha).toBe(false);
    expect(metadata.exif ?? metadata.xmp ?? metadata.icc).toBeUndefined();
    for (const planted of fixture.absent) {
      expect(result.image.bytes.includes(planted), planted).toBe(false);
    }
  });
});
