# Privacy gateway

DoeDesk keeps personal data away from the AI model. Before a request leaves your computer, names,
phone numbers, IDs, emails, IBANs, addresses and organization names are replaced with stand-ins
such as `[PERSON_FBJD2]`. The model works with the stand-ins. When it answers, writes a file or
runs a tool, the real values are put back on your computer, so what you see and what lands on disk
is real.

## How it works

- A small proxy runs on your computer, on a local port. Every agent DoeDesk starts is told to send
  its traffic through it and to trust its certificate. Your system's trust settings are not
  changed.
- The proxy opens requests to model providers only. Other traffic passes through untouched.
- The table that maps real values to stand-ins is the vault. It is a file in the DoeDesk data
  folder (`privacy/vault.json`) and never leaves the computer. Stand-ins are random; one cannot be
  turned back into a value without the vault.
- If a request cannot be checked, for example because the detection service is unreachable, it is
  not sent. The agent shows an error instead.
- Images and PDFs are not sent to the model. Their text is read out, masked, and sent as text. If
  a file cannot be read it is withheld and the model is told so.
- Usage reports that agent programs send to their vendors are dropped.

**Settings → Privacy** shows whether masking is on, the recent requests with how many values were
masked in each, and the vault.

## Finding the names

Fixed-format identifiers (phones, national IDs, IBANs, emails) are found on your computer.
Names, organizations and addresses need a detection service. Choose one in the welcome page or in
**Settings → Privacy**:

- **DoeDesk Cloud.** Sign in with an account. The text being checked is sent to DoeDesk Cloud for
  detection and is not stored there.
- **Your own service.** Enter its address. Text is sent only to that address.

### Running your own service

Any HTTP service that answers these two calls works. A bearer token is optional.

`POST /v1/detect`

```json
{ "texts": ["Applicant: Khalid Al-Otaibi, phone 0551234567."] }
```

answers one result per text, in order:

```json
{ "results": [{ "entities": [{ "start": 11, "end": 27, "kind": "PERSON" }] }] }
```

`start` and `end` are offsets in UTF-16 code units, as in JavaScript strings. `kind` is one of
`PERSON`, `ORG`, `LOCATION`, `ADDRESS`, `PHONE`, `EMAIL`, `ID`, `IBAN`, `ACCOUNT`, `DATE`, `URL`,
`OTHER`. DoeDesk sends at most 25 texts of at most 4,000 characters per call.

`POST /v1/ocr` (optional) takes an image or PDF as the request body, with its media type in
`content-type`, and answers `{ "text": "..." }`. Without it, images and PDFs are withheld.

## Which agents are covered

The gateway rewrites the request formats used by Claude, Codex and ChatGPT, Gemini-based agents,
and agents that speak the OpenAI chat format (OpenCode, Pi and others). Cursor's agent uses a
format the gateway cannot rewrite, so its model traffic is blocked while masking is on.

## Limits

- Detection is not perfect. A name the service misses is sent as written, unless the same name
  was caught earlier in the conversation. Check **Settings → Privacy** when the material matters.
- Details that are not identifiers on their own, such as a plot number, a district or a date, are
  not masked, and together they can point to a person.
- The model's own reasoning is shown with stand-ins, not real values.
- Turning masking off sends everything as written. DoeDesk says so in **Settings → Privacy**.
