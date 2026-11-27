import { describe, expect, it } from "vite-plus/test";

import { detectCodes, inspectCodePayload, parseZatcaTlv } from "./barcodes.ts";
import { codePixels, paintPage, stampOn } from "./testkit.ts";

/** A ZATCA code's payload: tag, length, value for each field, in Base64. Every value is made up. */
const zatca = (fields: ReadonlyArray<string | Buffer>): string =>
  Buffer.concat(
    fields.map((field, index) => {
      const value = typeof field === "string" ? Buffer.from(field, "utf8") : field;
      return Buffer.concat([Buffer.from([index + 1, value.length]), value]);
    }),
  ).toString("base64");

const INVOICE = [
  "شركة الواحة التقنية",
  "310123456700003",
  "2026-03-14T10:30:00Z",
  "115.00",
  "15.00",
];

describe("a ZATCA invoice code", () => {
  it("reads seller, VAT number, time and totals from tags 1 to 5, with or without the phase 2 tags", () => {
    expect(parseZatcaTlv(zatca(INVOICE))).toEqual({
      sellerName: "شركة الواحة التقنية",
      vatNumber: "310123456700003",
      timestamp: "2026-03-14T10:30:00Z",
      total: "115.00",
      vatTotal: "15.00",
      phase: 1,
    });
    const signed = zatca([
      ...INVOICE,
      Buffer.alloc(32, 7),
      Buffer.alloc(64, 9),
      Buffer.alloc(33, 3),
    ]);
    expect(parseZatcaTlv(signed)).toMatchObject({ vatNumber: "310123456700003", phase: 2 });
  });

  it("is nothing else: other Base64, a field cut short, tags out of order", () => {
    expect(
      parseZatcaTlv(Buffer.from("just some words in base64!").toString("base64")),
    ).toBeUndefined();
    expect(parseZatcaTlv(zatca(INVOICE.slice(0, 4)))).toBeUndefined();
    expect(parseZatcaTlv(zatca(INVOICE).slice(0, -8))).toBeUndefined();
    expect(
      parseZatcaTlv(zatca([INVOICE[1] ?? "", INVOICE[0] ?? "", ...INVOICE.slice(2)])),
    ).toBeUndefined();
    expect(parseZatcaTlv("https://example.com/")).toBeUndefined();
  });
});

describe("what a code's payload holds", () => {
  it("tells a link to the document, an invoice and an identifier from a link that names nobody", () => {
    const cases: ReadonlyArray<readonly [string, boolean, string, ReadonlyArray<string>]> = [
      ["https://alah.li/7Xk2PqR", true, "URL", ["verification-link"]],
      [
        "https://qr.saudibusiness.gov.sa/viewcr?nCrNumber=AbCde1FgHiJk==",
        true,
        "URL",
        ["verification-link"],
      ],
      // No word says "verify", and a record's own code is in the address.
      [
        "https://files.example.com/view/3f2a9c1e-7b44-4d0a-9e21-5c8d7a6b1f00",
        true,
        "URL",
        ["record-link"],
      ],
      // Spaces in a parameter, as one bank's letters write them: still a link, and to a record.
      [
        "https://m.bank.example/app/letters/doc-view?data=ab - CDEF 12& G.H",
        true,
        "URL",
        ["record-link"],
      ],
      ["https://www.example.com/", false, "URL", []],
      ["https://www.example.com/about", false, "URL", []],
      [zatca(INVOICE), true, "OTHER", ["tax-invoice"]],
      ["SA4420000001234567891234", true, "IBAN", ["identifier"]],
      ["BEGIN:VCARD\nFN:Sami Alharbi\nEND:VCARD", true, "PERSON", ["contact-card"]],
      ["SHELF-7", false, "OTHER", []],
    ];
    for (const [payload, identifying, kind, findings] of cases) {
      expect(inspectCodePayload(payload), payload).toMatchObject({ identifying, kind, findings });
    }
  });

  it("describes the payload for a person without quoting it", () => {
    const link = inspectCodePayload("https://alah.li/7Xk2PqR");
    expect(link.summary).toBe("QR code: verification link (alah.li)");
    expect(link.summary).not.toContain("7Xk2PqR");
    const invoice = inspectCodePayload(zatca(INVOICE));
    expect(invoice.summary).not.toContain("310123456700003");
    expect(invoice.invoice?.sellerName).toBe("شركة الواحة التقنية");
  });
});

describe("codes in a picture", () => {
  it("decodes every QR code on a page and outlines each with a margin", async () => {
    const page = paintPage(900, 500, []);
    const verify = await codePixels("https://alah.li/7Xk2PqR");
    const plain = await codePixels("https://www.example.com/");
    stampOn(page, verify, 100, 80);
    stampOn(page, plain, 560, 220);
    const codes = await detectCodes(page);
    expect(codes.map((code) => [code.format, code.text, code.inspection.identifying])).toEqual(
      expect.arrayContaining([
        ["QRCode", "https://alah.li/7Xk2PqR", true],
        ["QRCode", "https://www.example.com/", false],
      ]),
    );
    expect(codes).toHaveLength(2);
    const found = codes.find((code) => code.inspection.identifying);
    const xs = (found?.polygon ?? []).map((point) => point.x);
    const ys = (found?.polygon ?? []).map((point) => point.y);
    // The symbol stands inside its quiet zone, four modules of five pixels from the stamp's edge.
    const quiet = 20;
    expect(Math.min(...xs)).toBeLessThan(100 + quiet);
    expect(Math.min(...xs)).toBeGreaterThan(100 - quiet);
    expect(Math.max(...xs)).toBeGreaterThan(100 + verify.width - quiet);
    expect(Math.min(...ys)).toBeLessThan(80 + quiet);
    expect(Math.max(...ys)).toBeGreaterThan(80 + verify.height - quiet);
  });

  it("reads pixels with or without alpha, and outlines a barcode over the full height of its bars", async () => {
    const page = paintPage(700, 300, []);
    const bars = await codePixels("SA4420000001234567891234", "Code128", 2);
    stampOn(page, bars, 60, 90);
    const [code] = await detectCodes(page);
    expect(code).toMatchObject({ format: "Code128", text: "SA4420000001234567891234" });
    expect(code?.inspection).toMatchObject({ identifying: true, kind: "IBAN" });
    const ys = (code?.polygon ?? []).map((point) => point.y);
    expect(Math.max(...ys) - Math.min(...ys)).toBeGreaterThan(0.8 * bars.height);

    const rgba = Buffer.alloc(page.width * page.height * 4, 255);
    for (let pixel = 0; pixel < page.width * page.height; pixel += 1) {
      page.data.copy(rgba, pixel * 4, pixel * 3, pixel * 3 + 3);
    }
    const again = await detectCodes({ width: page.width, height: page.height, data: rgba });
    expect(again.map((found) => found.text)).toEqual(["SA4420000001234567891234"]);
  });
});
