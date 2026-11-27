import {
  DEIDENTIFY_ROUTE_PREFIX,
  type DeidentifyFileRef,
  type DeidentifyInspectResult,
  type DeidentifyLayerChange,
  type DeidentifyPolicy,
  type DeidentifyPolicyRequest,
  type DeidentifyStageResult,
  type DeidentifyUpdateResult,
  type DeidentifyWorkspace,
} from "@t3tools/contracts";

import { readDesktopPrimaryBearerToken } from "~/environments/primary/desktopAuth";
import { resolvePrimaryEnvironmentHttpUrl } from "~/environments/primary/target";

/**
 * De-identification, as the app asks the server for it. Every view takes one of these, so a
 * test can hand in a client that answers from memory.
 */
export interface DeidentifyClient {
  readonly inspect: (
    file: DeidentifyFileRef,
    options?: { readonly rescan?: boolean },
  ) => Promise<DeidentifyInspectResult>;
  readonly update: (
    file: DeidentifyFileRef,
    changes: ReadonlyArray<DeidentifyLayerChange>,
  ) => Promise<DeidentifyUpdateResult>;
  /** A page or picture as an address an `<img>` can show. The caller revokes it when done. */
  readonly picture: (url: string, revision: string) => Promise<string | null>;
  /** Saves the de-identified copy to the person's downloads. False when it could not be made. */
  readonly download: (file: DeidentifyFileRef) => Promise<boolean>;
  readonly reveal: (file: DeidentifyFileRef) => Promise<boolean>;
  readonly stage: (file: File) => Promise<DeidentifyStageResult>;
  readonly workspace: (projectId: string) => Promise<DeidentifyWorkspace>;
  readonly scan: (projectId: string, paths?: ReadonlyArray<string>) => Promise<DeidentifyWorkspace>;
  readonly policy: (request: DeidentifyPolicyRequest) => Promise<DeidentifyPolicy | null>;
}

const FAILED = { ok: false, reason: "unavailable" } as const;

/** A request the way every other request to this computer's server is made. */
const send = async (pathWithQuery: string, init: RequestInit = {}): Promise<Response> => {
  const url = new URL(pathWithQuery, resolvePrimaryEnvironmentHttpUrl("/"));
  const token = await readDesktopPrimaryBearerToken();
  return fetch(url, {
    ...init,
    credentials: token === null ? "include" : "omit",
    headers: {
      ...(init.headers as Record<string, string> | undefined),
      ...(token === null ? {} : { authorization: `Bearer ${token}` }),
    },
  });
};

const post = (path: string, body: unknown): Promise<Response> =>
  send(`${DEIDENTIFY_ROUTE_PREFIX}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

const answerOf = async <Answer>(request: Promise<Response>, fallback: Answer): Promise<Answer> => {
  try {
    const response = await request;
    return response.ok ? ((await response.json()) as Answer) : fallback;
  } catch {
    return fallback;
  }
};

const fileNameOf = (response: Response): string => {
  const header = response.headers.get("content-disposition") ?? "";
  const extended = /filename\*=UTF-8''([^;]+)/iu.exec(header)?.[1];
  if (extended !== undefined) {
    try {
      return decodeURIComponent(extended);
    } catch {
      // Falls through to the plain name.
    }
  }
  return /filename="([^"]+)"/iu.exec(header)?.[1] ?? "deidentified";
};

const saveBlob = (blob: Blob, name: string): void => {
  const address = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = address;
  link.download = name;
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(address);
};

export const liveDeidentifyClient: DeidentifyClient = {
  inspect: (file, options) =>
    answerOf<DeidentifyInspectResult>(post("/inspect", { file, ...options }), FAILED),
  update: (file, changes) =>
    answerOf<DeidentifyUpdateResult>(post("/layer/update", { file, changes }), FAILED),
  picture: async (url, revision) => {
    try {
      const response = await send(`${url}&rev=${encodeURIComponent(revision)}`);
      // A refusal comes back as JSON: only a picture is shown.
      if (!response.ok || !(response.headers.get("content-type") ?? "").startsWith("image/")) {
        return null;
      }
      return URL.createObjectURL(await response.blob());
    } catch {
      return null;
    }
  },
  download: async (file) => {
    try {
      const response = await post("/export", { file });
      if (!response.ok || !response.headers.has("content-disposition")) return false;
      saveBlob(await response.blob(), fileNameOf(response));
      return true;
    } catch {
      return false;
    }
  },
  reveal: async (file) => (await answerOf(post("/reveal", { file }), { ok: false })).ok,
  stage: (file) =>
    answerOf<DeidentifyStageResult>(
      send(`${DEIDENTIFY_ROUTE_PREFIX}/stage?name=${encodeURIComponent(file.name)}`, {
        method: "POST",
        headers: { "content-type": "application/octet-stream" },
        body: file,
      }),
      FAILED,
    ),
  workspace: (projectId) =>
    answerOf<DeidentifyWorkspace>(
      send(`${DEIDENTIFY_ROUTE_PREFIX}/workspace?projectId=${encodeURIComponent(projectId)}`),
      FAILED,
    ),
  scan: (projectId, paths) =>
    answerOf<DeidentifyWorkspace>(
      post("/workspace/scan", { projectId, ...(paths === undefined ? {} : { paths }) }),
      FAILED,
    ),
  policy: (request) => answerOf<DeidentifyPolicy | null>(post("/workspace/policy", request), null),
};
