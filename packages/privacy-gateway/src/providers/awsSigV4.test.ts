import { describe, expect, it } from "vite-plus/test";

import { callAwsJson, signAwsRequest } from "./awsSigV4.ts";
import { AWS_KEYS, json, recorded } from "./testkit.ts";
import { ProviderError } from "./types.ts";

/** The credentials, time and scope of AWS's published Signature Version 4 test suite. */
const suite = {
  region: "us-east-1",
  service: "service",
  credentials: {
    accessKeyId: "AKIDEXAMPLE",
    secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
  },
  now: new Date("2015-08-30T12:36:00.000Z"),
};
const signatureOf = (headers: Record<string, string>) =>
  /Signature=([0-9a-f]{64})$/.exec(headers.authorization ?? "")?.[1];

describe("signAwsRequest", () => {
  it("signs AWS's published test requests to the published signatures", () => {
    const vanilla = signAwsRequest({
      ...suite,
      method: "GET",
      url: "https://example.amazonaws.com/",
    });
    expect(vanilla).toEqual({
      "x-amz-date": "20150830T123600Z",
      authorization:
        "AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, SignedHeaders=host;x-amz-date, Signature=5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31",
    });
    expect(
      signatureOf(
        signAwsRequest({ ...suite, method: "POST", url: "https://example.amazonaws.com/" }),
      ),
    ).toBe("5da7c1a2acd57cee7505fc6676e4e544621c30862966e37dddb68e92efbe5d6b");
    // Query parameters are signed sorted by name, whatever order they were written in.
    expect(
      signatureOf(
        signAwsRequest({
          ...suite,
          method: "GET",
          url: "https://example.amazonaws.com/?Param2=value2&Param1=value1",
        }),
      ),
    ).toBe("b97d918cfa904a5beff61c982a1b6f458b799221646efd99d3219ec94cdf2500");
  });

  it("signs the body, the headers given and a session token", () => {
    const base = {
      ...suite,
      method: "POST",
      url: "https://textract.us-east-1.amazonaws.com/",
      headers: { "Content-Type": "application/x-amz-json-1.1", "X-Amz-Target": "Textract.X" },
    };
    const first = signAwsRequest({ ...base, body: "{}" });
    expect(first.authorization).toContain(
      "SignedHeaders=content-type;host;x-amz-date;x-amz-target,",
    );
    expect(first["content-type"]).toBe("application/x-amz-json-1.1");
    expect(signatureOf(signAwsRequest({ ...base, body: '{"a":1}' }))).not.toBe(signatureOf(first));
    const temporary = signAwsRequest({
      ...base,
      body: "{}",
      credentials: { ...suite.credentials, sessionToken: "session-token" },
    });
    expect(temporary["x-amz-security-token"]).toBe("session-token");
    expect(temporary.authorization).toContain("x-amz-security-token");
  });
});

describe("callAwsJson", () => {
  const call = (runtime: ReturnType<typeof recorded>["runtime"]) =>
    callAwsJson({
      service: "AWS Textract",
      runtime,
      region: AWS_KEYS.settings.region,
      signingName: "textract",
      credentials: { accessKeyId: AWS_KEYS.settings.accessKeyId, ...AWS_KEYS.secrets },
      target: "Textract.DetectDocumentText",
      body: { Document: { Bytes: "AA==" } },
    });

  it("posts a signed JSON 1.1 request to the regional address", async () => {
    const { calls, runtime } = recorded(json({ Blocks: [] }));
    await expect(call(runtime)).resolves.toEqual({ Blocks: [] });
    const [sent] = calls;
    expect(sent?.url).toBe("https://textract.me-central-1.amazonaws.com/");
    expect(sent?.method).toBe("POST");
    expect(sent?.headers.get("content-type")).toBe("application/x-amz-json-1.1");
    expect(sent?.headers.get("x-amz-target")).toBe("Textract.DetectDocumentText");
    expect(sent?.headers.get("x-amz-date")).toBe("20261127T100000Z");
    expect(sent?.headers.get("authorization")).toMatch(
      /^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\/20261127\/me-central-1\/textract\/aws4_request, SignedHeaders=content-type;host;x-amz-date;x-amz-target, Signature=[0-9a-f]{64}$/,
    );
    expect(sent?.json).toEqual({ Document: { Bytes: "AA==" } });
  });

  it("reads AWS's own reason out of a 400", async () => {
    const throttled = json(
      { __type: "ThrottlingException", message: "Rate exceeded" },
      { status: 400 },
    );
    const busy = recorded(throttled, throttled, throttled, throttled);
    await expect(call(busy.runtime)).rejects.toMatchObject({ kind: "busy", status: 400 });
    expect(busy.calls).toHaveLength(4);

    const unsigned = recorded(
      json(
        { __type: "com.amazon.coral.service#UnrecognizedClientException", message: "bad token" },
        { status: 400 },
      ),
    );
    await expect(call(unsigned.runtime)).rejects.toMatchObject({ kind: "auth" });
    expect(unsigned.calls).toHaveLength(1);

    const invalid = recorded(
      json({ __type: "UnsupportedDocumentException", message: "Unsupported" }, { status: 400 }),
    );
    const refusal = await call(invalid.runtime).catch((cause: unknown) => cause);
    expect(refusal).toBeInstanceOf(ProviderError);
    expect(refusal).toMatchObject({ kind: "refused" });
    expect((refusal as Error).message).toContain("Unsupported");
  });

  it("asks for a region before it sends anything", async () => {
    const { calls, runtime } = recorded();
    await expect(
      callAwsJson({
        service: "AWS Textract",
        runtime,
        region: "evil.example.com/",
        signingName: "textract",
        credentials: { accessKeyId: "a", secretAccessKey: "b" },
        target: "Textract.DetectDocumentText",
        body: {},
      }),
    ).rejects.toMatchObject({ kind: "misconfigured" });
    expect(calls).toHaveLength(0);
  });
});
