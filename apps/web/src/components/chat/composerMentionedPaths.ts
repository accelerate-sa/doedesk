import { splitPromptIntoComposerSegments } from "~/composer-editor-mentions";

/** The message with every mention of `path` replaced by `replacement`, and nothing else changed. */
export const replaceMentionedPath = (prompt: string, path: string, replacement: string): string =>
  splitPromptIntoComposerSegments(prompt)
    .map((segment) =>
      segment.type === "text"
        ? segment.text
        : segment.type === "mention" && segment.path === path
          ? replacement
          : segment.source,
    )
    .join("");
