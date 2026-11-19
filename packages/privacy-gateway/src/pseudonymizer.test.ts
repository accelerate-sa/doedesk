import { describe, expect, it } from "vite-plus/test";

import type { DetectedEntity, Detector } from "./detect.ts";
import type { EntityKind } from "./placeholders.ts";
import { Pseudonymizer } from "./pseudonymizer.ts";
import { Vault } from "./vault.ts";

/** Reports each listed value wherever it stands, as a detection service would. */
const finds = (values: ReadonlyArray<readonly [string, EntityKind]>): Detector => ({
  detect: (texts) =>
    Promise.resolve(
      texts.map((text) =>
        values.flatMap(([value, kind]) =>
          [...text.matchAll(new RegExp(value, "g"))].map((match): DetectedEntity => ({
            start: match.index,
            end: match.index + value.length,
            kind,
          })),
        ),
      ),
    ),
});

const STAND_IN = /\[[A-Z]+_[A-HJ-NP-Z2-9]{5}\]/g;

describe("Arabic prefix letters", () => {
  it("leaves the letter outside the stand-in, and restores the text exactly", async () => {
    // The detector reports the attached letter as part of the name, as one engine does.
    const pseudonymizer = new Pseudonymizer(
      new Vault(),
      finds([
        ["كمحمد العتيبي", "PERSON"],
        ["لشركة قمم الحجاز", "ORG"],
        ["وبندر الغامدي", "PERSON"],
        ["فهد الشمري", "PERSON"],
      ]),
    );
    const text =
      "يعامل الموظف كمحمد العتيبي، وسلمت النسخة لشركة قمم الحجاز، وحضر وبندر الغامدي مع فهد الشمري.";
    const { texts } = await pseudonymizer.mask([{ text, mode: "detect" }]);
    const sent = texts[0] ?? "";
    expect(sent.replace(STAND_IN, "[X]")).toBe(
      "يعامل الموظف ك[X]، وسلمت النسخة ل[X]، وحضر و[X] مع [X].",
    );
    expect(pseudonymizer.unmask(sent)).toBe(text);
    const [spans = []] = await pseudonymizer.locate([text]);
    expect(spans.map((span) => text.slice(span.start, span.end))).toEqual([
      "محمد العتيبي",
      "شركة قمم الحجاز",
      "بندر الغامدي",
      "فهد الشمري",
    ]);
  });

  it("masks a known name wherever it appears again, with or without a letter attached", async () => {
    const pseudonymizer = new Pseudonymizer(
      new Vault(),
      finds([
        ["محمد العتيبي", "PERSON"],
        ["علي", "PERSON"],
      ]),
    );
    const first = await pseudonymizer.mask([{ text: "حضر محمد العتيبي مع علي.", mode: "detect" }]);
    const token = /\[PERSON_[A-HJ-NP-Z2-9]{5}\]/.exec(first.texts[0] ?? "")?.[0] ?? "";
    // The detector misses the prefixed form; the vault does not.
    const { texts } = await new Pseudonymizer(pseudonymizer.vault, finds([])).mask([
      { text: "اتصلت الإدارة بمحمد العتيبي وكمحمد العتيبي، وهذا فعلي.", mode: "detect" },
      { text: "أرسلت الخطاب لمحمد العتيبي.", mode: "known" },
    ]);
    expect(texts).toEqual([
      `اتصلت الإدارة ب${token} وك${token}، وهذا فعلي.`,
      `أرسلت الخطاب ل${token}.`,
    ]);
  });
});

describe("initials", () => {
  it("masks initials that stand for a known person or follow an honorific, and no abbreviation", async () => {
    const pseudonymizer = new Pseudonymizer(
      new Vault(),
      finds([
        ["محمد بن سعد العتيبي", "PERSON"],
        ["Umar Saleh", "PERSON"],
      ]),
    );
    const text = [
      "تقدم محمد بن سعد العتيبي بطلب، ووقع عليه بالأحرف الأولى (م. ع.).",
      "وراجعه د. ف. ق. ثم Dr. J. K. والعنوان ص.ب. 1234 والمبلغ 50 ر.س.",
      "Umar Saleh moved from the U.S. to the U.K.",
    ].join("\n");
    const { texts } = await pseudonymizer.mask([{ text, mode: "detect" }]);
    expect((texts[0] ?? "").replace(STAND_IN, "[X]")).toBe(
      [
        "تقدم [X] بطلب، ووقع عليه بالأحرف الأولى ([X]).",
        "وراجعه د. [X] ثم Dr. [X] والعنوان ص.ب. 1234 والمبلغ 50 ر.س.",
        "[X] moved from the U.S. to the U.K.",
      ].join("\n"),
    );
  });
});
