// Match the sidebar gap during a drag, before pointer-up commits its visibility.
export const COLLAPSED_SIDEBAR_TITLEBAR_INSET_CLASS =
  "[[data-sidebar-state=collapsed]:not([data-sidebar-drag-state=expanded])_&]:ps-[var(--workspace-titlebar-content-left)] [[data-sidebar-drag-state=collapsed]_&]:ps-[var(--workspace-titlebar-content-left)] max-md:[[data-sidebar-state=expanded]_&]:ps-[var(--workspace-titlebar-content-left)] [[data-sidebar-drag-state]_&]:transition-none!";

// Physical offsets, swapped by direction: each side keeps clearing the window controls drawn there.
export const WORKSPACE_CONTROLS_END_CLASS =
  "ltr:right-[var(--workspace-controls-right)] rtl:left-[var(--workspace-controls-left)]";
