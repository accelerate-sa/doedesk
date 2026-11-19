# How DoeDesk connects to each AI company

Written 18 November 2026. Measurements were made that day on macOS with Claude Code 2.1.327
(Agent SDK 0.3.321) on a Claude subscription login and Codex 0.169.0 on a ChatGPT login. Every
web page cited was read on that date. Re-measure after a vendor release before relying on a row:
`node packages/privacy-gateway/scripts/conformance-real.ts <front end> <empty folder>`.

## Summary

| Provider                                     | Masking off, or provider switched to direct                                                                                                                  | Masking on                                                                                                                                                                        | Vendor documentation for the setup                                                                                                                                                                                                                                                                           |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Claude (Claude Code through the Agent SDK)   | The app adds one variable, `CLAUDE_AGENT_SDK_CLIENT_APP=doedesk/<version>`. No proxy, certificate, base URL or switch. Claude Code talks to Anthropic itself | Proxy variables and DoeDesk's local certificate authority route Claude Code through the network gateway, which rewrites message content. Five documented switches are set (below) | Proxy and custom CA: <https://code.claude.com/docs/en/network-config>. App name: <https://code.claude.com/docs/en/agent-sdk/typescript> (`env`). Not supported by the vendor: changing the body. The gateway guide says "inspect without modifying" (<https://code.claude.com/docs/en/llm-gateway-protocol>) |
| Codex, the user's own install                | Nothing added                                                                                                                                                | Proxy variables and `CODEX_CA_CERTIFICATE` route Codex through the gateway. The gateway refuses Codex's WebSocket, and Codex continues over HTTPS                                 | Custom CA for a TLS proxy with ChatGPT login: <https://learn.chatgpt.com/docs/auth>. No page says whether a proxy may change the body                                                                                                                                                                        |
| Codex, signed in through DoeDesk ("managed") | Nothing added. DoeDesk holds the tokens of its own registered client and gives Codex an access token                                                         | Same gateway route as above                                                                                                                                                       | OpenAI's programme for open-source apps: <https://developers.openai.com/siwc/token-sharing-open-source> (registration, stored tokens, model list, Codex app-server)                                                                                                                                          |
| Cursor                                       | Nothing added                                                                                                                                                | Refused: the gateway blocks Cursor's model hosts, because their format cannot be masked                                                                                           | None read                                                                                                                                                                                                                                                                                                    |
| Every other provider                         | Nothing added                                                                                                                                                | Proxy variables and the local certificate authority; the gateway rewrites the request formats it knows and passes the rest                                                        | Not assessed per provider                                                                                                                                                                                                                                                                                    |

Switches set for a masked session, all documented by Anthropic in
<https://code.claude.com/docs/en/env-vars> and <https://code.claude.com/docs/en/data-usage>:
`DISABLE_ERROR_REPORTING=1`, `DISABLE_FEEDBACK_COMMAND=1`,
`CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY=1`, `CLAUDE_CODE_DISABLE_ARTIFACT=1`,
`ENABLE_CLAUDEAI_MCP_SERVERS=false`. Each stops content from reaching Anthropic on a route the
gateway does not rewrite. Claude Code's usage metrics are left on: Anthropic documents that they
hold no code, prompts or file paths, the recorded reports held none, and Anthropic staff named
missing telemetry as part of what made third-party traffic look unusual in January 2026. The
user can turn them off in Settings, Privacy, which adds `DISABLE_TELEMETRY=1`; that also stops
Claude Code's feature-flag fetch. DoeDesk does not change Codex's usage reports; OpenAI's switch
for them is `[analytics] enabled = false` in Codex's own config.

Changing masking, for everything or for one provider, rebuilds every provider instance. Its
running processes end, so none keeps the old route.

## What each AI company can observe

|           | Masking off or direct                                                                                                                                | Masking on                                                                                                                                                                                                                                                                                                                                                                                  |
| --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Anthropic | Claude Code's own requests, unchanged, with user agent `claude-cli/<v> (external, sdk-ts, agent-sdk/<v>, client-app/doedesk/<v>)`. Its usage reports | The same headers. Message content with stand-ins. Each request's fingerprint (`cch` in the first system block) was computed by Claude Code before the gateway changed the body, so it was computed over different content. HTTP/1.1 and Node's TLS in place of Claude Code's own connection. The five switches turn off error reports, feedback, the Artifact tool and claude.ai connectors |
| OpenAI    | Codex's own WebSocket and requests, unchanged                                                                                                        | HTTPS requests in place of the WebSocket, with stand-ins in the content, from Node's TLS. No request field that looked like a content fingerprint was seen; none was searched for beyond the field names                                                                                                                                                                                    |

DoeDesk does not forge, recompute or remove a fingerprint or any other integrity field. Whether
Anthropic compares `cch` with the body, logs a mismatch or scores it is not known. Masked
requests were accepted in every run.

## Measurements

"Left" means seen leaving this computer by the recorder (`src/observer.ts`, which forwards the
same bytes it received and checks that by hash) or, for gateway runs, by the gateway's record of
each body it sent. One session per row: a first turn with eight steps (read a file, list files, a
failing shell command, a search, an MCP tool, write a file, a command that needs a real value,
an edit), a second turn that delegates to a subagent, and for Claude a compaction and a question
after it. Four values were planted: a name, an ID number, a phone number and an IBAN.

| Front end                  | Messages seen | Planted values that left        | Real values written to the file | Edit applied                                | What went wrong                                                                                                                                                                        |
| -------------------------- | ------------- | ------------------------------- | ------------------------------- | ------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Claude through the gateway | 28            | 0                               | 4 of 4                          | Yes                                         | Nothing. Five usage reports and four feature-flag requests passed unchanged                                                                                                            |
| Codex through the gateway  | 54            | 0                               | 4 of 4                          | Yes                                         | Nothing. The WebSocket attempt failed and Codex used HTTPS. 28 usage reports and two metrics requests passed unchanged                                                                 |
| Claude with hooks only     | 43            | 12 occurrences, all four values | 4 of 4                          | Yes, after the model worked around the hook | See below                                                                                                                                                                              |
| Codex with hooks only      | 94            | 0                               | 4 of 4                          | Yes                                         | Every tool result reached the model framed as a failed script; the model reported one correct result as a failure. The MCP tool was not run (`codex exec` refuses it without approval) |

In the two gateway runs the vendor's client holds the real values, so its usage reports were
read as well: none held a planted value, the working folder's path, this computer's account
name, a file name or a command.

On the two hook rows the recorder confirmed that every request body reached the AI company
byte for byte as the vendor's client wrote it. On that path the fingerprint question does not
arise: nothing changes after the client computes it.

Hosts contacted directly by Claude Code with masking off: `api.anthropic.com` (messages, model
bootstrap, feature flags, usage reports, an MCP discovery probe at `/api/artifacts/mcp`),
`mcp-proxy.anthropic.com` (claude.ai connectors), and a Datadog intake host. Claude Code sends
each turn as a continuation of a thread held by Anthropic, so a request carries only the new
messages. By Codex: `chatgpt.com` (the model WebSocket, usage reports, plugin and model lists),
`ab.chatgpt.com` (metrics), `github.com`, and the user's own MCP servers.

`/api/artifacts/mcp` is not rewritten by the gateway. With masking on DoeDesk turns the Artifact
tool off with Anthropic's own switch, because a page the model writes would be published with the
real values restored.

Not measured: prompt-cache hit rates with and without masking; a PDF attachment through the real
gateway run (the unit tests cover it); sessions longer than about twenty requests; Windows and
Linux.

Measured on 19 November 2026, after images began to be sent redacted: one session each for
Claude and Codex through the app's own server, with a made-up letter attached, a made-up chat
screenshot opened by the agent's own image tool, and the `ocr_masked` tool called on the same
file. Six model requests each. Two images left in each session, both the redacted ones; read
again, neither showed any of the eleven planted values, and no planted value was in the text of
any request. Details and the corpus numbers:
[image-redaction.md](image-redaction.md).

## Masking through the vendors' own hooks: studied, built, not used

The idea: if the vendor's client builds its request from content that is already masked, nothing
is altered after the client signs it. Both vendors document hooks.

Claude Code hooks (<https://code.claude.com/docs/en/hooks>,
<https://code.claude.com/docs/en/agent-sdk/hooks>, and the SDK's type definitions):

| Event                                                                                                                      | Can change what the model sees                                           | Notes                                                                  |
| -------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ | ---------------------------------------------------------------------- |
| `UserPromptSubmit`, `UserPromptExpansion`                                                                                  | No: block, or add text                                                   | The app is the caller, so it masks the prompt before the SDK sees it   |
| `PreToolUse`                                                                                                               | Rewrites the tool's input (`updatedInput`), or denies                    | Runs after Claude Code's own check of the input                        |
| `PostToolUse`                                                                                                              | Replaces the tool's output (`updatedToolOutput`), built-in and MCP tools | Only for a tool that succeeded                                         |
| `PostToolUseFailure`, `PostToolBatch`                                                                                      | No: add text                                                             | A failed tool's message cannot be replaced                             |
| `SessionStart`, `SubagentStart`, `SubagentStop`, `Stop`, `Notification`, `PreCompact`, `PostCompact`, `InstructionsLoaded` | No: add text, block or observe                                           |                                                                        |
| `MessageDisplay`                                                                                                           | Display only                                                             | The app restores values in what it shows itself                        |
| Permission callback (`canUseTool`), custom tools, in-process MCP servers                                                   | The app's own tools return what the app decides                          | Would mean replacing Claude Code's file and shell tools with the app's |

Codex hooks (<https://learn.chatgpt.com/docs/hooks>):

| Event                                                                                                                       | Can change what the model sees                                                                          | Notes                                        |
| --------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- | -------------------------------------------- |
| `UserPromptSubmit`                                                                                                          | No: block, or add text                                                                                  | The app is the caller and masks the prompt   |
| `PreToolUse`                                                                                                                | Rewrites the input of shell, `apply_patch`, MCP and other local tools                                   |                                              |
| `PostToolUse`                                                                                                               | A blocking decision replaces the tool result with the hook's text. Runs after failed shell commands too | In code mode the script sees a rejected call |
| `PreModelRequest`, `PostModelRequest`, `PreCompact`, `PostCompact`, `SessionStart`, `SubagentStart`, `SubagentStop`, `Stop` | No                                                                                                      |                                              |
| Hosted tools such as web search                                                                                             | No hook                                                                                                 | They run at OpenAI                           |

Codex continues with the original tool result when a hook fails, times out or cannot start, and
its documentation says to "treat tool hooks as a useful guardrail, not a complete enforcement
boundary". Hooks that nobody reviewed in Codex's own screen are skipped unless Codex is started
with `--dangerously-bypass-hook-trust`.

### Coverage by route

"Gateway" is the network gateway. "Hooks" is the vendor's hook mechanism plus the app masking
what it hands over. Measured rows are marked M.

| Route to the AI company                                                    | Gateway                                                                                           | Claude hooks                                                                                                                      | Codex hooks                                                      |
| -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| The user's message                                                         | Masked (M)                                                                                        | App masks before the SDK (M)                                                                                                      | App masks before Codex (M)                                       |
| Attached images and PDFs                                                   | Images sent redacted (M, 19 November); PDFs replaced by read text, masked                         | App replaces before the SDK (M)                                                                                                   | App replaces before Codex (M)                                    |
| File contents read by a tool                                               | Masked (M)                                                                                        | `PostToolUse` (M)                                                                                                                 | `PostToolUse` (M)                                                |
| File and folder names in listings and search results                       | Masked (M)                                                                                        | `PostToolUse` (M)                                                                                                                 | `PostToolUse` (M)                                                |
| Shell output of a command that succeeds                                    | Masked (M)                                                                                        | `PostToolUse` (M)                                                                                                                 | `PostToolUse` (M)                                                |
| Shell output of a command that fails                                       | Masked (M)                                                                                        | **No native mechanism** (M: the name left)                                                                                        | `PostToolUse` (M)                                                |
| Any other failed tool's message                                            | Masked                                                                                            | **No native mechanism**                                                                                                           | `PostToolUse`                                                    |
| Web fetch                                                                  | Masked                                                                                            | **No native mechanism**: Claude Code sends the page to a model in a request of its own. The front end removes the tool            | No hook; hosted at OpenAI                                        |
| MCP tool result                                                            | Masked (M)                                                                                        | `PostToolUse` (M); a failed MCP call has no mechanism                                                                             | `PostToolUse` (not run in the measurement)                       |
| Subagent prompt and result                                                 | Masked (M)                                                                                        | Prompt left as the model wrote it; subagent tools covered by the same hooks (M)                                                   | Same (M)                                                         |
| Compaction summary                                                         | Masked (M)                                                                                        | Built from masked content                                                                                                         | Built from masked content                                        |
| System prompt and environment block: working folder, home folder           | Masked when the value is known to the vault. The vault starts with the account name and host name | **No native mechanism** (M). A symbolic link is resolved. `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1` removes the memory folder's path    | **No native mechanism** (M: skill folders under the home folder) |
| The signed-in account's email, which Claude Code adds to the first message | The account-name part is masked when it equals this computer's account name                       | **No native mechanism** (M)                                                                                                       | Not seen                                                         |
| Memory and instruction files                                               | Masked                                                                                            | No hook; the app would have to load and mask them itself                                                                          | No hook                                                          |
| Tool input the model writes, restored before it runs                       | Restored in the reply (M)                                                                         | `PreToolUse` for Read, Write, shell, search (M). **Edit is rejected before the hook runs** when its old text names a stand-in (M) | `PreToolUse`, including `apply_patch` (M)                        |
| Text the model writes to files                                             | Real values (M)                                                                                   | Real values (M)                                                                                                                   | Real values (M)                                                  |
| What the user reads, including reasoning summaries                         | Restored in the reply (M)                                                                         | App restores (M)                                                                                                                  | App restores (M)                                                 |

### What the real Claude run showed

With hooks only, the failed `cat` put the client's name into the conversation. The rejected Edit
then led the model to read the file's bytes with `od`, whose output the masking does not
recognise, and from there the model wrote all four real values in its own messages and in a
subagent's task. A mask that the client's own behaviour contradicts invites the model to look
behind it.

### Decision

A front end carries sessions only when it passes the conformance suite. The gateway passes.
Claude hooks fail three scenarios and Codex hooks fail one (`KNOWN_FAILURES` in
`src/conformance.test.ts`), so both providers stay on the gateway, and both hook front ends stay
in the package with their tests.

Open for the owner:

- Codex hooks are close. What separates them from use is the folder paths Codex writes into its
  own instructions, that a hook which does not run lets the original through, the
  `--dangerously-bypass-hook-trust` flag, and that every result reads as a failed script.
- Claude would need the app's own file and shell tools in place of Claude Code's (the Agent SDK
  documents custom tools), and would still send folder paths and the account email.
- Anthropic documents `ANTHROPIC_BASE_URL` for a gateway with a subscription login, and says the
  attribution block is then stable for the conversation. It was not implemented: the body would
  still be changed, which the same guide does not support.

## What was removed

Everything in this table came from T3 Code; none was added in this fork.

| Removed                                                         | What it did                                                                                                                      | Replaced by                                                                                                               |
| --------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `provider/claudeResetCredits.ts`                                | On Linux and Windows read the Claude login token and called Anthropic's usage and reset endpoints with user agent `claude-cli/…` | Nothing. Claude reset credits are no longer shown or redeemable. Usage limits still come from Claude Code through the SDK |
| `provider/antigravityUsageLimits.ts`                            | Refreshed Google tokens from Antigravity's token file and called Google with Antigravity's user agent                            | Nothing. Antigravity usage limits are no longer shown                                                                     |
| `usage/cliproxyApi.ts` and the hub settings                     | Had an account hub call Anthropic, xAI and Google under each vendor's client name                                                | Nothing. The service reports no hubs; the Settings section is gone                                                        |
| Grok usage read (`provider-grok/…/usageLimits.ts`)              | Read Grok's stored login and asked xAI for usage                                                                                 | Nothing                                                                                                                   |
| OpenCode Go usage read (`provider-opencode/…/usageLimits.ts`)   | Read OpenCode's stored keys and asked opencode.ai for usage                                                                      | OpenCode 2 reports usage through its own server; older versions show none                                                 |
| Cursor usage and account history (`provider-cursor`)            | Traded the user's Cursor key for a session and read Cursor's dashboard service as client type `cli`                              | Nothing                                                                                                                   |
| Provider logins in analytics identity (`telemetry/Identify.ts`) | Read `~/.codex/auth.json` and `~/.claude.json` to name an install                                                                | A random id in DoeDesk's own folder                                                                                       |
| `CLAUDE_CODE_ENTRYPOINT=t3-code`                                | Overrode Claude Code's own entry point label with another product's name                                                         | `CLAUDE_AGENT_SDK_CLIENT_APP`                                                                                             |
| The gateway's reply to usage reports                            | Answered `200 {}` in the AI company's place                                                                                      | Reports are forwarded as written                                                                                          |
| `DISABLE_TELEMETRY`, `DO_NOT_TRACK` for every agent             | Turned Claude Code's metrics off                                                                                                 | Off only when the user says so                                                                                            |

Kept, and why: DoeDesk's own ChatGPT sign-in for managed Codex stores and refreshes tokens and
lists models with them. That is the client OpenAI's open-source programme describes, registered
under DoeDesk's own name. Reading `~/.claude.json` for the organisation and account identifiers
stays: the file holds no token. Text generators call a vendor's public API with a key the user
typed into DoeDesk.

## Other providers

| Provider                                    | How it signs in                                                                                           | Treatment                                                                                                                                                                      |
| ------------------------------------------- | --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Antigravity                                 | DoeDesk runs Google's own agent program over its ACP interface and passes on its Google sign-in page      | Offered only in Developer mode, with a warning. Google has said that third-party tools on an Antigravity login break its terms; whether Google counts this as one is not known |
| pi                                          | pi's own `/login`, which can sign in to Claude, ChatGPT, Gemini and Copilot plans as a program of its own | Offered only in Developer mode, with a warning. An API key in pi is not affected                                                                                               |
| Cursor, Grok, Kiro                          | Each vendor's own CLI with its own sign-in                                                                | No change beyond the removals above                                                                                                                                            |
| OpenCode                                    | Its own subscription or keys, and sign-ins to other companies that were not checked                       | Not assessed                                                                                                                                                                   |
| Muse Code, fx, agents from the ACP registry | Not checked                                                                                               | Not assessed                                                                                                                                                                   |

## What remains risky

- Masked requests are changed after the vendor's client wrote them. Anthropic's gateway guide
  does not support that, and Anthropic can see it. No rule against it and no reported account
  action was found; neither company has said it accepts it.
- Usage on a subscription login is expected to be ordinary individual use. An automated
  evaluation of many runs on one plan is a separate risk, described in the risk assessment.
- The gateway's protection ends where a tool changes the form of a value. `od`, `base64` or a
  split across lines hides a value from the detector.
