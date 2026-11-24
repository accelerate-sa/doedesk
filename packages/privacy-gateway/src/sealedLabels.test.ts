import { describe, expect, it } from "vite-plus/test";

import { combineDetectors, type Detector, patternDetector } from "./detect.ts";
import { recordNumbersIn } from "./knownParts.ts";
import { Pseudonymizer } from "./pseudonymizer.ts";
import { maskedLabels, neutralLabel, openName } from "./sealedLabels.ts";
import { Vault } from "./vault.ts";
import { sealedIdentifierToken } from "./worker/seal.ts";

/**
 * Finds names as a name detector does: as words. A name joined to its neighbours by an
 * underscore, a hyphen, a dot or a capital letter is one word to it, and is not found.
 */
const wordNames = (names: ReadonlyArray<string>): Detector => ({
  detect: (texts) =>
    Promise.resolve(
      texts.map((text) =>
        names.flatMap((name) =>
          [
            ...text.matchAll(new RegExp(`(?<![\\p{L}\\p{N}_])${name}(?![\\p{L}\\p{N}_])`, "gu")),
          ].map((match) => ({
            start: match.index,
            end: match.index + name.length,
            kind: "PERSON" as const,
          })),
        ),
      ),
    ),
});

const NAMES = ["khalid alotaibi", "Khalid Al Otaibi", "Adel Al Amri", "خالد العتيبي"];

const setup = (detector: Detector = wordNames(NAMES)) =>
  new Pseudonymizer(new Vault(), combineDetectors([patternDetector, detector]));

describe("what a provider is told a sealed file is called", () => {
  it("opens a name's joined words, and says where each character came from", () => {
    expect(openName("KhalidAlOtaibi-diabetes_2026").text).toBe("Khalid Al Otaibi diabetes 2026");
    expect(openName("خالد_العتيبي.تقرير").text).toBe("خالد العتيبي تقرير");
    expect(openName("PDFReportخالد2").text).toBe("PDF Report خالد 2");
    const { text, at } = openName("AlAmri_x");
    expect([...text].map((_, index) => at[index])).toEqual([0, 1, -1, 2, 3, 4, 5, 6, 7]);
  });

  it("masks a person's name however the file name joins it, in Latin and Arabic script", async () => {
    const pseudonymizer = setup();
    const labels = await maskedLabels(pseudonymizer, [
      "khalid_alotaibi_chart.txt",
      "KhalidAlOtaibi-diabetes.pdf",
      "Adel_AlAmri_1293040015_PulmonaryEmbolism.txt",
      "خالد_العتيبي_تقرير.txt",
      "تقرير-خالد.العتيبي.docx",
      "minutes.2026.final.md",
    ]);
    expect(labels[0]).toMatch(/^\[PERSON_\w{5}\]_chart\.txt$/);
    expect(labels[1]).toMatch(/^\[PERSON_\w{5}\]-diabetes\.pdf$/);
    // The ID was masked before; the name beside it was not.
    expect(labels[2]).toMatch(/^\[PERSON_\w{5}\]_\[ID_\w{5}\]_PulmonaryEmbolism\.txt$/);
    expect(labels[3]).toMatch(/^\[PERSON_\w{5}\]_تقرير\.txt$/);
    expect(labels[4]).toMatch(/^تقرير-\[PERSON_\w{5}\]\.docx$/);
    // One person, one stand-in, wherever the name stands: the label stays usable.
    expect(/\[PERSON_\w{5}\]/.exec(labels[3] ?? "")?.[0]).toBe(
      /\[PERSON_\w{5}\]/.exec(labels[4] ?? "")?.[0],
    );
    // A name with nothing to find is sent as it is.
    expect(labels[5]).toBe("minutes.2026.final.md");
    expect(labels.join(" ")).not.toMatch(/khalid|alotaibi|adel|amri|خالد|العتيبي|1293040015/i);
    // The stand-in is the one the same name gets in a message, so the two can be told the same.
    const { texts } = await pseudonymizer.mask([
      { text: "Open the chart of Khalid Al Otaibi.", mode: "typed" },
    ]);
    expect(texts[0]).toContain(/\[PERSON_\w{5}\]/.exec(labels[1] ?? "")?.[0] ?? "none");
    // The joined spelling is known from now on: a listing that prints the name is masked too.
    const listing = await pseudonymizer.mask([
      { text: "deleted: Adel_AlAmri_1293040015_PulmonaryEmbolism.txt", mode: "detect" },
    ]);
    expect(listing.texts[0]).not.toMatch(/adel|amri|1293040015/i);
    // Checked again, a name gets the label it had: what the person was shown is what is sent.
    expect(
      await maskedLabels(pseudonymizer, [
        "khalid_alotaibi_chart.txt",
        "Adel_AlAmri_1293040015_PulmonaryEmbolism.txt",
      ]),
    ).toEqual([labels[0], labels[2]]);
  });

  it("masks the part of a record number that the file's own text holds, under the stand-in the worker gives it", async () => {
    const pseudonymizer = setup();
    const { vault } = pseudonymizer;
    const names = ["amendment_mnt_8042.txt", "credit_note_701.txt", "agreement_03.txt"];
    const labels = await maskedLabels(pseudonymizer, names, [
      recordNumbersIn("Amendment to Agreement No. MNT-2025-8042, dated 15 July 2025."),
      recordNumbersIn("Credit note CN-26-101 against invoice INV-26-701 (ISO-9001, 2026-02-10)."),
      recordNumbersIn("Agreement No. MNT-2025-8042"),
    ]);
    const agreement = sealedIdentifierToken(vault, "MNT-2025-8042");
    expect(labels).toEqual([
      `amendment_${agreement}.txt`,
      `credit_note_${sealedIdentifierToken(vault, "INV-26-701")}.txt`,
      "agreement_03.txt",
    ]);
    // The value stays a sealed one: no tool's result is searched for it.
    expect(vault.maskKnown("MNT-2025-8042")).toBe("MNT-2025-8042");
    // A name is no secret from a tool, which finds the file by it: the label is turned back
    // there too. The value itself is not.
    vault.fileLabels.from(() => names.map((name, index) => ({ name, label: labels[index] ?? "" })));
    expect(vault.unmask(`cat ${labels[0]} # ${agreement}`)).toBe(
      `cat amendment_mnt_8042.txt # ${agreement}`,
    );
    expect(vault.unmask(`${labels[1]} amends ${agreement}`, false, true)).toBe(
      "credit_note_701.txt amends MNT-2025-8042",
    );
  });

  it("masks each folder of a path, and keeps the path's shape", async () => {
    const [label] = await maskedLabels(setup(), ["/cases/Adel_AlAmri/2026/KhalidAlOtaibi.txt"]);
    expect(label).toMatch(/^\/cases\/\[PERSON_\w{5}\]\/2026\/\[PERSON_\w{5}\]\.txt$/);
  });

  it("gives no label when the name cannot be checked", async () => {
    const down: Detector = { detect: () => Promise.reject(new Error("The service is down.")) };
    await expect(maskedLabels(setup(down), ["khalid_alotaibi_chart.txt"])).rejects.toThrow();
  });

  it("names a file by its handle and type alone", () => {
    expect(neutralLabel("DOC_7", "Adel_AlAmri_PulmonaryEmbolism.TXT")).toBe("DOC_7.txt");
    expect(neutralLabel("DOC_8", "notes")).toBe("DOC_8");
    // What follows a dot is a type only when it looks like one.
    expect(neutralLabel("DOC_9", "report.Khalid Al Otaibi")).toBe("DOC_9");
  });
});
