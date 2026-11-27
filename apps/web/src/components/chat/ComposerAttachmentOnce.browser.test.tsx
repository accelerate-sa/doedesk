import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import "~/index.css";
import type { ComposerFileAttachment } from "~/composerDraftStore";
import { fileContextReference } from "~/lib/composerContextRecords";
import { render } from "../../../test/render";
import type { ComposerContextActions } from "../composerContextActions";
import {
  ComposerContextActionsContext,
  ComposerContextRecordsContext,
  ComposerContextReferenceChip,
  composerContextRecordsFromDraft,
} from "../composerContextPresentation";
import { ComposerAttachmentFileList } from "./ComposerAttachmentStrip";
import { composerOtherFilesForPresentation } from "./composerAttachmentFiles";

const environmentId = EnvironmentId.make("environment-1");

const attached = (id: string, text: string): ComposerFileAttachment => ({
  type: "file",
  id,
  name: `${id}.csv`,
  mimeType: "text/csv",
  sizeBytes: text.length,
  file: new File([text], `${id}.csv`, { type: "text/csv" }),
});

/** The composer's two places for an attached file, fed as ChatComposer feeds them. */
function Attachments({
  files,
  inlineIds,
  actions,
}: {
  readonly files: ReadonlyArray<ComposerFileAttachment>;
  readonly inlineIds: ReadonlySet<string>;
  readonly actions: Pick<ComposerContextActions, "sealFile" | "reviewFile" | "removeFile">;
}) {
  const listed = composerOtherFilesForPresentation(files, environmentId, inlineIds);
  return (
    <ComposerContextActionsContext
      value={{
        environmentId,
        expandImage: () => {},
        expandVideo: () => {},
        openFile: () => {},
        openMention: () => {},
        openPullRequest: () => {},
        ...actions,
      }}
    >
      <ComposerContextRecordsContext
        value={composerContextRecordsFromDraft({ terminalContexts: [], files })}
      >
        <ComposerAttachmentFileList
          files={listed}
          resolvedTheme="light"
          supportsAttachmentUploads
          maxFileAttachmentBytes={1_000_000}
          fileStagingLimit={1_000_000}
          environmentId={environmentId}
          attachmentDraftTarget={{ environmentId, threadId: "thread-1" as never }}
          canOperateThread
          onPreviewFile={() => {}}
          onRemoveFile={(fileId) => actions.removeFile?.(fileId)}
          onSealFile={(file) => actions.sealFile?.(file.id)}
          onReviewFile={actions.reviewFile}
        />
        <p className="text-sm">
          {files
            .filter((file) => inlineIds.has(file.id))
            .map((file) => (
              <ComposerContextReferenceChip
                key={file.id}
                kind="file"
                contextId={fileContextReference(file).contextId}
                label={file.name}
              />
            ))}
        </p>
      </ComposerContextRecordsContext>
    </ComposerContextActionsContext>
  );
}

describe("an attached file in the composer", () => {
  it("shows once where sealing is offered, with Seal, Review and Remove on its chip", async () => {
    const actions = { sealFile: vi.fn(), reviewFile: vi.fn(), removeFile: vi.fn() };
    const picked = attached("picked", "name,city\nSara,Riyadh\n");
    await using screen = await render(
      <Attachments files={[picked]} inlineIds={new Set(["picked"])} actions={actions} />,
    );

    // The bug: the chip in the text and a second row under it. One name, and no row.
    await expect.element(screen.getByText("picked.csv")).toBeVisible();
    expect(screen.getByText("picked.csv").elements()).toHaveLength(1);
    expect(screen.container.querySelectorAll("[data-composer-file-pill]")).toHaveLength(0);
    expect(screen.container.querySelectorAll("[data-composer-file-chip]")).toHaveLength(1);

    // The three actions sit on the chip's own line, centered on it and the same size.
    const middle = (element: Element) => {
      const box = element.getBoundingClientRect();
      return box.top + box.height / 2;
    };
    const chip = screen.container.querySelector("[data-composer-file-chip]")!.firstElementChild!;
    const buttons = [...screen.container.querySelectorAll("[data-composer-file-actions] button")];
    expect(buttons).toHaveLength(3);
    for (const button of buttons) {
      expect(Math.abs(middle(button) - middle(chip))).toBeLessThanOrEqual(1);
      expect(button.getBoundingClientRect().height).toBeCloseTo(
        buttons[0]!.getBoundingClientRect().height,
        1,
      );
    }

    for (const [name, spy] of [
      ["Seal picked.csv", actions.sealFile],
      ["Review picked.csv", actions.reviewFile],
      ["Remove picked.csv", actions.removeFile],
    ] as const) {
      const button = screen.getByRole("button", { name, exact: true });
      expect(button.elements()).toHaveLength(1);
      (button.element() as HTMLElement).click();
      expect(spy).toHaveBeenCalledExactlyOnceWith("picked");
    }
  });

  it("shows a file without a chip once too, as a pill with the same three actions", async () => {
    const actions = { sealFile: vi.fn(), reviewFile: vi.fn(), removeFile: vi.fn() };
    const picked = attached("picked", "name,city\nSara,Riyadh\n");
    const listed = attached("listed", "a,b\n1,2\n");
    await using screen = await render(
      <Attachments files={[picked, listed]} inlineIds={new Set(["picked"])} actions={actions} />,
    );
    await expect.element(screen.getByText("listed.csv")).toBeVisible();
    for (const file of ["picked.csv", "listed.csv"]) {
      expect(screen.getByText(file).elements()).toHaveLength(1);
      for (const action of ["Seal", "Review", "Remove"]) {
        expect(
          screen.getByRole("button", { name: `${action} ${file}`, exact: true }).elements(),
        ).toHaveLength(1);
      }
    }
    expect(screen.container.querySelectorAll("[data-composer-file-pill]")).toHaveLength(1);
  });

  it("offers Seal by name on a file that looks like a register, with no sentence beside it", async () => {
    const actions = { sealFile: vi.fn(), reviewFile: vi.fn(), removeFile: vi.fn() };
    const payroll = attached("payroll", "employee,national id,salary\nSara,1098765432,9000\n");
    await using screen = await render(
      <Attachments files={[payroll]} inlineIds={new Set(["payroll"])} actions={actions} />,
    );
    await expect
      .element(screen.getByRole("button", { name: "Seal payroll.csv", exact: true }))
      .toHaveAttribute("data-seal-action", "suggested");
    // Why is on hover: the reason is no longer written out under the file.
    expect(screen.container.textContent).not.toContain("Seal it instead");
    expect(screen.container.querySelector('[role="note"]')).toBeNull();
  });

  it("leaves the chip as it was where nothing can be done to the file from here", async () => {
    await using screen = await render(
      <Attachments
        files={[attached("picked", "a,b\n")]}
        inlineIds={new Set(["picked"])}
        actions={{}}
      />,
    );
    await expect.element(screen.getByText("picked.csv")).toBeVisible();
    expect(screen.container.querySelector("[data-composer-file-actions]")).toBeNull();
  });
});
