import { thrownErrorMessage } from "@t3tools/client-runtime/errors";
import { m } from "~/i18n/messages";
import { RefreshIcon } from "~/components/ui/refresh-icon";
import type {
  ContextMenuItem as TreeContextMenuItem,
  ContextMenuOpenContext as TreeContextMenuOpenContext,
} from "@pierre/trees";
import type { EnvironmentId, ProjectEntry } from "@t3tools/contracts";
import { FileTree, useFileTree, useFileTreeSearch, useFileTreeSelector } from "@pierre/trees/react";
import { settlePromise } from "@t3tools/client-runtime/state/runtime";
import { serializeComposerFileLink } from "@t3tools/shared/composerTrigger";
import * as AsyncResult from "effect/reactivity/AsyncResult";
import * as Cause from "effect/Cause";
import { T, useGT, useMessages } from "gt-react";
import { ChevronsDownUpIcon, ChevronsUpDownIcon } from "lucide-react";
import { type Ref, useEffect, useEffectEvent, useRef, useState } from "react";

import { Button } from "~/components/ui/button";
import { InputGroup, InputGroupInput } from "~/components/ui/input-group";
import { toastManager } from "~/components/ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { useComposerHandleContext } from "~/composerHandleContext";
import { writeTextToClipboard } from "~/hooks/useCopyToClipboard";
import { useStableCallback } from "~/hooks/useStableCallback";
import { useTheme } from "~/hooks/useTheme";
import { useWorkspaceMutationRefresh } from "~/hooks/useWorkspaceMutationRefresh";
import { useFileContextMenu, type FileContextMenuAction } from "~/fileContextMenu";
import { readLocalApi } from "~/localApi";
import { T3_PIERRE_ICONS } from "~/pierre-icons";
import {
  markRightToLeftTreeNames,
  PIERRE_TREE_UNSAFE_CSS,
  pierreTreeStyle,
  titleClippedPierreTreeRow,
} from "~/pierre-tree-theme";

import { SealedFilesList, SealingElsewhereNote } from "../privacy/SealedFiles";
import {
  fileNameOf,
  groupSealedListing,
  sealedFolderAt,
  sealedFolderHolding,
  sealedFolderToUnseal,
} from "../privacy/sealedFiles.logic";
import { useFolderSealing } from "../privacy/useFolderSealing";
import { reloadSealedDocuments, useSealedRevision } from "~/privacy/privacyClient";
import {
  requestSeal,
  requestSealFiles,
  requestSealFolder,
  requestUnsealFolder,
} from "~/privacy/sealPrompt";
import { joinHostPath } from "./filePath";
import { createFileTreeDragMentionController } from "./fileTreeDragMention";
import {
  areAllDirectoriesExpanded,
  coalesceReentrantCalls,
  readExpandedDirectories,
  setAllDirectoriesExpanded,
  writeExpandedDirectories,
} from "./fileTreeExpansion";
import { buildFileTreePathUpdates, shouldRebuildFileTree } from "./fileTreePathReconciliation";
import { loadFileAncestors } from "./loadFileAncestors";
import { useDirectoryEntries } from "./useDirectoryEntries";
import { useProjectPathSearch } from "~/state/queries";
import { isMacPlatform } from "~/lib/utils";
import { type PreviewAction, subscribePreviewAction } from "../preview/previewActionBus";

interface FileBrowserPanelProps {
  environmentId: EnvironmentId;
  cwd: string;
  /** The folder's project, when its files can be sealed from this list. */
  projectId?: string | undefined;
  projectName: string;
  selectedPath: string | null;
  selectedPathRevealId: number;
  onOpenFile: (relativePath: string) => void;
  /** Host-folder entries use absolute paths. Avoid full traversal: disable expand-all and search only
   * loaded folders. */
  hostFolder?: boolean;
  onRefreshSelectedFile?: () => void;
  workspaceMutationId: string | null;
  answersPanelFind?: boolean;
}

function treePath(entry: ProjectEntry): string {
  return entry.kind === "directory" ? `${entry.path}/` : entry.path;
}

function RefreshFilesButton(props: { isPending: boolean; onRefresh: () => void }) {
  const gt = useGT();
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            aria-label={gt("Refresh workspace files")}
            onClick={props.onRefresh}
          />
        }
      >
        <RefreshIcon refreshing={props.isPending} />
      </TooltipTrigger>
      <TooltipPopup>{props.isPending ? gt("Refreshing…") : gt("Refresh files")}</TooltipPopup>
    </Tooltip>
  );
}

function FileSearchField({
  ref,
  ...props
}: {
  ariaLabel: string;
  name: string;
  onClose: () => void;
  onValueChange: (value: string) => void;
  ref: Ref<HTMLInputElement>;
  value: string;
}) {
  const gt = useGT();
  return (
    <InputGroup variant="ghost" className="h-7 min-w-0 flex-1">
      <InputGroupInput
        ref={ref}
        type="search"
        name={props.name}
        size="sm"
        value={props.value}
        aria-label={props.ariaLabel}
        placeholder={gt("Search files")}
        data-workspace-focus-default
        spellCheck={false}
        onChange={(event) => props.onValueChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key !== "Escape") return;
          props.onClose();
          event.currentTarget.blur();
        }}
      />
    </InputGroup>
  );
}

function buildTreeEntries(
  directoryEntries: readonly ProjectEntry[],
  searchEntries: readonly ProjectEntry[],
  searchPending: boolean,
  query: string,
) {
  const result = new Map(directoryEntries.map((entry) => [entry.path, entry]));
  if (query.trim() && !searchPending) {
    for (const entry of searchEntries) {
      if (!result.has(entry.path)) result.set(entry.path, entry);
      const segments = entry.path.split("/");
      for (let index = 1; index < segments.length; index++) {
        const path = segments.slice(0, index).join("/");
        if (!result.has(path)) result.set(path, { path, kind: "directory" });
      }
    }
  }
  const entries = [...result.values()];
  const entryKinds: ReadonlyMap<string, ProjectEntry["kind"]> = new Map(
    entries.map((entry) => [entry.path, entry.kind] as const),
  );
  const treePaths = entries.map(treePath);
  const directories = entries.filter((entry) => entry.kind === "directory");
  const directoryPaths = directories.map(treePath);
  // Expanding a folder lists it, and an ignored one such as `node_modules` can hold tens of
  // thousands, so expand all skips ignored folders. They still open by hand.
  const expandableDirectoryPaths = directories.filter((entry) => !entry.ignored).map(treePath);
  return { entries, entryKinds, treePaths, directoryPaths, expandableDirectoryPaths };
}

export default function FileBrowserPanel({
  environmentId,
  cwd,
  projectId,
  projectName,
  selectedPath,
  selectedPathRevealId,
  onOpenFile,
  onRefreshSelectedFile,
  workspaceMutationId,
  hostFolder = false,
  answersPanelFind = false,
}: FileBrowserPanelProps) {
  const panelPath = (relativePath: string) =>
    hostFolder ? joinHostPath(cwd, relativePath) : relativePath;
  const gt = useGT();
  const messages = useMessages();
  const { resolvedTheme } = useTheme();
  const composerRef = useComposerHandleContext();
  const fileContextMenu = useFileContextMenu(environmentId);
  const sealing = useFolderSealing(environmentId, projectId);
  const sealedRevision = useSealedRevision();
  /** Where a row of the tree lies on the computer that holds the folder. */
  const hostPath = (treeItemPath: string) => {
    const relativePath = treeItemPath.replace(/\/$/, "");
    return hostFolder ? panelPath(relativePath) : joinHostPath(cwd, relativePath);
  };
  const {
    entries: directoryEntries,
    load,
    refresh,
    ready,
    error,
    isPending,
    loadingDirectories,
  } = useDirectoryEntries(environmentId, cwd);
  const [query, setQuery] = useState("");
  const [expandAll, setExpandAll] = useState(false);
  const pathSearch = useProjectPathSearch(
    { environmentId, cwd: hostFolder ? null : cwd, query: query.slice(0, 256) },
    200,
    undefined,
    messages,
  );
  const { entries, entryKinds, treePaths, directoryPaths, expandableDirectoryPaths } =
    buildTreeEntries(directoryEntries, pathSearch.entries, pathSearch.isPending, query);
  const entryKindsRef = useRef(entryKinds);
  const previousTreePathsRef = useRef<readonly string[] | null>(null);
  const syncingSelectionRef = useRef(false);
  const treeSelectionPathRef = useRef<string | null>(null);
  const handledRevealRef = useRef<{ path: string; revealId: number } | null>(null);
  // Tree path of the revealed row. Folders restored or loaded later insert rows above it, so each
  // path update scrolls to it again until the user takes over the scroll position.
  const followedRevealRef = useRef<string | null>(null);

  // Shadow-DOM row rects are unreliable; capture the composed contextmenu event's viewport position.
  const contextMenuPointerRef = useRef<{ x: number; y: number; at: number } | null>(null);

  // Kept by the tree's selection handler, for the menu that opens on one of the selected rows.
  const selectedTreePathsRef = useRef<readonly string[]>([]);
  const selectedFilePaths = () =>
    selectedTreePathsRef.current.filter((path) => !path.endsWith("/"));
  const showEntryContextMenu = useStableCallback(
    (item: TreeContextMenuItem, context: TreeContextMenuOpenContext) => {
      const api = readLocalApi();
      if (!api) {
        context.close();
        return;
      }
      const relativePath = item.path.replace(/\/$/, "");
      const mention = serializeComposerFileLink(panelPath(relativePath));
      const pointer = contextMenuPointerRef.current;
      const pointerIsFresh = pointer !== null && performance.now() - pointer.at < 1000;
      const anchorRect = context.anchorElement.getBoundingClientRect();
      const position = pointerIsFresh
        ? { x: pointer.x, y: pointer.y }
        : { x: anchorRect.left, y: anchorRect.bottom };
      const fileTarget = { environmentId, filePath: relativePath, workspaceRoot: cwd };
      const fileMenuItems = fileContextMenu.buildItems(fileTarget);
      const isDirectory = item.path.endsWith("/");
      // A right-click on one of several selected files is about all of them.
      const selectedFiles = selectedFilePaths();
      const sealsSelection = selectedFiles.length > 1 && selectedFiles.includes(item.path);
      const sealedFolder = isDirectory
        ? sealedFolderAt(sealing.listing, hostPath(item.path))
        : undefined;
      const sealItems =
        !sealing.offered || projectId === undefined
          ? []
          : sealedFolder !== undefined
            ? [{ id: "unseal-folder", label: gt("Unseal folder…") }]
            : isDirectory
              ? // A folder inside a sealed one is sealed already, with it.
                sealedFolderHolding(sealing.listing, hostPath(item.path)) === undefined
                ? [{ id: "seal-folder", label: gt("Seal folder…") }]
                : []
              : sealsSelection
                ? [
                    {
                      id: "seal-selected",
                      label: gt(
                        "{count, plural, one {Seal {count} file…} other {Seal {count} files…}}",
                        { count: selectedFiles.length },
                      ),
                    },
                  ]
                : [{ id: "seal", label: gt("Seal…") }];
      // The app menu owns focus; the tree's outside-click handler would dismiss it before click.
      context.close({ restoreFocus: !pointerIsFresh });
      void settlePromise(async () => {
        const clicked = await api.contextMenu.show(
          [
            ...fileMenuItems,
            { id: "copy-mention", label: gt("Copy mention") },
            { id: "add-to-chat", label: gt("Add to chat") },
            ...sealItems,
          ],
          position,
        );
        if (clicked === null) return;
        // Open-with submenu ids are absent from the top-level item list.
        const isFileMenuAction =
          fileMenuItems.some((entry) => entry.id === clicked) || clicked.startsWith("editor:");
        if (isFileMenuAction) {
          await fileContextMenu.activate(clicked as FileContextMenuAction, fileTarget);
          return;
        }
        if (clicked === "seal" && projectId !== undefined) {
          requestSeal({ projectId, name: fileNameOf(relativePath), path: hostPath(item.path) });
          return;
        }
        if (clicked === "seal-selected" && projectId !== undefined) {
          requestSealFiles({ projectId, paths: selectedFiles.map(hostPath) });
          return;
        }
        if (clicked === "seal-folder" && projectId !== undefined) {
          requestSealFolder({
            projectId,
            name: fileNameOf(relativePath),
            path: hostPath(item.path),
          });
          return;
        }
        if (clicked === "unseal-folder" && projectId !== undefined) {
          const folder = sealedFolderToUnseal(sealing.listing, hostPath(item.path));
          if (folder !== undefined) requestUnsealFolder({ projectId, ...folder });
          return;
        }
        if (clicked === "copy-mention") {
          try {
            await writeTextToClipboard(mention);
          } catch (error) {
            toastManager.add({
              type: "error",
              title: gt("Failed to copy mention"),
              description: thrownErrorMessage(error, m) ?? gt("An error occurred."),
            });
          }
          return;
        }
        if (clicked === "add-to-chat") {
          const composer = composerRef?.current;
          if (!composer) {
            toastManager.add({
              type: "error",
              title: gt("Unable to add to chat"),
              description: gt("Open a chat for this folder and try again."),
            });
            return;
          }
          const inserted = composer.insertTextAtEnd(`${mention} `, { ensureLeadingBoundary: true });
          if (!inserted) {
            toastManager.add({
              type: "error",
              title: gt("Unable to add to chat"),
              description: gt("The chat isn't ready to accept input right now."),
            });
          }
        }
      }).then((result) => {
        if (!AsyncResult.isSuccess(result)) throw Cause.squash(result.cause);
      });
    },
  );

  const loadingDirectoriesRef = useRef(loadingDirectories);
  // What the tree says beside a sealed folder's row, by the row's path: how many files are sealed.
  const sealedFolderLabelsRef = useRef<ReadonlyMap<string, string>>(new Map());
  const dragMention = createFileTreeDragMentionController(
    hostFolder ? { mentionPath: (path: string) => joinHostPath(cwd, path) } : {},
  );
  const { model } = useFileTree({
    composition: {
      contextMenu: {
        // The row's own button too: a right-click is not something every person finds.
        triggerMode: "both",
        onOpen: (item, context) => {
          showEntryContextMenu(item, context);
        },
      },
    },
    dragAndDrop: { canDrop: () => false },
    density: "compact",
    fileTreeSearchMode: "hide-non-matches",
    flattenEmptyDirectories: true,
    initialExpansion: "closed",
    icons: T3_PIERRE_ICONS,
    onSelectionChange: (selectedPaths) => {
      selectedTreePathsRef.current = selectedPaths;
      // Update drag selection even for reveals so subsequent drags cannot use stale paths.
      dragMention.handleSelectionChange(selectedPaths);
      if (syncingSelectionRef.current) return;
      if (dragMention.isDragInProgress()) {
        return;
      }
      const selectedPath = selectedPaths.at(-1)?.replace(/\/$/, "");
      if (selectedPath && entryKindsRef.current.get(selectedPath) === "file") {
        treeSelectionPathRef.current = selectedPath;
        onOpenFile(panelPath(selectedPath));
      }
    },
    paths: [],
    renderRowDecoration: ({ item, row }) => {
      if (row.kind !== "directory") return null;
      if (row.isExpanded && loadingDirectoriesRef.current.has(item.path.replace(/\/$/, ""))) {
        return { icon: "t3-tree-icon-loading", title: gt("Loading…") };
      }
      // Sealed files leave the folder: its row says they are sealed, not gone.
      const sealed = sealedFolderLabelsRef.current.get(item.path);
      return sealed === undefined ? null : { text: sealed, title: gt("Sealed folder") };
    },
    search: false,
    onSearchChange: (value) => setQuery(value ?? ""),
    unsafeCSS: PIERRE_TREE_UNSAFE_CSS,
  });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- makes the Pierre tree model re-render row decorations when loading directories change
  useEffect(() => {
    if (loadingDirectoriesRef.current === loadingDirectories) return;
    loadingDirectoriesRef.current = loadingDirectories;
    model.setComposition(model.getComposition());
  }, [loadingDirectories, model]);
  // As text, so the effect below runs only when a label really changed.
  const sealedFolderLabels = JSON.stringify(
    sealing.listing === null
      ? []
      : groupSealedListing(sealing.listing).folders.map((group) => {
          const root = cwd.replaceAll("\\", "/").replace(/\/+$/, "");
          const path = group.folder.path.replaceAll("\\", "/");
          const inside = path.startsWith(`${root}/`);
          return [
            `${inside ? path.slice(root.length + 1) : path}/`,
            gt("{count, plural, one {{count} sealed} other {{count} sealed}}", {
              count: group.documents.length,
              $context: "after a folder's name: how many of its files are sealed",
            }),
          ];
        }),
  );
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- makes the Pierre tree model re-render row decorations when a folder is sealed or its count changes
  useEffect(() => {
    sealedFolderLabelsRef.current = new Map(
      JSON.parse(sealedFolderLabels) as ReadonlyArray<readonly [string, string]>,
    );
    model.setComposition(model.getComposition());
  }, [sealedFolderLabels, model]);
  // The selected files, as one string so the selector's answer stays the same between changes.
  const selectedFileList = useFileTreeSelector(model, (currentModel) =>
    currentModel
      .getSelectedPaths()
      .filter((path) => !path.endsWith("/"))
      .join("\n"),
  );
  const selectedFileCount = selectedFileList === "" ? 0 : selectedFileList.split("\n").length;
  const search = useFileTreeSearch(model);
  // Pierre restores the unfiltered tree when a search has no matches.
  const hasNoSearchMatches = search.value.trim().length > 0 && search.matchingPaths.length === 0;
  const allDirectoriesExpanded = useFileTreeSelector(model, (currentModel) =>
    areAllDirectoriesExpanded(currentModel, expandableDirectoryPaths),
  );
  const toggleAllDirectories = () => {
    const expanded = !(expandAll || allDirectoriesExpanded);
    setExpandAll(expanded);
    setAllDirectoriesExpanded(
      model,
      expanded ? expandableDirectoryPaths : directoryPaths,
      expanded,
    );
  };
  const closeSearch = () => {
    setQuery("");
    search.close();
  };
  const searchInputRef = useRef<HTMLInputElement>(null);
  const focusSearch = () => {
    searchInputRef.current?.focus();
    searchInputRef.current?.select();
  };
  const onPanelAction = useEffectEvent((action: PreviewAction) => {
    // Hidden panel tabs stay mounted; only the visible Files tab answers.
    if (action === "find" && searchInputRef.current?.getClientRects().length) focusSearch();
  });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- subscribes to the panel find command, which fires while focus is anywhere in the right panel
  useEffect(() => {
    if (!answersPanelFind) return;
    return subscribePreviewAction(onPanelAction);
  }, [answersPanelFind]);
  const expandedPathsRef = useRef(new Set<string>());
  const expansionRoot = `${environmentId}:${cwd}`;
  // Folders expanded when the panel last unmounted; each reopens once lazy loading lists it.
  const [pendingExpandedPaths] = useState(() => new Set(readExpandedDirectories(expansionRoot)));
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- subscribes to the Pierre tree model to load directories as they are expanded
  useEffect(() => {
    const currentPaths = new Set(directoryPaths);
    for (const path of expandedPathsRef.current) {
      if (!currentPaths.has(path)) expandedPathsRef.current.delete(path);
    }
    // Restoring calls item.expand(), which notifies subscribers synchronously.
    const loadExpanded = coalesceReentrantCalls(() => {
      if (model.isSearchOpen()) return;
      let changed = false;
      for (const path of directoryPaths) {
        const item = model.getItem(path);
        if (item?.isDirectory() && pendingExpandedPaths.delete(path) && "expand" in item) {
          item.expand();
        }
        if (item?.isDirectory() && "isExpanded" in item && item.isExpanded()) {
          if (!expandedPathsRef.current.has(path)) {
            expandedPathsRef.current.add(path);
            changed = true;
            void load(path.replace(/\/$/, ""));
          }
        } else {
          if (item?.isDirectory() && expandedPathsRef.current.has(path)) setExpandAll(false);
          if (expandedPathsRef.current.delete(path)) changed = true;
        }
      }
      if (changed) {
        writeExpandedDirectories(expansionRoot, [
          ...expandedPathsRef.current,
          ...pendingExpandedPaths,
        ]);
      }
    });
    loadExpanded();
    return model.subscribe(loadExpanded);
  }, [directoryPaths, expansionRoot, load, model, pendingExpandedPaths]);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- pushes ignored-file status into the imperative Pierre tree model
  useEffect(() => {
    model.setGitStatus(
      entries
        .filter((entry) => entry.ignored)
        .map((entry) => ({
          path: treePath(entry),
          status: "ignored",
        })),
    );
  }, [entries, model]);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- loads the selected file's ancestor directories and aborts on cleanup
  useEffect(() => {
    if (!selectedPath) return;
    const controller = new AbortController();
    void loadFileAncestors(selectedPath, load, { signal: controller.signal });
    return () => {
      controller.abort();
    };
  }, [load, selectedPath]);
  const stopFollowingReveal = () => {
    followedRevealRef.current = null;
  };
  const handleSearchValueChange = (value: string) => {
    setQuery(value);
    if (value.trim().length === 0) {
      search.close();
      return;
    }
    search.setValue(value);
  };
  const hasSealedFolders = (sealing.listing?.folders?.length ?? 0) > 0;
  const handleRefresh = () => {
    refresh();
    if (hasSealedFolders) reloadSealedDocuments();
    if (query.trim()) pathSearch.refresh();
    onRefreshSelectedFile?.();
  };
  const refreshOnReturn = useEffectEvent(() => {
    refresh();
    if (query.trim()) pathSearch.refresh();
  });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- subscribes to the window coming back to the front: a file saved from another program is in the folder by then, and nothing else says so
  useEffect(() => {
    let last = Number.NEGATIVE_INFINITY;
    const onReturn = () => {
      // Focus and visibility both fire on one return; a second read within moments adds nothing.
      if (document.visibilityState !== "visible" || performance.now() - last < 2_000) return;
      last = performance.now();
      refreshOnReturn();
    };
    window.addEventListener("focus", onReturn);
    document.addEventListener("visibilitychange", onReturn);
    return () => {
      window.removeEventListener("focus", onReturn);
      document.removeEventListener("visibilitychange", onReturn);
    };
  }, []);
  useWorkspaceMutationRefresh({
    // Sealing moves a file out of the folder and unsealing puts it back.
    mutationId:
      sealedRevision === 0 ? workspaceMutationId : `${workspaceMutationId}:${sealedRevision}`,
    refresh: () => {
      refresh();
      if (query.trim()) pathSearch.refresh();
    },
    resourceKey: `files:${environmentId}:${cwd}`,
  });
  // A sealed folder seals what an agent's turn left in it, so its count follows the turn.
  useWorkspaceMutationRefresh({
    enabled: hasSealedFolders,
    mutationId: workspaceMutationId,
    refresh: reloadSealedDocuments,
    resourceKey: `sealed:${environmentId}:${cwd}`,
  });

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- applies tree path changes to the imperative Pierre tree model as a reset or batch update
  useEffect(() => {
    if (!ready) return;
    if (previousTreePathsRef.current === treePaths) return;
    entryKindsRef.current = entryKinds;
    const previousTreePaths = previousTreePathsRef.current;
    previousTreePathsRef.current = treePaths;
    if (previousTreePaths === null) {
      model.resetPaths(treePaths);
      return;
    }
    const updates = buildFileTreePathUpdates(previousTreePaths, treePaths);
    if (shouldRebuildFileTree(previousTreePaths, treePaths, updates)) {
      // A reset keeps old search matches, so search closes first and recomputes afterwards.
      const activeSearch = model.isSearchOpen() ? model.getSearchValue() : null;
      if (activeSearch !== null) model.closeSearch();
      model.resetPaths(treePaths, { initialExpandedPaths: [...expandedPathsRef.current] });
      if (activeSearch !== null) model.setSearch(activeSearch);
    } else if (updates.length > 0) {
      model.batch(updates);
    } else {
      return;
    }
    if (followedRevealRef.current !== null) {
      model.scrollToPath(followedRevealRef.current, { focus: false, offset: "center" });
    }
  }, [ready, entryKinds, model, treePaths]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- expands every directory in the Pierre tree model while expand-all is on and no search is active
  useEffect(() => {
    if (expandAll && !query.trim())
      setAllDirectoriesExpanded(model, expandableDirectoryPaths, true);
  }, [expandableDirectoryPaths, expandAll, model, query]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- reveals an externally selected path in the Pierre tree model by expanding, selecting and scrolling
  useEffect(() => {
    if (!selectedPath) {
      handledRevealRef.current = null;
      followedRevealRef.current = null;
      return;
    }
    const selectedKind = entryKinds.get(selectedPath);
    if (selectedKind === undefined) {
      handledRevealRef.current = null;
      return;
    }
    const revealRequest = { path: selectedPath, revealId: selectedPathRevealId };
    const handledReveal = handledRevealRef.current;
    // Refresh rebuilds treePaths; replaying handled reveals would close search and steal focus.
    if (
      handledReveal?.path === revealRequest.path &&
      handledReveal.revealId === revealRequest.revealId
    ) {
      return;
    }
    const selectedTreePath = selectedKind === "directory" ? `${selectedPath}/` : selectedPath;
    const selectedItem = model.getItem(selectedTreePath);
    if (!selectedItem) return;

    // Reveal only external selections; tree selections are visible and re-revealing would close search.
    const selectedInTree = model
      .getSelectedPaths()
      .some((path) => path.replace(/\/$/, "") === selectedPath);
    if (selectedInTree && treeSelectionPathRef.current === selectedPath) {
      treeSelectionPathRef.current = null;
      handledRevealRef.current = revealRequest;
      followedRevealRef.current = null;
      return;
    }
    treeSelectionPathRef.current = null;
    handledRevealRef.current = revealRequest;

    syncingSelectionRef.current = true;
    setQuery("");
    model.closeSearch();
    for (const path of model.getSelectedPaths()) {
      model.getItem(path)?.deselect();
    }

    // Directory paths include trailing slashes; ancestor lookups must match.
    const segments = selectedPath.split("/");
    let ancestorPath = "";
    for (const segment of segments.slice(0, -1)) {
      ancestorPath = ancestorPath ? `${ancestorPath}/${segment}` : segment;
      const item = model.getItem(`${ancestorPath}/`) ?? model.getItem(ancestorPath);
      if (item && "expand" in item) item.expand();
    }

    if ("expand" in selectedItem) selectedItem.expand();
    selectedItem.select();
    model.scrollToPath(selectedTreePath, {
      focus: true,
      offset: "center",
    });
    followedRevealRef.current = selectedTreePath;
    queueMicrotask(() => {
      syncingSelectionRef.current = false;
    });
  }, [entryKinds, model, selectedPath, selectedPathRevealId]);

  return (
    <div
      ref={markRightToLeftTreeNames}
      className="flex min-h-0 flex-1 flex-col bg-background"
      data-file-browser-panel={`${environmentId}:${cwd}`}
      // Capture runs before the tree's shadow-internal row handler opens the menu.
      onContextMenuCapture={(event) => {
        contextMenuPointerRef.current = { x: event.clientX, y: event.clientY, at: event.timeStamp };
      }}
      // Capture dragstart before the tree selects the row so selection sees the drag flag.
      onDragStartCapture={(event) => dragMention.handleDragStart(event.nativeEvent)}
      onDragEnd={() => dragMention.handleDragEnd((path) => model.getItem(path)?.deselect())}
      onWheel={stopFollowingReveal}
      onPointerDown={stopFollowingReveal}
      onTouchStart={stopFollowingReveal}
      onKeyDown={(event) => {
        stopFollowingReveal();
        const isModPressed = isMacPlatform(navigator.platform) ? event.metaKey : event.ctrlKey;
        if (!isModPressed || event.altKey || event.shiftKey || event.key.toLowerCase() !== "f")
          return;
        event.preventDefault();
        focusSearch();
      }}
    >
      <div
        className="flex h-10 min-h-10 shrink-0 items-center gap-1 border-b border-border/60 bg-background px-2 in-data-[preview-panel-mode=inline]:mb-1 in-data-[preview-panel-mode=inline]:h-9 in-data-[preview-panel-mode=inline]:min-h-9 in-data-[preview-panel-mode=inline]:border-b-transparent"
        data-surface-subheader
      >
        <RefreshFilesButton isPending={isPending} onRefresh={handleRefresh} />
        <FileSearchField
          ref={searchInputRef}
          name="project-files-search"
          ariaLabel={gt("Search {projectName} files", { projectName })}
          value={search.value}
          onValueChange={handleSearchValueChange}
          onClose={closeSearch}
        />
        {directoryPaths.length > 0 && !hostFolder ? (
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  type="button"
                  size="icon-xs"
                  variant="ghost"
                  aria-label={
                    expandAll || allDirectoriesExpanded
                      ? gt("Collapse all folders")
                      : gt("Expand all folders")
                  }
                  onClick={toggleAllDirectories}
                />
              }
            >
              {allDirectoriesExpanded ? (
                <ChevronsDownUpIcon className="size-3.5" />
              ) : (
                <ChevronsUpDownIcon className="size-3.5" />
              )}
            </TooltipTrigger>
            <TooltipPopup>
              {expandAll || allDirectoriesExpanded
                ? gt("Collapse all folders")
                : gt("Expand all folders")}
            </TooltipPopup>
          </Tooltip>
        ) : null}
      </div>
      {error || pathSearch.error ? (
        <button
          type="button"
          onClick={handleRefresh}
          className="p-4 text-start text-xs leading-relaxed text-destructive"
        >
          {gt("{error} Click to retry.", { error: error ?? pathSearch.error })}
        </button>
      ) : null}
      {query.trim() && pathSearch.truncated && !pathSearch.isPending ? (
        <div className="px-3 py-1 text-xs text-muted-foreground">
          <T>More matches available. Refine your search.</T>
        </div>
      ) : null}
      {(!ready || pathSearch.isPending) && (
        <div
          role="status"
          className={
            entries.length > 0 && !hasNoSearchMatches
              ? "sr-only"
              : "px-3 py-1 text-xs text-muted-foreground"
          }
        >
          <T>Loading files…</T>
        </div>
      )}
      {hasNoSearchMatches ? (
        ready && !isPending && !pathSearch.isPending && !error && !pathSearch.error ? (
          <div role="status" className="px-3 py-4 text-xs text-muted-foreground">
            <T>No matching files.</T>
          </div>
        ) : null
      ) : (
        <FileTree
          model={model}
          aria-label={gt("{projectName} files", { projectName })}
          className="min-h-0 flex-1 overflow-hidden"
          style={pierreTreeStyle(resolvedTheme)}
          onPointerOver={titleClippedPierreTreeRow}
        />
      )}
      {sealing.offered && projectId !== undefined && selectedFileCount > 1 ? (
        <div className="flex shrink-0 items-center justify-between gap-2 border-t border-border/60 px-3 py-1.5 text-xs">
          <span className="min-w-0 truncate text-muted-foreground">
            {gt("{count, plural, one {{count} file selected} other {{count} files selected}}", {
              count: selectedFileCount,
            })}
          </span>
          <Button
            variant="outline"
            size="xs"
            onClick={() =>
              requestSealFiles({ projectId, paths: selectedFileList.split("\n").map(hostPath) })
            }
          >
            {gt("{count, plural, one {Seal {count} file} other {Seal {count} files}}", {
              count: selectedFileCount,
            })}
          </Button>
        </div>
      ) : null}
      {projectId !== undefined &&
      sealing.listing !== null &&
      sealing.listing.documents.length + (sealing.listing.folders?.length ?? 0) > 0 ? (
        <section
          aria-label={gt("Sealed files")}
          className="max-h-40 shrink-0 overflow-y-auto border-t border-border/60 px-3 py-2"
        >
          <h3 className="pb-1 text-2xs font-medium text-muted-foreground">{gt("Sealed files")}</h3>
          <SealedFilesList
            projectId={projectId}
            listing={sealing.listing}
            onOpen={(origin) => {
              const root = cwd.replace(/[\\/]+$/, "");
              const inside = origin.startsWith(`${root}/`) || origin.startsWith(`${root}\\`);
              onOpenFile(
                inside && !hostFolder
                  ? origin.slice(root.length + 1).replaceAll("\\", "/")
                  : origin,
              );
            }}
          />
        </section>
      ) : null}
      {sealing.elsewhere ? <SealingElsewhereNote environmentId={environmentId} /> : null}
    </div>
  );
}
