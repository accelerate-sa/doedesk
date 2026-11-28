<p align="center">
  <img src="./assets/prod/logo.svg" width="72" height="72" alt="">
</p>

<h1 align="center">DoeDesk</h1>

<p align="center">Use Claude, Codex, and Gemini on confidential files — without handing over client identities.</p>

<p align="center">
  <a href="https://doedesk.com/download">Download</a> ·
  <a href="https://doedesk.com">Website</a> ·
  <a href="./docs/user/privacy.md">How protection works</a> ·
  <a href="./COMMERCIAL-LICENSE.md">Commercial licence</a>
</p>

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="./.github/readme/welcome-dark.png">
    <img src="./.github/readme/welcome-light.png" width="720" alt="DoeDesk desktop app for confidential AI workflows.">
  </picture>
</p>

DoeDesk sits between your confidential files and your AI provider. Before a prompt, PDF, scan, or Office document leaves your computer, DoeDesk detects sensitive identifiers locally and through your chosen provider, lets you review every item in **De-identification Studio**, and sends only protected output to your AI — restoring real values locally when the reply comes back.

## Three ways to protect sensitive files

| Mode                      | How it works                                                                                                                                                                                       | Best for                                                                                                      |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| **Mask (Reversible)**     | Replaces names, IDs, IBANs, phone numbers, and references with random stand-ins (`[PERSON_FBJD2]`) mapped in a local vault on your device, then restores real values in replies and written files. | Drafting contracts, analyzing client matters, summarizing financial & HR files with Claude, Codex, or Gemini. |
| **Redact (Irreversible)** | Permanently strips detected identifiers with **zero vault writes** so nothing can be re-identified later.                                                                                          | Preparing sanitized copies for external sharing, audits, or non-reversible workflows.                         |
| **Seal (Private Worker)** | Keeps ultra-sensitive documents off general AI providers altogether — processed exclusively by a sovereign regional worker or your organization's dedicated pool.                                  | Restricted legal, financial, or regulated records that cannot touch third-party AI APIs.                      |

## What DoeDesk does today (`v2026.11.3`)

- **De-identification Studio & Pre-send Review:** Inspect every detected identifier side by side before anything reaches AI. Toggle individual items, edit overrides, preview the exact payload leaving your machine, and enforce mandatory review before send (`Require review before AI`) across workspaces.
- **Full document coverage:** Native handlers for `.txt`/`.md`, `.pdf` (rendered page-by-page), scanned images, `.docx`, `.xlsx`/`.csv`, and `.pptx` — plus **local QR and barcode detection** (including Saudi ZATCA e-invoice TLV payloads).
- **Arabic, English & Saudi-native detection:** Built from the ground up for bilingual workspaces — detects Arabic and English names, Saudi national/resident IDs, 70-series Unified Numbers, IBANs, bank account numbers, serials, shortlinks, and Arabic-Indic digits.
- **Fail-closed & local vault:** The mapping vault never leaves your computer. If a file or request cannot be inspected, DoeDesk blocks the send rather than leaking raw data.
- **Decoupled enterprise providers (zero lock-in):** Independently choose **OCR (8 providers)**, **Entity Detection (8 providers)**, and **Sealed Worker (3 providers)** in Settings — use DoeDesk Cloud, your own Azure / AWS / Google Cloud endpoints, or a fully self-hosted stack without signing out.
- **Your own AI subscription:** Works directly with your existing Claude, ChatGPT/Codex, Gemini, OpenCode, or Pi logins — no token reselling or API markup.
- **Verifiable cloud infrastructure:** DoeDesk Cloud processes text and scans in stateless encrypted memory (AMD SEV-SNP confidential VM in Jeddah, Saudi Arabia), stores zero document content, publishes its server code at [accelerate-sa/doedesk-server](https://github.com/accelerate-sa/doedesk-server), and signs every production release into a public Sigstore transparency log (`https://api.doedesk.com/v1/release`).

## Install

Download DoeDesk from [doedesk.com/download](https://doedesk.com/download) or the [latest release](https://github.com/accelerate-sa/doedesk/releases/latest):

- **macOS (Apple Silicon):** Open `DoeDesk-arm64.dmg` (signed and Apple notarized) and drag DoeDesk to Applications.
- **Windows (x64):** Run `DoeDesk-x64.exe`. The Windows installer is not code-signed yet, so SmartScreen warns on first launch: choose **More info**, then **Run anyway**.
- **Linux (x64 or arm64):** Make `DoeDesk-x86_64.AppImage` or `DoeDesk-arm64.AppImage` executable and run it, or install `DoeDesk-amd64.deb` / `DoeDesk-arm64.deb` with `apt`.

macOS, Windows, and Linux AppImage builds update automatically. Sign in with a Saudi phone number, by email anywhere, or connect your own detection and OCR providers directly under **Settings → Privacy**.

## Bring your own detection & OCR

DoeDesk supports decoupled enterprise providers out of the box (Azure, AWS, Google Cloud, Presidio, Ollama, custom OpenAI-compatible workers, and self-hosted HTTP services). Any custom HTTP service answering these two endpoints works immediately:

```http
POST /v1/detect   { "texts": ["..."] }  ->  { "results": [{ "entities": [{ "start", "end", "kind" }] }] }
POST /v1/ocr      <image or PDF bytes>  ->  { "text": "..." }
```

Configure providers independently in **Settings → Privacy**. See [docs/user/privacy.md](./docs/user/privacy.md) for architecture details and known boundaries.

## Enterprise & teams

For law firms, financial institutions, healthcare, and regulated organizations, DoeDesk offers:

- **14-day Free Evaluation Pass** (up to 10 seats, with hosted regional worker access)
- **Organization controls:** Pooled monthly allowances, domain onboarding, region locking (`sa` / `eu` / `global`), and dedicated isolated worker pools
- **Customer-hosted & commercial licensing:** Deploy inside your own VPC or on-premise environment under a commercial licence ([COMMERCIAL-LICENSE.md](./COMMERCIAL-LICENSE.md))

Write to [hello@doedesk.com](mailto:hello@doedesk.com) to request an evaluation pass or our Security & PDPL Trust Pack.

## Build from source

```sh
curl -fsSL https://vite.plus | bash   # installs the `vp` command
vp i
vp run dev
```

`packages/privacy-gateway` holds the de-identification engine, local detectors, QR/ZATCA scanner, PDF/Office handlers, and decoupled provider adapters as a standalone Node package with no dependency on the desktop shell.

## Contact

This repository does not take public issues or pull requests. Write to [hello@doedesk.com](mailto:hello@doedesk.com).

## Credit

DoeDesk is built on [T3 Code](https://github.com/pingdotgg/t3code) by T3 Tools Inc. The agent runtime, core interface, and foundation are theirs; DoeDesk adds the privacy gateway, De-identification Studio, decoupled enterprise provider layer, and Saudi/bilingual confidentiality workflows.

## Licence

DoeDesk is free software under the [GNU Affero General Public License, version 3 or later](./LICENSE) (AGPL-3.0-or-later).

- **DoeDesk as a whole, and what Accelerate Technology Establishment wrote for it**, including `packages/privacy-gateway`, is under the AGPL.
- **The code that comes from T3 Code** is released by T3 Tools Inc. under the MIT licence ([LICENSE.T3-Code-MIT](./LICENSE.T3-Code-MIT)) and remains available under MIT from [their repository](https://github.com/pingdotgg/t3code).
- **Versions up to and including `v2026.11.1`** were released under the MIT licence and remain under it.
- **Third-party AI provider SDKs** loaded or started by DoeDesk keep their own terms, covered by the section 7 additional permission in [NOTICE](./NOTICE).
- **A commercial licence** is available from Accelerate Technology Establishment for organizations that cannot adopt AGPL: see [COMMERCIAL-LICENSE.md](./COMMERCIAL-LICENSE.md) or write to [hello@doedesk.com](mailto:hello@doedesk.com).

The app links to the exact source of the running version under **Settings → About → Source code**. If you modify DoeDesk and offer it over a network, AGPL section 13 requires offering your modified source (`SOURCE_REPOSITORY_URL` in `packages/shared/src/sourceCode.ts`).
