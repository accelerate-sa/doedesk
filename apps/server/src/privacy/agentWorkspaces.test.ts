import { describe, expect, it } from "vite-plus/test";

import {
  sealedFilesNote,
  sealedFoldersBeforeTurn,
  sealedFoldersBelow,
  setSealChangeHandler,
  setSealedFilesSource,
  setSealedFolderPaths,
} from "./agentWorkspaces.ts";

describe("sealedFilesNote", () => {
  it("tells an agent each sealed file and folder of its project as the gateway labels them", () => {
    const asked: Array<string | null> = [];
    setSealedFilesSource((project, cwd) => {
      asked.push(cwd);
      return project === "project-with-sealed"
        ? {
            askOffered: true,
            folders: ["contracts"],
            files: [
              { handle: "DOC_1", name: "lease.md", path: "contracts/lease.md", unread: false },
              {
                handle: "DOC_2",
                name: "elsewhere.csv",
                path: "/other/elsewhere.csv",
                unread: false,
              },
              { handle: "DOC_3", name: "upload.pdf", unread: false },
              // A file saved again into a sealed folder keeps its handle: it is one line.
              {
                handle: "DOC_4",
                name: "scan.tiff",
                path: "contracts/2025/scan.tiff",
                unread: true,
              },
            ],
          }
        : { askOffered: true, folders: [], files: [] };
    });

    const note = sealedFilesNote("project-with-sealed", "/case/");
    // The gateway writes the paths from the agent's working folder.
    expect(asked).toEqual(["/case/"]);
    expect(note).toContain("- DOC_2: elsewhere.csv (was at /other/elsewhere.csv)");
    expect(note).toContain("- DOC_3: upload.pdf\n");
    expect(note).toContain(
      [
        "- Sealed folder contracts/ (every file in it is sealed, and so is any file put there later; write nothing into it):",
        "  - DOC_1: lease.md",
        "  - DOC_4: scan.tiff (at 2025/scan.tiff) (cannot be asked about yet)",
      ].join("\n"),
    );
    expect(sealedFilesNote("project-without", "/case")).toBe("");
  });
});

describe("sealed folders and checkpoints", () => {
  it("names the sealed folders below a folder as paths from it", () => {
    setSealedFolderPaths(() => ["/case/contracts", "/case/hr/payroll/", "/other/contracts"]);
    expect(sealedFoldersBelow("/case/")).toEqual(["contracts", "hr/payroll"]);
    expect(sealedFoldersBelow("/case/contracts")).toEqual([]);
    setSealedFolderPaths(() => []);
  });

  it("does not start a turn while a copy of a sealed file is still kept for undo", async () => {
    const asked: Array<number> = [];
    let removed = false;
    setSealChangeHandler(async (change) => {
      asked.push(change.paths.length);
      return removed;
    });
    const refusal = await sealedFoldersBeforeTurn("thread-1", "project-1");
    expect(refusal?.title).toBe("Earlier copies of a sealed file could not be removed");
    removed = true;
    expect(await sealedFoldersBeforeTurn("thread-1", "project-1")).toBeNull();
    // Asked with nothing new each time: only what was left is tried again.
    expect(asked).toEqual([0, 0]);
    setSealChangeHandler(() => Promise.resolve(true));
  });
});
