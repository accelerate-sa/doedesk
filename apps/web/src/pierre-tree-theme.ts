import type { CSSProperties, PointerEvent } from "react";

export const PIERRE_TREE_UNSAFE_CSS = `
  :host {
    --trees-bg-override: transparent;
    --trees-selected-bg-override: color-mix(in srgb, currentColor 12%, transparent);
    --trees-hover-bg-override: color-mix(in srgb, currentColor 7%, transparent);
    --trees-border-color-override: color-mix(in srgb, currentColor 14%, transparent);
    --trees-font-family-override: var(--font-sans);
    --trees-font-size-override: 0.75rem;
  }
  /* A name and its file type are two boxes, ordered by the name's own direction: see
     markRightToLeftTreeNames. Left to the page's direction, a Latin name shows its type first. */
  [data-item-section='content'] { direction: ltr; }
  [data-name-rtl] [data-item-section='content'] { direction: rtl; }
  [data-truncate-content='visible'] { overflow: hidden; text-overflow: ellipsis; }
  [data-truncate-marker] { display: none; }
  button[data-type='item'], button[data-type='item']::before { border-radius: var(--radius-md); }
  svg[data-icon-name='t3-tree-icon-loading'] { opacity: 0.6; }
  @media (prefers-reduced-motion: no-preference) {
    svg[data-icon-name='t3-tree-icon-loading'] { animation: t3-tree-spin 1s linear infinite; }
  }
  @keyframes t3-tree-spin { to { transform: rotate(360deg); } }
`;

export function pierreTreeStyle(colorScheme: "light" | "dark"): CSSProperties {
  return {
    colorScheme,
    ["--trees-fg-override" as string]: "var(--contrast-foreground)",
    ["--trees-fg-muted-override" as string]: "var(--contrast-muted-foreground)",
    ["--trees-status-ignored-override" as string]: "var(--contrast-muted-foreground)",
  };
}

/** A name whose first letter is of a script written right to left. */
const STARTS_RIGHT_TO_LEFT = /^[^\p{L}]*[\p{Script=Arabic}\p{Script=Hebrew}]/u;

/**
 * Marks the rows of the trees under `container` whose name starts in a right-to-left script, as
 * `dir="auto"` would. The tree gives no hook for drawing a row, and a style cannot read a name.
 * A ref callback: returns its own cleanup.
 */
export function markRightToLeftTreeNames(container: HTMLElement | null): (() => void) | undefined {
  if (container === null) return undefined;
  const roots = new Set<ShadowRoot>();
  const mark = () => {
    for (const host of container.querySelectorAll("*")) {
      const root = host.shadowRoot;
      if (root === null || roots.has(root)) continue;
      roots.add(root);
      // Rows come and go as the tree scrolls, and one is reused for another file.
      observer.observe(root, {
        subtree: true,
        childList: true,
        attributes: true,
        attributeFilter: ["data-item-path"],
      });
    }
    for (const root of roots) {
      for (const row of root.querySelectorAll<HTMLElement>("[data-item-path]")) {
        const name = (row.dataset.itemPath ?? "").replace(/\/$/, "").split("/").at(-1) ?? "";
        const rightToLeft = STARTS_RIGHT_TO_LEFT.test(name);
        if (row.hasAttribute("data-name-rtl") !== rightToLeft) {
          row.toggleAttribute("data-name-rtl", rightToLeft);
        }
      }
    }
  };
  const observer = new MutationObserver(mark);
  observer.observe(container, { subtree: true, childList: true });
  mark();
  return () => observer.disconnect();
}

// Clipped labels are unreadable and the tree cannot scroll sideways, so a clipped row gets its full name as a native tooltip.
export function titleClippedPierreTreeRow(event: PointerEvent<HTMLElement>) {
  const row = event.nativeEvent
    .composedPath()
    .find(
      (node): node is HTMLElement =>
        node instanceof HTMLElement && node.matches("button[data-type='item']"),
    );
  if (!row) return;
  const label = row.getAttribute("aria-label");
  const clipped = Array.from(
    row.querySelectorAll<HTMLElement>("[data-truncate-content='visible']"),
  ).some((element) => element.scrollWidth > element.clientWidth);
  if (label && clipped) row.title = label;
  else row.removeAttribute("title");
}
