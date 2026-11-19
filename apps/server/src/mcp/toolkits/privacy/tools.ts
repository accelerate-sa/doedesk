import { OrchestratorMcpFailure } from "@t3tools/contracts";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { McpSchema, Tool, Toolkit } from "effect/ai";

import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as PrivacyGateway from "../../../privacy/PrivacyGateway.ts";
import * as Project from "../../../project/ProjectService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const OCR_MASKED_TOOL_NAME = "ocr_masked";

const OcrMaskedTool = Tool.make(OCR_MASKED_TOOL_NAME, {
  description:
    "Read the text in an image or PDF in this thread's workspace. Personal data comes back as stand-ins like [PERSON_FBJD2], never the values. Use when a redacted image hides text you need.",
  parameters: Schema.Struct({
    path: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4096)).annotate({
      description: "Absolute path of an image or PDF file.",
    }),
  }),
  success: Schema.Struct({
    text: Schema.String,
    note: Schema.String,
  }),
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
    PrivacyGateway.PrivacyGateway,
    Project.ProjectService,
    FileSystem.FileSystem,
    Path.Path,
  ],
})
  .annotate(Tool.Title, "Read text, masked")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, true)
  .annotate(McpSchema.EnabledWhen, McpInvocationContext.hiddenFromOutsideClients);

export const PrivacyToolkit = Toolkit.make(OcrMaskedTool);
