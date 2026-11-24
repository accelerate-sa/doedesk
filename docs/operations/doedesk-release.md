# Releasing DoeDesk

How the DoeDesk builds are made today. The Mac and iPhone apps are built on the owner's Mac, with
Xcode, the repository's dependencies (`vp i`), and the signing identities in the login keychain.
GitHub Actions builds the Windows and Linux apps from the same tag.

## Versions and when to release

DoeDesk is a fork of T3 Code (`upstream` = pingdotgg/t3code, `origin` = accelerate-sa/doedesk, work
on the `doedesk` branch; `main` on the fork follows upstream).

- DoeDesk uses calendar versions `YYYY.M.N`: the year, the month without a leading zero (semver
  forbids `2026.01.0`), then a counter from 0 within the month: `2026.11.0`, `2026.11.1`,
  `2026.12.0`. Decided on 19 November 2026; `0.1.10` was the last release numbered after T3 Code.
- Releases are not tied to T3 Code's: release when the owner decides. Every release's notes still
  start by naming the base: `Based on T3 Code v0.1.10.`
- The updater downloads from `releases/download/v<version>/`, so the tag is `v<version>`
  (`v2026.11.0`), which never collides with T3 Code's `v0.x` tags. Tag a commit on `doedesk` and
  push the tag: `git tag v2026.11.0 && git push origin v2026.11.0`. Never push tags to `upstream`.
- GitHub Actions run only DoeDesk's own workflows (see [CI and Actions](#ci-and-actions)).

**Nothing goes to T3 Code.** Three guards, set up on 19 November 2026:

- `upstream` can be fetched but not pushed: its push address is `no-push:…`
  (`git remote set-url --push upstream no-push:upstream-is-T3-Code-DoeDesk-pushes-to-origin`), and
  `remote.pushDefault` is `origin`. Both are local settings; set them again in a new clone.
- `.vite-hooks/pre-push` refuses any push whose address contains `pingdotgg/t3code`, under any
  remote name. It is in the repository, so every clone with Vite+ hooks installed has it.
- `gh repo set-default accelerate-sa/doedesk`, so `gh pr create` opens pull requests on the fork
  and not on T3 Code, which GitHub would otherwise pick as the fork's parent. Set it again in a new
  clone.

GitHub also refuses pushes to pingdotgg/t3code from this account (it has read access only).

To take in a T3 Code release: `git fetch upstream --tags`, `git merge v<version>` into `doedesk`,
resolve, delete every workflow the merge brought back (`git rm` anything in `.github/workflows/`
not named `doedesk-*.yml`; the pre-push hook refuses to push them), and run the checks.
Merging T3 Code does not by itself make a release.

Three files are regenerated after the merge, never merged by hand: the lockfile (`vp i`), the
translation catalogs (`vp run i18n:generate` in `apps/web`, `apps/mobile` and `apps/desktop`;
`vp run i18n:check` gates them), and `apps/server/src/provider/agentContextBudget.json` (set it
to what `AgentContextBudget.test.ts` measures).

T3 Code's new text arrives in T3 Code's words. Where DoeDesk's screens say DoeDesk, chat, folder
and computer, reword it, in the server and provider packages as well as the apps, and the tests
that assert it. A catalog key is a hash of its English, so a reworded string is a new key and
reads in English in the other languages until someone translates it.

## CI and Actions

Set up on 19 November 2026. All jobs run on [Blacksmith](https://blacksmith.sh) runners (the
`blacksmith-sh` GitHub app is installed on the org): `blacksmith-{2,4,8,16}vcpu-ubuntu-2404` for
Linux x64, `blacksmith-16vcpu-ubuntu-2404-arm` for Linux arm64, `blacksmith-4vcpu-windows-2025`
(public beta) for the Windows checks.

- `doedesk-ci.yml`: lint, format, knip, build, typecheck, tests, Rust, release smoke, on every
  push to `doedesk` and `ci-blacksmith`. Pull requests are off on the fork, so there is no PR run.
- `doedesk-release.yml` (with `doedesk-release-desktop.yml`): the Windows and Linux apps, on a
  pushed `v2026.11.0`-style tag or by hand. It builds only tags whose commit is on `doedesk`.
- `doedesk-windows-tests.yml`: by hand, T3 Code's Windows test lane.

Repository settings: Actions allow only GitHub's own actions plus `voidzero-dev/setup-vp`,
`dtolnay/rust-toolchain` and `taiki-e/install-action`, each pinned by commit SHA (required);
the workflow token is read-only and only the release's upload job gets `contents: write`.
Pushing a branch or tag runs that commit's own workflow files, and the fork's other branches
(including `main`) still carry T3 Code's. So never push T3 Code's branches or tags to `origin`,
and do not use GitHub's "Sync fork" on `main`: it would run T3 Code's CI and bots here. Most of
their deploy and release jobs check for T3 Code's repository and skip, and the action allowlist
blocks many of their steps, but nothing disables them.

## Windows and Linux apps

Push the release tag (above), or run the workflow for an existing tag:

```sh
gh workflow run doedesk-release.yml -R accelerate-sa/doedesk --ref doedesk -f version=2026.11.0
gh run watch -R accelerate-sa/doedesk      # add -f upload=false above to build without uploading
```

It builds the JS bundle once, packages Linux x64 and arm64 (AppImage and deb) and Windows x64
(NSIS, built on Linux and checked on a Windows runner), checks that each app carries the original
brand fonts and reads updates from `accelerate-sa/doedesk`, checks every update manifest's sha512
and size, and attaches to the tag's release:

| File                                                         | What                                                                |
| ------------------------------------------------------------ | ------------------------------------------------------------------- |
| `DoeDesk-<version>-x64.exe`, `.exe.blockmap`, `latest.yml`   | Windows installer and its update feed                               |
| `DoeDesk-x86_64.AppImage`, `DoeDesk-arm64.AppImage`          | AppImages (no version in the name, so the updater can replace them) |
| `latest-linux.yml`, `latest-linux-arm64.yml`                 | Linux update feeds                                                  |
| `DoeDesk-<version>-amd64.deb`, `DoeDesk-<version>-arm64.deb` | Debian packages                                                     |
| `DoeDesk-x64.exe`, `DoeDesk-amd64.deb`, `DoeDesk-arm64.deb`  | Copies with fixed names for `doedesk.com/download`                  |

It uploads only these names, never replaces or deletes the Mac files, and re-running it replaces
its own files. If the tag has no release yet it creates one as a **draft** with the notes
`Based on T3 Code vX.Y.Z.` (the workflow cannot know the base): fill in the version and the notes,
add the Mac files, then publish it yourself. Re-run a failed job
from the run's page or with `gh run rerun <id> --failed`.

The Windows installer is **not code-signed**: there is no certificate yet, and SmartScreen warns
on first run ("More info", "Run anyway"). The place to add signing is marked `WINDOWS CODE
SIGNING` in `doedesk-release-desktop.yml`.

The Windows app has no WSL backend: T3 Code embeds its Linux CLI archive for it, and that archive
cannot be built for DoeDesk (a Node single executable cannot load `sharp`, which the privacy
gateway uses). For the same reason the releases carry no `t3` CLI archives.

Secrets: `DOEDESK_BRAND_FONTS_01` to `_10` hold the six Thmanyah files as one base64 `tar.xz`,
split because a secret holds at most 48 KB (the workflow reads up to `_12`). The jobs unpack them
in the runner's temp folder; the JS bundle artifact is uploaded without them. To replace them,
from the folder with the six files:

```sh
COPYFILE_DISABLE=1 tar --format=ustar --uid 0 --gid 0 --uname root --gname root -cf - thmanyah-serif-*.otf \
  | xz -9e | base64 | tr -d '\n' > /tmp/fonts.b64 && split -b 45000 -a 2 /tmp/fonts.b64 /tmp/fonts.part.
i=1; for f in /tmp/fonts.part.*; do gh secret set "DOEDESK_BRAND_FONTS_$(printf %02d $i)" -R accelerate-sa/doedesk < "$f"; i=$((i+1)); done
rm /tmp/fonts.b64 /tmp/fonts.part.*
```

Delete any higher-numbered part left from a longer earlier set.

## Brand fonts

The repository carries Redaction (English), Noto Naskh Arabic, and the digits of Newsreader, all
under the SIL Open Font License. Digits in the serif come from Newsreader because Redaction's "1"
reads as a lowercase "l"; `scripts/build-brand-fonts.py` makes those files. The brand's Arabic face is Thmanyah Serif, whose licence lets an app ship the files but
forbids redistributing or changing them. This repository is public, so those files are never
committed: an official build reads them from a folder outside it.

Set `DOEDESK_BRAND_FONTS_DIR` to a folder holding the original `.otf` files, named
`thmanyah-serif-text-regular.otf`, `-text-medium`, `-text-bold`, and the same three for
`-display-`. Set it for every build command below:

- The web build copies the files, byte for byte, to `brand-fonts/` in its output and adds their
  `@font-face` rules to `index.html`. The desktop app packages that output. The phone app needs
  `thmanyah-serif-text-regular.otf`, `thmanyah-serif-text-bold.otf` and
  `thmanyah-serif-display-medium.otf`, and bundles them through `expo prebuild`.
- Unset, nothing changes: Arabic is set in Noto Naskh Arabic and no build output refers to a
  Thmanyah file. The font stack still names the family, so a copy installed on the computer is used.
- Set but wrong (no such files), the build fails rather than shipping without them.

To check a build, look for `brand-fonts/` beside `index.html` in the web output, or open an Arabic
answer and inspect the font. `.gitignore` refuses any file with `thmanyah` in its name; do not
work around it.

## Mac app

```sh
T3CODE_DESKTOP_UPDATE_REPOSITORY=accelerate-sa/doedesk \
DOEDESK_BRAND_FONTS_DIR=<folder with the Thmanyah files> \
  node scripts/build-desktop-artifact.ts --platform mac --target dmg --arch arm64 \
  --signed --build-version 2026.11.0 --output-dir release
```

`--signed` signs with the Developer ID Application identity. No provisioning profile is needed;
set `T3CODE_MACOS_PROVISIONING_PROFILE` only to enable passkeys in the in-app browser.

Then notarize and staple the disk image, and check Gatekeeper accepts the app:

```sh
asc notarization submit --file release/DoeDesk-2026.11.0-arm64.dmg --wait
xcrun stapler staple release/DoeDesk-2026.11.0-arm64.dmg
spctl -a -t exec -vv /Volumes/<mounted image>/DoeDesk.app   # "source=Notarized Developer ID"
```

Stapling changes the disk image, so update its `sha512` and `size` in `release/latest-mac.yml`.
Upload the disk image, the zip, both blockmaps and `latest-mac.yml` to the tag's GitHub release
(the draft the release workflow made, if it ran first), plus a copy of the disk image named
`DoeDesk-arm64.dmg`: `doedesk.com/download` links to the fixed names on the latest release.

## iPhone app

The app builds without App Groups, so it needs only an App ID with Push Notifications and
Associated Domains, and a development profile that lists the phone. Widgets and the share sheet
need an App Group, which has to be created in the Apple developer portal first.

```sh
cd apps/mobile
export DOEDESK_BRAND_FONTS_DIR=<folder with the Thmanyah files>
APP_VARIANT=production T3CODE_IOS_PERSONAL_TEAM=1 T3CODE_IOS_PERSONAL_TEAM_BUNDLE_ID=com.doedesk.app \
  T3CODE_MOBILE_VERSION=2026.11.0 npx expo prebuild --clean --platform ios
cd ios
APP_VARIANT=production T3CODE_IOS_PERSONAL_TEAM=1 T3CODE_IOS_PERSONAL_TEAM_BUNDLE_ID=com.doedesk.app \
  xcodebuild -workspace DoeDesk.xcworkspace -scheme DoeDesk -configuration Release \
  -sdk iphoneos -destination 'generic/platform=iOS' -derivedDataPath build/device \
  CODE_SIGNING_ALLOWED=NO build
```

Copy `build/device/Build/Products/Release-iphoneos/DoeDesk.app`, put the profile inside it as
`embedded.mobileprovision`, sign it, and install it:

```sh
scripts/sign-ios-app.sh <copy>/DoeDesk.app <entitlements.plist>
xcrun devicectl device install app --device <device id> <copy>/DoeDesk.app
```

The entitlements file names the App ID (`<team>.com.doedesk.app`), the team, `aps-environment`,
the associated domains, the keychain group and `get-task-allow`, matching the profile. Installing
over Wi-Fi can fail with "the tunnel was interrupted"; repeat it, or connect the phone by cable.

For the simulator, build with `-sdk iphonesimulator` and `CODE_SIGN_IDENTITY=-`. Do not pass
`CODE_SIGNING_ALLOWED=NO` there: without its entitlements the app cannot read the keychain and
stays on "Loading environments".
