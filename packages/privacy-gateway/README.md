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

`scripts/routes-seen.ts <folder> -- <command>` runs any program behind the gateway and lists
every host, method and path it called with what the gateway did. A body with no rule stays on
this computer and is written to `<folder>/bodies.ndjson`: read it there before giving its path
a rule in `src/routes.ts`, and run the script again when a provider's program is updated.

## What the network gateway touches

The gateway is in a provider's path only while masking is on and the user has not switched that
provider to direct. Otherwise the provider's process is given nothing: no proxy variable, no
certificate, no switch (`controller.ts`, `environmentFor`).

### Connections

| What                                                                       | What the gateway does                                                                                                                                                                                                      |
| -------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A host on the inspected list (`DEFAULT_INSPECTED_HOSTS`)                   | Ends TLS with a certificate from the local authority, speaks HTTP/1.1 to the client, opens its own TLS connection to the host                                                                                              |
| A host on the blocked list (`DEFAULT_BLOCKED_HOSTS`, Cursor's model hosts) | Refuses the connection with `403`: their format cannot be masked                                                                                                                                                           |
| Any other host                                                             | Passes the bytes through unread, or refuses it with `403` under the rule for other hosts (`EgressPolicy`: any, listed only, none). Sign-in hosts always pass. With sealed documents the rule is never looser than the list |
| A WebSocket upgrade to an inspected host                                   | Refuses it with `426`. Codex then uses HTTPS (measured)                                                                                                                                                                    |

### Requests on an inspected host

| Part                                                                                                                                                                                 | What the gateway does                                                                                                                          |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Paths `…/v1/messages`, `…/v1/messages/count_tokens`, `…/responses`, `…/responses/compact`, `…/chat/completions`, Gemini `:generateContent`, `:streamGenerateContent`, `:countTokens` | Rewrites the body as described below                                                                                                           |
| Text in another JSON shape: `…/responses/input_tokens`, `…/embeddings`, `…/moderations`, legacy `…/completions`, Gemini `:embedContent`                                              | Checks every string in the body like a tool's result (`json-text`)                                                                             |
| Usage reports: Claude Code `/api/event_logging/…`, Codex analytics events and metrics, Gemini CLI metrics                                                                            | Sends them. Measured to hold no text of the session; a value the vault knows is still replaced, also inside Claude Code's base64 event details |
| Sign-in, feature flags, quota and settings (the short list in `src/routes.ts`), and any request with no body                                                                         | Forwards it as written. The gateway never answers in the AI company's place                                                                    |
| JSON-RPC to apps the AI company hosts (Codex `/backend-api/ps/mcp`)                                                                                                                  | Lets the program list them; refuses a call, which would carry restored values                                                                  |
| Any other request with a body (file and batch uploads, feedback, transcripts, session sync, anything new)                                                                            | Refuses it with `400` and records it: nothing is forwarded unread                                                                              |
| Text of user messages and tool results                                                                                                                                               | Checked by the detector; each value found becomes a stand-in such as `[PERSON_FBJD2]`                                                          |
| Assistant text, tool call input, system prompt                                                                                                                                       | Only values already in the vault become stand-ins. The vault starts with this computer's account name and host name                            |
| Images                                                                                                                                                                               | Sent redacted: a black box over each value with its stand-in on it, then a text legend. See below                                              |
| PDFs, and images when the user chose masked text or the image cannot be redacted                                                                                                     | Replaced by one text block: the text read from them, then masked, or a note that the file was withheld                                         |
| Tool definitions, model, parameters, `cache_control`, IDs, signed thinking, encrypted reasoning, the attribution block                                                               | Not changed                                                                                                                                    |
| `cache_control` `scope: "global"` on a system block                                                                                                                                  | Removed from the first system block masking changed onward: the provider refuses a globally cached prefix it does not know                     |
| The body as a whole                                                                                                                                                                  | Parsed and written again as JSON, uncompressed                                                                                                 |
| Header `content-length`                                                                                                                                                              | Set to the new body's length                                                                                                                   |
| Header `content-encoding`                                                                                                                                                            | Removed, because the body is sent uncompressed                                                                                                 |
| Header `accept-encoding`                                                                                                                                                             | Set to `identity`, so that the reply can be read                                                                                               |
| Headers `connection`, `keep-alive`, `proxy-*`, `te`, `trailer`, `transfer-encoding`, `upgrade`                                                                                       | Dropped: they belong to one connection                                                                                                         |
| Every other header, including `user-agent`, `authorization`, `x-api-key`, `anthropic-*`, `x-claude-code-*`, `x-stainless-*`, `openai-*`                                              | Forwarded unchanged. Node writes header names in lower case. Nothing is added                                                                  |

A request that cannot be checked is not sent: the gateway answers `400` with
`describeMaskingFailure`'s sentence in the provider's error shape. A detection call that could not
be reached, or was answered 408, 425, 429 or 5xx, is tried again after 0.5, 1.5 and 4 seconds
first (`detect.ts`, `RETRY_WAITS_MS`).

A text in which a tool printed characters apart (`od -c`, `hexdump -c`, `sed 's/./& /g'`) is
checked as it reads put back together, and each value found is replaced where its characters
stand (`separated.ts`). Hexadecimal, base64 and other encodings are not read.

The result of a web search, and of a web fetch whose address is plainly public, is the one kind
of tool result that is not checked by the detector: only values already in the vault are replaced
in it, unless the person switches the check on. `webResults.ts` holds the rules and why each
fails closed.

The gateway's own connections go through the proxy the person had configured, and trust the
certificates they had added (`upstream.ts`). An agent's process still gets only the gateway.
That covers requests to AI hosts (one tunnel each, closed with the reply), tunnels to other
hosts, and the calls to detection, reading, the worker and DoeDesk Cloud, which use
`fetchThrough` because Node's `fetch` ignores the proxy variables. A proxy that refuses, asks
for a sign-in or does not answer in 30 seconds is a recorded refusal; nothing falls back to a
direct connection. `scripts/through-proxy.ts` checks this in any runtime, and is run in
Electron's Node as well: the packaged app's server runs there.

A request that is handed its connection must be handed no agent. With `agent: false` Node builds
an agent of its own that ignores `createConnection` and connects straight to the host, and the
tunnel sits unused.

### Names of files and paths

A detector reads words, and a file's name joins them: `Sara_AlDossari_bank_letter.txt`,
`KhalidAlOtaibi-diabetes.pdf`. Read as prose, such a name goes out with part of a person's name
in it. So a name is read a second time with its joins opened (a separator, a capital after a
small letter, a letter beside a digit, a change of script), and what is found is replaced where
it stands in the name, which keeps its shape: `[PERSON_X]_Al[PERSON_Y]_bank_letter.txt`
(`fileNameTokens.ts`, `Pseudonymizer`). A sealed file's name is not read again at all: its kept
label is written (`fileLabels.ts`).

What is taken for a name, in any text that is masked (a message, a tool's result, a command, a
diff): a run of characters with no space, quote, bracket, comma, colon, semicolon, equals sign
or bar, that is one of

- a path: it holds `/` and starts as one (`/`, `./`, `../`, `~/`), ends in one, has two or more,
  or ends in a file type; a backslash parts folders only after a drive letter or a leading `\\`,
  since everywhere else it is an escape of quoted text; a run whose every part starts with a
  digit is a date or a ratio and is left;
- a file's name: it ends in a file type from a fixed list (`.txt`, `.pdf`, `.py`, ...) and no
  `(` follows it, which would make it a call (`rows.map(`);
- a name with no type, as a listing prints a folder: words joined by `_`, each an Arabic word or
  a capital followed by small letters (`Sara_AlDossari`).

Everything else is left as it is: `handleClick`, `user.name`, `MAX_RETRY`, `snake_case`,
`and/or`. Being taken for a name changes nothing by itself. Only a part that joins two or more
words is read again. It is put to the detection service, in the same call as the text it stands
in, when it holds a capital or a letter outside ASCII, or when it is the name of a document
(`.txt`, `.md`, `.pdf`, Word, Excel and the like), which people call after whom it is about:
`quote_helvetia.txt`. That is what a sealed file's label is asked, so a listing masks what a
label would. The rest (`user_service.ts`) are looked up among the values already known. A text
met before is not gone through again unless a value learned since stands in it or in one of its
names.

A name can also write only a part of a value the vault holds whole, which no reading above
finds. Two such parts are looked for among the words of every folder's and file's name, with no
call to the detection service (`knownParts.ts`):

- The serial of a record's number. A record number is a known identifier written as letters and
  then runs of digits, the last of them (the serial) three digits or more: `MNT-2025-8042`,
  `INV-26-701`. A name writes it where a word of the name is the serial and either the number's
  letters stand before it, in any case and with any join (`amendment_mnt_8042.txt`, `MNT8042`,
  `mnt_2025_8042`), or the serial stands apart as a number of its own, exactly one known record
  number ends with it, and it is not a year from 1900 to 2099 (`credit_note_701.txt`). Left as
  written: a middle run (`report_2025.txt`, `invoice_26.txt`), a longer number that holds the
  serial, digits inside a code (`3a701e`), a serial two known numbers share, and any number in
  prose.
- The first words of an organisation's name, in any case: `quote_meridian_crest.txt` for
  "Meridian Crest Reinsurance Holdings". The first word has four letters or more and is not one
  many organisations start with ("National", "Saudi", "Bank"); an article counts with the word
  after it (`al_rajhi`, `alrajhi`); a body named for what it does ("Placement Committee") is
  not looked for. A word that several known names start with gets a stand-in of its own.

The part gets the stand-in of the whole value, in the name only: it does not become a spelling
of the value, so the same number in prose is left, and the name comes back as it was spelled.
When a sealed file's label is made, the record numbers of the file's own text count as known.
One the vault does not hold gets the stand-in the worker gives that identifier and stays a
sealed value; its part of the label is turned back in what a tool is run with too, since a
tool finds the file by its name.

On the way back the name is given as it was spelled: a stand-in's value is "Khalid Al Otaibi",
the path wrote `Khalid_Al_Otaibi`, and a tool has to be run with the path. The names met are
kept in memory with their stand-ins for that, the newest four thousand.

### Replies

| Part                                                | What the gateway does                                                                                                                                                                                            |
| --------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Event streams and JSON bodies of rewritten requests | Stand-ins become the real values again. A stand-in split across two chunks is held until it is whole. A stand-in for a value of a sealed document is restored in the assistant's text only, never in a tool call |
| Signed thinking, encrypted reasoning, IDs           | Not changed                                                                                                                                                                                                      |
| Replies to requests that were not rewritten         | Passed through unread                                                                                                                                                                                            |

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

QR codes and barcodes are decoded on this computer (`src/redaction/barcodes.ts`) and covered
when what they hold names someone or opens the document: a verification link, a link to a
record, an identifier, a ZATCA invoice. A code that decodes and holds none of that is left open,
and reported. If the decoder cannot be loaded the image is not sent.

The rules, the measurements behind each number in `DEFAULT_REDACTION_POLICY`, what still leaks
and what is not covered at all (faces, signatures) are in
[docs/operations/image-redaction.md](../../docs/operations/image-redaction.md).
`src/redaction/fixtures/` holds recorded answers of the real reading and detection services for
made-up documents; `scripts/redaction-corpus.ts` records them and `scripts/redaction-live.ts`
checks real provider sessions.

## De-identifying files

`src/deidentify/` makes a de-identified copy of a file a person chose: `.txt`, `.md`, `.png`,
`.jpg`, `.jpeg`, `.webp`, `.pdf`, `.csv`, `.xlsx`, `.docx`, `.pptx`. Legacy `.doc` is refused.

- **Two steps, a person between them.** `deidentifyFile` finds what is in a file and returns a
  layer (`layer.ts`): one item for each value found, with where it is and what is to be done
  about it. `applyLayer` and `exportDeidentified` write the copy. The file itself is never
  written to. A layer holds real values, like the vault, and stays on this computer.
- **Mask or redact.** A masked value gets a stand-in and goes to the vault; a redacted one
  becomes `[REDACTED]` or a black box and goes nowhere. Finding makes no stand-in
  (`Pseudonymizer.find`): the vault is written only when a layer is applied, and only for
  masked items, so a redacted document leaves nothing behind. The document has a mode and each
  item may differ from it, `keep` included.
- **A PDF is its pages as pictures** (`pdfPages.ts`). A PDF's own text is not what a person
  sees: Arabic is stored in drawing order and a filled form keeps its answers in annotations.
  Each page is drawn here with pdf.js, read like any picture, and the copy is a new PDF made of
  the painted pages only: no text layer, annotation, link or metadata is carried over.
- **Office files are edited in place** (`formats/ooxml.ts`): only the characters that change are
  rewritten in the XML, so layout and styles come out as they went in. Embedded pictures go
  through the same reading and painting as any picture. An `.xlsx` cell is rewritten in the
  cell and its old shared string blanked.
- **An edited file makes its layer stale** (`reconcileLayerOnFileChange`): the layer is kept by
  project and path, compared by content hash, and a person's choices and marks are carried over
  where they still hold.

Three things to know before wiring it in:

- `pdfjs-dist`, `@napi-rs/canvas`, `zxing-wasm` and `jszip` are loaded on first use and read
  files from their own packages (fonts, WebAssembly). A packaged server has to ship them as it
  ships `sharp`.
- Every picture and every PDF page is one call to the reading service (`verify` is off here: a
  person reviews the result). Without a reader, pictures and pages are checked for codes only
  and hidden whole until a person opens them.
- A layer's `warnings` name what was not checked: drawings that are not pixels in Office files,
  and an `.xlsx` file's comments, drawings, pictures and pivot tables.

## Sealed documents and the worker

`src/worker/` holds what `ask_documents` and `fill_sealed` do: the encrypted store, the worker
client (Chat Completions or Responses, any OpenAI-compatible address), the checks of each answer
against the document, the interpreter for the agent's programs, the sealing of values, the count
of answers given in clear and the record of them. The gateway's part is small:

- A text that holds wording of a sealed document is not sent: a tool result is replaced whole
  by a note, and what the person typed loses only the copied passage (`withholdSealedText`).
- Assistant text in which sealed values were restored is put back as the model wrote it when
  the client sends it again (`Restorations`).
- With `secondPass` on, the worker also reads each new text before it is masked and names
  reference numbers and places for the detector's result to include.

The decisions and their reasons are in `docs/internals/sealed-documents.md`.

## What a turn is told

`src/turns.ts` adds up, chat by chat, what the gateway did: requests rewritten and refused, the
distinct stand-ins it wrote, attachments covered, read or withheld. It reads these from the
record each request already produces; no text is checked a second time for it. A request is tied
to a chat by the name the provider's own program puts in it (`sessionsNamedIn`); a request that
names none is counted apart and marked as such. The server takes a chat's share when a run ends
(`takeTurn`) and keeps counts by kind on the run. The stand-ins of the last 500 turns are kept in
`turns.json` beside the vault, so the app can show each beside its value; that file holds no
value. Nothing here says what the gateway missed, and no screen may word it as if it did.

## Switches set for a masked session

`MASKED_SESSION_SWITCHES` in `src/index.ts` is the whole list. Each is a documented Claude Code
variable that stops content from reaching Anthropic on a route the gateway does not rewrite.
Usage metrics stay on unless the user turns them off in Settings, which adds
`DISABLE_TELEMETRY=1`.

## Evaluation switches

`DOEDESK_EVAL_OCR_ONLY`, `DOEDESK_EVAL_SENT_BODIES_FILE`, `DOEDESK_EVAL_EVENTS_FILE`,
`DOEDESK_EVAL_WORKER_FILE`, `DOEDESK_EVAL_HOSTS_FILE`, `DOEDESK_EVAL_WORKER_UNCHECKED`,
`DOEDESK_EVAL_WORKER_FREETEXT` and `DOEDESK_EVAL_SEALED_ASK_FREELY` are read
by the server at start, never from settings. The files they name hold confidential text.
