import type { KnownValueMatcher } from "@t3tools/shared/privacyKnownValues";
import { THREAD_FIND_BLOCK_TAGS } from "@t3tools/shared/threadFindBlockTags";

/**
 * Marks the values DoeDesk replaces in text that is already on screen. The marks are CSS
 * highlights over ranges, so no node is added or changed: what is selected, copied and laid out
 * stays exactly as it was.
 */

/** The highlight an open file's marks are painted with. Styled in index.css. */
export const FILE_VALUE_MARK = "doedesk-replaced-value";
/** The fainter one for the chat. */
export const CHAT_VALUE_MARK = "doedesk-replaced-value-chat";

export interface ValueMark {
  readonly range: Range;
  readonly token: string;
}

const IGNORED = "svg, [data-thread-find-ignore], [role='toolbar']";

/** The code viewer keeps its lines in a shadow tree under the element that hosts it. */
export const codeViewerShadowRoot = (host: Element): ShadowRoot | null =>
  host.querySelector("diffs-container")?.shadowRoot ?? null;

/**
 * The known values in the text under `scope`. Text is read block by block, so a value is found
 * across inline elements and never across two paragraphs or cells. With `lineBreaks` "space" a
 * `<br>` is read as a space, for a PDF's text layer, where it ends every printed line.
 */
function collectValueMarks(
  scope: Node,
  matcher: KnownValueMatcher,
  lineBreaks: "block" | "space" = "block",
): { readonly marks: ReadonlyArray<ValueMark>; readonly characters: number } {
  const owner = scope.ownerDocument;
  const marks: Array<ValueMark> = [];
  let characters = 0;
  let text = "";
  let nodes: Array<{ node: Node; start: number; end: number }> = [];
  const flush = () => {
    if (owner !== null && nodes.length > 0) {
      let first = 0;
      for (const span of matcher.find(text)) {
        while (first < nodes.length && nodes[first]!.end <= span.start) first += 1;
        let last = first;
        while (last < nodes.length && nodes[last]!.end < span.end) last += 1;
        const start = nodes[first];
        const end = nodes[last];
        // A span that starts or ends in a line break has no text node to anchor to.
        if (!start || !end || start.start > span.start || end.start >= span.end) continue;
        const range = owner.createRange();
        range.setStart(start.node, span.start - start.start);
        range.setEnd(end.node, span.end - end.start);
        marks.push({ range, token: span.token });
      }
    }
    text = "";
    nodes = [];
  };
  const visit = (node: Node, pre: boolean) => {
    if (node.nodeType === 3) {
      const value = node.nodeValue ?? "";
      nodes.push({ node, start: text.length, end: text.length + value.length });
      // One character for one, so offsets in the text are offsets in the node.
      text += pre ? value : value.replace(/[\r\n]/g, " ");
      characters += value.length;
      return;
    }
    const element = node.nodeType === 1 ? (node as Element) : null;
    if (element === null && node.nodeType !== 11) return;
    if (element?.matches(IGNORED)) {
      flush();
      return;
    }
    const tag = element?.localName ?? "";
    if (tag === "br" && lineBreaks === "space") {
      text += " ";
      return;
    }
    const block = THREAD_FIND_BLOCK_TAGS.has(tag);
    if (block) flush();
    for (const child of node.childNodes) visit(child, pre || tag === "pre");
    if (block) flush();
  };
  visit(scope, false);
  flush();
  return { marks, characters };
}

export interface ValueMarkHit {
  readonly token: string;
  /** Where the mark is on screen, in viewport coordinates. */
  readonly rect: DOMRect;
}

export interface ValueMarkStats {
  /** Rows, pages or lines looked at. */
  readonly units: number;
  readonly marks: number;
  /** Characters of text looked at. Zero for a scanned page: there is nothing to mark. */
  readonly characters: number;
}

export interface ValueMarkSurface {
  /**
   * Looks again: the matcher of a unit may have changed. A unit whose matcher is the same one
   * keeps its marks as they are, so a new turn in a chat repaints nothing in the turns before it.
   */
  readonly refresh: () => void;
  readonly at: (x: number, y: number) => ValueMarkHit | null;
  readonly stop: () => void;
}

export interface ValueMarkSurfaceOptions {
  /** The element whose text is marked. Everything under it is watched. */
  readonly host: Element;
  /** The shadow tree to mark in place of `host`'s own children, once it exists. */
  readonly shadow?: (host: Element) => ShadowRoot | null | undefined;
  readonly highlight: string;
  /**
   * The rows of the surface. Each is searched once and searched again only when its own text
   * changes, so a list that mounts rows as it scrolls costs one row's search per row.
   */
  readonly unitSelector: string;
  /** Inside a unit, only these subtrees are searched. */
  readonly scopeSelector?: string;
  /** Attributes of a unit that change which matcher it gets. */
  readonly unitAttributes?: ReadonlyArray<string>;
  readonly lineBreaks?: "space";
  /** The matcher for a unit. Null leaves it unmarked and costs nothing. */
  readonly matcherFor: (unit: Element) => KnownValueMatcher | null;
  readonly onStats?: (stats: ValueMarkStats) => void;
}

const highlightsSupported = (): boolean =>
  typeof CSS !== "undefined" && "highlights" in CSS && typeof Highlight !== "undefined";

const contains = (rect: DOMRect, x: number, y: number): boolean =>
  x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;

/**
 * Keeps the marks of one surface painted while its text changes. Only mounted text is searched:
 * the chat and the viewers mount what is near the screen, so that is what is marked.
 */
export function startValueMarks(options: ValueMarkSurfaceOptions): ValueMarkSurface {
  const { host, highlight: name, unitSelector, scopeSelector } = options;
  if (!highlightsSupported()) {
    return { refresh: () => undefined, at: () => null, stop: () => undefined };
  }
  const existing = CSS.highlights.get(name);
  const highlight = existing ?? new Highlight();
  if (existing === undefined) {
    // Below find results and citations, which say something about the same text.
    highlight.priority = -1;
    CSS.highlights.set(name, highlight);
  }

  interface Found {
    readonly matcher: KnownValueMatcher;
    readonly marks: ReadonlyArray<ValueMark>;
    readonly characters: number;
  }
  const found = new Map<Element, Found>();
  let painted = new Set<Range>();
  let rects = new Map<Range | Element, ReadonlyArray<DOMRect>>();
  let observed: ParentNode | null = null;
  let frame = 0;
  let stopped = false;
  let lastStats = "";

  const search = (unit: Element, matcher: KnownValueMatcher): Found => {
    const scopes =
      scopeSelector === undefined
        ? [unit]
        : [...unit.querySelectorAll(scopeSelector)].filter(
            (scope) => scope.parentElement?.closest(scopeSelector) == null,
          );
    const marks: Array<ValueMark> = [];
    let characters = 0;
    for (const scope of scopes) {
      const result = collectValueMarks(scope, matcher, options.lineBreaks);
      for (const mark of result.marks) marks.push(mark);
      characters += result.characters;
    }
    return { matcher, marks, characters };
  };

  const observerOptions: MutationObserverInit = {
    subtree: true,
    childList: true,
    characterData: true,
    ...(options.unitAttributes === undefined
      ? {}
      : { attributes: true, attributeFilter: [...options.unitAttributes] }),
  };

  const holdsUnit = (node: Node): boolean =>
    node.nodeType === 1 &&
    ((node as Element).matches(unitSelector) ||
      (node as Element).querySelector(unitSelector) !== null);

  const schedule = () => {
    if (frame !== 0 || stopped) return;
    frame = requestAnimationFrame(paint);
  };

  const observer = new MutationObserver((records) => {
    let dirty = false;
    for (const record of records) {
      const target =
        record.target.nodeType === 1 ? (record.target as Element) : record.target.parentElement;
      const unit = target?.closest(unitSelector);
      if (unit) {
        // A unit with no matcher, such as a reply still streaming, is left alone at no cost.
        if (found.delete(unit) || options.matcherFor(unit) !== null) dirty = true;
      } else if (
        record.type === "childList" &&
        ([...record.addedNodes].some(holdsUnit) || [...record.removedNodes].some(holdsUnit))
      ) {
        dirty = true;
      }
    }
    if (dirty) schedule();
  });

  const paint = () => {
    frame = 0;
    if (stopped) return;
    const root: ParentNode = options.shadow?.(host) ?? host;
    if (root !== observed) {
      observer.disconnect();
      observer.observe(host, observerOptions);
      if (root !== host) observer.observe(root, observerOptions);
      observed = root;
    }
    const next = new Set<Range>();
    const live = new Set<Element>();
    let characters = 0;
    for (const unit of root.querySelectorAll(unitSelector)) {
      const matcher = options.matcherFor(unit);
      if (matcher === null) continue;
      live.add(unit);
      let entry = found.get(unit);
      if (entry === undefined || entry.matcher !== matcher) {
        entry = search(unit, matcher);
        found.set(unit, entry);
      }
      characters += entry.characters;
      for (const mark of entry.marks) next.add(mark.range);
    }
    for (const unit of found.keys()) if (!live.has(unit)) found.delete(unit);
    for (const range of painted) if (!next.has(range)) highlight.delete(range);
    for (const range of next) if (!painted.has(range)) highlight.add(range);
    painted = next;
    rects = new Map();
    // Only what the notice tells apart, so scrolling through a file does not re-render it.
    const stats = `${live.size > 0}:${next.size > 0}:${characters > 0}`;
    if (stats !== lastStats) {
      lastStats = stats;
      options.onStats?.({ units: live.size, marks: next.size, characters });
    }
  };

  const rectsOf = (target: Range | Element): ReadonlyArray<DOMRect> => {
    let cached = rects.get(target);
    if (cached === undefined) {
      cached = [...target.getClientRects()];
      rects.set(target, cached);
    }
    return cached;
  };
  const forgetRects = () => {
    rects = new Map();
  };
  // Scrolling moves every mark; the shadow tree's scroller is a child of the host.
  host.addEventListener("scroll", forgetRects, { capture: true, passive: true });
  window.addEventListener("resize", forgetRects, { passive: true });

  paint();
  return {
    refresh: schedule,
    at: (x, y) => {
      if (painted.size === 0) return null;
      for (const [unit, entry] of found) {
        if (entry.marks.length === 0 || !rectsOf(unit).some((rect) => contains(rect, x, y))) {
          continue;
        }
        for (const mark of entry.marks) {
          const rect = rectsOf(mark.range).find((candidate) => contains(candidate, x, y));
          if (rect) return { token: mark.token, rect };
        }
      }
      return null;
    },
    stop: () => {
      stopped = true;
      if (frame !== 0) cancelAnimationFrame(frame);
      observer.disconnect();
      host.removeEventListener("scroll", forgetRects, { capture: true });
      window.removeEventListener("resize", forgetRects);
      for (const range of painted) highlight.delete(range);
      painted = new Set();
      found.clear();
      if (highlight.size === 0 && CSS.highlights.get(name) === highlight) {
        CSS.highlights.delete(name);
      }
    },
  };
}
