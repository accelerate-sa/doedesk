#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off globalConsole:off - a plain Node script that writes image files.
// Renders every tracked DoeDesk app icon from the mark's geometry.
// The upstream exporter needs Icon Composer 2; this draws the same flat icons with sharp, so the
// icons can be rebuilt on any machine: `node scripts/render-doedesk-icons.ts`.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import sharp from "sharp";

import { BRAND_ASSET_PATHS, DEVELOPMENT_PUBLIC_ICON_OVERRIDES } from "./lib/brand-assets.ts";
import { encodePngIco, WINDOWS_ICON_SIZES } from "./lib/icon-export.ts";

const root = NodePath.resolve(import.meta.dirname, "..");

interface Palette {
  readonly background: string;
  readonly letter: string;
  readonly bar: string;
}

const PALETTES = {
  production: { background: "#171815", letter: "#F5F3EE", bar: "#E2A674" },
  nightly: { background: "#F5F3EE", letter: "#171815", bar: "#96531F" },
  development: { background: "#96531F", letter: "#F5F3EE", bar: "#171815" },
} as const satisfies Record<string, Palette>;

/** The mark on its 24-unit grid: a doe's face spanning x 2.5 to 21.5 and y 3 to 21.6, with a bar cut out. */
const mark = (palette: Palette, canvas: number, heightShare: number): string => {
  const scale = (canvas * heightShare) / 18.6;
  const x = (canvas - 19 * scale) / 2 - 2.5 * scale;
  const y = (canvas - 18.6 * scale) / 2 - 3 * scale;
  return `<g transform="translate(${x} ${y}) scale(${scale})">
    <path fill="${palette.letter}" fill-rule="evenodd" d="M2.5 3C7 3 10 5.5 10.5 9.05c.5-.1 1-.15 1.5-.15s1 .05 1.5.15C14 5.5 17 3 21.5 3c.3 4.1-1.3 7.2-4.3 8.6.3.6.5 1.3.5 2 0 3.1-2.3 6-4.8 7.7a1.6 1.6 0 0 1-1.8 0c-2.5-1.7-4.8-4.6-4.8-7.7 0-.7.2-1.4.5-2C3.8 10.2 2.2 7.1 2.5 3zM7.3 12v2.6h9.4V12z"/>
    <rect x="7.3" y="12" width="9.4" height="2.6" fill="${palette.bar}"/>
  </g>`;
};

const svg = (size: number, body: string): Buffer =>
  Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">${body}</svg>`,
  );

/** Fills the canvas edge to edge; iOS and Android mask it themselves. */
const fullBleed = (palette: Palette): Buffer =>
  svg(
    1024,
    `<rect width="1024" height="1024" fill="${palette.background}"/>${mark(palette, 1024, 0.5)}`,
  );

/** A rounded tile for places that draw the image as given: favicons, Linux, Windows. */
const tile = (palette: Palette): Buffer =>
  svg(
    1024,
    `<rect width="1024" height="1024" rx="230" fill="${palette.background}"/>${mark(palette, 1024, 0.5)}`,
  );

/** The classic macOS shape: an 824-pixel body inset 100 pixels, with a soft shadow below it. */
const macos = (palette: Palette): Buffer =>
  svg(
    1024,
    `<defs><filter id="shadow" x="-20%" y="-20%" width="140%" height="140%">
      <feDropShadow dx="0" dy="10" stdDeviation="12" flood-color="#000" flood-opacity="0.28"/>
    </filter></defs>
    <rect x="100" y="100" width="824" height="824" rx="185" fill="${palette.background}" filter="url(#shadow)"/>
    ${mark(palette, 1024, 0.46)}`,
  );

const write = async (relativePath: string, contents: Buffer): Promise<void> => {
  const target = NodePath.join(root, relativePath);
  NodeFS.mkdirSync(NodePath.dirname(target), { recursive: true });
  NodeFS.writeFileSync(target, contents);
};

const png = (source: Buffer, size: number): Promise<Buffer> =>
  sharp(source).resize(size, size).png({ compressionLevel: 9 }).toBuffer();

const ico = async (source: Buffer, sizes: ReadonlyArray<number>): Promise<Buffer> =>
  encodePngIco(
    await Promise.all(sizes.map(async (size) => ({ size, contents: await png(source, size) }))),
  );

interface Outputs {
  readonly ios?: string;
  readonly macos: string;
  readonly universal?: string;
  readonly windowsIco: string;
  readonly faviconIco: string;
  readonly favicon16: string;
  readonly favicon32: string;
  readonly appleTouch: string;
  readonly icon192: string;
  readonly icon512: string;
}

const render = async (palette: Palette, outputs: Outputs): Promise<void> => {
  const rounded = tile(palette);
  const square = fullBleed(palette);
  if (outputs.ios !== undefined) await write(outputs.ios, await png(square, 1024));
  if (outputs.universal !== undefined) await write(outputs.universal, await png(rounded, 1024));
  await write(outputs.macos, await png(macos(palette), 1024));
  await write(outputs.windowsIco, await ico(rounded, WINDOWS_ICON_SIZES));
  await write(outputs.faviconIco, await ico(rounded, [16, 32, 48]));
  await write(outputs.favicon16, await png(rounded, 16));
  await write(outputs.favicon32, await png(rounded, 32));
  await write(outputs.appleTouch, await png(square, 180));
  await write(outputs.icon192, await png(square, 192));
  await write(outputs.icon512, await png(square, 512));
};

await render(PALETTES.production, {
  ios: BRAND_ASSET_PATHS.productionIosIconPng,
  macos: BRAND_ASSET_PATHS.productionMacIconPng,
  universal: BRAND_ASSET_PATHS.productionLinuxIconPng,
  windowsIco: BRAND_ASSET_PATHS.productionWindowsIconIco,
  faviconIco: BRAND_ASSET_PATHS.productionWebFaviconIco,
  favicon16: BRAND_ASSET_PATHS.productionWebFavicon16Png,
  favicon32: BRAND_ASSET_PATHS.productionWebFavicon32Png,
  appleTouch: BRAND_ASSET_PATHS.productionWebAppleTouchIconPng,
  icon192: BRAND_ASSET_PATHS.productionWebIcon192Png,
  icon512: BRAND_ASSET_PATHS.productionWebIcon512Png,
});
await render(PALETTES.nightly, {
  ios: BRAND_ASSET_PATHS.nightlyIosIconPng,
  macos: BRAND_ASSET_PATHS.nightlyMacIconPng,
  universal: BRAND_ASSET_PATHS.nightlyLinuxIconPng,
  windowsIco: BRAND_ASSET_PATHS.nightlyWindowsIconIco,
  faviconIco: BRAND_ASSET_PATHS.nightlyWebFaviconIco,
  favicon16: BRAND_ASSET_PATHS.nightlyWebFavicon16Png,
  favicon32: BRAND_ASSET_PATHS.nightlyWebFavicon32Png,
  appleTouch: BRAND_ASSET_PATHS.nightlyWebAppleTouchIconPng,
  icon192: BRAND_ASSET_PATHS.nightlyWebIcon192Png,
  icon512: BRAND_ASSET_PATHS.nightlyWebIcon512Png,
});
await render(PALETTES.development, {
  ios: BRAND_ASSET_PATHS.developmentIosIconPng,
  macos: BRAND_ASSET_PATHS.developmentDesktopIconPng,
  universal: BRAND_ASSET_PATHS.developmentUniversalIconPng,
  windowsIco: BRAND_ASSET_PATHS.developmentWindowsIconIco,
  faviconIco: BRAND_ASSET_PATHS.developmentWebFaviconIco,
  favicon16: BRAND_ASSET_PATHS.developmentWebFavicon16Png,
  favicon32: BRAND_ASSET_PATHS.developmentWebFavicon32Png,
  appleTouch: BRAND_ASSET_PATHS.developmentWebAppleTouchIconPng,
  icon192: BRAND_ASSET_PATHS.developmentWebIcon192Png,
  icon512: BRAND_ASSET_PATHS.developmentWebIcon512Png,
});

// The web app's public folder carries the development set; release builds swap in their own.
for (const override of DEVELOPMENT_PUBLIC_ICON_OVERRIDES) {
  NodeFS.copyFileSync(
    NodePath.join(root, override.sourceRelativePath),
    NodePath.join(root, override.targetRelativePath),
  );
}

// Android draws its own shape around the icon, so the art is the bare letter on a clear canvas.
// The bar is a hole: the launcher's background colour shows through it.
const letter = (canvas: number, heightShare: number, fill: string): Buffer => {
  const scale = (canvas * heightShare) / 18.6;
  const x = (canvas - 19 * scale) / 2 - 2.5 * scale;
  const y = (canvas - 18.6 * scale) / 2 - 3 * scale;
  return svg(
    canvas,
    `<g transform="translate(${x} ${y}) scale(${scale})"><path fill="${fill}" fill-rule="evenodd" d="M2.5 3C7 3 10 5.5 10.5 9.05c.5-.1 1-.15 1.5-.15s1 .05 1.5.15C14 5.5 17 3 21.5 3c.3 4.1-1.3 7.2-4.3 8.6.3.6.5 1.3.5 2 0 3.1-2.3 6-4.8 7.7a1.6 1.6 0 0 1-1.8 0c-2.5-1.7-4.8-4.6-4.8-7.7 0-.7.2-1.4.5-2C3.8 10.2 2.2 7.1 2.5 3zM7.3 12v2.6h9.4V12z"/></g>`,
  );
};
// The splash screen has no icon background, so its mark carries its own tile.
const splash = (palette: Palette): Buffer =>
  svg(
    1152,
    `<rect x="336" y="336" width="480" height="480" rx="108" fill="${palette.background}"/>${mark(palette, 1152, 0.21)}`,
  );
const mobile = "apps/mobile/assets";
await write(`${mobile}/android-icon-foreground.png`, await png(letter(432, 0.34, "#F5F3EE"), 432));
await write(`${mobile}/android-icon-mark.png`, await png(letter(432, 0.34, "#FFFFFF"), 432));
await write(`${mobile}/android-notification-icon.png`, await png(letter(96, 0.72, "#FFFFFF"), 96));
await write(`${mobile}/android-splash-icon-prod.png`, await png(splash(PALETTES.production), 1152));
await write(`${mobile}/android-splash-icon-nightly.png`, await png(splash(PALETTES.nightly), 1152));
await write(`${mobile}/android-splash-icon-dev.png`, await png(splash(PALETTES.development), 1152));

NodeFS.writeFileSync(
  NodePath.join(root, "assets/prod/logo.svg"),
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">
  <path fill="#171815" fill-rule="evenodd" d="M2.5 3C7 3 10 5.5 10.5 9.05c.5-.1 1-.15 1.5-.15s1 .05 1.5.15C14 5.5 17 3 21.5 3c.3 4.1-1.3 7.2-4.3 8.6.3.6.5 1.3.5 2 0 3.1-2.3 6-4.8 7.7a1.6 1.6 0 0 1-1.8 0c-2.5-1.7-4.8-4.6-4.8-7.7 0-.7.2-1.4.5-2C3.8 10.2 2.2 7.1 2.5 3zM7.3 12v2.6h9.4V12z"/>
  <rect x="7.3" y="12" width="9.4" height="2.6" fill="#96531F"/>
</svg>
`,
);
console.log("icons rendered");
