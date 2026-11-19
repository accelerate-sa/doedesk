# Releasing DoeDesk

How the DoeDesk builds are made today. Each step runs on a Mac with Xcode, the repository's
dependencies (`vp i`), and the signing identities in the login keychain.

## Versions and when to release

DoeDesk is a fork of T3 Code (`upstream` = pingdotgg/t3code, `origin` = accelerate-sa/doedesk, work
on the `doedesk` branch; `main` on the fork follows upstream).

- A DoeDesk release carries the version of the T3 Code desktop release it is built on. DoeDesk
  0.1.10 is T3 Code v0.1.10 plus DoeDesk's changes.
- Release when a T3 Code release has been merged in, not for each change in between. If a fix
  cannot wait, say so in the notes; do not invent a version T3 Code has not used.
- The first line of every release's notes names the base: `Based on T3 Code v0.1.10.`
- The updater downloads from `releases/download/v<version>/`, so the tag must be `v<version>`. The
  fork inherits upstream's tag of that name; move it to the DoeDesk commit when releasing:
  `git tag -f v0.1.10 && git push -f origin v0.1.10`. Never push tags to `upstream`.
- GitHub Actions stay off on the fork: upstream's workflows would deploy and publish.

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
resolve, run the checks, then build with `--build-version <version>`.

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
  --signed --build-version 0.1.10 --output-dir release
```

`--signed` signs with the Developer ID Application identity. No provisioning profile is needed;
set `T3CODE_MACOS_PROVISIONING_PROFILE` only to enable passkeys in the in-app browser.

Then notarize and staple the disk image, and check Gatekeeper accepts the app:

```sh
asc notarization submit --file release/DoeDesk-0.1.10-arm64.dmg --wait
xcrun stapler staple release/DoeDesk-0.1.10-arm64.dmg
spctl -a -t exec -vv /Volumes/<mounted image>/DoeDesk.app   # "source=Notarized Developer ID"
```

Stapling changes the disk image, so update its `sha512` and `size` in `release/latest-mac.yml`.
Upload the disk image, the zip, both blockmaps and `latest-mac.yml` to a GitHub release, plus a
copy of the disk image named `DoeDesk-arm64.dmg`: `doedesk.com/download` points at that name on
the latest release.

## iPhone app

The app builds without App Groups, so it needs only an App ID with Push Notifications and
Associated Domains, and a development profile that lists the phone. Widgets and the share sheet
need an App Group, which has to be created in the Apple developer portal first.

```sh
cd apps/mobile
export DOEDESK_BRAND_FONTS_DIR=<folder with the Thmanyah files>
APP_VARIANT=production T3CODE_IOS_PERSONAL_TEAM=1 T3CODE_IOS_PERSONAL_TEAM_BUNDLE_ID=com.doedesk.app \
  npx expo prebuild --clean --platform ios
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
