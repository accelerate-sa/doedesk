import { describe, expect, it } from "vite-plus/test";

import { FileLabels } from "./fileLabels.ts";

const P1 = "[PERSON_AAAAA]";
const P2 = "[PERSON_BBBBB]";
const P3 = "[PERSON_CCCCC]";

const labels = () => {
  const table = new FileLabels();
  table.from(() => [
    { name: "Sara_AlDossari_bank_letter.txt", label: `${P1}_Al${P2}_bank_letter.txt` },
    {
      name: "/work/clients/Khalid_Al_Otaibi/Khalid_Al_Otaibi_warning_letter.txt",
      label: `/work/clients/${P3}/${P3}_warning_letter.txt`,
    },
    { name: "خالد_العتيبي_تقرير.txt", label: `${P3}_تقرير.txt` },
    { name: "Omar_AlShehri_medical_report.txt", label: "DOC_4.txt", neutral: true },
    { name: "notes.txt", label: "DOC_5.txt", neutral: true },
    // Nothing was found in it: the label is the name, and nothing is done.
    { name: "leave-request-0412.txt", label: "leave-request-0412.txt" },
  ]);
  return table;
};

describe("FileLabels", () => {
  it("writes the kept label where a sealed file's name stands, whoever wrote it there", () => {
    const table = labels();
    const sent = (text: string) => table.writeNeutral(table.write(text));
    expect(sent("[File: Sara_AlDossari_bank_letter.txt; ref=file_1] DOC_1")).toBe(
      `[File: ${P1}_Al${P2}_bank_letter.txt; ref=file_1] DOC_1`,
    );
    // Without its type, in another case, and joined to more: a copy an agent named after it.
    expect(sent(" D sara_aldossari_bank_letter.txt\nSara_AlDossari_bank_letter-summary.md")).toBe(
      ` D ${P1}_Al${P2}_bank_letter.txt\n${P1}_Al${P2}_bank_letter-summary.md`,
    );
    // Each folder of a path apart, and a name in another script.
    expect(sent("clients/Khalid_Al_Otaibi/x.pdf and خالد_العتيبي_تقرير.txt")).toBe(
      `clients/${P3}/x.pdf and ${P3}_تقرير.txt`,
    );
    // Inside a longer word it is not the name.
    expect(sent("XKhalid_Al_Otaibi2")).toBe("XKhalid_Al_Otaibi2");
    expect(sent("leave-request-0412.txt")).toBe("leave-request-0412.txt");
  });

  it("writes the handle and the type for a name the person chose not to send, unless another file has it", () => {
    const table = labels();
    expect(table.writeNeutral("[File: Omar_AlShehri_medical_report.txt; ref=file_2]")).toBe(
      "[File: DOC_4.txt; ref=file_2]",
    );
    expect(table.writeNeutral("Read notes.txt, then hr/Notes.txt.")).toBe(
      "Read DOC_5.txt, then hr/DOC_5.txt.",
    );
    // Part of another file's name is not this file.
    expect(table.writeNeutral("my-notes.txt notes.txt.bak release_notes.txt")).toBe(
      "my-notes.txt notes.txt.bak release_notes.txt",
    );
    expect(table.neutralNamesIn("ls: notes.txt README.md")).toEqual(["notes.txt"]);
    expect(table.writeNeutral("ls: notes.txt", new Set(["notes.txt"]))).toBe("ls: notes.txt");
  });

  it("says how a name writes the value of a stand-in, given the label's text around it", () => {
    const table = labels();
    expect(table.spelling(P3, "open ", "_warning_letter.txt")).toBe("Khalid_Al_Otaibi");
    expect(table.spelling(P3, "", "_تقرير.txt")).toBe("خالد_العتيبي");
    expect(table.spelling(P2, `see ${P1}_Al`, "_bank_letter-summary.txt")).toBe("Dossari");
    // In prose the value is written as the vault holds it.
    expect(table.spelling(P3, "Dear ", ", your letter")).toBeUndefined();
    // More of the label may still come; text that is not the label's settles it.
    expect(table.awaits(P3, "", "_warning")).toBe(true);
    expect(table.awaits(P3, "", "_warning_letter")).toBe(false);
    expect(table.awaits(P3, "", " said")).toBe(false);
  });

  it("reads the labels again once they are said to have changed", () => {
    let sealed = true;
    const table = new FileLabels();
    table.from(() => (sealed ? [{ name: "Adel_AlAmri.txt", label: `${P1}.txt` }] : []));
    expect(table.write("Adel_AlAmri.txt")).toBe(`${P1}.txt`);
    // A folder's only stand-in is told from prose by the file type after it.
    expect(table.spelling(P1, "", ".txt")).toBe("Adel_AlAmri");
    sealed = false;
    table.changed();
    expect(table.write("Adel_AlAmri.txt")).toBe("Adel_AlAmri.txt");
  });
});
