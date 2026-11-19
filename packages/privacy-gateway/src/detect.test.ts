import { describe, expect, it } from "vite-plus/test";

import { combineDetectors, type DetectedEntity, type Detector, patternDetector } from "./detect.ts";

/** What the local patterns mask in `text`, after the chain's span tidying. */
const masked = async (text: string, detectors: ReadonlyArray<Detector> = [patternDetector]) => {
  const [entities = []] = await combineDetectors(detectors).detect([text]);
  return entities.map((entity) => [text.slice(entity.start, entity.end), entity.kind]);
};

/** A name detector that reads every ten-digit number as a phone number, as one engine does. */
const digitsAsPhones: Detector = {
  detect: (texts) =>
    Promise.resolve(
      texts.map((text) =>
        [...text.matchAll(/(?<![0-9])[0-9]{10}(?![0-9])/g)].map((match): DetectedEntity => ({
          start: match.index,
          end: match.index + match[0].length,
          kind: "PHONE",
        })),
      ),
    ),
};

describe("ten-digit numbers", () => {
  it("masks national IDs and iqamas, and leaves amounts and references readable", async () => {
    const cases: ReadonlyArray<readonly [string, ReadonlyArray<ReadonlyArray<string>>]> = [
      ["يحمل الموظف الهوية الوطنية رقم 1098765432 الصادرة من الرياض.", [["1098765432", "ID"]]],
      ["Iqama No. 2456789013 expires next year.", [["2456789013", "ID"]]],
      // Nothing says what it is: an ID's shape is enough.
      ["المراجع (1098765432) لم يستكمل الطلب.", [["1098765432", "ID"]]],
      ["بلغت القيمة الإجمالية للعقد 1234500000 ريال سعودي.", []],
      ["The total contract value is SAR 2345600000 payable in stages.", []],
      ["Please quote invoice number 1987654321 in all correspondence.", []],
      // The nearer word decides.
      ["نفذت الحوالة رقم 2087654321 لصاحب الهوية 1098765432", [["1098765432", "ID"]]],
      // A table: the column's header decides.
      ["رقم الفاتورة\tالتاريخ\tالمبلغ\n1662447745\t25/04/2025\t32750", []],
      [
        "الاسم\tرقم الهوية\tالجوال\nسلطان العنزي\t1629328641\t0537536817",
        [
          ["1629328641", "ID"],
          ["0537536817", "PHONE"],
        ],
      ],
      // A two-cell row: its label decides.
      ["رقم العميل\t1117764070\nرقم الهوية\t1381307895", [["1381307895", "ID"]]],
      ["Call the applicant on 2125550147 before noon.", [["2125550147", "PHONE"]]],
    ];
    for (const [text, expected] of cases) {
      expect(await masked(text), text).toEqual(expected);
    }
    const longTable = Array.from({ length: 300 }, (_, row) => `${1600000000 + row}\t32750`);
    expect(await masked(["رقم الفاتورة\tالمبلغ", ...longTable].join("\n"))).toEqual([]);
  });

  it("finds commercial registration and VAT numbers without a detection service", async () => {
    const cases: ReadonlyArray<readonly [string, ReadonlyArray<ReadonlyArray<string>>]> = [
      ["المنشأة مسجلة بالسجل التجاري رقم 4030123456 وتاريخه سابق.", [["4030123456", "ID"]]],
      ["س.ت: 5855123456", [["5855123456", "ID"]]],
      ["C.R. No. 1010123456 issued in Riyadh.", [["1010123456", "ID"]]],
      ["رقم الشحنة 4030123456 في طريقها إلى المستودع.", []],
      ["الرقم الضريبي للمورد 300123456789003 مطبوع على الفاتورة.", [["300123456789003", "ID"]]],
      ["VAT Registration No. 311234567890123", [["311234567890123", "ID"]]],
      ["رقم التتبع 412345678901234", []],
      // In groups: masked where the text names the number, as the detector may not.
      ["رقم الهوية 1087-654-321 كما ورد في النموذج.", [["1087-654-321", "ID"]]],
      ["الرقم الضريبي 300 123 456 789 003 للمنشأة.", [["300 123 456 789 003", "ID"]]],
      ["سجل تجاري 1010-123456 ساري المفعول.", [["1010-123456", "ID"]]],
      ["بلغت القيمة 1 234 500 000 ريال.", []],
    ];
    for (const [text, expected] of cases) {
      expect(await masked(text), text).toEqual(expected);
    }
  });

  it("drops a detector's guess on a number the text calls an amount or a reference", async () => {
    expect(
      await masked("بلغت القيمة 1234500000 ريال، ورقم الشحنة 6012345678.", [digitsAsPhones]),
    ).toEqual([]);
    // A number with no such word, and the detector's own phone numbers, are kept.
    expect(await masked("للتواصل 0551234567 أو 6012345678", [digitsAsPhones])).toEqual([
      ["0551234567", "PHONE"],
      ["6012345678", "PHONE"],
    ]);
  });
});

describe("IBANs", () => {
  it("keeps an IBAN to its own table cell and to check digits that add up", async () => {
    expect(await masked("Ali\tSA03 8000 0000 6080 1016 7519\t5000\t2026-01-01")).toEqual([
      ["SA03 8000 0000 6080 1016 7519", "IBAN"],
    ]);
    expect(await masked("الآيبان SA0380000000608010167519\n5000")).toEqual([
      ["SA0380000000608010167519", "IBAN"],
    ]);
    // An amount after a space is not more of the account.
    expect(await masked("IBAN SA03 8000 0000 6080 1016 7519 5000 ريال")).toEqual([
      ["SA03 8000 0000 6080 1016 7519", "IBAN"],
    ]);
    expect(await masked("IBAN SA04 8000 0000 6080 1016 7519")).toEqual([]);
  });
});
