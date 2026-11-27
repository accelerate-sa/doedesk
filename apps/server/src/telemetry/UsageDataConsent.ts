/**
 * Whether usage data may be sent from this installation, and under which identifier.
 *
 * The rule is the consent specification, section 11: nothing is sent until the person has seen
 * the choice or the notice; the identifier is random, made here the first time usage data is on,
 * and discarded when it is turned off.
 */
import {
  type PrivacyLocale,
  UsageDataBasis,
  UsageDataState,
  type UsageDataStatus,
} from "@t3tools/contracts";
import { writeFileStringAtomically } from "@t3tools/shared/atomicWrite";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { isCiEnvironment, isDoNotTrackSet } from "@t3tools/shared/otelEnvironment";
import * as Config from "effect/Config";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpClientResponse from "effect/http/HttpClientResponse";

import packageJson from "../../package.json" with { type: "json" };
import * as ServerConfig from "../config.ts";
import * as ManagedPolicy from "../policy/ManagedPolicy.ts";
import * as ServerSettings from "../serverSettings.ts";
import { decideUsageDataBasis, type UsageDataSignal } from "./UsageDataRegion.ts";

const Signal = Schema.Literals(["network", "locale", "timezone"]);
const Locale = Schema.Literals(["en", "ar"]);

/** One change of state that DoeDesk Cloud has not yet been told about. */
const ChoiceReport = Schema.Struct({
  installId: Schema.String,
  state: Schema.Literals(["on_consented", "on_by_default_notice_shown", "off"]),
  at: Schema.String,
  wordingId: Schema.String,
  basis: Schema.NullOr(UsageDataBasis),
  signal: Schema.NullOr(Signal),
  locale: Schema.NullOr(Locale),
});
type ChoiceReport = typeof ChoiceReport.Type;

const StoredUsageData = Schema.Struct({
  state: UsageDataState,
  /** When the state was last set by the person, or by showing the notice. */
  at: Schema.NullOr(Schema.String),
  basis: Schema.NullOr(UsageDataBasis),
  signal: Schema.NullOr(Signal),
  /** Which wording the person saw when the state was set. */
  wordingId: Schema.NullOr(Schema.String),
  locale: Schema.NullOr(Locale),
  installId: Schema.NullOr(Schema.String),
  unreported: Schema.Array(ChoiceReport),
});
type StoredUsageData = typeof StoredUsageData.Type;

const decodeStored = Schema.decodeUnknownOption(Schema.fromJsonString(StoredUsageData));

const UNSET: StoredUsageData = {
  state: "unset",
  at: null,
  basis: null,
  signal: null,
  wordingId: null,
  locale: null,
  installId: null,
  unreported: [],
};

/** Where usage events and the record of the choice are sent. The key is public; it is not a secret. */
export const IngestConfig = Config.all({
  key: Config.String("T3CODE_TELEMETRY_KEY").pipe(Config.withDefault("doedesk-client")),
  host: Config.String("T3CODE_TELEMETRY_HOST").pipe(
    Config.withDefault("https://api.doedesk.com/ingest"),
  ),
});

/** DoeDesk Cloud, which says whether usage data needs agreement first where a connection comes from. */
const CloudUrlConfig = Config.String("DOEDESK_CLOUD_URL").pipe(
  Config.withDefault("https://api.doedesk.com"),
);

const NetworkAnswer = Schema.Struct({
  usageData: UsageDataBasis,
  usageDataConsentRegions: Schema.optionalKey(Schema.Array(Schema.String)),
});
const decodeNetworkAnswer = Schema.decodeUnknownOption(NetworkAnswer);

/** A CI runner is no one's installation, so it sends nothing unless the variable says to. */
const enabledConfig = (byDefault: boolean) =>
  Config.Boolean("T3CODE_TELEMETRY_ENABLED").pipe(Config.withDefault(byDefault));

/** This computer's own time zone, as a second witness beside the one the window reports. */
export const HostTimeZone = Context.Reference<string | null>(
  "t3/telemetry/UsageDataConsent/HostTimeZone",
  { defaultValue: () => Intl.DateTimeFormat().resolvedOptions().timeZone ?? null },
);

/** What an event is sent with while usage data is on. */
export interface UsageDataSending {
  /** The random installation identifier: both `distinct_id` and `installId`. */
  readonly installId: string;
  /** Present when the person agreed: which wording they agreed to, and when. */
  readonly consent: { readonly wordingId: string; readonly at: string } | undefined;
}

export class UsageDataConsent extends Context.Service<
  UsageDataConsent,
  {
    readonly status: Effect.Effect<UsageDataStatus>;
    /** None while nothing may be sent: no choice yet, turned off, or switched off from outside. */
    readonly sending: Effect.Effect<Option.Option<UsageDataSending>>;
    /**
     * Decides which rule applies here, from the country DoeDesk Cloud reports for this connection
     * and from the region and time zone of the device asking and of this computer. A choice the
     * person made is never changed; usage data that is on only by default is paused when the
     * place now needs agreement first.
     */
    readonly decide: (input: {
      readonly locale: string | null;
      readonly timeZone: string | null;
    }) => Effect.Effect<UsageDataStatus>;
    /** The person's own choice. Turning it off discards the identifier. */
    readonly choose: (input: {
      readonly on: boolean;
      readonly wordingId: string;
      readonly locale: PrivacyLocale;
    }) => Effect.Effect<UsageDataStatus>;
    /** The person continued past the notice that says usage data is on. */
    readonly noticeShown: (input: {
      readonly wordingId: string;
      readonly locale: PrivacyLocale;
    }) => Effect.Effect<UsageDataStatus>;
    /**
     * Completes when the latest change has been told to DoeDesk Cloud, or telling it has failed
     * for now. A change is reported beside the request that made it, so nothing waits on this.
     */
    readonly reported: Effect.Effect<void>;
  }
>()("t3/telemetry/UsageDataConsent") {}

const isOn = (state: UsageDataState): boolean =>
  state === "on_consented" || state === "on_by_default_notice_shown";

const make = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const { usageDataPath, anonymousIdPath } = yield* ServerConfig.ServerConfig;
  const hostEnvironment = yield* HostProcess.Environment;
  const hostTimeZone = yield* HostTimeZone;
  const ingest = yield* IngestConfig;
  const cloudUrl = (yield* CloudUrlConfig).replace(/\/+$/, "");
  const enabledByDefault = !isCiEnvironment(hostEnvironment);
  const enabledAtStart = yield* enabledConfig(enabledByDefault);
  const httpClient = yield* HttpClient.HttpClient;
  const crypto = yield* SecureRandom.SecureRandom;
  const platform = yield* HostProcess.Platform;
  // A managed policy can switch usage data off over the environment, never on.
  const policyAllows =
    ManagedPolicy.deniedBy(yield* ManagedPolicy.ManagedPolicy, "telemetry") === undefined;
  const serverSettings = yield* Effect.serviceOption(ServerSettings.ServerSettingsService);
  const awaitingShellConsent = hostEnvironment.T3CODE_DESKTOP_SHELL_DISCOVERY_PENDING === "1";

  // A cached PATH does not establish consent from the current login shell.
  const environmentAllows = Effect.suspend(() => {
    if (!enabledAtStart || isDoNotTrackSet(hostEnvironment)) return Effect.succeed(false);
    if (!awaitingShellConsent) return Effect.succeed(true);
    if (hostEnvironment.T3CODE_DESKTOP_SHELL_DISCOVERY_PENDING === "1")
      return Effect.succeed(false);
    const preference = hostEnvironment.T3CODE_TELEMETRY_ENABLED;
    return enabledConfig(enabledByDefault).pipe(
      Effect.provideService(
        ConfigProvider.ConfigProvider,
        ConfigProvider.fromEnv({
          env: preference === undefined ? {} : { T3CODE_TELEMETRY_ENABLED: preference },
        }),
      ),
      Effect.orElseSucceed(() => false),
    );
  });
  // The switch in the settings file. Read on every send, so turning it off stops events at once;
  // a settings file that cannot be read counts as off.
  const settingAllows = Option.match(serverSettings, {
    onNone: () => Effect.succeed(true),
    onSome: (service) =>
      service.getSettings.pipe(
        Effect.map((settings) => settings.usageDataEnabled),
        Effect.orElseSucceed(() => false),
      ),
  });
  const blockedBy = Effect.map(environmentAllows, (allowed) =>
    !policyAllows ? ("policy" as const) : allowed ? null : ("environment" as const),
  );

  // Apps before 0.2 kept a random identifier here and sent a hash of it without asking. It is
  // discarded; a new one is made only once the person has seen the choice or the notice.
  yield* fileSystem.remove(anonymousIdPath, { force: true }).pipe(Effect.ignore);

  const persist = (record: StoredUsageData) =>
    writeFileStringAtomically({
      filePath: usageDataPath,
      contents: `${JSON.stringify(record)}\n`,
    }).pipe(
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(Path.Path, path),
      Effect.provideService(HostProcess.Platform, platform),
      Effect.catch((cause) =>
        Effect.logWarning("Could not save the usage-data choice", { errorTag: cause._tag }),
      ),
    );

  const readStored = fileSystem.readFileString(usageDataPath).pipe(
    Effect.map(decodeStored),
    Effect.orElseSucceed(() => Option.none<StoredUsageData>()),
  );

  const lock = yield* Semaphore.make(1);
  const recordRef = yield* Ref.make<StoredUsageData | undefined>(undefined);

  const newIdentifier = crypto.uuidV4().pipe(Effect.option);
  const now = Effect.map(DateTime.now, DateTime.formatIso);

  const sendReport = (report: ChoiceReport) =>
    HttpClientRequest.post(`${ingest.host}/choice`).pipe(
      HttpClientRequest.bodyJson({
        api_key: ingest.key,
        installId: report.installId,
        state: report.state,
        at: report.at,
        wordingId: report.wordingId,
        ...(report.basis === null ? {} : { basis: report.basis }),
        ...(report.signal === null ? {} : { signal: report.signal }),
        ...(report.locale === null ? {} : { locale: report.locale }),
        appVersion: packageJson.version,
      }),
      Effect.flatMap(httpClient.execute),
      Effect.timeout("10 seconds"),
      // Sent: told. Refused as malformed: telling it again cannot help. Anything else: try later.
      Effect.map((response) => response.status < 500 && response.status !== 429),
      Effect.orElseSucceed(() => false),
    );

  /**
   * Asks DoeDesk Cloud which rule applies to the country this connection comes from. The request
   * carries no sign-in and no identifier. None when it could not be asked or was not understood.
   */
  const askNetwork = HttpClientRequest.get(`${cloudUrl}/v1/auth/options`).pipe(
    httpClient.execute,
    Effect.flatMap(HttpClientResponse.filterStatusOk),
    Effect.flatMap((response) => response.json),
    Effect.timeout("10 seconds"),
    Effect.map(decodeNetworkAnswer),
    Effect.orElseSucceed(() => Option.none<typeof NetworkAnswer.Type>()),
  );

  const reporting = yield* Semaphore.make(1);
  /**
   * Tells DoeDesk Cloud about each change it has not heard of. One that fails waits for the next
   * change or the next start. The record is not held while the network is: sending reads it too.
   */
  const report = Effect.gen(function* () {
    const pending = (yield* Ref.get(recordRef))?.unreported ?? [];
    if (pending.length === 0 || (yield* blockedBy) !== null) return;
    const told = new Set<ChoiceReport>();
    for (const entry of pending) {
      if (yield* sendReport(entry)) told.add(entry);
    }
    if (told.size === 0) return;
    yield* Effect.gen(function* () {
      const current = yield* Ref.get(recordRef);
      if (current === undefined) return;
      const next = {
        ...current,
        unreported: current.unreported.filter((entry) => !told.has(entry)),
      };
      yield* Ref.set(recordRef, next);
      yield* persist(next);
    }).pipe(lock.withPermit);
  }).pipe(reporting.withPermit);

  const lastReport = yield* Ref.make<Fiber.Fiber<void> | undefined>(undefined);
  /** Reports beside the request that caused the change, so a slow network delays nobody. */
  const reportSoon = Effect.forkDetach(report).pipe(
    Effect.flatMap((fiber) => Ref.set(lastReport, fiber)),
  );
  const reported = Ref.get(lastReport).pipe(
    Effect.flatMap((fiber) => (fiber === undefined ? Effect.void : Fiber.await(fiber))),
    Effect.asVoid,
  );
  // Quitting does not wait for the network: a report that was cut short is sent at the next start.
  yield* Effect.addFinalizer(() =>
    Ref.get(lastReport).pipe(
      Effect.flatMap((fiber) => (fiber === undefined ? Effect.void : Fiber.interrupt(fiber))),
    ),
  );

  const save = Effect.fn("UsageDataConsent.save")(function* (record: StoredUsageData) {
    yield* Ref.set(recordRef, record);
    yield* persist(record);
  });

  const turnedOff = (record: StoredUsageData, at: string, wordingId: string): StoredUsageData => ({
    ...record,
    state: "off",
    at,
    wordingId,
    installId: null,
    // The last word under an identifier is that it was switched off.
    unreported:
      record.installId === null
        ? record.unreported
        : [
            ...record.unreported,
            {
              installId: record.installId,
              state: "off",
              at,
              wordingId,
              basis: record.basis,
              signal: record.signal,
              locale: record.locale,
            },
          ],
  });

  /**
   * The record as it stands, read from disk the first time. The settings file wins: when its
   * switch is off, usage data is off here too and the identifier goes.
   */
  const load = Effect.gen(function* () {
    const settingOn = yield* settingAllows;
    const known = yield* Ref.get(recordRef);
    const record =
      known ??
      Option.getOrElse(yield* readStored, () =>
        // An installation that had usage data switched off keeps it off and is not asked.
        settingOn ? UNSET : { ...UNSET, state: "off" as const },
      );
    if (!settingOn && isOn(record.state)) {
      const off = turnedOff(record, yield* now, record.wordingId ?? "settings-file");
      yield* save(off);
      yield* reportSoon;
      return off;
    }
    if (known === undefined) yield* Ref.set(recordRef, record);
    return record;
  });

  const statusOf = Effect.fn("UsageDataConsent.statusOf")(function* (record: StoredUsageData) {
    const blocked = yield* blockedBy;
    return {
      state: record.state,
      basis: record.basis,
      installId: record.installId,
      sending: blocked === null && isOn(record.state) && record.installId !== null,
      blockedBy: blocked,
    } satisfies UsageDataStatus;
  });

  const status = load.pipe(lock.withPermit, Effect.flatMap(statusOf));

  const sending: UsageDataConsent["Service"]["sending"] = Effect.gen(function* () {
    if ((yield* blockedBy) !== null) return Option.none();
    const record = yield* load.pipe(lock.withPermit);
    if (!isOn(record.state) || record.installId === null) return Option.none();
    return Option.some({
      installId: record.installId,
      consent:
        record.state === "on_consented" && record.wordingId !== null && record.at !== null
          ? { wordingId: record.wordingId, at: record.at }
          : undefined,
    });
  });

  const changed = (record: StoredUsageData) => Effect.as(save(record), record);

  const decide: UsageDataConsent["Service"]["decide"] = Effect.fn("UsageDataConsent.decide")(
    function* (input) {
      const network = Option.getOrNull(yield* askNetwork);
      const record = yield* Effect.gen(function* () {
        const current = yield* load;
        const decision = decideUsageDataBasis({
          network: network?.usageData ?? null,
          consentRegions: network?.usageDataConsentRegions ?? null,
          locales: [
            input.locale,
            hostEnvironment.LC_ALL ?? hostEnvironment.LC_MESSAGES ?? hostEnvironment.LANG,
          ],
          timeZones: [input.timeZone, hostTimeZone],
        });
        const signal: UsageDataSignal = decision.signal;
        switch (current.state) {
          // An explicit choice stands wherever the person goes.
          case "on_consented":
          case "off":
            return current;
          case "unset":
            return current.basis === decision.basis && current.signal === signal
              ? current
              : yield* changed({ ...current, basis: decision.basis, signal });
          case "on_by_default_notice_shown": {
            if (decision.basis === "notice") return current;
            // On only by default, and this place needs agreement first: stop, and ask.
            const off = turnedOff(current, yield* now, current.wordingId ?? "region-changed");
            return yield* changed({
              ...off,
              state: "unset",
              at: null,
              wordingId: null,
              basis: "ask",
              signal,
            });
          }
        }
      }).pipe(lock.withPermit);
      yield* reportSoon;
      return yield* statusOf(record);
    },
  );

  const choose: UsageDataConsent["Service"]["choose"] = Effect.fn("UsageDataConsent.choose")(
    function* (input) {
      if ((yield* blockedBy) !== null) return yield* status;
      // The settings file wins over this record, so the two are changed together.
      if (Option.isSome(serverSettings)) {
        yield* serverSettings.value
          .updateSettings({ usageDataEnabled: input.on })
          .pipe(Effect.ignore);
      }
      const record = yield* Effect.gen(function* () {
        const current = yield* load;
        const at = yield* now;
        if (!input.on) return yield* changed(turnedOff(current, at, input.wordingId));
        const installId = current.installId ?? Option.getOrNull(yield* newIdentifier);
        if (installId === null) return current;
        return yield* changed({
          ...current,
          state: "on_consented",
          at,
          wordingId: input.wordingId,
          locale: input.locale,
          installId,
          unreported: [
            ...current.unreported,
            {
              installId,
              state: "on_consented",
              at,
              wordingId: input.wordingId,
              basis: current.basis,
              signal: current.signal,
              locale: input.locale,
            },
          ],
        });
      }).pipe(lock.withPermit);
      yield* reportSoon;
      return yield* statusOf(record);
    },
  );

  const noticeShown: UsageDataConsent["Service"]["noticeShown"] = Effect.fn(
    "UsageDataConsent.noticeShown",
  )(function* (input) {
    if ((yield* blockedBy) !== null) return yield* status;
    const record = yield* Effect.gen(function* () {
      const current = yield* load;
      // Only where the rule is "notice", and only before the person has chosen anything.
      if (current.state !== "unset" || current.basis !== "notice") return current;
      const installId = Option.getOrNull(yield* newIdentifier);
      if (installId === null) return current;
      const at = yield* now;
      return yield* changed({
        ...current,
        state: "on_by_default_notice_shown",
        at,
        wordingId: input.wordingId,
        locale: input.locale,
        installId,
        unreported: [
          ...current.unreported,
          {
            installId,
            state: "on_by_default_notice_shown",
            at,
            wordingId: input.wordingId,
            basis: current.basis,
            signal: current.signal,
            locale: input.locale,
          },
        ],
      });
    }).pipe(lock.withPermit);
    yield* reportSoon;
    return yield* statusOf(record);
  });

  return UsageDataConsent.of({ status, sending, decide, choose, noticeShown, reported });
});

export const layer = Layer.effect(UsageDataConsent, make);
