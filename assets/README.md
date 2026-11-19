# Brand icons

The DoeDesk mark is a D with a name struck out of it: ink `#171815`, paper `#F5F3EE`, and one fawn
accent (`#96531F` on light, `#E2A674` on dark). `prod/logo.svg` is the mark on its 24-unit grid.

Run `vp run icons:render` from the repository root to redraw every tracked
icon: iOS, macOS, Linux, Windows and web, for the production, nightly and development builds. It
also copies the development web icons to `apps/web/public`. It needs nothing but the repository's
own dependencies.

| Build       | Tile  | Letter | Bar  |
| ----------- | ----- | ------ | ---- |
| Production  | ink   | paper  | fawn |
| Nightly     | paper | ink    | fawn |
| Development | fawn  | paper  | ink  |

The three Icon Composer projects (`*/app-icon.icon`) hold the same mark for anyone who wants the
layered Apple format. The upstream exporter for them (`vp run icons:export`) needs Icon Composer 2
and is not part of the DoeDesk icon build.

Do not edit the generated PNG or ICO files directly.

## Android launcher and splash artwork

Android masks the central 72dp of a 108dp adaptive canvas, and the Android 12+ splash screen masks
the central two thirds of a 288dp canvas, so the Icon Composer exports cannot be used directly:
their rounded-square silhouette gets framed again and the wordmark is cropped. The Android artwork
is instead rendered from the same Icon Composer SVG sources by `vp run icons:export:android`:

- `apps/mobile/assets/android-icon-foreground.png`: the shared transparent wordmark, sized to stay
  inside the safe zone
- `apps/mobile/assets/android-icon-background-dev.png` and `-nightly.png`: full-bleed variant
  artwork (blueprint grid and annotations; night sky and clouds). Production uses a solid color.
- `apps/mobile/assets/android-splash-icon-*.png`: the two layers composed into one 288dp image, so
  the splash mask reproduces the launcher icon's framing.

Rerun the export after changing a layer SVG. `android-icon-mark.png` remains a flat silhouette for
Android's monochrome themed icon.
