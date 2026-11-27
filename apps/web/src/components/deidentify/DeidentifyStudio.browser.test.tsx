import "~/index.css";

import type {
  DeidentifyFileRef,
  DeidentifyInspection,
  DeidentifyItem,
  DeidentifyLayer,
  DeidentifyLayerChange,
  DeidentifyPreview,
  DeidentifyWorkspaceFile,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import type { DeidentifyClient } from "~/privacy/deidentifyClient";

import { act, render } from "../../../test/render";
import { DeidentifyStudioDialog } from "./DeidentifyStudioDialog";
import { WorkspaceDeidentifyDrawer } from "./WorkspaceDeidentifyDrawer";

const IBAN = "SA0380000000608010167519";
const LETTER = `Pay ${IBAN} today. Huda signed it, and Huda sent it.`;

const PICTURE =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='400' height='300'%3E%3Crect width='400' height='300' fill='white'/%3E%3C/svg%3E";

const found = (id: string, preview: string, target: DeidentifyItem["target"]): DeidentifyItem => ({
  id,
  source: "auto",
  action: "mask",
  kind: "IBAN",
  label: "IBAN",
  preview,
  target,
});

interface FakeFile {
  readonly family: DeidentifyLayer["family"];
  readonly preview: DeidentifyPreview;
  readonly items: ReadonlyArray<DeidentifyItem>;
}

const TEXT_FILE: FakeFile = {
  family: "text",
  preview: { type: "text", text: LETTER },
  items: [found("iban", IBAN, { type: "text", start: 4, end: 4 + IBAN.length })],
};

const IMAGE_FILE: FakeFile = {
  family: "image",
  preview: {
    type: "pages",
    pages: [
      {
        index: 0,
        width: 400,
        height: 300,
        urls: { original: "/picture?view=original", deidentified: "/picture?view=deidentified" },
      },
    ],
  },
  items: [
    found("code", "https://example.test/verify", {
      type: "region",
      page: 0,
      polygon: [
        { x: 0.7, y: 0.7 },
        { x: 0.9, y: 0.7 },
        { x: 0.9, y: 0.9 },
        { x: 0.7, y: 0.9 },
      ],
    }),
  ],
};

const SHEET_FILE: FakeFile = {
  family: "csv",
  preview: {
    type: "sheets",
    sheets: [
      {
        name: "csv",
        columnCount: 2,
        rowCount: 3,
        rows: [
          { index: 0, cells: ["Name", "IBAN"] },
          { index: 1, cells: ["Huda", IBAN] },
          { index: 2, cells: ["Sara", IBAN] },
        ],
      },
    ],
  },
  items: [],
};

const keyOf = (file: DeidentifyFileRef): string =>
  file.kind === "workspace"
    ? file.path
    : file.kind === "attachment"
      ? file.attachmentId
      : file.stagedId;

/** A server in memory: it keeps a layer for each file and changes it the way the real one does. */
const fakeClient = (files: Readonly<Record<string, FakeFile>>) => {
  const layers = new Map<string, DeidentifyLayer>();
  const pictures: Array<string> = [];
  let made = 0;
  const layerOf = (key: string): DeidentifyLayer => {
    const file = files[key];
    if (file === undefined) throw new Error(`No such file: ${key}`);
    const existing = layers.get(key);
    if (existing !== undefined) return existing;
    const layer: DeidentifyLayer = {
      family: file.family,
      defaultMode: "mask",
      reviewState: "unreviewed",
      items: file.items,
      unchecked: false,
      fileRevision: key,
      revision: "0",
    };
    layers.set(key, layer);
    return layer;
  };
  const changed = (layer: DeidentifyLayer, change: DeidentifyLayerChange): DeidentifyLayer => {
    switch (change.type) {
      case "setDefaultMode":
        return {
          ...layer,
          defaultMode: change.mode,
          items: layer.items.map((item) =>
            item.source === "auto" && item.action !== "keep"
              ? { ...item, action: change.mode }
              : item,
          ),
        };
      case "setItemAction":
        return {
          ...layer,
          items: layer.items.map((item) =>
            item.id === change.id ? { ...item, action: change.action } : item,
          ),
        };
      case "addItem": {
        made += 1;
        const preview =
          change.target.type === "text"
            ? LETTER.slice(change.target.start, change.target.end)
            : undefined;
        return {
          ...layer,
          items: [
            ...layer.items,
            {
              id: `made-${made}`,
              source: "manual",
              action: change.action,
              kind: "OTHER",
              label: "Marked by hand",
              ...(preview === undefined ? {} : { preview }),
              target: change.target,
            },
          ],
        };
      }
      case "moveItem":
        return {
          ...layer,
          items: layer.items.map((item) =>
            item.id === change.id ? { ...item, target: change.target } : item,
          ),
        };
      case "removeItem":
        return { ...layer, items: layer.items.filter((item) => item.id !== change.id) };
      case "setReviewState":
        return { ...layer, reviewState: change.state };
    }
  };
  const listing = (): ReadonlyArray<DeidentifyWorkspaceFile> =>
    Object.entries(files).map(([path, file]) => {
      const layer = layers.get(path);
      return {
        path,
        family: file.family,
        status: layer?.reviewState ?? "notScanned",
        itemCount: layer?.items.filter((item) => item.action !== "keep").length ?? 0,
        defaultMode: layer?.defaultMode ?? null,
      };
    });
  const policy = {
    defaultMode: "mask",
    requireReviewBeforeAi: false,
    alwaysReviewBeforeSend: false,
  } as const;
  const client: DeidentifyClient = {
    inspect: async (file): Promise<DeidentifyInspection> => {
      const key = keyOf(file);
      return {
        ok: true,
        name: key.slice(key.lastIndexOf("/") + 1),
        canReveal: true,
        layer: layerOf(key),
        preview: (files[key] as FakeFile).preview,
      };
    },
    update: async (file, changes) => {
      const key = keyOf(file);
      const before = layerOf(key);
      const layer = {
        ...changes.reduce(changed, before),
        revision: String(Number(before.revision) + 1),
      };
      layers.set(key, layer);
      return { ok: true, layer };
    },
    picture: async (url) => {
      pictures.push(url);
      return PICTURE;
    },
    download: async () => true,
    reveal: async () => true,
    stage: async () => ({ ok: false, reason: "unsupported" }),
    workspace: async () => ({ ok: true, policy, files: listing(), truncated: false }),
    scan: async (_projectId, paths) => {
      for (const path of paths ?? Object.keys(files)) layerOf(path);
      return { ok: true, policy, files: listing(), truncated: false };
    },
    policy: async () => policy,
  };
  return { client, layers, pictures };
};

const workspaceFile = (path: string): DeidentifyFileRef => ({
  kind: "workspace",
  projectId: "project",
  path,
});

const openStudio = async (path: string, files: Readonly<Record<string, FakeFile>>) => {
  // A window as wide as a desktop's: the list of items stays beside the file.
  await page.viewport(1280, 800);
  const fake = fakeClient(files);
  const screen = await render(
    <DeidentifyStudioDialog
      client={fake.client}
      file={workspaceFile(path)}
      onOpenChange={() => undefined}
      open
    />,
  );
  return { ...fake, screen };
};

/** A drag across the page, in shares of its width and height. */
const drag = async (
  target: Element,
  from: { x: number; y: number },
  to: { x: number; y: number },
) => {
  const bounds = target.getBoundingClientRect();
  const at = (point: { x: number; y: number }) => ({
    bubbles: true,
    button: 0,
    pointerId: 1,
    clientX: bounds.left + bounds.width * point.x,
    clientY: bounds.top + bounds.height * point.y,
  });
  await act(() => target.dispatchEvent(new PointerEvent("pointerdown", at(from))));
  await act(() => target.dispatchEvent(new PointerEvent("pointermove", at(to))));
  await act(() => target.dispatchEvent(new PointerEvent("pointerup", at(to))));
};

describe("de-identification studio", () => {
  it("draws a box on a picture and switches it between mask, redact and keep", async () => {
    const { screen, layers } = await openStudio("scan.png", { "scan.png": IMAGE_FILE });
    await using _screen = screen;
    const sheet = page.getByTestId("deidentify-page");
    await expect.element(sheet).toBeVisible();
    await expect
      .element(sheet.getByRole("button", { name: "IBAN" }))
      .toHaveAttribute("data-action", "mask");

    await drag(sheet.element(), { x: 0.1, y: 0.1 }, { x: 0.4, y: 0.3 });
    const box = sheet.getByRole("button", { name: "Marked by hand" });
    await expect.element(box).toHaveAttribute("data-action", "mask");
    const target = layers.get("scan.png")?.items.find((item) => item.source === "manual")?.target;
    expect(target?.type).toBe("region");
    if (target?.type !== "region") return;
    expect(target.polygon[0]?.x).toBeCloseTo(0.1, 2);
    expect(target.polygon[2]?.y).toBeCloseTo(0.3, 2);

    // The box just drawn is the chosen one: its actions are already open.
    const actions = page.getByTestId("deidentify-box-actions");
    await actions.getByRole("button", { name: "Redact" }).click();
    await expect.element(box).toHaveAttribute("data-action", "redact");
    await actions.getByRole("button", { name: "Keep" }).click();
    await expect.element(box).toHaveAttribute("data-action", "keep");

    // A drawn box can be dragged somewhere else.
    await drag(box.element(), { x: 0.5, y: 0.5 }, { x: 2, y: 2 });
    await expect
      .poll(() => {
        const moved = layers
          .get("scan.png")
          ?.items.find((item) => item.source === "manual")?.target;
        return moved?.type === "region" ? moved.polygon[0]?.x : undefined;
      })
      .toBeGreaterThan(0.3);

    await userEvent.keyboard("{Delete}");
    await expect.element(box).not.toBeInTheDocument();
    expect(layers.get("scan.png")?.items.map((item) => item.id)).toEqual(["code"]);
  });

  it("masks, redacts and clears a whole column from its header", async () => {
    const { screen, layers } = await openStudio("people.csv", { "people.csv": SHEET_FILE });
    await using _screen = screen;
    const header = page.getByRole("button", { name: "Column IBAN" });
    await header.click();
    const actions = page.getByTestId("deidentify-cells-actions");
    await actions.getByRole("button", { name: "Mask column" }).click();
    await expect.element(header).toHaveAttribute("data-action", "mask");
    expect(layers.get("people.csv")?.items[0]?.target).toMatchObject({
      type: "cells",
      scope: "column",
      startColumn: 1,
      startRow: 1,
      endRow: null,
    });
    // The header's own row is left alone; every row under it is tinted.
    await expect
      .element(page.getByRole("cell", { name: "IBAN", exact: true }))
      .not.toHaveAttribute("data-action");
    expect(document.querySelector('[data-cell="2:1"]')?.getAttribute("data-action")).toBe("mask");

    await actions.getByRole("button", { name: "Redact column" }).click();
    await expect.element(header).toHaveAttribute("data-action", "redact");
    expect(layers.get("people.csv")?.items).toHaveLength(1);

    await page.getByRole("button", { name: "Clear column" }).click();
    await expect.element(header).not.toHaveAttribute("data-action");
    expect(layers.get("people.csv")?.items).toHaveLength(0);
  });

  it("marks words selected with the mouse, once or wherever they stand", async () => {
    const { screen, layers } = await openStudio("letter.txt", { "letter.txt": TEXT_FILE });
    await using _screen = screen;
    const text = page.getByText("today. Huda signed it", { exact: false });
    await expect.element(text).toBeVisible();
    const node = text.element().firstChild as Text;
    const start = (node.textContent ?? "").indexOf("Huda");
    await act(() => {
      window.getSelection()?.setBaseAndExtent(node, start, node, start + 4);
      node.parentElement?.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    });

    await page
      .getByTestId("deidentify-selection-actions")
      .getByRole("button", { name: "Mask all" })
      .click();
    await expect
      .poll(() =>
        layers
          .get("letter.txt")
          ?.items.filter((item) => item.source === "manual")
          .map((item) => item.preview),
      )
      .toEqual(["Huda", "Huda"]);
    await expect
      .element(page.getByRole("button", { name: "Marked by hand" }).first())
      .toHaveAttribute("data-action", "mask");

    // What was found is switched from the stretch itself.
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "IBAN", exact: true })
      .first()
      .click();
    await page
      .getByTestId("deidentify-span-actions")
      .getByRole("button", { name: "Redact" })
      .click();
    await expect.poll(() => layers.get("letter.txt")?.items[0]?.action).toBe("redact");
  });

  it("shows the copy in place of the file, and the file again", async () => {
    const { screen, pictures } = await openStudio("letter.txt", {
      "letter.txt": TEXT_FILE,
      "scan.png": IMAGE_FILE,
    });
    await using _screen = screen;
    await expect.element(page.getByText(IBAN, { exact: true }).first()).toBeVisible();
    await page.getByRole("group", { name: "Mode" }).getByRole("button", { name: "Redact" }).click();
    await page.getByRole("button", { name: "De-identified" }).click();
    const letter = page.getByRole("dialog").getByText("Pay", { exact: false }).first();
    await expect.poll(() => letter.element().parentElement?.textContent).toContain("[REDACTED]");
    expect(letter.element().parentElement?.textContent).not.toContain(IBAN);
    await page.getByRole("button", { name: "Original" }).click();
    await expect.poll(() => letter.element().parentElement?.textContent).toContain(IBAN);

    await screen.rerender(
      <DeidentifyStudioDialog
        client={fakeClient({ "scan.png": IMAGE_FILE }).client}
        file={workspaceFile("scan.png")}
        onOpenChange={() => undefined}
        open
      />,
    );
    await expect.element(page.getByTestId("deidentify-page")).toBeVisible();
    expect(pictures).toEqual([]);
  });

  it("goes through a folder's files one after another", async () => {
    await page.viewport(1280, 800);
    const fake = fakeClient({
      "letter.txt": TEXT_FILE,
      "people.csv": SHEET_FILE,
      "scan.png": IMAGE_FILE,
    });
    await using _screen = await render(
      <WorkspaceDeidentifyDrawer
        client={fake.client}
        onOpenChange={() => undefined}
        open
        projectId="project"
      />,
    );
    await page.getByRole("button", { name: "Scan all" }).click();
    await expect
      .poll(() => document.querySelector('[data-path="scan.png"]')?.getAttribute("data-status"))
      .toBe("unreviewed");

    await page.getByRole("button", { name: /letter\.txt/ }).click();
    const studio = page.getByRole("dialog", { name: "letter.txt" });
    await expect.element(studio).toBeVisible();
    await expect.element(studio.getByText("1 / 3")).toBeVisible();
    await expect.element(studio.getByRole("button", { name: "Previous file" })).toBeDisabled();

    await studio.getByRole("button", { name: "Mark reviewed" }).click();
    // Marking a file reviewed moves on to the next one.
    const next = page.getByRole("dialog", { name: "people.csv" });
    await expect.element(next.getByText("2 / 3")).toBeVisible();
    expect(fake.layers.get("letter.txt")?.reviewState).toBe("reviewed");

    await userEvent.keyboard("]");
    const last = page.getByRole("dialog", { name: "scan.png" });
    await expect.element(last.getByText("3 / 3")).toBeVisible();
    await expect.element(last.getByRole("button", { name: "Next file" })).toBeDisabled();
    await userEvent.keyboard("[[");
    await expect.element(page.getByRole("dialog", { name: "people.csv" })).toBeVisible();
  });
});
