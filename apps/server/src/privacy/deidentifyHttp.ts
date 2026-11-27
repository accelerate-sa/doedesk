import {
  AuthOrchestrationOperateScope,
  DEIDENTIFY_ROUTE_PREFIX,
  DeidentifyFileRef,
  DeidentifyFileRequest,
  DeidentifyInspectRequest,
  DeidentifyPolicyRequest,
  DeidentifyScanRequest,
  DeidentifyUpdateRequest,
} from "@t3tools/contracts";
import * as ByteSize from "effect/ByteSize";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import * as HttpIncomingMessage from "effect/http/HttpIncomingMessage";

import { authenticateRawRouteWithScope, downloadContentDisposition } from "../http.ts";
import { requestUrl } from "../requestUrl.ts";
import * as Deidentification from "./DeidentificationService.ts";

/**
 * The de-identification routes. They are routes of their own, outside the typed API, because
 * two of them answer with a file: a page as a picture, and the copy a person saves.
 */

const NO_STORE = { "cache-control": "private, no-store", "x-content-type-options": "nosniff" };
const JSON_MAX_BODY_BYTES = 1024 * 1024;
const STAGE_MAX_BODY_BYTES = 50 * 1024 * 1024;

const json = (body: unknown, status = 200) =>
  HttpServerResponse.jsonUnsafe(body, { status, headers: NO_STORE });

/** A refusal the app shows in its own words: the reason, and nothing of the file. */
const refused =
  /* Request instrumentation already owns the span; keep this helper in that context. */
  Effect.fnUntraced(function* (error: Deidentification.DeidentificationError) {
    if (error.cause !== undefined) {
      yield* Effect.logWarning("de-identification request failed", {
        reason: error.reason,
        cause: error.cause,
      });
    }
    return json({ ok: false, reason: error.reason });
  });

/** The body of a request as its schema reads it, or nothing when it does not fit. */
const bodyAs = <A, I>(schema: Schema.Codec<A, I>) =>
  HttpServerRequest.HttpServerRequest.pipe(
    Effect.flatMap((request) => request.json),
    Effect.flatMap(Schema.decodeUnknownEffect(schema)),
    Effect.provideService(HttpIncomingMessage.MaxBodySize, ByteSize.bytes(JSON_MAX_BODY_BYTES)),
    Effect.option,
  );

const invalid = json({ ok: false, reason: "invalid" }, 400);

const decodeFileRef = Schema.decodeUnknownOption(Schema.fromJsonString(DeidentifyFileRef));

const route = <E, R>(
  method: "GET" | "POST",
  path: string,
  handler: Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>,
) =>
  HttpRouter.add(
    method,
    `${DEIDENTIFY_ROUTE_PREFIX}${path}`,
    authenticateRawRouteWithScope(AuthOrchestrationOperateScope).pipe(Effect.andThen(handler)),
  );

/** Built once with the service in hand: a route's own needs are met for each request. */
const routesOf = (service: Deidentification.DeidentificationService["Service"]) => {
  const inspectRoute = route(
    "POST",
    "/inspect",
    Effect.gen(function* () {
      const body = yield* bodyAs(DeidentifyInspectRequest);
      if (Option.isNone(body)) return invalid;
      return yield* service.inspect(body.value).pipe(Effect.map(json), Effect.catch(refused));
    }),
  );

  const updateRoute = route(
    "POST",
    "/layer/update",
    Effect.gen(function* () {
      const body = yield* bodyAs(DeidentifyUpdateRequest);
      if (Option.isNone(body)) return invalid;
      return yield* service.updateLayer(body.value).pipe(
        Effect.map((layer) => json({ ok: true, layer })),
        Effect.catch(refused),
      );
    }),
  );

  const previewRoute = route(
    "GET",
    "/preview",
    Effect.gen(function* () {
      const url = requestUrl(yield* HttpServerRequest.HttpServerRequest);
      if (Option.isNone(url)) return invalid;
      const query = url.value.searchParams;
      const file = decodeFileRef(query.get("file") ?? "");
      const view = query.get("view");
      const part = query.get("part");
      const page = Number(query.get("page") ?? "0");
      if (
        Option.isNone(file) ||
        (view !== "original" && view !== "deidentified") ||
        !Number.isInteger(page) ||
        page < 0
      ) {
        return invalid;
      }
      return yield* service
        .preview({
          file: file.value,
          view,
          place: part === null ? { type: "page", page } : { type: "media", part },
        })
        .pipe(
          Effect.map((picture) =>
            HttpServerResponse.uint8Array(picture.bytes, {
              contentType: picture.mediaType,
              headers: {
                // The address names one state of the file and its layer when it carries `rev`.
                "cache-control": query.has("rev") ? "private, max-age=600" : "private, no-store",
                "x-content-type-options": "nosniff",
              },
            }),
          ),
          Effect.catch(refused),
        );
    }),
  );

  const exportRoute = route(
    "POST",
    "/export",
    Effect.gen(function* () {
      const body = yield* bodyAs(DeidentifyFileRequest);
      if (Option.isNone(body)) return invalid;
      return yield* service.exportCopy(body.value.file).pipe(
        Effect.map((copy) =>
          HttpServerResponse.uint8Array(copy.bytes, {
            contentType: copy.mediaType,
            headers: {
              ...NO_STORE,
              "content-disposition": downloadContentDisposition(copy.fileName),
            },
          }),
        ),
        Effect.catch(refused),
      );
    }),
  );

  const revealRoute = route(
    "POST",
    "/reveal",
    Effect.gen(function* () {
      const body = yield* bodyAs(DeidentifyFileRequest);
      if (Option.isNone(body)) return invalid;
      return yield* service.reveal(body.value.file).pipe(
        Effect.map((ok) => json({ ok })),
        Effect.catch(refused),
      );
    }),
  );

  const stageRoute = route(
    "POST",
    "/stage",
    Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      const name = Option.getOrUndefined(requestUrl(request))?.searchParams.get("name") ?? "";
      const bytes = yield* request.arrayBuffer.pipe(
        Effect.provideService(
          HttpIncomingMessage.MaxBodySize,
          ByteSize.bytes(STAGE_MAX_BODY_BYTES),
        ),
        Effect.option,
      );
      if (name === "" || Option.isNone(bytes)) return invalid;
      return yield* service.stage(name, Buffer.from(bytes.value)).pipe(
        Effect.map((stagedId) => json({ ok: true, stagedId })),
        Effect.catch(refused),
      );
    }),
  );

  const workspaceRoute = route(
    "GET",
    "/workspace",
    Effect.gen(function* () {
      const url = requestUrl(yield* HttpServerRequest.HttpServerRequest);
      const projectId = Option.getOrUndefined(url)?.searchParams.get("projectId") ?? "";
      if (projectId === "") return invalid;
      return yield* service.workspace(projectId).pipe(
        Effect.map((listing) => json({ ok: true, ...listing })),
        Effect.catch(refused),
      );
    }),
  );

  const scanRoute = route(
    "POST",
    "/workspace/scan",
    Effect.gen(function* () {
      const body = yield* bodyAs(DeidentifyScanRequest);
      if (Option.isNone(body)) return invalid;
      return yield* service.scanWorkspace(body.value).pipe(
        Effect.map((listing) => json({ ok: true, ...listing })),
        Effect.catch(refused),
      );
    }),
  );

  const policyRoute = route(
    "POST",
    "/workspace/policy",
    Effect.gen(function* () {
      const body = yield* bodyAs(DeidentifyPolicyRequest);
      if (Option.isNone(body)) return invalid;
      return json(yield* service.policy(body.value));
    }),
  );

  return Layer.mergeAll(
    inspectRoute,
    updateRoute,
    previewRoute,
    exportRoute,
    revealRoute,
    stageRoute,
    workspaceRoute,
    scanRoute,
    policyRoute,
  );
};

export const layer = Layer.unwrap(
  Effect.map(Deidentification.DeidentificationService, routesOf),
).pipe(Layer.provide(Deidentification.layer));
