import { describe, expect, it } from "vite-plus/test";

import { readableForSuggestion, sealSuggestionFor } from "./sealSuggestion.logic";

const lines = (...rows: ReadonlyArray<string>) => rows.join("\n");

describe("the local suggestion to seal an attached file", () => {
  it.each([
    {
      case: "a payroll sheet, by its header row",
      name: "october.csv",
      text: lines("Employee,Department,Basic Salary,Housing Allowance", "Sara,Finance,18000,4500"),
      expected: { reason: "columns" },
    },
    {
      case: "an Arabic staff register, by its identity column",
      name: "الموظفون.csv",
      text: lines("الاسم,رقم الهوية,القسم", "سارة,1087654321,المالية"),
      expected: { reason: "columns" },
    },
    {
      case: "a tab-separated list with an IBAN column",
      name: "vendors.tsv",
      text: lines("Vendor\tIBAN\tCity", "Najd Supplies\tSA0380000000608010167519\tRiyadh"),
      expected: { reason: "columns" },
    },
    {
      case: "a list dense with identity numbers and phones, with no header that says so",
      name: "contacts.txt",
      text: lines(
        "Khalid 1087654321 0551234567",
        "Noura 1098765432 0559876543",
        "Faisal 2456789012 0501112233",
      ),
      expected: { reason: "identifiers", count: 6 },
    },
    {
      case: "identity numbers in Arabic-Indic digits",
      name: "قائمة.txt",
      text: lines(
        "خالد ١٠٨٧٦٥٤٣٢١",
        "نورة ١٠٩٨٧٦٥٤٣٢",
        "فيصل ٢٤٥٦٧٨٩٠١٢",
        "سارة ١٠١٢٣٤٥٦٧٨",
        "هند ٢٣٤٥٦٧٨٩٠١",
      ),
      expected: { reason: "identifiers", count: 5 },
    },
    {
      case: "a roster with one identity column among ordinary ones, spelled with an underscore",
      name: "roster.csv",
      text: lines("employee_no,name,national_id,team,start", "E-1,Sara,x,Finance,2024"),
      expected: { reason: "columns" },
    },
    {
      case: "an identity column in camel case",
      name: "staff.csv",
      text: lines("fullName,passportNo,team", "Sara,x,Finance"),
      expected: { reason: "columns" },
    },
    {
      case: "a date of birth column, abbreviated",
      name: "patients.csv",
      text: lines("Name;DOB;Ward", "Sara;x;3"),
      expected: { reason: "columns" },
    },
    {
      case: "a date of birth column, written out",
      name: "members.tsv",
      text: lines("Name\tDate of Birth\tPlan", "Sara\tx\tGold"),
      expected: { reason: "columns" },
    },
    {
      case: "a mobile number column",
      name: "contacts.csv",
      text: lines("name,Mobile No.,city", "Sara,x,Riyadh"),
      expected: { reason: "columns" },
    },
    {
      case: "an iqama column",
      name: "workers.csv",
      text: lines("Name,Iqama Number,Site", "Omar,x,North"),
      expected: { reason: "columns" },
    },
    {
      case: "an ID number column written with a sign",
      name: "visitors.csv",
      text: lines("Visitor,ID #,Host", "Omar,x,Sara"),
      expected: { reason: "columns" },
    },
    {
      case: "Arabic: a mobile number column",
      name: "جهات.csv",
      text: lines("الاسم,رقم الجوال,المدينة", "سارة,x,الرياض"),
      expected: { reason: "columns" },
    },
    {
      case: "Arabic: a date of birth column",
      name: "المرضى.csv",
      text: lines("الاسم,تاريخ الميلاد,الجناح", "سارة,x,3"),
      expected: { reason: "columns" },
    },
    {
      case: "Arabic: an iqama column and a passport column",
      name: "العمالة.csv",
      text: lines("الاسم,رقم الإقامة,رقم جواز السفر", "عمر,x,y"),
      expected: { reason: "columns" },
    },
    {
      case: "Arabic: an IBAN column",
      name: "الموردون.csv",
      text: lines("المورد,الآيبان,المدينة", "نجد,x,الرياض"),
      expected: { reason: "columns" },
    },
    {
      case: "a header that only contains the letters id",
      name: "orders.csv",
      text: lines("order_id,sku,qty,paid,valid,video_id", "1,A-2,3,yes,yes,9"),
      expected: null,
    },
    {
      case: "an ID column that names no person's document",
      name: "tickets.csv",
      text: lines("id,title,status,employee_id", "1,Printer,open,E-7"),
      expected: null,
    },
    {
      case: "a column about a mobile app, not a person's mobile",
      name: "releases.csv",
      text: lines("mobile_app,version,birthday_theme", "ios,2.1,no"),
      expected: null,
    },
    {
      case: "a note that mentions one phone number",
      name: "notes.md",
      text: lines("# Site visit", "Call the contractor on 0551234567 before Thursday."),
      expected: null,
    },
    {
      case: "a table of amounts and invoice numbers",
      name: "invoices.csv",
      text: lines("Invoice,Amount,Due", "INV-20391,84000,2026-12-01", "INV-20392,1200,2026-12-09"),
      expected: null,
    },
    {
      case: "a long log with a few phone numbers far apart",
      name: "server.log",
      text: lines(
        ...Array.from({ length: 400 }, (_, index) =>
          index % 80 === 0 ? `sms sent to 05512345${String(index).padStart(2, "0")}` : "ok",
        ),
      ),
      expected: null,
    },
    {
      case: "a file whose text the browser cannot read itself",
      name: "payroll.pdf",
      text: lines("Employee,Basic Salary", "Sara,18000"),
      expected: null,
    },
  ])("$case", ({ name, text, expected }) => {
    expect(sealSuggestionFor(name, text)).toEqual(expected);
  });

  it("reads text files and tables only", () => {
    expect(["a.csv", "a.TSV", "a.txt", "a.json"].map(readableForSuggestion)).toEqual([
      true,
      true,
      true,
      true,
    ]);
    expect(["a.pdf", "a.png", "a.xlsx", "a.docx"].map(readableForSuggestion)).toEqual([
      false,
      false,
      false,
      false,
    ]);
  });
});
