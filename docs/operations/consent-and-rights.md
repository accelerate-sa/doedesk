# Consent and account rights

What the app shows and sends for the Terms of Use, usage data and the account rights, and how to
change the wording. The design is the consent specification and the service's contract, both kept
with DoeDesk Cloud (`legal/consent-spec.md` and `legal/service-changes-notes.md`, section 3).
Where they differ, the contract decides what goes over the wire and the specification decides the
words and the behaviour.

## Who talks to DoeDesk Cloud

The window never calls DoeDesk Cloud. It asks the DoeDesk server on the same computer
(`/api/privacy/*`), and two services there make the calls:

| Service                                                                   | Calls                                                                     | State on disk                                                                                                      |
| ------------------------------------------------------------------------- | ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| [Privacy controller](../../packages/privacy-gateway/src/controller.ts)    | Sign-in, `/v1/me`, acceptance, export, deletion, detection                | `privacy/config.json`: the sign-in, the account's identifier, where it stands on the Terms, the documents in force |
| [Usage-data consent](../../apps/server/src/telemetry/UsageDataConsent.ts) | `GET /v1/auth/options` (no sign-in, no identifier), `POST /ingest/choice` | `usage-data.json`: the state, the rule and signal that decided it, the wording shown, the installation identifier  |

`DOEDESK_CLOUD_URL` and `T3CODE_TELEMETRY_HOST` point both at another copy of the service.

## Accepting the Terms of Use

**Where.** The sign-in form (the welcome page and Settings, under Privacy) shows the notice at
collection and one unticked box above the button, every time it is shown. "Use my own detection
service" and "Use DoeDesk without masking" create no account and ask for nothing.

**What is sent.** With the request for a code or a link:

```json
"acceptance": {
  "termsVersion": "1.1", "privacyVersion": "1.1",
  "locale": "ar", "wordingId": "signup-2026-11",
  "appVersion": "0.2.0", "method": "checkbox+button"
}
```

The versions are the ones DoeDesk Cloud named in the `legal` answer the links came from. They are
not constants in the build: if the service did not answer just now, the form shows no box and no
button to press, only "Try again".

**Answers the form handles.**

| Code                 | What the person sees                                                                      |
| -------------------- | ----------------------------------------------------------------------------------------- |
| `terms_required`     | "Tick the box to continue." The box is shown if it was not                                |
| `invalid_acceptance` | That this is a fault in DoeDesk, and to update. The service's message goes to the console |
| `terms_outdated`     | The links now open the new version; the box is empty again                                |
| `signup_unavailable` | No new account can be created from this country; an existing one signs in as usual        |
| `too_many_requests`  | To wait a few minutes                                                                     |
| anything else        | DoeDesk Cloud's own message                                                               |

**Accounts that have not accepted.** Every sign-in answer and `/v1/me` (read at each start) say
whether acceptance is `outstanding` and whether the service `blocked` the account. While it is
outstanding, the app shows a sheet with the same box. Not blocked: the sheet can be closed and
returns at the next start. Blocked: it stays until the person accepts (`POST /v1/me/acceptance`,
wording `terms-sheet-2026-11`), signs out, or connects their own detection service.

A detection or reading request that DoeDesk Cloud refuses with `terms_update_required` marks the
account blocked on this computer. The model request is not sent, its reason in Settings says what
to do, and nothing is retried; the window re-reads the status every 15 seconds while an account is
signed in, so the sheet comes up.

## Usage data

**The rule.** Nothing is sent until the person has seen the choice or the notice. At each start
the window sends its locale and time zone, and the server decides:

1. It asks DoeDesk Cloud for the rule where the connection comes from (`usageData`), and takes
   the list of consent regions from the same answer. No answer, or one it cannot read: "ask".
2. A region in the list from the window's locale, or from the server's own (`LC_ALL`, `LANG`): "ask".
3. A time zone that belongs to a country in the list, from the window or the server: "ask".
4. Otherwise "notice".

A country listed only by one of its regions (`CA-QC`) counts whole when the region is unknown,
which a locale and a time zone never tell. `UTC` and a language without a region say nothing.
The list shipped in the build ([UsageDataRegion.ts](../../apps/server/src/telemetry/UsageDataRegion.ts))
is used only when the service sent none.

**What is shown.** "ask": an unticked box. "notice": a sentence that usage data is on, with the
switch. On the welcome page it is a section of the page; an installation that is already set up
gets a dialog once. Leaving the welcome page, or pressing Continue in the dialog, records
`on_by_default_notice_shown` under "notice", and `off` under "ask" when the box was left empty.

**States.** `unset`, `on_by_default_notice_shown`, `on_consented`, `off`.

- A choice the person made (`on_consented`, `off`) is never changed by the app.
- `on_by_default_notice_shown` and a later start that decides "ask": sending stops, the identifier
  is discarded, and the unticked box is shown again.
- The settings file's `usageDataEnabled: false`, `T3CODE_TELEMETRY_ENABLED=false` and a managed
  policy each turn usage data off whatever the state. The first also moves the state to `off`.
- An installation from before this rule starts `unset`, or `off` if its setting was off, and the
  identifier file older versions kept (`anonymous-id`) is deleted at start.

**The identifier.** A random UUID made when usage data is first on, sent as both `distinct_id`
and `properties.installId`, shown in Settings with a copy control, and deleted when usage data is
turned off. Nothing else names an installation: no provider account, no DoeDesk account, no
device. Events from a person who agreed carry `properties.consent = { wordingId, at }`.

**The record of the choice.** Each change of state is sent once to `POST /ingest/choice` with the
identifier, the state, the time, the wording, the rule and signal, and the language. A report that
cannot be sent waits in `usage-data.json` for the next change or the next start.

## The notice about masking for a provider

"What DoeDesk changes in what OpenAI receives", and the same for each AI company, tells a person
that DoeDesk alters the requests their own sign-in sends, and that the company can tell. Its
sentences are in [providerConnections.ts](../../apps/web/src/doedesk/providerConnections.ts) and
go through the interface translations.

- **When.** Once per provider, when a chat with that provider starts: the first Send to it opens
  the notice and the message goes only after "I understand". A provider that already has a chat on
  this computer (one an agent or a schedule started, or one from the phone) gets its notice the
  next time the app is open. Providers a person is signed in to and has not used get none. It
  can be read again from Settings, Privacy, Advanced, AI companies.
- **What is recorded.** The provider and `PROVIDER_NOTICE_VERSION`, in `privacy/config.json` on
  this computer. Nothing is sent to DoeDesk Cloud. Raise the version when the meaning of the
  notice changes, and it is shown again.
- **What must hold.** No message leaves this window for a masked provider before its notice was
  read. Do not turn the notice into a line the person can miss, and do not record it as read
  without showing it.

## Account rights

Settings, under Privacy, for a signed-in account:

| Control                      | Call                  | Notes                                                                       |
| ---------------------------- | --------------------- | --------------------------------------------------------------------------- |
| Your answers                 | `POST /v1/me/profile` | Shows what `/v1/me` holds. Saving corrects; "Remove my answers" sends nulls |
| Download my data             | `GET /v1/me/export`   | Saved as `doedesk-account-<day>.json`                                       |
| Delete my account            | `DELETE /v1/me`       | See below                                                                   |
| Terms of Use, Privacy Policy |                       | Version in force, the link, and when this account accepted                  |

**Deleting.** The dialog lists what is deleted, what is kept and what is not touched, then calls
`DELETE /v1/me`. The service deletes only with a sign-in made in the last ten minutes. Older than
that, it answers `recent_sign_in_required` and the dialog asks for a new sign-in, by the number or
address the account has. That sign-in is used for the deletion and nothing else:

- it sends no `acceptance`, unless the service refuses a sign-in without one, and then the box is shown;
- if another number or address is verified, nothing of the signed-in account is deleted, and an
  account that mistake created is removed again;
- on success the app shows the account's identifier and the day the proof of acceptance is kept
  until, and this computer is signed out.

The phone app does not sign in to DoeDesk Cloud, so it has no account controls.

## Changing the wording

Every sentence a person agrees to is in [consentWords.ts](../../apps/web/src/doedesk/consentWords.ts),
in English and Arabic, with the identifier of each wording. These are not run through the
interface translations: the language and identifier the service records must be what was on screen.

1. Change the sentence in both languages, from the new version of the specification.
2. Give the wording a new identifier (`signup-<year>-<month>`, with `-<day>` when a month has two: `signup-2026-11-19`). Letters,
   digits and `. _ + -`, at most 64.
3. Take new screenshots of that screen in both languages, light and dark, and keep them with the
   service's `legal` folder beside the identifier.
4. Messages for the service's error codes are in
   [privacyMessages.ts](../../apps/web/src/doedesk/privacyMessages.ts); those go through the
   interface translations (`vp run --filter @t3tools/web i18n:generate` after a change).

A new version of the Terms or the Policy needs no app change: the versions and links come from the
service. A new consent region needs none either, unless the time zone table has to learn a zone:
`python3 scripts/build-time-zone-countries.py`, then format the file.

## Checking against a local copy of the service

DoeDesk Cloud's `test/local-service.mjs` starts the service on a throwaway database with stand-ins
for SMS, mail and the detection engine. Start the app with `DOEDESK_CLOUD_URL` and `T3CODE_TELEMETRY_HOST` set to
it, `T3CODE_TELEMETRY_ENABLED=true`, and its own `--home-dir`. With `EXPOSE_LOGIN_SECRETS=1` the
service returns the code or link and takes the country from an `x-test-country` header, so a small
proxy in front of it can place the app in any country. Never use the production service for
account creation or deletion tests.
