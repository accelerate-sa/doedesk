import type { ItemTarget, LayerItem } from "../layer.ts";
import {
  findInTexts,
  type FormatHandler,
  foundItem,
  nearestOccurrence,
  rewriteSpans,
  spanEdits,
} from "./shared.ts";

/** Plain text and Markdown: values are found and replaced where they stand, and nothing else moves. */

const read = (bytes: Buffer): string => bytes.toString("utf8");

const spanOf = (item: LayerItem) =>
  item.target.type === "text" ? { start: item.target.start, end: item.target.end } : undefined;

export const textHandler: FormatHandler = {
  family: "text",
  extensions: [".txt", ".md"],
  detect: async (file, context, mode) => {
    const text = read(file.bytes);
    const [found = []] = await findInTexts(context, [text]);
    return {
      items: found.map((span) =>
        foundItem(
          { type: "text", start: span.start, end: span.end },
          span.kind,
          text.slice(span.start, span.end),
          mode,
        ),
      ),
      warnings: [],
    };
  },
  apply: async (file, items, context) => {
    const text = read(file.bytes);
    const replacements = new Map<string, string>();
    const spans = items.flatMap((item) => {
      const span = spanOf(item);
      return span === undefined ? [] : [{ ...item, span }];
    });
    const rewritten = rewriteSpans(text, spanEdits(text, spans, context, replacements));
    return {
      bytes: Buffer.from(rewritten, "utf8"),
      mediaType: file.path.toLowerCase().endsWith(".md") ? "text/markdown" : "text/plain",
      replacements,
    };
  },
  reanchor: async (file, items) => {
    const text = read(file.bytes);
    const anchors = new Map<string, ItemTarget>();
    for (const item of items) {
      const span = spanOf(item);
      const found =
        span === undefined ? undefined : nearestOccurrence(text, item.preview, span.start);
      if (found !== undefined) anchors.set(item.id, { type: "text", ...found });
    }
    return anchors;
  },
};
