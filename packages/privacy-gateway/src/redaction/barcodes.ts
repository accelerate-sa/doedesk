import * as NodeFS from "node:fs";
import * as NodeModule from "node:module";

import { findFixedFormats, isVerificationUrl } from "../fixedFormats.ts";
import type { EntityKind } from "../placeholders.ts";
import { expandQuad, frameOf, type Point } from "./geometry.ts";

/**
 * QR codes and barcodes, read on this computer. A code on a bank letter or a ministry's
 * certificate opens the unmasked original for whoever scans it, and an invoice's code spells out
 * the seller and its VAT number: covering the words around a code and leaving the code is no
 * redaction at all.
 */

/** Pixels as the image tools give them: three bytes a pixel, or four with alpha. */
export interface CodeImage {
  readonly width: number;
  readonly height: number;
  readonly data: Uint8Array;
}

/** The fields of a Saudi e-invoice's QR code (ZATCA), tags 1 to 5. */
export interface ZatcaInvoice {
  readonly sellerName: string;
  readonly vatNumber: string;
  readonly timestamp: string;
  readonly total: string;
  readonly vatTotal: string;
  /** 2 when the code also carries the invoice's hash and signature (tags 6 and up). */
  readonly phase: 1 | 2;
}

export type CodeFinding =
  /** A link that opens the document, or a record of it, as issued. */
  | "verification-link"
  /** A link with a record's number or code in it. */
  | "record-link"
  /** An IBAN, an ID, a phone number, an email address. */
  | "identifier"
  | "tax-invoice"
  | "contact-card";

/** What a code's payload holds, worked out without sending it anywhere. */
export interface CodeInspection {
  /** True when the payload names someone or leads to a record of them. */
  readonly identifying: boolean;
  /** The kind a stand-in for the payload takes. */
  readonly kind: EntityKind;
  readonly findings: ReadonlyArray<CodeFinding>;
  /** One line for a person to read. It describes the payload and never quotes it. */
  readonly summary: string;
  readonly invoice?: ZatcaInvoice | undefined;
}

export interface DetectedCode {
  /** The symbology as the decoder names it: "QRCode", "Code128", "DataMatrix", "PDF417". */
  readonly format: string;
  /** The decoded payload. A real value: kept on this computer like any other. */
  readonly text: string;
  /** The code's corners in the image's pixels, clockwise from the top left, with a margin. */
  readonly polygon: ReadonlyArray<Point>;
  readonly inspection: CodeInspection;
}

/** The decoder could not be loaded. An image is then not sent: its codes cannot be checked. */
export class CodeReaderUnavailableError extends Error {
  override readonly name = "CodeReaderUnavailableError";
}

const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/u;
const ZATCA_TEXT_TAGS = 5;

/**
 * Reads a ZATCA e-invoice code: Base64 of tag, length, value, with tags 1 to 5 in order (seller,
 * VAT number, time, total, VAT total). Phase 2 adds binary tags after them, which are skipped.
 * Anything that is not exactly that is not an invoice code.
 */
export const parseZatcaTlv = (payload: string): ZatcaInvoice | undefined => {
  const compact = payload.trim();
  if (compact.length < 24 || compact.length % 4 !== 0 || !BASE64.test(compact)) return undefined;
  const bytes = Buffer.from(compact, "base64");
  const fields: Array<string> = [];
  let cursor = 0;
  let tags = 0;
  while (cursor + 2 <= bytes.length) {
    const tag = bytes[cursor] as number;
    const length = bytes[cursor + 1] as number;
    const end = cursor + 2 + length;
    if (tag !== tags + 1 || end > bytes.length) return undefined;
    if (tag <= ZATCA_TEXT_TAGS) {
      const value = bytes.subarray(cursor + 2, end).toString("utf8");
      if (value.includes("�")) return undefined;
      fields.push(value);
    }
    tags = tag;
    cursor = end;
  }
  const [sellerName, vatNumber, timestamp, total, vatTotal] = fields;
  if (
    cursor !== bytes.length ||
    sellerName === undefined ||
    vatNumber === undefined ||
    timestamp === undefined ||
    total === undefined ||
    vatTotal === undefined
  ) {
    return undefined;
  }
  if (!/^[0-9]{15}$/u.test(vatNumber) || !/^[0-9]/u.test(total)) return undefined;
  return {
    sellerName,
    vatNumber,
    timestamp,
    total,
    vatTotal,
    phase: tags > ZATCA_TEXT_TAGS ? 2 : 1,
  };
};

/** A link, whatever follows its host: a bank's code carries spaces in its link's parameters. */
const WEB_LINK = /^https?:\/\/[^\s/?#]+/iu;
/** A record's own number or code in a link: a long number, a UUID, a long code, a parameter. */
const RECORD_IN_LINK =
  /[0-9]{6,}|[0-9a-f]{8}-[0-9a-f]{4}-|[A-Za-z0-9_-]*[0-9][A-Za-z0-9_-]{9,}|[?&][^=&#]+=[^&#]{6,}/iu;

const hostOf = (link: string): string =>
  link
    .replace(/^https?:\/\//iu, "")
    .replace(/[/?#].*$/u, "")
    .toLowerCase();

const FORMAT_NAMES: Readonly<Record<string, string>> = {
  QRCode: "QR code",
  MicroQRCode: "QR code",
};

/** Says what a decoded payload holds. `format` is the decoder's name for the symbology. */
export const inspectCodePayload = (text: string, format = "QRCode"): CodeInspection => {
  const name = FORMAT_NAMES[format] ?? "Barcode";
  const payload = text.trim();
  const invoice = parseZatcaTlv(payload);
  if (invoice !== undefined) {
    return {
      identifying: true,
      kind: "OTHER",
      findings: ["tax-invoice"],
      summary: `${name}: tax invoice (seller, VAT number, time, totals)`,
      invoice,
    };
  }
  if (/^(?:BEGIN:VCARD|MECARD:)/iu.test(payload)) {
    return {
      identifying: true,
      kind: "PERSON",
      findings: ["contact-card"],
      summary: `${name}: contact card`,
    };
  }
  if (WEB_LINK.test(payload)) {
    const path = payload.replace(/^https?:\/\/[^/?#]+/iu, "");
    const findings: Array<CodeFinding> = [];
    if (isVerificationUrl(payload)) findings.push("verification-link");
    else if (RECORD_IN_LINK.test(path)) findings.push("record-link");
    if (findFixedFormats(decodeSafely(path)).length > 0) findings.push("identifier");
    const said = findings.includes("verification-link")
      ? "verification link"
      : findings.includes("record-link")
        ? "link to a record"
        : findings.length > 0
          ? "link holding an identifier"
          : "web link";
    return {
      identifying: findings.length > 0,
      kind: "URL",
      findings,
      summary: `${name}: ${said} (${hostOf(payload)})`,
    };
  }
  const formats = findFixedFormats(payload);
  const kinds = [...new Set(formats.map((entity) => entity.kind))];
  if (kinds.length > 0) {
    return {
      identifying: true,
      kind: kinds.length === 1 ? (kinds[0] as EntityKind) : "OTHER",
      findings: ["identifier"],
      summary: `${name}: holds ${kinds.join(", ")}`,
    };
  }
  return {
    identifying: false,
    kind: "OTHER",
    findings: [],
    summary: `${name}: no personal data found`,
  };
};

const decodeSafely = (text: string): string => {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
};

interface DecodedSymbol {
  readonly text: string;
  readonly format: string;
  readonly isValid?: boolean;
  readonly position: {
    readonly topLeft: Point;
    readonly topRight: Point;
    readonly bottomRight: Point;
    readonly bottomLeft: Point;
  };
}

type ReadSymbols = (
  image: { readonly data: Uint8ClampedArray; readonly width: number; readonly height: number },
  options: { readonly tryHarder: boolean; readonly maxNumberOfSymbols: number },
) => Promise<ReadonlyArray<DecodedSymbol>>;

let decoder: Promise<ReadSymbols> | undefined;
/**
 * Loaded on first use, with its WebAssembly read from the package's own file: the decoder's
 * default is to fetch that file, which a Node process cannot do from disk.
 */
const loadDecoder = (): Promise<ReadSymbols> => {
  decoder ??= (async () => {
    try {
      const zxing = await import("zxing-wasm/reader");
      const wasm = NodeFS.readFileSync(
        NodeModule.createRequire(import.meta.url).resolve("zxing-wasm/reader/zxing_reader.wasm"),
      );
      zxing.prepareZXingModule({
        overrides: {
          wasmBinary: wasm.buffer.slice(wasm.byteOffset, wasm.byteOffset + wasm.length),
        },
      });
      return (image, options) =>
        zxing.readBarcodes({ ...image, colorSpace: "srgb" } as ImageData, options);
    } catch (cause) {
      decoder = undefined;
      throw new CodeReaderUnavailableError("The barcode reader could not be loaded.", { cause });
    }
  })();
  return decoder;
};

const rgbaOf = (image: CodeImage): Uint8ClampedArray => {
  const pixels = image.width * image.height;
  if (image.data.length === pixels * 4) {
    return new Uint8ClampedArray(image.data.buffer, image.data.byteOffset, image.data.length);
  }
  if (image.data.length !== pixels * 3) {
    throw new RangeError("A code image holds three or four bytes for every pixel.");
  }
  const rgba = new Uint8ClampedArray(pixels * 4);
  for (let index = 0; index < pixels; index += 1) {
    rgba[index * 4] = image.data[index * 3] as number;
    rgba[index * 4 + 1] = image.data[index * 3 + 1] as number;
    rgba[index * 4 + 2] = image.data[index * 3 + 2] as number;
    rgba[index * 4 + 3] = 255;
  }
  return rgba;
};

/** Symbologies whose bars run on above and below the line the decoder reports. */
const LINEAR = /^(?:Code|EAN|UPC|ITF|Codabar|DataBar|DX)/u;
/** The margin around a code, as a share of its shorter side, and at least this many pixels. */
const MARGIN_SHARE = 0.08;
const MIN_MARGIN = 4;

const darkAt = (rgba: Uint8ClampedArray, width: number, height: number, point: Point): boolean => {
  const x = Math.round(point.x);
  const y = Math.round(point.y);
  if (x < 0 || y < 0 || x >= width || y >= height) return false;
  const index = (y * width + x) * 4;
  return (
    (rgba[index] as number) * 0.299 +
      (rgba[index + 1] as number) * 0.587 +
      (rgba[index + 2] as number) * 0.114 <
    128
  );
};

/**
 * A linear code's full height. The decoder gives the line it read along; the bars are found by
 * walking away from that line for as long as the same bars are met.
 */
const barsAround = (
  rgba: Uint8ClampedArray,
  width: number,
  height: number,
  quad: ReadonlyArray<Point>,
): ReadonlyArray<Point> => {
  const [p0, p1, p2, p3] = quad as [Point, Point, Point, Point];
  const frame = frameOf(quad);
  const samples = Math.max(16, Math.min(256, Math.round(frame.width)));
  const row = (from: Point, to: Point, shift: number): string => {
    let bars = "";
    for (let index = 0; index < samples; index += 1) {
      const share = (index + 0.5) / samples;
      bars += darkAt(rgba, width, height, {
        x: from.x + (to.x - from.x) * share + frame.across.x * shift,
        y: from.y + (to.y - from.y) * share + frame.across.y * shift,
      })
        ? "1"
        : "0";
    }
    return bars;
  };
  const alike = (left: string, right: string): boolean => {
    let same = 0;
    for (let index = 0; index < left.length; index += 1)
      if (left[index] === right[index]) same += 1;
    return same >= 0.85 * left.length;
  };
  const reach = (from: Point, to: Point, direction: 1 | -1): number => {
    const reference = row(from, to, 0);
    const limit = Math.round(frame.width);
    let shift = 0;
    while (shift < limit && alike(reference, row(from, to, direction * (shift + 1)))) shift += 1;
    return shift;
  };
  const up = reach(p0, p1, -1);
  const down = reach(p3, p2, 1);
  const move = (point: Point, shift: number): Point => ({
    x: point.x + frame.across.x * shift,
    y: point.y + frame.across.y * shift,
  });
  return [move(p0, -up), move(p1, -up), move(p2, down), move(p3, down)];
};

/**
 * Every QR code and barcode in an image, decoded, with where it is and what it holds. Nothing
 * leaves this computer. Rejects with `CodeReaderUnavailableError` when the decoder cannot run.
 */
export const detectCodes = async (image: CodeImage): Promise<ReadonlyArray<DetectedCode>> => {
  const read = await loadDecoder();
  const rgba = rgbaOf(image);
  const symbols = await read(
    { data: rgba, width: image.width, height: image.height },
    { tryHarder: true, maxNumberOfSymbols: 32 },
  );
  return symbols
    .filter((symbol) => symbol.isValid !== false)
    .map((symbol): DetectedCode => {
      const { topLeft, topRight, bottomRight, bottomLeft } = symbol.position;
      const corners = [topLeft, topRight, bottomRight, bottomLeft];
      const quad = LINEAR.test(symbol.format)
        ? barsAround(rgba, image.width, image.height, corners)
        : corners;
      const frame = frameOf(quad);
      const margin = Math.max(MIN_MARGIN, MARGIN_SHARE * Math.min(frame.width, frame.height));
      return {
        format: symbol.format,
        text: symbol.text,
        polygon: expandQuad(quad, frame, margin, margin),
        inspection: inspectCodePayload(symbol.text, symbol.format),
      };
    });
};
