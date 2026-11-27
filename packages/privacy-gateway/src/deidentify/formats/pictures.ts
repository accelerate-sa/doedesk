import type { EntityKind } from "../../placeholders.ts";
import { type DeidentificationMode, REDACTED_LABEL } from "../../pseudonymizer.ts";
import { type DetectedCode, detectCodes } from "../../redaction/barcodes.ts";
import type { Point } from "../../redaction/geometry.ts";
import { decodeImage, padRaster, type Raster } from "../../redaction/raster.ts";
import {
  DEFAULT_REDACTION_POLICY,
  type ImageRedactor,
  makeImageRedactor,
  paintRegions,
  type RedactionPolicy,
  UNREADABLE_LABEL,
} from "../../redaction/redactImage.ts";
import { autoItemId, type LayerItem, type NormalizedPoint } from "../layer.ts";
import { type DeidentifyContext, labelOfKind } from "./shared.ts";

/**
 * What the picture formats share: a picture on its own, a page of a PDF and a picture inside a
 * document are all read, searched and painted the same way.
 */

/** One thing found in a picture, before it is given a place in a file. */
export interface PictureFinding {
  readonly polygon: ReadonlyArray<NormalizedPoint>;
  readonly kind: EntityKind;
  readonly label: string;
  readonly preview?: string | undefined;
  readonly origin: NonNullable<LayerItem["origin"]>;
  /** False for a code that was decoded and holds nothing personal: found, and left open. */
  readonly hide: boolean;
}

export interface PictureAnalysis {
  readonly findings: ReadonlyArray<PictureFinding>;
  readonly warnings: ReadonlyArray<string>;
}

/**
 * A copy for a person to review is as large as the file it came from, and the reader is asked
 * once: what the person sees on the page is the check a second reading would have been.
 */
const EXPORT_POLICY: Partial<RedactionPolicy> = {
  maxOutputEdge: 1_000_000,
  maxOutputPixels: 1_000_000_000,
  verify: false,
};

const WHOLE: ReadonlyArray<NormalizedPoint> = [
  { x: 0, y: 0 },
  { x: 1, y: 0 },
  { x: 1, y: 1 },
  { x: 0, y: 1 },
];

const share = (value: number, of: number): number =>
  Math.min(1, Math.max(0, value / Math.max(1, of)));

const normalized = (
  polygon: ReadonlyArray<Point>,
  width: number,
  height: number,
): ReadonlyArray<NormalizedPoint> =>
  polygon.map((point) => ({ x: share(point.x, width), y: share(point.y, height) }));

const policyOf = (context: DeidentifyContext): RedactionPolicy => ({
  ...DEFAULT_REDACTION_POLICY,
  ...EXPORT_POLICY,
  ...context.policy,
});

/** The picture as it is painted on: a very small one sits on the canvas the reader was shown. */
export const paintable = async (bytes: Buffer, context: DeidentifyContext): Promise<Raster> => {
  const policy = policyOf(context);
  return padRaster((await decodeImage(bytes)).raster, policy.minReadEdge, policy.minReadEdge);
};

const codeFinding = (
  code: DetectedCode,
  width: number,
  height: number,
  policy: RedactionPolicy,
): PictureFinding => ({
  polygon: normalized(code.polygon, width, height),
  kind: code.inspection.kind,
  label: code.inspection.summary,
  preview: code.text,
  origin: "code",
  hide: policy.codes === "all" || code.inspection.identifying,
});

const redactors = new WeakMap<DeidentifyContext, ImageRedactor>();

const redactorOf = (context: DeidentifyContext): ImageRedactor | undefined => {
  if (context.reader === undefined) return undefined;
  let redactor = redactors.get(context);
  if (redactor === undefined) {
    redactor = makeImageRedactor({
      reader: context.reader,
      pseudonymizer: context.pseudonymizer,
      policy: policyOf(context),
    });
    redactors.set(context, redactor);
  }
  return redactor;
};

/**
 * Everything in one picture: the values in its writing, what could not be read, and its QR
 * codes and barcodes. Nothing is painted and no stand-in is made. A picture that could not be
 * read at all is given back hidden whole: a person may open it, the engine does not.
 */
export const analysePicture = async (
  bytes: Buffer,
  context: DeidentifyContext,
): Promise<PictureAnalysis> => {
  const policy = policyOf(context);
  const result = await redactorOf(context)?.redact(bytes, context.neverMask ?? [], "redact");
  if (result?.kind === "redacted") {
    return {
      findings: result.regions.map((region): PictureFinding => ({
        polygon: normalized(region.polygon, result.width, result.height),
        kind: region.kind,
        label:
          region.code?.inspection.summary ??
          (region.source === "value"
            ? labelOfKind(region.kind)
            : region.source === "ink"
              ? "Marks that could not be read"
              : "Writing that could not be read"),
        preview: region.surface,
        origin: region.source,
        hide: region.covered,
      })),
      warnings: [],
    };
  }
  // Not read: its codes are still decoded here, and the rest is hidden until a person looks.
  const warnings = [result === undefined ? "no-reader" : `unread-picture: ${result.reason}`];
  const findings: Array<PictureFinding> = [
    {
      polygon: WHOLE,
      kind: "OTHER",
      label: "Picture that was not read",
      origin: "unreadable",
      hide: true,
    },
  ];
  if (policy.codes !== "off") {
    try {
      const raster = await paintable(bytes, context);
      for (const code of await detectCodes(raster)) {
        findings.push(codeFinding(code, raster.width, raster.height, policy));
      }
    } catch (cause) {
      warnings.push(`codes-unchecked: ${cause instanceof Error ? cause.message : "unknown"}`);
    }
  }
  return { findings, warnings };
};

/** The automatic layer item for a finding, at the place `targetOf` gives its outline. */
export const pictureItem = (
  finding: PictureFinding,
  target: LayerItem["target"],
  mode: DeidentificationMode,
): LayerItem => ({
  id: autoItemId(target, finding.kind, finding.preview ?? finding.origin),
  source: "auto",
  action: finding.hide ? mode : "keep",
  kind: finding.kind,
  label: finding.label,
  ...(finding.preview === undefined ? {} : { preview: finding.preview }),
  origin: finding.origin,
  target,
});

/**
 * What a box over an item says. A masked value shows its stand-in, made here. A box over
 * something with no value to keep (writing that was not read, a box a person drew) cannot be
 * undone whatever its action says, and says so.
 */
const boxLabel = (item: LayerItem, context: DeidentifyContext): string => {
  if (item.action === "redact") return REDACTED_LABEL;
  if (item.preview !== undefined && item.preview.trim() !== "") {
    return context.pseudonymizer.vault.tokenFor(item.kind, item.preview);
  }
  return item.source === "auto" ? UNREADABLE_LABEL : REDACTED_LABEL;
};

/** Paints the boxes of every item that is not kept, and records what each one says. */
export const paintItems = (
  raster: Raster,
  items: ReadonlyArray<LayerItem & { readonly polygon: ReadonlyArray<NormalizedPoint> }>,
  context: DeidentifyContext,
  replacements: Map<string, string>,
): Raster => {
  const boxes = items
    .filter((item) => item.action !== "keep")
    .map((item) => {
      const label = boxLabel(item, context);
      replacements.set(item.id, label);
      return { polygon: item.polygon, label };
    });
  return boxes.length === 0 ? raster : paintRegions(raster, boxes, policyOf(context)).raster;
};
