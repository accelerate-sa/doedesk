/**
 * Calls the worker model: any server that speaks OpenAI's Chat Completions or Responses format.
 * One call is one question about one document. Nothing is kept between calls, no tools are
 * offered, and the Responses driver asks the server not to store the exchange.
 */

import { ALLOWANCE_ENDED_CODES } from "../detect.ts";

export const WORKER_DRIVERS = ["chatCompletions", "responses"] as const;
export type WorkerDriver = (typeof WORKER_DRIVERS)[number];

/** How the server is asked for JSON: by schema, as any JSON object, or only in the prompt. */
export type StructuredOutput = "jsonSchema" | "jsonObject" | "none";

export interface WorkerEndpoint {
  /** The API root, for example `https://api.groq.com/openai/v1`. The driver adds its path. */
  readonly baseUrl: string;
  readonly apiKey?: string | undefined;
  readonly model: string;
  readonly driver: WorkerDriver;
  /** Sent as the server spells it (`reasoning_effort`, or `reasoning.effort`). Unset: not sent. */
  readonly reasoningEffort?: string | undefined;
  readonly structured: StructuredOutput;
  /** Extra request headers, for example a signed account token. */
  readonly headers?: Readonly<Record<string, string>> | undefined;
  /**
   * Set for DoeDesk Cloud's worker, which queues calls for everyone in the region: it takes
   * `parallel` calls at once, and a call may wait `maxWaitMs` there for its turn before it is
   * answered as busy. Unset: the server takes what it is sent, and nothing here changes.
   */
  readonly queue?: { readonly parallel: number; readonly maxWaitMs: number } | undefined;
}

export interface WorkerRequest {
  readonly system: string;
  readonly user: string;
  /** Earlier attempts of the same job: the worker's reply and what was wrong with it. */
  readonly corrections?: ReadonlyArray<{ readonly reply: string; readonly feedback: string }>;
  readonly schema: Record<string, unknown>;
  readonly maxOutputTokens: number;
  readonly signal?: AbortSignal | undefined;
}

export interface WorkerUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly reasoningTokens: number;
}

export interface WorkerReply {
  readonly text: string;
  readonly usage: WorkerUsage;
  /** Wall-clock milliseconds of this call. */
  readonly ms: number;
  /** The output was cut off at the token limit. */
  readonly truncated: boolean;
  /**
   * Where the server says it handled the call, when it says so: DoeDesk Cloud names the account
   * region whose worker answered (`x-doedesk-worker-region`), Groq its own (`x-groq-region`).
   */
  readonly servedFrom: string | null;
  /** Milliseconds the call waited for its turn at a server that queues. 0 anywhere else. */
  readonly queuedMs: number;
}

/** The server refused or could not be reached. `retryable`: trying again may work. */
export class WorkerEndpointError extends Error {
  override readonly name = "WorkerEndpointError";
  readonly status: number | null;
  readonly retryable: boolean;
  /** Seconds the server asked to wait, when it said so. */
  readonly retryAfter: number | null;
  /**
   * The server could not make its own output fit the schema it was given. Some servers fail this
   * way on one call in several with the same input, so the call is worth making again.
   */
  readonly decoding: boolean;
  /**
   * DoeDesk Cloud's worker is busy: the call waited its turn there and was not sent. `waiting`
   * is how many calls were waiting in the region. Asking again at once only joins the same line.
   */
  readonly busy: { readonly waiting: number } | null;
  /** DoeDesk Cloud refused the call because its worker is not included in the account. */
  readonly notIncluded: boolean;
  /**
   * The server refused the strict schema itself, as some validators refuse a choice field. The
   * same schema is refused every time, so the call is worth making again only as a JSON object.
   */
  readonly schemaRefused: boolean;

  constructor(
    message: string,
    status: number | null,
    retryable: boolean,
    retryAfter: number | null = null,
    decoding = false,
    busy: { readonly waiting: number } | null = null,
    notIncluded = false,
    schemaRefused = false,
  ) {
    super(message);
    this.status = status;
    this.retryable = retryable;
    this.retryAfter = retryAfter;
    this.decoding = decoding;
    this.busy = busy;
    this.notIncluded = notIncluded;
    this.schemaRefused = schemaRefused;
  }
}

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

const count = (value: unknown): number => (typeof value === "number" && value >= 0 ? value : 0);

const endpointUrl = (endpoint: WorkerEndpoint, path: string): string =>
  `${endpoint.baseUrl.replace(/\/+$/, "")}${path}`;

const chatBody = (endpoint: WorkerEndpoint, request: WorkerRequest): Record<string, unknown> => {
  const messages: Array<{ role: string; content: string }> = [
    { role: "system", content: request.system },
    { role: "user", content: request.user },
  ];
  for (const correction of request.corrections ?? []) {
    messages.push({ role: "assistant", content: correction.reply });
    messages.push({ role: "user", content: correction.feedback });
  }
  return {
    model: endpoint.model,
    messages,
    temperature: 0,
    max_completion_tokens: request.maxOutputTokens,
    ...(endpoint.reasoningEffort === undefined
      ? {}
      : { reasoning_effort: endpoint.reasoningEffort }),
    ...(endpoint.structured === "jsonSchema"
      ? {
          response_format: {
            type: "json_schema",
            json_schema: { name: "answer", strict: true, schema: request.schema },
          },
        }
      : endpoint.structured === "jsonObject"
        ? { response_format: { type: "json_object" } }
        : {}),
  };
};

const responsesBody = (
  endpoint: WorkerEndpoint,
  request: WorkerRequest,
): Record<string, unknown> => {
  const input: Array<{ role: string; content: string }> = [{ role: "user", content: request.user }];
  for (const correction of request.corrections ?? []) {
    input.push({ role: "assistant", content: correction.reply });
    input.push({ role: "user", content: correction.feedback });
  }
  return {
    model: endpoint.model,
    instructions: request.system,
    input,
    // The exchange holds a confidential document: the server is told not to keep it.
    store: false,
    temperature: 0,
    max_output_tokens: request.maxOutputTokens,
    ...(endpoint.reasoningEffort === undefined
      ? {}
      : { reasoning: { effort: endpoint.reasoningEffort } }),
    ...(endpoint.structured === "jsonSchema"
      ? {
          text: {
            format: { type: "json_schema", name: "answer", strict: true, schema: request.schema },
          },
        }
      : endpoint.structured === "jsonObject"
        ? { text: { format: { type: "json_object" } } }
        : {}),
  };
};

const readChat = (body: Record<string, unknown>) => {
  const choice = asRecord(Array.isArray(body.choices) ? body.choices[0] : undefined);
  const message = asRecord(choice?.message);
  const usage = asRecord(body.usage);
  const details = asRecord(usage?.completion_tokens_details);
  return {
    text: typeof message?.content === "string" ? message.content : "",
    truncated: choice?.finish_reason === "length",
    usage: {
      inputTokens: count(usage?.prompt_tokens),
      outputTokens: count(usage?.completion_tokens),
      reasoningTokens: count(details?.reasoning_tokens),
    },
  };
};

const readResponses = (body: Record<string, unknown>) => {
  let text = "";
  for (const item of Array.isArray(body.output) ? body.output : []) {
    const entry = asRecord(item);
    if (entry?.type !== "message" || !Array.isArray(entry.content)) continue;
    for (const part of entry.content) {
      const piece = asRecord(part);
      if (piece?.type === "output_text" && typeof piece.text === "string") text += piece.text;
    }
  }
  const usage = asRecord(body.usage);
  const details = asRecord(usage?.output_tokens_details);
  return {
    text,
    truncated: asRecord(body.incomplete_details)?.reason === "max_output_tokens",
    usage: {
      inputTokens: count(usage?.input_tokens),
      outputTokens: count(usage?.output_tokens),
      reasoningTokens: count(details?.reasoning_tokens),
    },
  };
};

/** One call. Rejects with `WorkerEndpointError` when the server did not answer with a reply. */
export const callWorker = async (
  endpoint: WorkerEndpoint,
  request: WorkerRequest,
  fetchImpl: typeof fetch = fetch,
): Promise<WorkerReply> => {
  const responses = endpoint.driver === "responses";
  const started = performance.now();
  let response: Response;
  try {
    response = await fetchImpl(
      endpointUrl(endpoint, responses ? "/responses" : "/chat/completions"),
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(endpoint.apiKey ? { authorization: `Bearer ${endpoint.apiKey}` } : {}),
          ...endpoint.headers,
        },
        body: JSON.stringify(
          responses ? responsesBody(endpoint, request) : chatBody(endpoint, request),
        ),
        ...(request.signal === undefined ? {} : { signal: request.signal }),
      },
    );
  } catch (cause) {
    if (request.signal?.aborted === true)
      throw new WorkerEndpointError("The call ran out of time.", null, false);
    throw new WorkerEndpointError(
      `The worker address could not be reached (${cause instanceof Error ? cause.message : String(cause)}).`,
      null,
      true,
    );
  }
  const raw = await response.text().catch(() => "");
  if (!response.ok) {
    let detail = raw.slice(0, 300);
    let code = "";
    let waiting: number | null = null;
    try {
      const error = asRecord(asRecord(JSON.parse(raw))?.error);
      if (typeof error?.message === "string") detail = error.message.slice(0, 300);
      if (typeof error?.code === "string") code = error.code;
      if (typeof error?.waiting === "number") waiting = error.waiting;
      // A router says only "Provider returned error"; the host's own reason is beside it.
      const reason = asRecord(error?.metadata)?.raw;
      if (reason !== undefined && reason !== null) {
        const said = typeof reason === "string" ? reason : JSON.stringify(reason);
        detail = `${detail} (${said})`.slice(0, 300);
      }
    } catch {
      // Not JSON: the first characters of the body are the detail.
    }
    const retryAfter = Number(response.headers.get("retry-after"));
    const decoding =
      response.status === 400 &&
      (code === "json_validate_failed" ||
        /failed to generate json|does not match the expected schema/i.test(detail));
    // DoeDesk Cloud's own word that the region has no worker now. Asking again gets the same
    // answer, so it is not waited on like a server's passing failure.
    const noWorkerNow = response.status === 503 && code === "worker_unavailable";
    throw new WorkerEndpointError(
      `The worker answered ${response.status}: ${detail}`,
      response.status,
      decoding ||
        response.status === 408 ||
        (response.status === 429 && !ALLOWANCE_ENDED_CODES.has(code)) ||
        (response.status >= 500 && !noWorkerNow),
      Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : null,
      decoding,
      response.status === 429 && code === "worker_busy" && waiting !== null ? { waiting } : null,
      response.status === 403 && code === "worker_not_included",
      !decoding &&
        endpoint.structured === "jsonSchema" &&
        (response.status === 400 || response.status === 422) &&
        SCHEMA_REFUSED.test(detail),
    );
  }
  let body: Record<string, unknown> | undefined;
  try {
    body = asRecord(JSON.parse(raw));
  } catch {
    body = undefined;
  }
  if (body === undefined) {
    throw new WorkerEndpointError("The worker's answer was not JSON.", response.status, true);
  }
  const read = responses ? readResponses(body) : readChat(body);
  return {
    ...read,
    ms: performance.now() - started,
    servedFrom:
      response.headers.get("x-doedesk-worker-region") ?? response.headers.get("x-groq-region"),
    queuedMs: count(Number(response.headers.get("x-doedesk-worker-queued-ms"))),
  };
};

/** Shaped as a question's schema is, choice field included: some validators refuse that field. */
const PROBE_SCHEMA = {
  type: "object",
  properties: {
    word: {
      type: "object",
      properties: {
        quote: { type: "string" },
        value: { type: ["string", "null"] },
        kind: { type: ["string", "null"], enum: ["test", "other", null] },
      },
      required: ["quote", "value", "kind"],
      additionalProperties: false,
    },
  },
  required: ["word"],
  additionalProperties: false,
};

/** A refusal that is about the schema sent, in the words validators and routers use for it. */
const SCHEMA_REFUSED = /schema|response_format|enum value|declared type/i;
/** A refusal of the reasoning setting: "must be one of low, medium, or high", "is mandatory". */
const REASONING_REFUSED = /reasoning/i;

export interface WorkerProbe {
  readonly ok: boolean;
  /** The strictest way of asking for JSON that this server accepted. */
  readonly structured: StructuredOutput;
  /** Written for the person connecting the worker. Null when `ok`. */
  readonly message: string | null;
  /**
   * Set when the server refused the reasoning setting it was given and took another: the one
   * it took, null for none at all. The caller stores it in place of the one typed.
   */
  readonly reasoningEffort?: string | null;
}

/**
 * Finds out how this server can be asked for JSON, strictest first, with a question that holds
 * nothing confidential. A server that takes no structured-output option still works: the answer
 * is checked here and asked for again when it is malformed. A server that refuses the reasoning
 * setting is asked without one, then with `low`: some models refuse `none`, some the setting.
 */
export const probeWorker = async (
  endpoint: Omit<WorkerEndpoint, "structured">,
  fetchImpl: typeof fetch = fetch,
): Promise<WorkerProbe> => {
  let last = "The worker did not answer.";
  const { reasoningEffort: given, ...unset } = endpoint;
  const efforts = [given, ...[undefined, "low"].filter((effort) => effort !== given)];
  for (const [index, effort] of efforts.entries()) {
    const asked = effort === undefined ? unset : { ...unset, reasoningEffort: effort };
    let reasoningRefused = false;
    for (const structured of ["jsonSchema", "jsonObject", "none"] as const) {
      try {
        const reply = await callWorker(
          { ...asked, structured },
          {
            system:
              'Answer with JSON only, in this shape: {"word":{"quote":"...","value":"...","kind":"test"}}. No other text.',
            user: 'The document says: "The password for this connection test is heron." Give the quote and the test word as JSON.',
            schema: PROBE_SCHEMA,
            maxOutputTokens: 1024,
            signal: AbortSignal.timeout(30_000),
          },
          fetchImpl,
        );
        if (/heron/i.test(reply.text)) {
          return {
            ok: true,
            structured,
            message: null,
            ...(index === 0 ? {} : { reasoningEffort: effort ?? null }),
          };
        }
        last = "The worker answered, but not with the JSON it was asked for.";
      } catch (cause) {
        last = cause instanceof Error ? cause.message : String(cause);
        // A refusal of the option itself is a 400 or 422; anything else is not about the option.
        const status = cause instanceof WorkerEndpointError ? cause.status : null;
        if (status !== 400 && status !== 422 && status !== 404 && status !== 501) {
          return { ok: false, structured, message: last };
        }
        // Not about how JSON is asked for: no other way of asking would get past it.
        reasoningRefused = (status === 400 || status === 422) && REASONING_REFUSED.test(last);
        if (reasoningRefused) break;
      }
    }
    if (!reasoningRefused) break;
  }
  return { ok: false, structured: "none", message: last };
};
