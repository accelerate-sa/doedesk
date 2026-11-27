/**
 * AWS Signature Version 4 for a request with its whole body in hand, as Textract and Comprehend
 * take theirs. https://docs.aws.amazon.com/IAM/latest/UserGuide/reference_sigv.html
 */

import * as NodeCrypto from "node:crypto";

import { asRecord, readJson, requireUrl, send } from "./http.ts";
import { ProviderError, type ProviderProblemKind, type ProviderRuntime } from "./types.ts";

export interface AwsCredentials {
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly sessionToken?: string | undefined;
}

export interface AwsRequestToSign {
  readonly method: string;
  readonly url: string;
  /** Every header given is signed. `host` and `x-amz-date` are added. */
  readonly headers?: Readonly<Record<string, string>> | undefined;
  readonly body?: string | Uint8Array | undefined;
  readonly region: string;
  readonly service: string;
  readonly credentials: AwsCredentials;
  readonly now?: Date | undefined;
}

const sha256Hex = (data: string | Uint8Array): string =>
  NodeCrypto.createHash("sha256").update(data).digest("hex");

const hmac = (key: string | Uint8Array, data: string): Buffer =>
  NodeCrypto.createHmac("sha256", key).update(data).digest();

/** RFC 3986: everything but the unreserved characters, which `encodeURIComponent` nearly does. */
const encodeRfc3986 = (value: string): string =>
  encodeURIComponent(value).replace(
    /[!'()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );

/** Each segment is encoded twice, as every service but S3 expects. */
const canonicalPath = (pathname: string): string =>
  pathname
    .split("/")
    .map((segment) => encodeRfc3986(encodeRfc3986(decodeURIComponent(segment))))
    .join("/") || "/";

const canonicalQuery = (parameters: URLSearchParams): string =>
  [...parameters]
    .map(([name, value]) => [encodeRfc3986(name), encodeRfc3986(value)] as const)
    .toSorted(([leftName, leftValue], [rightName, rightValue]) =>
      leftName === rightName
        ? leftValue < rightValue
          ? -1
          : leftValue > rightValue
            ? 1
            : 0
        : leftName < rightName
          ? -1
          : 1,
    )
    .map(([name, value]) => `${name}=${value}`)
    .join("&");

/** The headers to send: those given, in lower case, with the date, the token and the signature. */
export const signAwsRequest = (request: AwsRequestToSign): Record<string, string> => {
  const url = new URL(request.url);
  const amzDate = (request.now ?? new Date()).toISOString().replace(/[-:]|\.\d{3}/g, "");
  const date = amzDate.slice(0, 8);
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(request.headers ?? {})) {
    headers[name.toLowerCase()] = value.trim().replace(/\s+/g, " ");
  }
  headers.host = url.host;
  headers["x-amz-date"] = amzDate;
  if (request.credentials.sessionToken) {
    headers["x-amz-security-token"] = request.credentials.sessionToken;
  }
  const signedNames = Object.keys(headers).toSorted();
  const signedHeaders = signedNames.join(";");
  const canonicalRequest = [
    request.method.toUpperCase(),
    canonicalPath(url.pathname),
    canonicalQuery(url.searchParams),
    ...signedNames.map((name) => `${name}:${headers[name]}`),
    "",
    signedHeaders,
    sha256Hex(request.body ?? ""),
  ].join("\n");
  const scope = `${date}/${request.region}/${request.service}/aws4_request`;
  const stringToSign = ["AWS4-HMAC-SHA256", amzDate, scope, sha256Hex(canonicalRequest)].join("\n");
  const signingKey = [date, request.region, request.service, "aws4_request"].reduce<
    string | Buffer
  >((key, part) => hmac(key, part), `AWS4${request.credentials.secretAccessKey}`);
  const signature = hmac(signingKey, stringToSign).toString("hex");
  // `fetch` sets the host itself, from the same address that was signed.
  const { host: _host, ...sent } = headers;
  return {
    ...sent,
    authorization: `AWS4-HMAC-SHA256 Credential=${request.credentials.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
  };
};

const AWS_THROTTLED =
  /^(?:Throttl\w*|TooManyRequests\w*|ProvisionedThroughputExceeded\w*|LimitExceededException)$/;
const AWS_NOT_SIGNED_IN =
  /^(?:UnrecognizedClient|InvalidSignature|AccessDenied|ExpiredToken|MissingAuthenticationToken|IncompleteSignature|InvalidClientTokenId|SignatureDoesNotMatch|NotAuthorized)\w*$/;

/** AWS answers a throttled or unsigned call with 400, and names the reason in `__type`. */
const classifyAwsError = (_status: number, body: string): ProviderProblemKind | undefined => {
  let type = "";
  try {
    const named = asRecord(JSON.parse(body))?.__type;
    if (typeof named === "string") type = named.slice(named.lastIndexOf("#") + 1);
  } catch {
    return undefined;
  }
  if (AWS_THROTTLED.test(type)) return "busy";
  if (AWS_NOT_SIGNED_IN.test(type)) return "auth";
  return undefined;
};

export interface AwsJsonCall {
  /** The service as a message names it. */
  readonly service: string;
  readonly runtime: ProviderRuntime;
  readonly region: string;
  /** The name requests are signed for, and the first label of the regional address. */
  readonly signingName: string;
  readonly endpoint?: string | undefined;
  readonly credentials: AwsCredentials;
  /** `X-Amz-Target`, for example `Textract.DetectDocumentText`. */
  readonly target: string;
  readonly body: Record<string, unknown>;
  readonly timeoutMs?: number | undefined;
}

/** One call of an AWS JSON 1.1 operation, signed again on every try. */
export const callAwsJson = async (call: AwsJsonCall): Promise<Record<string, unknown>> => {
  if (!/^[a-z0-9-]+$/.test(call.region)) {
    throw new ProviderError(
      `${call.service} needs an AWS region, such as me-central-1. Check it in Settings, under Privacy.`,
      { kind: "misconfigured" },
    );
  }
  const url = `${
    call.endpoint?.trim()
      ? requireUrl(call.service, call.endpoint)
      : `https://${call.signingName}.${call.region}.amazonaws.com`
  }/`;
  const body = JSON.stringify(call.body);
  const response = await send({
    service: call.service,
    runtime: call.runtime,
    classify: classifyAwsError,
    timeoutMs: call.timeoutMs,
    request: () => ({
      url,
      method: "POST",
      headers: signAwsRequest({
        method: "POST",
        url,
        headers: { "content-type": "application/x-amz-json-1.1", "x-amz-target": call.target },
        body,
        region: call.region,
        service: call.signingName,
        credentials: call.credentials,
        now: call.runtime.now?.(),
      }),
      body,
    }),
  });
  return readJson(response, call.service, url);
};
