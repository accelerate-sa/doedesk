# Privacy gateway

Masks personal details in what an agent sends to an AI company and restores them in what comes
back. One core decides what is masked; three front ends call it.

| Part                                                            | File                                                                        | Used for a user's sessions            |
| --------------------------------------------------------------- | --------------------------------------------------------------------------- | ------------------------------------- |
| Core: detection, vault, stand-ins, restoration, refusal wording | `src/core.ts`, `src/pseudonymizer.ts`, `src/vault.ts`, `src/attachments.ts` | Yes                                   |
| Network gateway front end                                       | `src/gateway.ts`, `src/requestMasking.ts`, `src/responseUnmasking.ts`       | Yes, for every provider               |
| Claude Code hooks front end                                     | `src/native/claude.ts`                                                      | No. See its `CLAUDE_UNCOVERED_ROUTES` |
| Codex hooks front end                                           | `src/native/codex.ts`                                                       | No. See its `CODEX_UNCOVERED_ROUTES`  |
| Recorder for tests and measurements                             | `src/observer.ts`                                                           | Never                                 |

`src/conformance.test.ts` runs the same scenarios against all three front ends.
`scripts/conformance-real.ts` runs them against the real Claude Code and Codex. Results and the
reasons the two hook front ends are not used are in
[docs/operations/provider-connections.md](../../docs/operations/provider-connections.md).

## What the network gateway touches

The gateway is in a provider's path only while masking is on and the user has not switched that
provider to direct. Otherwise the provider's process is given nothing: no proxy variable, no
certificate, no switch (`controller.ts`, `environmentFor`).

### Connections

| What                                                                       | What the gateway does                                                                                                         |
| -------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| A host on the inspected list (`DEFAULT_INSPECTED_HOSTS`)                   | Ends TLS with a certificate from the local authority, speaks HTTP/1.1 to the client, opens its own TLS connection to the host |
| A host on the blocked list (`DEFAULT_BLOCKED_HOSTS`, Cursor's model hosts) | Refuses the connection with `403`: their format cannot be masked                                                              |
| Any other host                                                             | Passes the bytes through unread                                                                                               |
| A WebSocket upgrade to an inspected host                                   | Refuses it with `426`. Codex then uses HTTPS (measured)                                                                       |

### Requests on an inspected host

| Part                                                                                                                                                                                 | What the gateway does                                                                                               |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------- |
| Paths `…/v1/messages`, `…/v1/messages/count_tokens`, `…/responses`, `…/responses/compact`, `…/chat/completions`, Gemini `:generateContent`, `:streamGenerateContent`, `:countTokens` | Rewrites the body as described below                                                                                |
| Every other path, including usage reports                                                                                                                                            | Forwards it as written. The gateway never answers in the AI company's place                                         |
| Text of user messages and tool results                                                                                                                                               | Checked by the detector; each value found becomes a stand-in such as `[PERSON_FBJD2]`                               |
| Assistant text, tool call input, system prompt                                                                                                                                       | Only values already in the vault become stand-ins. The vault starts with this computer's account name and host name |
| Images                                                                                                                                                                               | Sent redacted: a black box over each value with its stand-in on it, then a text legend. See below                   |
| PDFs, and images when the user chose masked text or the image cannot be redacted                                                                                                     | Replaced by one text block: the text read from them, then masked, or a note that the file was withheld              |
| Tool definitions, model, parameters, `cache_control`, IDs, signed thinking, encrypted reasoning, the attribution block                                                               | Not changed                                                                                                         |
| The body as a whole                                                                                                                                                                  | Parsed and written again as JSON, uncompressed                                                                      |
| Header `content-length`                                                                                                                                                              | Set to the new body's length                                                                                        |
| Header `content-encoding`                                                                                                                                                            | Removed, because the body is sent uncompressed                                                                      |
| Header `accept-encoding`                                                                                                                                                             | Set to `identity`, so that the reply can be read                                                                    |
| Headers `connection`, `keep-alive`, `proxy-*`, `te`, `trailer`, `transfer-encoding`, `upgrade`                                                                                       | Dropped: they belong to one connection                                                                              |
| Every other header, including `user-agent`, `authorization`, `x-api-key`, `anthropic-*`, `x-claude-code-*`, `x-stainless-*`, `openai-*`                                              | Forwarded unchanged. Node writes header names in lower case. Nothing is added                                       |

A request that cannot be checked is not sent: the gateway answers `400` with
`describeMaskingFailure`'s sentence in the provider's error shape.

### Replies

| Part                                                | What the gateway does                                                                                |
| --------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Event streams and JSON bodies of rewritten requests | Stand-ins become the real values again. A stand-in split across two chunks is held until it is whole |
| Signed thinking, encrypted reasoning, IDs           | Not changed                                                                                          |
| Replies to requests that were not rewritten         | Passed through unread                                                                                |

### What the AI company can observe

The gateway does not forge, recompute or remove any integrity field. Claude Code writes a
fingerprint of the request into the first system block before the gateway changes the body, so a
masked request carries a fingerprint that was computed over different content. The connection
also differs from the vendor's own: HTTP/1.1, Node's TLS, lower-case header names, an
uncompressed body, and for Codex HTTPS in place of its WebSocket.

### Images

`src/redaction/` turns an image into the image that is sent. It opens the file as plain pixels
(no metadata, no alpha, first frame, EXIF orientation applied), asks the reading service where
each word is, covers every word of a detected or known value and every word it cannot trust,
writes the value's stand-in on the box, reads the result again, and sends it only if nothing
that should be hidden is legible. Anything else ends in the masked text of the image or in the
withheld note, never in the image as it came.

The rules, the measurements behind each number in `DEFAULT_REDACTION_POLICY`, what still leaks
and what is not covered at all (faces, signatures, codes, PDFs) are in
[docs/operations/image-redaction.md](../../docs/operations/image-redaction.md).
`src/redaction/fixtures/` holds recorded answers of the real reading and detection services for
made-up documents; `scripts/redaction-corpus.ts` records them and `scripts/redaction-live.ts`
checks real provider sessions.

## Switches set for a masked session

`MASKED_SESSION_SWITCHES` in `src/index.ts` is the whole list. Each is a documented Claude Code
variable that stops content from reaching Anthropic on a route the gateway does not rewrite.
Usage metrics stay on unless the user turns them off in Settings, which adds
`DISABLE_TELEMETRY=1`.

## Evaluation switches

`DOEDESK_EVAL_OCR_ONLY`, `DOEDESK_EVAL_SENT_BODIES_FILE` and `DOEDESK_EVAL_EVENTS_FILE` are read
by the server at start, never from settings. The two files hold confidential text.
