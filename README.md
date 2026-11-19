<p align="center">
  <img src="./assets/prod/logo.svg" width="72" height="72" alt="">
</p>

<h1 align="center">DoeDesk</h1>

<p align="center">Use AI on confidential files.</p>

<p align="center">
  <a href="https://doedesk.com/download">Download for Mac</a> ·
  <a href="https://doedesk.com">Website</a> ·
  <a href="./docs/user/privacy.md">How masking works</a>
</p>

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="./.github/readme/welcome-dark.png">
    <img src="./.github/readme/welcome-light.png" width="720" alt="The DoeDesk welcome screen: sign in, then connect an AI.">
  </picture>
</p>

DoeDesk replaces names, phone numbers and IDs with stand-ins such as `[PERSON_FBJD2]` before an
AI model sees them, and puts the real values back on your screen and in the files it writes.

- **Your own AI subscription.** DoeDesk runs the agents you are already signed in to, such as
  Claude and Codex.
- **Real values stay on your computer.** The list that links each stand-in to a real value never
  leaves it. A request that cannot be checked is not sent.
- **Scans and images are masked too.** By default they are read and sent as masked text; you can
  choose to send the image itself with a labelled box over each value.
- **Your choice of detector.** Use DoeDesk Cloud ([server code](https://github.com/accelerate-sa/doedesk-server)),
  or run the detection service yourself.

## Install

Download [DoeDesk for Mac](https://doedesk.com/download) (Apple silicon), open it, and drag
DoeDesk to Applications. Sign in with a phone number in Saudi Arabia, or by email anywhere.

## Run your own detection

DoeDesk needs one service to find names in text and, optionally, one to read documents. Any
server that answers these two calls works:

```
POST /v1/detect   { "texts": ["..."] }  ->  { "results": [{ "entities": [{ "start", "end", "kind" }] }] }
POST /v1/ocr      <image or PDF bytes>  ->  { "text": "..." }
```

Choose **Use my own detection service** when you sign in, or later under Settings, Privacy.
[docs/user/privacy.md](./docs/user/privacy.md) has the details and the limits.

## Build from source

```sh
curl -fsSL https://vite.plus | bash   # installs the `vp` command
vp i
vp run dev
```

`packages/privacy-gateway` holds the masking. It is plain Node with no dependency on the rest
of the app.

## Contact

This repository does not take issues or pull requests. Write to
[hello@doedesk.com](mailto:hello@doedesk.com).

## Credit

DoeDesk is a fork of [T3 Code](https://github.com/pingdotgg/t3code) by T3 Tools Inc. The agent
runtime, the interface and most of the code are theirs. DoeDesk adds the privacy gateway and
removes what is only for programming. Both are MIT licensed; see [LICENSE](./LICENSE).
