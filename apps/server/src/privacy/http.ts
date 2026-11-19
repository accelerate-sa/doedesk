import {
  AuthOrchestrationReadScope,
  AuthSettingsWriteScope,
  EnvironmentHttpApi,
} from "@t3tools/contracts";
import type { RedactionRecord } from "@t3tools/privacy-gateway";
import * as Effect from "effect/Effect";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";

import { annotateEnvironmentRequest, requireEnvironmentScope } from "../auth/http.ts";
import * as UsageDataConsent from "../telemetry/UsageDataConsent.ts";
import * as PrivacyGateway from "./PrivacyGateway.ts";

/** A record as the app shows it: no reason text, which is for the model and the log. */
const publicRedaction = (record: RedactionRecord) => ({
  id: record.id,
  at: record.at,
  kind: record.kind,
  outcome: record.outcome,
  hasImage: record.hasImage,
  hasText: record.hasText,
  width: record.width,
  height: record.height,
  valueBoxes: record.valueBoxes,
  unreadableBoxes: record.unreadableBoxes,
});

export const layer = HttpApiBuilder.group(
  EnvironmentHttpApi,
  "privacy",
  Effect.fnUntraced(function* (handlers) {
    const privacy = yield* PrivacyGateway.PrivacyGateway;
    const usageData = yield* UsageDataConsent.UsageDataConsent;

    return handlers
      .handle(
        "status",
        Effect.fn("environment.privacy.status")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthOrchestrationReadScope);
          return yield* privacy.status;
        }),
      )
      .handle(
        "configure",
        Effect.fn("environment.privacy.configure")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthSettingsWriteScope);
          const result = yield* privacy.configure(args.payload);
          return { ...result, status: yield* privacy.status };
        }),
      )
      .handle(
        "signIn",
        Effect.fn("environment.privacy.signIn")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthSettingsWriteScope);
          const result = yield* privacy.signIn(args.payload);
          return { ...result, status: yield* privacy.status };
        }),
      )
      .handle(
        "profile",
        Effect.fn("environment.privacy.profile")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthSettingsWriteScope);
          // The answers go to the account and nowhere else: no usage event repeats them.
          yield* privacy.saveProfile(args.payload);
          return yield* privacy.status;
        }),
      )
      .handle(
        "preference",
        Effect.fn("environment.privacy.preference")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthSettingsWriteScope);
          yield* privacy.setPreference(args.payload);
          return yield* privacy.status;
        }),
      )
      .handle(
        "account",
        Effect.fn("environment.privacy.account")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthSettingsWriteScope);
          const result = yield* privacy.account(args.payload);
          return { ...result, status: yield* privacy.status };
        }),
      )
      .handle(
        "usageData",
        Effect.fn("environment.privacy.usageData")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthOrchestrationReadScope);
          return yield* usageData.status;
        }),
      )
      .handle(
        "setUsageData",
        Effect.fn("environment.privacy.setUsageData")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthSettingsWriteScope);
          const request = args.payload;
          switch (request.action) {
            case "choose":
              return yield* usageData.choose(request);
            case "noticeShown":
              return yield* usageData.noticeShown(request);
            case "decide":
              return yield* usageData.decide(request);
          }
        }),
      )
      .handle(
        "activity",
        Effect.fn("environment.privacy.activity")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthOrchestrationReadScope);
          const records = yield* privacy.activity;
          return {
            entries: records.map((record) => ({
              at: record.at,
              host: record.host,
              outcome: record.outcome,
              masked: record.masked ?? 0,
              withheld: record.withheld ?? 0,
              reason: record.reason ?? null,
            })),
          };
        }),
      )
      .handle(
        "vault",
        Effect.fn("environment.privacy.vault")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          // The vault holds the real values, so it needs the same right as changing settings.
          yield* requireEnvironmentScope(AuthSettingsWriteScope);
          return { entries: yield* privacy.vault };
        }),
      )
      .handle(
        "redactions",
        Effect.fn("environment.privacy.redactions")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthOrchestrationReadScope);
          return { entries: (yield* privacy.redactions).map(publicRedaction) };
        }),
      )
      .handle(
        "redactionFile",
        Effect.fn("environment.privacy.redactionFile")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          // What was sent holds stand-ins if redaction worked; it is treated as the vault is.
          yield* requireEnvironmentScope(AuthSettingsWriteScope);
          const file = yield* privacy.redactionFile(args.payload.id, args.payload.part);
          return {
            file:
              file === undefined
                ? null
                : {
                    fileName: file.fileName,
                    mediaType: file.mediaType,
                    data: file.bytes.toString("base64"),
                  },
          };
        }),
      )
      .handle(
        "clearRedactions",
        Effect.fn("environment.privacy.clearRedactions")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthSettingsWriteScope);
          yield* privacy.clearRedactions;
          return { entries: (yield* privacy.redactions).map(publicRedaction) };
        }),
      );
  }),
);
