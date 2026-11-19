import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { EnvironmentId, ProjectId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
import * as Project from "../../../project/ProjectService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { liveThreadShell } from "../../McpToolAccess.testkit.ts";
import { readableFile } from "./handlers.ts";

const threadId = ThreadId.make("thread:reading");

/** A thread in the given mode whose workspace is `workspace`, as a worktree or as its project's folder. */
const caller = (
  runtimeMode: "full-access" | "approval-required",
  workspace: string,
  asWorktree: boolean,
) =>
  Layer.mergeAll(
    NodeServices.layer,
    Layer.succeed(McpInvocationContext.McpInvocationContext, {
      environmentId: EnvironmentId.make("environment:reading"),
      requestNamespace: "provider:reading",
      thread: {
        threadId,
        providerSessionId: "provider:reading",
        providerInstanceId: ProviderInstanceId.make("codex"),
      },
      client: undefined,
      capabilities: new Set(["orchestration" as const]),
      issuedAt: 0,
    }),
    Layer.mock(ThreadManagement.ThreadManagementService)({
      getThreadShell: () =>
        Effect.succeed({
          ...liveThreadShell(threadId),
          runtimeMode,
          worktreePath: asWorktree ? workspace : null,
        }),
    }),
    Layer.mock(Project.ProjectService)({
      getById: () =>
        Effect.succeedSome({
          id: ProjectId.make("project:reading"),
          workspaceRoot: workspace,
        } as never),
    }),
  );

const outcome = (path: string, layer: ReturnType<typeof caller>) =>
  readableFile(path).pipe(
    Effect.map((file) => `read ${file.mediaType} ${file.bytes.length}`),
    Effect.catch((failure) => Effect.succeed(`${failure.code}: ${failure.message}`)),
    Effect.provide(layer),
  );

it.effect("reads for a thread only what the agent could read without asking", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fs.realPath(
      yield* fs.makeTempDirectoryScoped({ prefix: "doedesk-reading-" }),
    );
    const workspace = path.join(root, "workspace");
    const elsewhere = path.join(root, "elsewhere");
    yield* fs.makeDirectory(path.join(workspace, "scans"), { recursive: true });
    yield* fs.makeDirectory(elsewhere);
    const inside = path.join(workspace, "scans", "contract.png");
    const outside = path.join(elsewhere, "passport.png");
    yield* fs.writeFileString(inside, "png bytes");
    yield* fs.writeFileString(outside, "another person's passport");
    yield* fs.writeFileString(path.join(workspace, "notes.txt"), "not an image");
    yield* fs.writeFileString(path.join(workspace, "empty.pdf"), "");
    // A link inside the workspace that points out of it.
    const link = path.join(workspace, "scans", "link.png");
    yield* fs.symlink(outside, link);
    const denied =
      "capability_denied: That file is outside this thread's workspace. Only a full-access thread may have a file elsewhere read for it.";

    for (const asWorktree of [true, false]) {
      const supervised = caller("approval-required", workspace, asWorktree);
      expect(yield* outcome(inside, supervised)).toBe("read image/png 9");
      expect(yield* outcome(outside, supervised)).toBe(denied);
      expect(yield* outcome(link, supervised)).toBe(denied);
      expect(
        yield* outcome(
          path.join(workspace, "scans", "..", "..", "elsewhere", "passport.png"),
          supervised,
        ),
      ).toBe(denied);
      // A sibling folder whose name merely starts like the workspace's.
      const sibling = path.join(root, "workspace-private");
      yield* fs.makeDirectory(sibling, { recursive: true });
      yield* fs.writeFileString(path.join(sibling, "id.png"), "x");
      expect(yield* outcome(path.join(sibling, "id.png"), supervised)).toBe(denied);
    }

    const fullAccess = caller("full-access", workspace, true);
    expect(yield* outcome(outside, fullAccess)).toBe("read image/png 25");

    // Whatever the mode: only images and PDFs, only real files, only by absolute path.
    for (const layer of [fullAccess, caller("approval-required", workspace, true)]) {
      expect(yield* outcome(path.join(workspace, "notes.txt"), layer)).toBe(
        "invalid_request: Only image and PDF files can be read.",
      );
      expect(yield* outcome("scans/contract.png", layer)).toBe(
        "invalid_request: Pass an absolute path.",
      );
      expect(yield* outcome(path.join(workspace, "missing.png"), layer)).toBe(
        "invalid_request: No readable file is at that path.",
      );
      expect(yield* outcome(path.join(workspace, "empty.pdf"), layer)).toBe(
        "invalid_request: The file is empty or larger than 20 MB.",
      );
    }
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
