import { makeKnownValueMatcher } from "@t3tools/shared/privacyKnownValues";
import JSZip from "jszip";
import { expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";
import "~/index.css";

import { render } from "../../../../test/render";
import {
  FileValueMarksContext,
  type FileValueMarksValue,
} from "../../privacy/FileValueMarkSurface";
import Spreadsheet from "./Spreadsheet";

const text = (cell: string, value: string) =>
  `<c r="${cell}" t="inlineStr"><is><t>${value}</t></is></c>`;

it("marks the cells that hold a known value, names the stand-in on hover, and clears when switched off", async () => {
  const archive = new JSZip();
  archive.file(
    "xl/workbook.xml",
    '<workbook xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Tenants" sheetId="1" r:id="sheet"/></sheets></workbook>',
  );
  archive.file(
    "xl/_rels/workbook.xml.rels",
    '<Relationships><Relationship Id="sheet" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>',
  );
  archive.file(
    "xl/worksheets/sheet1.xml",
    `<worksheet><sheetData><row r="1">${text("A1", "Tenant")}${text("B1", "Khalid")}</row><row r="2">${text("A2", "Phone")}${text("B2", "Riyadh")}</row></sheetData></worksheet>`,
  );
  const bytes = await archive.generateAsync({ type: "arraybuffer" });
  const matcher = makeKnownValueMatcher([{ token: "[PERSON_FBJD2]", surfaces: ["Khalid"] }]);
  const report = vi.fn();
  const marks = (on: boolean): FileValueMarksValue => ({
    on,
    setOn: () => undefined,
    surfaces: { text: 1, textless: 0 },
    mount: () => () => undefined,
    state: on ? { kind: "ready", matcher } : null,
    stats: null,
    report,
  });
  const view = { hiddenGridlines: [], themeFonts: { major: "Calibri Light", minor: "Calibri" } };
  const sheet = (on: boolean) => (
    <FileValueMarksContext value={marks(on)}>
      <Spreadsheet bytes={bytes} view={view} onDetails={onDetails} onError={onError} />
    </FileValueMarksContext>
  );
  const onDetails = vi.fn();
  const onError = vi.fn();
  const container = document.createElement("div");
  Object.assign(container.style, { display: "flex", width: "500px", height: "300px" });
  await using screen = await render(sheet(true), { container });
  await expect.element(screen.getByRole("grid", { name: "Tenants" })).toBeVisible();
  const root = screen.getByRole("grid", { name: "Tenants" }).element();
  const canvas = root.querySelector("canvas")!;
  const ratio = window.devicePixelRatio || 1;
  // The corner of a cell, clear of its text: columns are 64 wide past a 44 header, rows 20 tall.
  const shade = (column: number, row: number) =>
    canvas
      .getContext("2d")!
      .getImageData(
        Math.round((44 + 64 * column + 60) * ratio),
        Math.round((20 + 20 * row + 3) * ratio),
        1,
        1,
      ).data[0]!;
  // B1 holds the known name: a faint fill. B2 holds a word DoeDesk does not know: paper.
  await vi.waitFor(() => {
    expect(shade(1, 0)).toBeLessThan(245);
    expect(shade(1, 0)).toBeGreaterThan(200);
    expect(shade(1, 1)).toBe(255);
  });
  expect(report).toHaveBeenLastCalledWith(expect.objectContaining({ marks: 1 }));

  const box = canvas.getBoundingClientRect();
  root.dispatchEvent(
    new PointerEvent("pointermove", {
      bubbles: true,
      pointerId: 1,
      clientX: box.left + 44 + 64 + 20,
      clientY: box.top + 20 + 10,
    }),
  );
  await expect.element(page.getByText("[PERSON_FBJD2]")).toBeVisible();
  await expect.element(page.getByText(/DoeDesk sends/)).toBeVisible();

  // Switched off: the sheet is as it was, without reopening the workbook.
  await screen.rerender(sheet(false));
  await vi.waitFor(() => expect(shade(1, 0)).toBe(255));
  await expect.element(page.getByText("[PERSON_FBJD2]")).not.toBeInTheDocument();
  expect(onDetails).toHaveBeenCalledTimes(1);
  expect(onError).not.toHaveBeenCalled();
});
