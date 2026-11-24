import type { MFunctionType } from "gt-i18n/types";
import { describe, expect, it } from "vite-plus/test";

import { sealedToolTitle, serverSentence } from "./serverSentencesCopy.ts";

// Stands in for a language: shows which sentences were handed over for translation.
const translated = ((message: unknown) =>
  typeof message === "string" ? "<t>" : message) as MFunctionType;

describe("sentences the server writes in English", () => {
  it("hands over the fixed ones a person meets, with their values, and leaves the rest", () => {
    for (const sentence of [
      "Cancelled because the server shut down before the provider work completed.",
      "DoeDesk restarted and resumed this turn",
      "Codex provider status has not been checked in this session yet.",
      'The worker answered 401: {"error":"invalid api key"}',
    ]) {
      expect(serverSentence(sentence, translated)).toBe("<t>");
      // English reads as the server wrote it.
      expect(serverSentence(sentence)).toBe(sentence);
    }
    const other = "The provider refused the request: quota exceeded.";
    expect(serverSentence(other, translated)).toBe(other);
  });

  it("names the sealed-file tools for a person under any spelling a provider gives", () => {
    for (const label of ["ask_documents", "mcp__t3-code__ask_documents", "Ask documents"]) {
      expect(sealedToolTitle(label)).toBe("Ask about sealed files");
    }
    expect(sealedToolTitle("t3-code.fill_sealed")).toBe("Make a finished file");
    expect(sealedToolTitle("list sealed")).toBe("List sealed files");
    expect(sealedToolTitle("read_file")).toBeUndefined();
    expect(sealedToolTitle(null)).toBeUndefined();
  });
});
