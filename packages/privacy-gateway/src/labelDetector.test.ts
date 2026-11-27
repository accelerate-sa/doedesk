import { describe, expect, it } from "vite-plus/test";

import { findLabelledValues, kindOfHeader } from "./labelDetector.ts";

/** What the labels of `text` point at, each with its kind. Every name here is made up. */
const labelled = (text: string) =>
  findLabelledValues(text).map((entity) => [text.slice(entity.start, entity.end), entity.kind]);

describe("a value in the cell beside its label", () => {
  it("takes the value of a bilingual form's row, whichever side each label stands on", () => {
    const cases: ReadonlyArray<readonly [string, ReadonlyArray<ReadonlyArray<string>>]> = [
      ["Full Name\tSami Tariq Alharbi\tاسم الشخص", [["Sami Tariq Alharbi", "PERSON"]]],
      ["الاسم الكامل\tسامي طارق الحربي\tFull Name", [["سامي طارق الحربي", "PERSON"]]],
      // The label's notes are not part of it, closed or cut off by the cell's edge.
      [
        "Facility Name (As of Official Documents) *\tمؤسسة الواحة التقنية\tاسم المنشأة (حسب الوثائق الرسمية) *",
        [["مؤسسة الواحة التقنية", "ORG"]],
      ],
      [
        "Facility Name in English (Trade name)\twaha tech\tاسم المنشأة باللغة الإنجليزية",
        [["waha tech", "ORG"]],
      ],
      [
        "Business Address\tJeddah, Al Rawdah, Ibn Zaydun 1234\tعنوان المنشأة",
        [["Jeddah, Al Rawdah, Ibn Zaydun 1234", "ADDRESS"]],
      ],
      ["P.O. Box\t4521\tالصندوق البريدي", [["4521", "ADDRESS"]]],
      ["Postal Code\t21442\tالرمز البريدي", [["21442", "ADDRESS"]]],
      [
        "Date of birth (Gregorian or Hijri)\t14/03/1991\tتاريخ الميلاد (ميلادي أو",
        [["14/03/1991", "DATE"]],
      ],
      ["| Owner | Sami Alharbi |", [["Sami Alharbi", "PERSON"]]],
      // An empty field, a hint left in it, and what a table leaves beside a label.
      ["Full Name\t\tاسم الشخص", []],
      ["Full Name\tRequired\tاسم الشخص", []],
      ["Owner\tphone", []],
      // A table's header row: the cell beside a label is another column's header, not its value.
      ["Full Name\tNational ID\tIBAN\tGreeting", []],
      ["Full Name\tNational ID", []],
      ["Full Name National ID IBAN Sami Alharbi 1098765432", []],
      // Two fields on one row, each with its value.
      [
        "Full Name\tSami Alharbi\tDate of birth\t14/03/1991",
        [
          ["Sami Alharbi", "PERSON"],
          ["14/03/1991", "DATE"],
        ],
      ],
    ];
    for (const [text, expected] of cases) expect(labelled(text), text).toEqual(expected);
  });
});

describe("a value on the line of its label", () => {
  it("takes what follows a colon as written, and what follows a bare label only when it looks like a name", () => {
    const cases: ReadonlyArray<readonly [string, ReadonlyArray<ReadonlyArray<string>>]> = [
      ["Full Name: sami tariq alharbi", [["sami tariq alharbi", "PERSON"]]],
      ["الاسم الكامل: سامي طارق الحربي", [["سامي طارق الحربي", "PERSON"]]],
      ["المالك: سامي الحربي", [["سامي الحربي", "PERSON"]]],
      ["Full Name Sami Tariq Alharbi", [["Sami Tariq Alharbi", "PERSON"]]],
      // The same field named again in the other language, the value between.
      ["Full Name Sami Tariq Alharbi اسم الشخص", [["Sami Tariq Alharbi", "PERSON"]]],
      ["اسم المنشأة مؤسسة الواحة التقنية Facility Name", [["مؤسسة الواحة التقنية", "ORG"]]],
      // An Arabic label read left to right: the value stands before it.
      ["Sami Tariq Alharbi اسم الشخص", [["Sami Tariq Alharbi", "PERSON"]]],
      ["Owner Sami Alharbi signed the lease on Monday.", [["Sami Alharbi", "PERSON"]]],
      // Exact shapes are taken after their label wherever it stands.
      [
        "Riyadh 12211, P.O. Box 4521, Postal Code 21442",
        [
          ["4521", "ADDRESS"],
          ["21442", "ADDRESS"],
        ],
      ],
      ["Applicant's date of birth 14/03/1991 was confirmed.", [["14/03/1991", "DATE"]]],
      ["ص.ب 4521 الرياض", [["4521", "ADDRESS"]]],
      // Prose and code that happen to use a label's word.
      ["Owner: the user who created it", []],
      ["The owner agreed to the terms.", []],
      ["Owner/Manager", []],
      ["المالك/المدير", []],
      ["وافق المالك على العقد", []],
      ["Full Name: string", []],
      ["full name is required for all applicants", []],
    ];
    for (const [text, expected] of cases) expect(labelled(text), text).toEqual(expected);
  });
});

describe("a name after a title", () => {
  it("takes a name as a bank's system holds it, and stops where a sentence goes on", () => {
    const cases: ReadonlyArray<readonly [string, ReadonlyArray<ReadonlyArray<string>>]> = [
      // Lower case and misspelt, alone on its line.
      ["Mr. esrablishment alwaha altijari", [["esrablishment alwaha altijari", "PERSON"]]],
      ["Mrs. Noura Alqahtani has an appointment.", [["Noura Alqahtani", "PERSON"]]],
      ["Dear Mr Sami bin Tariq Alharbi, thank you.", [["Sami bin Tariq Alharbi", "PERSON"]]],
      ["السيد/ سامي الحربي المحترم", [["سامي الحربي", "PERSON"]]],
      ["السيدة نورة القحطاني", [["نورة القحطاني", "PERSON"]]],
      ["السيد/ مؤسسة الواحة التقنية", [["مؤسسة الواحة التقنية", "ORG"]]],
      ["السادةAcme Trading", [["Acme Trading", "ORG"]]],
      ["قال السيد سامي إن الموعد غدا", [["سامي", "PERSON"]]],
      // Lower case in the middle of a sentence is the sentence.
      ["mr. smith went to the market and bought apples", []],
      ["The Ms office suite", []],
    ];
    for (const [text, expected] of cases) expect(labelled(text), text).toEqual(expected);
  });
});

describe("a column's header", () => {
  it("says what kind of value its cells hold, and only when it is a label and nothing else", () => {
    expect(kindOfHeader("Full Name")).toBe("PERSON");
    expect(kindOfHeader("الاسم")).toBe("PERSON");
    expect(kindOfHeader("Date of Birth")).toBe("DATE");
    expect(kindOfHeader("Business Address *")).toBe("ADDRESS");
    expect(kindOfHeader("Amount")).toBeUndefined();
    expect(kindOfHeader("Full name of the product")).toBeUndefined();
  });
});
