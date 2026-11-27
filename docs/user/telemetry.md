# Product usage data and diagnostics

## Product usage data

Usage data tells DoeDesk which features are used. The DoeDesk server sends it to DoeDesk Cloud at
`api.doedesk.com/ingest`; DoeDesk Cloud stores the events itself and does not forward them to an
analytics company.

Nothing is sent until you have seen the choice. Where the law requires your agreement first,
DoeDesk asks at first run with an unticked box, and sends nothing unless you tick it. Elsewhere it
tells you at first run that usage data is on and shows the switch. DoeDesk decides which applies
from the country of your connection, your system's region and its time zone, and asks first
whenever one of them points to a place that requires it or the country cannot be told.

Each event carries a random installation identifier. DoeDesk makes it on your computer the first
time usage data is on. It is not derived from your DoeDesk account, your AI provider account or
your device, and turning usage data off discards it. **Settings > Privacy > Usage data** shows the
identifier, so you can quote it in a privacy request.

Events include the provider, model, reasoning effort, permission mode, turn and request results,
duration, release channel, and token counts when available. Model names are sent only when they
appear in a provider's public model list. Events do not include prompts, responses, file contents,
names or other masked values, authentication tokens, conversation IDs, raw provider events,
child-agent output, your phone number, your email address or your answers to the two questions.

## Turn usage data off

Turn off **Send usage data** in **Settings > Privacy**. The setting takes effect at once. These
turn it off as well:

- **Server / CLI**: Set `T3CODE_TELEMETRY_ENABLED=false` or `DO_NOT_TRACK=1` before starting (`DO_NOT_TRACK=1` takes precedence). CI environments (`CI`, `GITHUB_ACTIONS`, `GITLAB_CI`, `JENKINS_URL`) send nothing unless `T3CODE_TELEMETRY_ENABLED=true`.
- **Desktop app**: Export `T3CODE_TELEMETRY_ENABLED=false` or `DO_NOT_TRACK=1` in your shell profile (macOS/Linux) or user environment variables (Windows) and restart.
- **Managed policy**: Administrators can set `"telemetry": false` in [managed policy](./managed-policy.md#other-capabilities) for servers and desktop apps.
- **Mobile app**: Toggle **Send crash reports** and **Send connection traces** separately in **Settings → About → Diagnostics**.

## Relay connection diagnostics

T3 Connect sends connection timings, request paths, environment/thread IDs, and error types (no addresses, logs, or stack frames) to Axiom. Disabled by the server telemetry opt-outs above or by `T3CODE_OTEL_SDK_DISABLED` / `OTEL_SDK_DISABLED`.

## Agent feedback

Optional tool for agents to report DoeDesk bugs or missing capabilities. Reports go to DoeDesk Cloud, and only while usage data is on. Configure in **Settings → Labs → Agent feedback**:

- **Off** (default): Feedback tools and `t3 feedback` are disabled.
- **When I ask**: Agents submit a report only when you ask, shown as an interactive approval card before anything leaves your machine.
- **Automatic**: Also sends minimal automated reports (problem kind + tool/command name only—no text or conversation) when an agent hits a DoeDesk tool failure; enables `t3 feedback` CLI reporting (up to 10/hour).

Approval cards show exact payloads (expected/actual/workaround, turn outline with no text, and optional **Include the conversation** up to 16 KB). File paths, usernames, hostnames, git remotes, and secret-like strings are scrubbed before saving, and reports use one-off random IDs. Inspect local reports with `t3 feedback list [--json]`.

## Agent activity for mobile notifications

**Settings → Sharing & access → Publish agent activity** sends project/thread titles, model names, and turn status to the T3 Connect relay for [mobile notifications and live activities](./mobile-notifications.md). This is independent of telemetry—turn it off directly on the host if you don't want it.

## Export diagnostics to your own OpenTelemetry receiver

Open **Settings → Maintenance → Diagnostics** (per environment) and enter OTLP HTTP endpoints (e.g. `http://localhost:4318/v1/traces`), save, and restart the server. Use **Test** to verify connectivity.

`T3CODE_OTLP_*_URL` and standard `OTEL_EXPORTER_OTLP_*` env vars override saved settings (use `T3CODE_OTLP_HEADERS` / `T3CODE_OTLP_PROTOCOL=http/protobuf` or the standard `OTEL_EXPORTER_OTLP_*` equivalents for auth and protobuf).
