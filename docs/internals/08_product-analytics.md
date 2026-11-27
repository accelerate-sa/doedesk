# Product analytics

The server owns analytics delivery, opt-out, and identity for every connected client. Clients never
load an analytics browser SDK, and visiting hosted web without an authenticated connection does not
count as product use.

## Installations

An event is sent only while the person's choice allows it
([UsageDataConsent](../../apps/server/src/telemetry/UsageDataConsent.ts)): the analytics service
asks on every record and every send, and keeps nothing recorded before the choice. What the choice
is, and how the region rule decides it, is in
[Consent and account rights](../operations/consent-and-rights.md).

`distinct_id` and `installId` are the same random UUID, made when usage data is first on and
discarded when it is turned off. Count installations with it, and expect a new one after off and
on. Nothing ties an installation to a person: there are no owner events, and a connecting client
sends no account or device identifier. Do not add one; the Privacy Policy says there is none.

## Attribution boundaries

- Client dimensions (`surface`, etc.) belong to the event's WebSocket connection, never a
  server-global "current client". Keep client and server dimensions separate, and leave missing
  client metadata unknown rather than backfilling from server properties.
- Active-use reports count `client.turn.requested` (deduplicated by command ID), not connections
  (T3 Connect sessions renew hourly).

## Collection boundary and delivery

- Payloads stay strictly to product metadata, closed contract enums, and normalized measurements:
  never attach prompts, file paths, credentials, raw provider payloads, device names, conversation
  IDs, or user-named provider instance IDs. Models in the bundled manifest or a vendor's own
  model list report their catalog slug, with aliases and routed IDs mapped to it. Any other model
  ID can name a user, a deployment, or a local file, so it reports only `custom:<driver>`.
- The sole exception is opt-in `agent.feedback`, which
  [`FeedbackService`](../../apps/server/src/feedback/FeedbackService.ts) scrubs of paths, private
  values, and secret-shaped strings, and only attaches bounded conversation traces when the user
  explicitly previews and sends them. Each report is sent under its own id without `installId` or
  host properties, in a request of its own, so it links to no install or other report; reports sent
  without a preview carry only their categories. Like every event, a report goes to DoeDesk Cloud and only
  while usage data is on.
- Delivery ([`AnalyticsService.ts`](../../apps/server/src/telemetry/AnalyticsService.ts)) attaches a
  UUID per event, backs off on failure, and drops batches after bounded retries so a stuck batch
  cannot loop forever.
- Dev-runner servers and servers on CI runners disable telemetry (and relay tracing) by default so
  they do not inflate install counts. CI detection is `isCiEnvironment` in
  [`otelEnvironment.ts`](../../packages/shared/src/otelEnvironment.ts). An explicit
  `T3CODE_TELEMETRY_ENABLED=true` overrides both defaults; `DO_NOT_TRACK`, a managed policy that
  denies telemetry, and the person's own choice each override that.
