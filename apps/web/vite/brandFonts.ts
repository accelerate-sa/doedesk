// @effect-diagnostics nodeBuiltinImport:off -- Vite config runs before any Effect runtime.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import type { Plugin } from "vite-plus";

// Thmanyah Serif's licence lets an app ship the files but not redistribute or change them,
// so they stay out of this repository. An official build points this variable at a folder
// of the original .otf files, which are copied in as they are.
export const BRAND_FONTS_DIR_ENV = "DOEDESK_BRAND_FONTS_DIR";

const PUBLIC_DIRECTORY = "brand-fonts";
const FACE_FILE = /^thmanyah[\s_-]*serif[\s_-]*(display|text)[\s_-]*(regular|medium|bold)\.otf$/i;
const WEIGHTS: Record<string, number> = { regular: 400, medium: 500, bold: 700 };
// The same Arabic range as the bundled naskh, so Latin always stays in Redaction.
const ARABIC_RANGE =
  "U+0600-06FF,U+0750-077F,U+0870-088E,U+0890-0891,U+0897-08E1,U+08E3-08FF,U+FB50-FDFF,U+FE70-FE74,U+FE76-FEFC";

interface BrandFontFace {
  readonly fileName: string;
  readonly family: string;
  readonly weight: number;
}

function readBrandFontFaces(directory: string): ReadonlyArray<BrandFontFace> {
  const faces = NodeFS.readdirSync(directory).flatMap((fileName): Array<BrandFontFace> => {
    const match = FACE_FILE.exec(fileName);
    const cut = match?.[1]?.toLowerCase();
    const weight = WEIGHTS[match?.[2]?.toLowerCase() ?? ""];
    if (cut === undefined || weight === undefined) return [];
    return [{ fileName, family: `Thmanyah Serif ${cut === "text" ? "Text" : "Display"}`, weight }];
  });
  if (faces.length === 0) {
    throw new Error(
      `${BRAND_FONTS_DIR_ENV}=${directory} holds no Thmanyah Serif files (thmanyah-serif-text-regular.otf and the like).`,
    );
  }
  return faces.toSorted((left, right) => left.fileName.localeCompare(right.fileName));
}

// The metric overrides put the baseline where Redaction's is, so mixed lines keep their height.
function brandFontFaceCss(faces: ReadonlyArray<BrandFontFace>): string {
  return faces
    .map(
      (face) =>
        `@font-face{font-family:"${face.family}";font-style:normal;font-weight:${face.weight};font-display:swap;src:url("/${PUBLIC_DIRECTORY}/${encodeURIComponent(face.fileName)}") format("opentype");unicode-range:${ARABIC_RANGE};ascent-override:92.5%;descent-override:32.5%;line-gap-override:0%}`,
    )
    .join("");
}

export function brandFontsPlugin(configuredDirectory: string | undefined): Plugin | undefined {
  const trimmed = configuredDirectory?.trim();
  if (!trimmed) return undefined;
  const directory = NodePath.resolve(trimmed);
  const faces = readBrandFontFaces(directory);
  const css = brandFontFaceCss(faces);
  return {
    name: "doedesk:brand-fonts",
    configureServer(server) {
      server.middlewares.use(`/${PUBLIC_DIRECTORY}`, (request, response, next) => {
        const requested = decodeURIComponent((request.url ?? "").split("?")[0]!.slice(1));
        const face = faces.find((candidate) => candidate.fileName === requested);
        if (face === undefined) return next();
        response.setHeader("Content-Type", "font/otf");
        NodeFS.createReadStream(NodePath.join(directory, face.fileName)).pipe(response);
      });
    },
    generateBundle() {
      for (const face of faces) {
        this.emitFile({
          type: "asset",
          fileName: `${PUBLIC_DIRECTORY}/${face.fileName}`,
          source: NodeFS.readFileSync(NodePath.join(directory, face.fileName)),
        });
      }
    },
    transformIndexHtml: () => [
      { tag: "style", attrs: { "data-brand-fonts": "" }, children: css, injectTo: "head" },
    ],
  };
}
