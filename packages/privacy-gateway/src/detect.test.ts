import { describe, expect, it } from "vite-plus/test";

import { describeMaskingFailure } from "./core.ts";
import {
  combineDetectors,
  type DetectedEntity,
  type Detector,
  DetectorUnavailableError,
  makeRemoteDetector,
  patternDetector,
} from "./detect.ts";
import { ProxyError } from "./upstream.ts";

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
  it("masks national IDs and iqamas, and leaves amounts readable", async () => {
    const cases: ReadonlyArray<readonly [string, ReadonlyArray<ReadonlyArray<string>>]> = [
      ["يحمل الموظف الهوية الوطنية رقم 1098765432 الصادرة من الرياض.", [["1098765432", "ID"]]],
      ["Iqama No. 2456789013 expires next year.", [["2456789013", "ID"]]],
      // Nothing says what it is: an ID's shape is enough.
      ["المراجع (1098765432) لم يستكمل الطلب.", [["1098765432", "ID"]]],
      ["بلغت القيمة الإجمالية للعقد 1234500000 ريال سعودي.", []],
      ["The total contract value is SAR 2345600000 payable in stages.", []],
      ["Please quote invoice number 1987654321 in all correspondence.", [["1987654321", "ID"]]],
      // The nearer word decides.
      ["حولنا 2087654321 ريال لصاحب الهوية 1098765432", [["1098765432", "ID"]]],
      // A table: the column's header decides.
      ["المبلغ\tالتاريخ\n1662447745\t25/04/2025", []],
      ["رقم الفاتورة\tالتاريخ\tالمبلغ\n1662447745\t25/04/2025\t32750", [["1662447745", "ID"]]],
      [
        "الاسم\tرقم الهوية\tالجوال\nسلطان العنزي\t1629328641\t0537536817",
        [
          ["1629328641", "ID"],
          ["0537536817", "PHONE"],
        ],
      ],
      // A two-cell row: its label decides.
      ["المبلغ\t1117764070\nرقم الهوية\t1381307895", [["1381307895", "ID"]]],
      ["Call the applicant on 2125550147 before noon.", [["2125550147", "PHONE"]]],
      // A mobile number in Arabic-Indic digits, with the country's code and no plus.
      [
        "للتواصل ٩٦٦٥٠١٢٣٤٥٦٧ أو ٠٠٩٦٦٥٠١٢٣٤٥٦٧",
        [
          ["٩٦٦٥٠١٢٣٤٥٦٧", "PHONE"],
          ["٠٠٩٦٦٥٠١٢٣٤٥٦٧", "PHONE"],
        ],
      ],
    ];
    for (const [text, expected] of cases) {
      expect(await masked(text), text).toEqual(expected);
    }
    const longTable = Array.from({ length: 300 }, (_, row) => `${1600000000 + row}\t32750`);
    expect(await masked(["المبلغ\tالرصيد", ...longTable].join("\n"))).toEqual([]);
  });

  it("finds commercial registration and VAT numbers without a detection service", async () => {
    const cases: ReadonlyArray<readonly [string, ReadonlyArray<ReadonlyArray<string>>]> = [
      ["المنشأة مسجلة بالسجل التجاري رقم 4030123456 وتاريخه سابق.", [["4030123456", "ID"]]],
      ["س.ت: 5855123456", [["5855123456", "ID"]]],
      ["C.R. No. 1010123456 issued in Riyadh.", [["1010123456", "ID"]]],
      ["قيمة الشحنة 4030123456 ريال.", []],
      ["الرقم الضريبي للمورد 300123456789003 مطبوع على الفاتورة.", [["300123456789003", "ID"]]],
      ["VAT Registration No. 311234567890123", [["311234567890123", "ID"]]],
      ["إجمالي الفاتورة 412345678901234", []],
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

  it("drops a detector's guess on a number the text calls an amount", async () => {
    expect(
      await masked("بلغت القيمة 1234500000 ريال، والرصيد 6012345678.", [digitsAsPhones]),
    ).toEqual([]);
    // A number with no such word, and the detector's own phone numbers, are kept.
    expect(await masked("للتواصل 0551234567 أو 6012345678", [digitsAsPhones])).toEqual([
      ["0551234567", "PHONE"],
      ["6012345678", "PHONE"],
    ]);
  });

  it("keeps a number that letters before it make a record's number, whatever word names it", async () => {
    // The detection service reports only the digits of `POL-857713407` (seen in the evaluation).
    const digitsAsIds: Detector = {
      detect: (texts) =>
        Promise.resolve(
          texts.map((text) =>
            [...text.matchAll(/(?<![0-9])[0-9]{9,12}(?![0-9])/g)].map((match): DetectedEntity => ({
              start: match.index,
              end: match.index + match[0].length,
              kind: "ID",
            })),
          ),
        ),
    };
    expect(
      await masked("- `claim_number`: The claim number of the claim under policy POL-857713407.", [
        digitsAsIds,
      ]),
    ).toEqual([["857713407", "ID"]]);
    expect(await masked("Policy no.: POL-667054815", [digitsAsIds])).toEqual([["667054815", "ID"]]);
    // A bare number after the same word is a reference: masked, whatever the detector said.
    expect(
      await masked("Please quote policy 857713407 in all correspondence.", [digitsAsIds]),
    ).toEqual([["857713407", "ID"]]);
  });
});

describe("bare reference numbers", () => {
  it("masks five digits or more after a reference word, and leaves short numbers, years and amounts readable", async () => {
    const cases: ReadonlyArray<readonly [string, ReadonlyArray<ReadonlyArray<string>>]> = [
      ["Customer 48213 asked about case 2 of 5.", [["48213", "ID"]]],
      ["Claim #5566778 was filed under policy 4821.", [["5566778", "ID"]]],
      [
        "Order 99812, ticket 104553 and invoice 7710023 are open.",
        [
          ["99812", "ID"],
          ["104553", "ID"],
          ["7710023", "ID"],
        ],
      ],
      ["The contract 2026 renewal and deed 1446 are on file.", []],
      ["The total amount is 150000 for policy 857713407.", [["857713407", "ID"]]],
      ["Invoice 150000 SAR is due.", []],
      ["Policy 1,250,000 cover; case 12345.50 settled.", []],
      ["رقم القضية 45678 لدى المحكمة.", [["45678", "ID"]]],
      ["صك رقم ٤٣١٠١٢٣٤٥٦ باسم المالك.", [["٤٣١٠١٢٣٤٥٦", "ID"]]],
      ["بوليصة التأمين ٥٥٦٦٧٧ سارية.", [["٥٥٦٦٧٧", "ID"]]],
      ["رقم المطالبة 556677 قيد المراجعة.", [["556677", "ID"]]],
      ["عقد 2026 وصك 1446هـ والقضية 3.", []],
      // The amount of a reference, in Arabic word order, is still an amount.
      ["إجمالي الفاتورة 150000 ورصيد العميل 250000.", []],
      ["مبلغ المطالبة ٧٥٠٠٠ مستحق.", []],
      // A table column of references, and one of amounts.
      ["رقم العميل\tالمبلغ\n1117764\t32750", [["1117764", "ID"]]],
    ];
    for (const [text, expected] of cases) {
      expect(await masked(text), text).toEqual(expected);
    }
  });
});

describe("lettered record numbers", () => {
  it("masks letters, a hyphen and five digits or more, and leaves standards and code alone", async () => {
    // Medical record and ID numbers that reached the provider in the evaluation.
    const cases: ReadonlyArray<readonly [string, ReadonlyArray<ReadonlyArray<string>>]> = [
      ["Patient MRN-1788876 was admitted.", [["MRN-1788876", "ID"]]],
      [
        "MRN-2045895, MRN-9658472 and (MRN-663419).",
        [
          ["MRN-2045895", "ID"],
          ["MRN-9658472", "ID"],
          ["MRN-663419", "ID"],
        ],
      ],
      ["رقم الهوية NID-44820193 مسجل.", [["NID-44820193", "ID"]]],
      ["الملف MRN-١٧٨٨٨٧٦ لدى العيادة.", [["MRN-١٧٨٨٨٧٦", "ID"]]],
      ["Ticket ABCDE-12345 is open.", [["ABCDE-12345", "ID"]]],
      // Too few digits, too many letters, or lower case.
      ["COVID-19 and IFRS-17 apply; see ABCDEF-12345.", []],
      ["Run mrn-1788876 or build-20260101 again.", []],
      // Standards keep their numbers.
      ["ISO-27001, IEC-62304, RFC-10000, IEEE-80211, SASO-12345, NIST-80053 and CVE-20241.", []],
      // Part of a web address or a longer token.
      ["See https://example.com/case/ABC-12345-update and example.com/MRN-1788876 now.", []],
      ["The key xMRN-1788876 and MRN-1788876A and MRN-1788876-2 differ.", []],
    ];
    for (const [text, expected] of cases) {
      expect(await masked(text), text).toEqual(expected);
    }
  });
});

describe("IBANs", () => {
  it("masks an IBAN in its country's form whatever its check digits, and keeps it to its own cell", async () => {
    const iban = (surface: string) => [[surface, "IBAN"]];
    const cases: ReadonlyArray<readonly [string, ReadonlyArray<ReadonlyArray<string>>]> = [
      [
        "Ali\tSA03 8000 0000 6080 1016 7519\t5000\t2026-01-01",
        iban("SA03 8000 0000 6080 1016 7519"),
      ],
      ["الآيبان SA0380000000608010167519\n5000", iban("SA0380000000608010167519")],
      // An amount after a space is not more of the account.
      ["IBAN SA03 8000 0000 6080 1016 7519 5000 ريال", iban("SA03 8000 0000 6080 1016 7519")],
      // A mistyped digit: the check digits are wrong, and it is still someone's account.
      ["IBAN SA04 8000 0000 6080 1016 7519", iban("SA04 8000 0000 6080 1016 7519")],
      ["IBAN SA0480000000608010167519", iban("SA0480000000608010167519")],
      ["IBAN SA04 8000 0000 6080 1016 7519 5000 ريال", iban("SA04 8000 0000 6080 1016 7519")],
      // A dropped digit and a doubled one.
      ["SA04 8000 0000 6080 1016 751 5000 ريال", iban("SA04 8000 0000 6080 1016 751")],
      ["حساب SA04800000006080101675199 للمورد", iban("SA04800000006080101675199")],
      // As documents write it: dashes, Arabic-Indic digits, lower case, the country set apart.
      ["SA04-8000-0000-6080-1016-7519", iban("SA04-8000-0000-6080-1016-7519")],
      ["الآيبان SA٠٤٨٠٠٠٠٠٠٠٦٠٨٠١٠١٦٧٥١٩ للموظف", iban("SA٠٤٨٠٠٠٠٠٠٠٦٠٨٠١٠١٦٧٥١٩")],
      ["iban: sa0480000000608010167519.", iban("sa0480000000608010167519")],
      [
        "in fy25 the iban sa04 8000 0000 6080 1016 7519 was used",
        iban("sa04 8000 0000 6080 1016 7519"),
      ],
      ["SA 04 8000 0000 6080 1016 7519", iban("SA 04 8000 0000 6080 1016 7519")],
      // Too short to be an account, whatever it starts with.
      ["SA04 8000 0000 and SA1234 and SA12", []],
      // Other countries: their registered length, letters only in the bank code.
      ["GB29 NWBK 6016 1331 9268 19", iban("GB29 NWBK 6016 1331 9268 19")],
      ["GB30 NWBK 6016 1331 9268 19", iban("GB30 NWBK 6016 1331 9268 19")],
      ["AE08-0331-2345-6789-0123-456 500", iban("AE08-0331-2345-6789-0123-456")],
      ["gb29nwbk60161331926819", iban("gb29nwbk60161331926819")],
      // Letters in the account: only right check digits make it an IBAN.
      ["FR14 2004 1010 0505 0001 3M02 606", iban("FR14 2004 1010 0505 0001 3M02 606")],
      ["FR15 2004 1010 0505 0001 3M02 606", []],
      // Serial numbers, keys, GUIDs and prose that begin like an IBAN.
      ["XY12 3456 7890 1234 5678 and AB12CD34EF56GH78", []],
      ["DE12AB34-1234-5678-9ABC-DEF012345678 BE12CDEF-1234-5678-9ABC-DEF012345678", []],
      ["sha DE4F370400440532013000, at12 noon we met again today", []],
    ];
    for (const [text, expected] of cases) {
      expect(await masked(text), text).toEqual(expected);
    }
  });
});

describe("what a bank's letter and a ministry's certificate carry", () => {
  it("masks an establishment's unified national number as it masks an ID, with or without a label", async () => {
    const cases: ReadonlyArray<readonly [string, ReadonlyArray<ReadonlyArray<string>>]> = [
      ["الرقم الوطني الموحد: 7012345678", [["7012345678", "ID"]]],
      // Nothing says what it is: ten digits starting with 70 are enough.
      ["المنشأة (7012345678) لم تستكمل الطلب.", [["7012345678", "ID"]]],
      ["ID 7012345678", [["7012345678", "ID"]]],
      // Ten digits starting with 7 and another digit are as often anything else.
      ["Ticket 7312345678 was closed.", [["7312345678", "ID"]]],
      ["Build 7312345678 finished.", []],
      // An amount is an amount whatever it starts with.
      ["بلغت القيمة الإجمالية للعقد 7012345678 ريال سعودي.", []],
    ];
    for (const [text, expected] of cases) {
      expect(await masked(text), text).toEqual(expected);
    }
  });

  it("masks a bank account number named as one, before or after the number", async () => {
    const cases: ReadonlyArray<readonly [string, ReadonlyArray<ReadonlyArray<string>>]> = [
      ["Account Number at SNB 12345678901234", [["12345678901234", "ACCOUNT"]]],
      ["Account No: 123-4567-8901234", [["123-4567-8901234", "ACCOUNT"]]],
      ["رقم الحساب في البنك الأهلي 12345678901234", [["12345678901234", "ACCOUNT"]]],
      ["الحساب البنكي: 1234567890123456", [["1234567890123456", "ACCOUNT"]]],
      // An Arabic line read left to right: the number stands before its label.
      ["12345678901234 رقم الحساب في البنك", [["12345678901234", "ACCOUNT"]]],
      // A table: the column's header decides.
      [
        "Branch\tAccount Number\tOpened\nOlaya\t12345678901234\t2021",
        [["12345678901234", "ACCOUNT"]],
      ],
      // A short one is an account where the words before it say so, as a customer's is.
      ["Customer account number 123456", [["123456", "ACCOUNT"]]],
      ["123456 رقم الحساب", []],
      // Nothing names it: fourteen digits alone are as often a timestamp.
      ["Started at 20261127203000 and finished.", []],
    ];
    for (const [text, expected] of cases) {
      expect(await masked(text), text).toEqual(expected);
    }
  });

  it("masks a serial of letters and ten digits or more with no hyphen, and leaves standards and short codes", async () => {
    const cases: ReadonlyArray<readonly [string, ReadonlyArray<ReadonlyArray<string>>]> = [
      ["Serial Number IB09876543210987654321098", [["IB09876543210987654321098", "ID"]]],
      ["الرقم التسلسلي TRX1234567890", [["TRX1234567890", "ID"]]],
      // An IBAN is an IBAN, not a serial.
      ["SA4420000001234567891234", [["SA4420000001234567891234", "IBAN"]]],
      ["Model AB123456 ships in March.", []],
      ["Conforms to ISO1234567890123.", []],
      ["Open src/AB3456789012.ts and run it.", []],
    ];
    for (const [text, expected] of cases) {
      expect(await masked(text), text).toEqual(expected);
    }
  });

  it("masks a Saudi IBAN a scan misread, and one that stands against Arabic letters", async () => {
    const cases: ReadonlyArray<readonly [string, ReadonlyArray<ReadonlyArray<string>>]> = [
      // O for 0, l for 1, 5A for SA: what a reader of pictures writes.
      ["IBAN SA44 2000 OOO1 2345 6789 l234", [["SA44 2000 OOO1 2345 6789 l234", "IBAN"]]],
      ["5A4420000001234567891234", [["5A4420000001234567891234", "IBAN"]]],
      ["رقم الآيبانSA4420000001234567891234هو", [["SA4420000001234567891234", "IBAN"]]],
      // A word in capitals with a few digits is not an account.
      ["SALESBOOSTDOZZLOOSSBILLS", []],
    ];
    for (const [text, expected] of cases) {
      expect(await masked(text), text).toEqual(expected);
    }
  });

  it("masks a link that verifies a document, and leaves other links to the detection service", async () => {
    const cases: ReadonlyArray<readonly [string, ReadonlyArray<ReadonlyArray<string>>]> = [
      [
        "To verify the letter, scan the QR code above or visit https://alah.li/7Xk2PqR",
        [["https://alah.li/7Xk2PqR", "URL"]],
      ],
      // A shortened link says nothing of where it leads: masked with no word beside it.
      ["alah.li/7Xk2PqR", [["alah.li/7Xk2PqR", "URL"]]],
      // Arabic written straight after the link is not part of it.
      ["الرابط https://alah.li/7Xk2PqRهذه الوثيقة معتمدة", [["https://alah.li/7Xk2PqR", "URL"]]],
      [
        "https://qr.saudibusiness.gov.sa/viewcr?nCrNumber=AbCde1FgHiJkLmnO2pQrSt==",
        [["https://qr.saudibusiness.gov.sa/viewcr?nCrNumber=AbCde1FgHiJkLmnO2pQrSt==", "URL"]],
      ],
      [
        "mc.gov.sa/ar/eservices/Pages/CR.aspx?id=7712345",
        [["mc.gov.sa/ar/eservices/Pages/CR.aspx?id=7712345", "URL"]],
      ],
      [
        "للتحقق من صحة الوثيقة: https://example.sa/d/9f3k2",
        [["https://example.sa/d/9f3k2", "URL"]],
      ],
      [
        "https://bank.example/documents/verify?ref=88213377",
        [["https://bank.example/documents/verify?ref=88213377", "URL"]],
      ],
      // A ministry's front page, a page of documentation, a pull request: none names anyone.
      ["Visit https://mc.gov.sa/ for more.", []],
      ["See https://docs.github.com/en/actions/12345678 for details.", []],
      ["Fixed in https://github.com/acme/app/pull/12345/checks", []],
      ["https://example.com/docs/verify-email", []],
    ];
    for (const [text, expected] of cases) {
      expect(await masked(text), text).toEqual(expected);
    }
  });
});

describe("the detection service", () => {
  type Step = number | "offline" | "timeout" | (() => Response);
  /** A service that answers each call with the next step: a status, or a failure to connect. */
  const service = (steps: ReadonlyArray<Step>) => {
    const waits: Array<number> = [];
    let calls = 0;
    const detector = makeRemoteDetector({
      endpoint: "https://detect.example",
      sleep: (milliseconds) => {
        waits.push(milliseconds);
        return Promise.resolve();
      },
      fetch: () => {
        const step = steps[Math.min(calls, steps.length - 1)] ?? 200;
        calls += 1;
        if (typeof step === "function") return Promise.resolve(step());
        if (step === "offline") return Promise.reject(new TypeError("fetch failed"));
        if (step === "timeout") {
          return Promise.reject(new DOMException("The operation timed out.", "TimeoutError"));
        }
        return Promise.resolve(
          step === 200
            ? Response.json({ results: [{ entities: [{ start: 0, end: 6, kind: "PERSON" }] }] })
            : new Response("unavailable", { status: step }),
        );
      },
    });
    const failure = () =>
      detector.detect(["Khalid asked."]).then(
        () => undefined,
        (cause: unknown) => describeMaskingFailure(cause),
      );
    const problem = () =>
      detector.detect(["Khalid asked."]).then(
        () => undefined,
        (cause: unknown) => (cause instanceof DetectorUnavailableError ? cause.problem : undefined),
      );
    return { detector, failure, problem, waits, calls: () => calls };
  };

  it("asks again when the service is briefly out of reach", async () => {
    const brief = service(["offline", 503, 200]);
    expect(await brief.detector.detect(["Khalid asked."])).toEqual([
      [{ start: 0, end: 6, kind: "PERSON" }],
    ]);
    expect(brief.calls()).toBe(3);
    expect(brief.waits).toEqual([500, 1500]);
  });

  it("stops after a bounded wait, and says what happened and what to do", async () => {
    const offline = service(["offline"]);
    const message = await offline.failure();
    expect(offline.calls()).toBe(4);
    expect(offline.waits).toEqual([500, 1500, 4000]);
    expect(message).toContain("nothing left this device");
    expect(message).toContain("could not be reached after 4 tries");
    expect(message).toContain("Check your internet connection");

    const down = service([503]);
    expect(await down.failure()).toContain("has a problem of its own (it answered 503)");
    expect(down.calls()).toBe(4);

    // The same failures, named for an app that words them in its own language.
    expect(await service(["offline"]).problem()).toEqual({
      kind: "unreachable",
      host: "detect.example",
    });
    expect(await service([401]).problem()).toEqual({
      kind: "signIn",
      host: "detect.example",
      status: 401,
    });

    // A service that hangs is asked once more, not three times: each try waits half a minute.
    const hanging = service(["timeout"]);
    expect(await hanging.failure()).toContain("did not answer in time");
    expect(hanging.calls()).toBe(2);
  });

  it("checks a long text in several calls at once, within a bound, and keeps every span in place", async () => {
    // 300 pieces of 4,000 characters: twelve calls of 25. Each piece names Khalid once.
    const piece = `${"x".repeat(3980)} Khalid ${"y".repeat(11)}\n`;
    const text = piece.repeat(300);
    let open = 0;
    let most = 0;
    const waiting: Array<() => void> = [];
    const detector = makeRemoteDetector({
      endpoint: "https://detect.example",
      fetch: async (_url, init) => {
        const { texts } = JSON.parse(String(init?.body)) as { texts: ReadonlyArray<string> };
        open += 1;
        most = Math.max(most, open);
        // Answered in the opposite order to the one they were asked in.
        await new Promise<void>((resolve) => {
          waiting.push(resolve);
          if (open === 4 || waiting.length === 12)
            waiting
              .splice(0)
              .toReversed()
              .forEach((go) => go());
        });
        open -= 1;
        return Response.json({
          results: texts.map((chunk) => ({
            entities: [
              { start: chunk.indexOf("Khalid"), end: chunk.indexOf("Khalid") + 6, kind: "PERSON" },
            ],
          })),
        });
      },
    });
    const [found = []] = await detector.detect([text]);
    expect(most).toBe(4);
    expect(found).toHaveLength(300);
    expect(found.every((entity) => text.slice(entity.start, entity.end) === "Khalid")).toBe(true);
    expect(found.map((entity) => entity.start)).toEqual(
      found.map((entity) => entity.start).toSorted((left, right) => left - right),
    );
  });

  it("passes on what the person's proxy said, and does not ask again", async () => {
    const waits: Array<number> = [];
    let calls = 0;
    const detector = makeRemoteDetector({
      endpoint: "https://detect.example",
      sleep: (milliseconds) => {
        waits.push(milliseconds);
        return Promise.resolve();
      },
      fetch: () => {
        calls += 1;
        return Promise.reject(
          new ProxyError(
            "signIn",
            "The proxy this computer is set to use (proxy.corp:3128) asks for a user name and password, and DoeDesk was given none.",
          ),
        );
      },
    });
    const message = await detector.detect(["Khalid asked."]).then(
      () => "",
      (cause: unknown) => describeMaskingFailure(cause),
    );
    expect(calls).toBe(1);
    expect(waits).toEqual([]);
    expect(message).toBe(
      "It could not be checked for personal data, so nothing left this device. The detection service at detect.example could not be asked. The proxy this computer is set to use (proxy.corp:3128) asks for a user name and password, and DoeDesk was given none. Then send your message again.",
    );
  });

  it("does not ask again for an answer that waiting will not change", async () => {
    const signedOut = service([401]);
    expect(await signedOut.failure()).toContain("sign in again");
    expect(signedOut.calls()).toBe(1);
    expect(signedOut.waits).toEqual([]);
    const refused = service([403]);
    await refused.failure();
    expect(refused.calls()).toBe(1);
  });

  it("stops at once when the allowance is used up, in the service's words, and still waits out a rate limit", async () => {
    const usedUp = (code: string, message?: string) => () =>
      Response.json({ error: { code, ...(message ? { message } : {}) } }, { status: 429 });

    const trial = service([
      usedUp("quota_exceeded", "This account has used its trial allowance for the month."),
    ]);
    const trialMessage = await trial.failure();
    expect(trial.calls()).toBe(1);
    expect(trial.waits).toEqual([]);
    expect(trialMessage).toContain("This account has used its trial allowance for the month.");
    expect(trialMessage).toContain("when the allowance renews next month");
    expect(trialMessage).not.toMatch(/too many requests|Wait a minute|tries/);
    expect(
      await service([usedUp("quota_exceeded", "This account has used its allowance.")]).problem(),
    ).toEqual({ kind: "allowance", host: "detect.example", status: 429 });

    const organization = service([
      usedUp(
        "org_allowance_ended",
        "Your organization's DoeDesk Cloud allowance for this month is used up. Your DoeDesk administrator can add more.",
      ),
    ]);
    expect(await organization.failure()).toMatch(
      /Your organization's DoeDesk Cloud allowance for this month is used up\. Your DoeDesk administrator can add more\.$/,
    );
    expect(organization.calls()).toBe(1);
    // Without the service's words, the person is still told what happened and who can help.
    expect(await service([usedUp("org_allowance_ended")]).failure()).toMatch(
      /Your organization's allowance at detect\.example is used up\. Your DoeDesk administrator can add more\.$/,
    );

    for (const limited of [
      usedUp("too_many_requests", "Slow down."),
      () => new Response("Too Many Requests", { status: 429 }),
    ]) {
      const busy = service([limited]);
      expect(await busy.failure()).toContain("receiving too many requests (it answered 429)");
      expect(busy.calls()).toBe(4);
      expect(busy.waits).toEqual([500, 1500, 4000]);
    }
  });
});
