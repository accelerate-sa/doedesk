import { Vault } from "@t3tools/privacy-gateway";
import { makeKnownValueMatcher } from "@t3tools/shared/privacyKnownValues";
import { describe, expect, it } from "vite-plus/test";

/**
 * The app marks replaced values with its own matcher, because the text it marks is on screen and
 * the vault is not. These cases hold that matcher to `Vault.findKnown`: where the gateway would
 * replace a value, and nowhere else.
 */
const CASES: ReadonlyArray<{
  readonly name: string;
  readonly known: ReadonlyArray<readonly [kind: "PERSON" | "PHONE" | "ID" | "ORG", value: string]>;
  readonly text: string;
  readonly marked: ReadonlyArray<string>;
}> = [
  {
    name: "a whole word only, and the longer name over the name it starts with",
    known: [
      ["PERSON", "Khalid"],
      ["PERSON", "Khalid Al-Otaibi"],
    ],
    text: "Khalid Al-Otaibi met Khalid. Khalidiyah is a district; so is AlKhalid.",
    marked: ["Khalid Al-Otaibi", "Khalid"],
  },
  {
    name: "only the spelling the vault holds, letter for letter",
    known: [["ORG", "Najd Trading"]],
    text: "Najd Trading, NAJD TRADING and najd trading",
    marked: ["Najd Trading"],
  },
  {
    name: "an Arabic value with a letter word attached in front, the letter left outside",
    known: [
      ["PERSON", "خالد العتيبي"],
      ["PERSON", "علي"],
    ],
    text: "أرسلت العقد لخالد العتيبي وخالد العتيبي وافق. هذا فعلي، وكتبه علي.",
    marked: ["خالد العتيبي", "خالد العتيبي", "علي"],
  },
  {
    name: "Arabic-Indic digits when that spelling is known, and not inside a longer number",
    known: [
      ["PHONE", "٠٥٥١٢٣٤٥٦٧"],
      ["ID", "1098765432"],
    ],
    text: "جواله ٠٥٥١٢٣٤٥٦٧ وهويته 1098765432، لا 10987654321 ولا 0551234567",
    marked: ["٠٥٥١٢٣٤٥٦٧", "1098765432"],
  },
  {
    name: "nothing shorter than three characters, and nothing inside a stand-in",
    known: [
      ["PERSON", "Al"],
      ["ORG", "PERSON"],
    ],
    text: "Al wrote [PERSON_FBJD2] about one PERSON.",
    marked: ["PERSON"],
  },
  {
    name: "a value beside punctuation and across a line break in the text",
    known: [["PERSON", "Sara Al-Harbi"]],
    text: '(Sara Al-Harbi), "Sara Al-Harbi"\nSara\nAl-Harbi',
    marked: ["Sara Al-Harbi", "Sara Al-Harbi"],
  },
];

describe("the app's matcher for replaced values", () => {
  it.each(CASES)("marks $name, exactly where the vault replaces", ({ known, text, marked }) => {
    const vault = new Vault();
    for (const [kind, value] of known) vault.tokenFor(kind, value);
    const matcher = makeKnownValueMatcher(
      vault.entries().map((entry) => ({ token: entry.token, surfaces: entry.surfaces })),
    );
    const found = matcher?.find(text) ?? [];
    expect(found.map((span) => text.slice(span.start, span.end))).toEqual(marked);
    expect(found).toEqual(vault.findKnown(text));
  });

  it("has nothing to look for when no value is long enough to search", () => {
    expect(makeKnownValueMatcher([{ token: "[PERSON_FBJD2]", surfaces: ["Al"] }])).toBeNull();
    expect(makeKnownValueMatcher([])).toBeNull();
  });
});
