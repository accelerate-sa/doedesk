export const COLLAPSED_SIDEBAR_TITLEBAR_INSET_CLASS =
  "[[data-sidebar-state=collapsed]_&]:ps-[var(--workspace-titlebar-content-left)] max-md:[[data-sidebar-state=expanded]_&]:ps-[var(--workspace-titlebar-content-left)]";

// Physical offsets, swapped by direction: each side keeps clearing the window controls drawn there.
export const WORKSPACE_CONTROLS_END_CLASS =
  "ltr:right-[var(--workspace-controls-right)] rtl:left-[var(--workspace-controls-left)]";
