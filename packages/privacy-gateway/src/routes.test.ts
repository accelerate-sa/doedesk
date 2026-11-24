import { describe, expect, it } from "vite-plus/test";

import { appsBodyIsPlain, routeFor } from "./routes.ts";

/** What becomes of a body sent to `host` on `path`: the format it is masked as, or the route. */
const decision = (host: string, path: string): string => {
  const route = routeFor(host, path, true);
  return route.kind === "masked" ? route.format : route.kind;
};

describe("requests to an AI host", () => {
  it("has a decision for every path the vendors' programs call, and sends no other body", () => {
    const table: ReadonlyArray<
      readonly [host: string, ReadonlyArray<readonly [path: string, decision: string]>]
    > = [
      // Claude Code 2.1, from 4,246 recorded sessions, one recorded here, and its program text.
      [
        "api.anthropic.com",
        [
          ["/v1/messages?beta=true", "anthropic-messages"],
          ["/v1/messages/count_tokens?beta=true", "anthropic-messages"],
          ["/api/event_logging/v2/batch", "report"],
          ["/api/claude_code/metrics", "report"],
          ["/api/eval/sdk-zAZezfDKGoZuXXKe", "plain"],
          ["/api/oauth/claude_cli/create_api_key", "plain"],
          ["/v1/oauth/token", "plain"],
          // Content the gateway has no rule for: batches, files, feedback, transcripts, published
          // pages, memory and settings sync, sessions run from another device.
          ["/v1/messages/batches", "unknown"],
          ["/v1/files", "unknown"],
          ["/api/oauth/file_upload", "unknown"],
          ["/api/claude_cli_feedback", "unknown"],
          ["/api/claude_code_shared_session_transcripts", "unknown"],
          ["/api/frame/upload", "unknown"],
          ["/api/claude_code/team_memory?repo=acme%2Fapp", "unknown"],
          ["/v1/code/sessions/cse_1/worker/events", "unknown"],
          ["/v1/sessions", "unknown"],
          ["/api/organizations/o1/dust/generate_title_and_branch", "unknown"],
        ],
      ],
      // Codex 0.170, from a session recorded here and its program text.
      [
        "chatgpt.com",
        [
          ["/backend-api/codex/responses", "openai-responses"],
          ["/backend-api/codex/responses/compact", "openai-responses"],
          ["/backend-api/codex/analytics-events/events", "report"],
          ["/backend-api/wham/usage/thread_usage/query", "plain"],
          ["/backend-api/ps/mcp", "apps"],
          ["/backend-api/wham/tasks", "unknown"],
          ["/backend-api/codex/memories/trace_summarize", "unknown"],
          ["/backend-api/transcribe", "unknown"],
          ["/backend-api/wham/settings/user", "unknown"],
        ],
      ],
      [
        "ab.chatgpt.com",
        [
          ["/otlp/v1/metrics", "report"],
          ["/otlp/v1/logs", "unknown"],
        ],
      ],
      [
        "api.openai.com",
        [
          ["/v1/responses", "openai-responses"],
          ["/v1/chat/completions", "openai-chat"],
          ["/v1/responses/input_tokens", "json-text"],
          ["/v1/embeddings", "json-text"],
          ["/v1/completions", "json-text"],
          ["/v1/moderations", "json-text"],
          ["/v1/files", "unknown"],
          ["/v1/batches", "unknown"],
          ["/v1/audio/transcriptions", "unknown"],
          ["/v1/images/edits", "unknown"],
          ["/v1/uploads", "unknown"],
          ["/v1/threads/t1/messages", "unknown"],
          // A report on another vendor's host is not that vendor's report.
          ["/api/event_logging/v2/batch", "unknown"],
        ],
      ],
      // Gemini CLI 0.x, from its program text.
      [
        "cloudcode-pa.googleapis.com",
        [
          ["/v1internal:streamGenerateContent?alt=sse", "gemini"],
          ["/v1internal:generateContent", "gemini"],
          ["/v1internal:countTokens", "gemini"],
          ["/v1internal:loadCodeAssist", "plain"],
          ["/v1internal:onboardUser", "plain"],
          ["/v1internal:retrieveUserQuota", "plain"],
          ["/v1internal:setCodeAssistGlobalUserSetting", "plain"],
          ["/v1internal:recordCodeAssistMetrics", "report"],
          ["/v1internal:somethingNew", "unknown"],
        ],
      ],
      // Antigravity 1.5.12, from a session recorded here up to its first model request, and its
      // program text for the rest.
      [
        "daily-cloudcode-pa.googleapis.com",
        [
          ["/v1internal:streamGenerateContent?alt=sse", "gemini"],
          ["/v1internal:loadCodeAssist", "plain"],
          ["/v1internal:fetchAdminControls", "plain"],
          ["/v1internal:listExperiments", "plain"],
          ["/v1internal:fetchAvailableModels", "plain"],
          ["/v1internal:fetchUserInfo", "plain"],
          ["/v1internal:retrieveUserQuotaSummary", "plain"],
          ["/v1internal:writeTrajectoryAcls", "plain"],
          // Text in shapes the gateway has no rule for, and reports nobody has read yet.
          ["/v1internal:streamGenerateChat", "unknown"],
          ["/v1internal:tabChat", "unknown"],
          ["/v1internal:completeCode", "unknown"],
          ["/v1internal:searchSnippets", "unknown"],
          ["/v1internal:recordTrajectoryAnalytics", "unknown"],
          ["/v1internal:recordClientEvent", "unknown"],
          ["/v1internal:uploadPerformanceProfile", "unknown"],
        ],
      ],
      // Grok Build 1.0.92, from its program text: no sign-in here. With an API key it asks
      // api.x.ai, with a grok.com sign-in the chat proxy; both speak the OpenAI formats.
      [
        "api.x.ai",
        [
          ["/v1/responses", "openai-responses"],
          ["/v1/chat/completions", "openai-chat"],
          ["/v1/files", "unknown"],
        ],
      ],
      [
        "cli-chat-proxy.grok.com",
        [
          ["/v1/responses", "openai-responses"],
          ["/v1/chat/completions", "openai-chat"],
          ["/v1/feedback", "unknown"],
          ["/v1/sessions", "unknown"],
        ],
      ],
      // OpenCode 1.19.6 and Pi 1.6.0, each from a session recorded here on OpenRouter; OpenCode
      // on its own free models as well.
      ["opencode.ai", [["/inference/openai/v1/chat/completions", "openai-chat"]]],
      [
        "generativelanguage.googleapis.com",
        [
          ["/v1beta/models/gemini-x:generateContent", "gemini"],
          ["/v1beta/models/gemini-x:countTokens", "gemini"],
          ["/v1beta/models/embed-x:embedContent", "json-text"],
          ["/v1beta/models/embed-x:batchEmbedContents", "json-text"],
          ["/upload/v1beta/files", "unknown"],
          ["/v1beta/cachedContents", "unknown"],
          ["/v1beta/models/gemini-x:batchGenerateContent", "unknown"],
        ],
      ],
      [
        "openrouter.ai",
        [
          ["/api/v1/chat/completions", "openai-chat"],
          ["/api/v1/messages", "anthropic-messages"],
          ["/api/v1/responses", "openai-responses"],
          ["/api/v1/completions", "json-text"],
          ["/api/v1/embeddings", "json-text"],
          ["/api/v1/auth/keys", "plain"],
          ["/api/v1/keys", "unknown"],
        ],
      ],
      ["api.opencode.ai", [["/share_sync", "unknown"]]],
      [
        "opencode.ai",
        [
          ["/zen/v1/chat/completions", "openai-chat"],
          ["/zen/v1/messages", "anthropic-messages"],
        ],
      ],
    ];
    for (const [host, paths] of table) {
      for (const [path, expected] of paths) {
        expect(decision(host, path), `${host}${path}`).toBe(expected);
      }
    }
    // Nothing sent, nothing to read: a request without a body is the program asking.
    expect(routeFor("api.anthropic.com", "/v1/files/f1", false)).toEqual({ kind: "plain" });
    expect(routeFor("chatgpt.com", "/backend-api/wham/tasks/list", false)).toEqual({
      kind: "plain",
    });
  });

  it("tells a question to an app server from a call that carries content", () => {
    const message = (method: string, params: unknown = {}) => ({
      jsonrpc: "2.0",
      id: 1,
      method,
      params,
    });
    const plain: ReadonlyArray<unknown> = [
      message("initialize"),
      { jsonrpc: "2.0", method: "notifications/initialized" },
      message("tools/list"),
      message("resources/templates/list"),
      message("ping"),
      { jsonrpc: "2.0", id: 4, result: {} },
      [message("tools/list"), message("prompts/list")],
    ];
    const content: ReadonlyArray<unknown> = [
      message("tools/call", { name: "search", arguments: { query: "Khalid" } }),
      message("resources/read", { uri: "file:///Khalid.txt" }),
      message("prompts/get", { name: "summary", arguments: { text: "Khalid" } }),
      message("completion/complete"),
      { jsonrpc: "2.0", id: 5, result: { action: "accept", content: { name: "Khalid" } } },
      [message("tools/list"), message("tools/call")],
      "tools/list",
      null,
    ];
    for (const body of plain) expect(appsBodyIsPlain(body), JSON.stringify(body)).toBe(true);
    for (const body of content) expect(appsBodyIsPlain(body), JSON.stringify(body)).toBe(false);
  });
});
