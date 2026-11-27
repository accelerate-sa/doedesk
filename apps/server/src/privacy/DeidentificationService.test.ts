// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import type { DeidentifyFileRef, DeidentifyItem } from "@t3tools/contracts";
import {
  type DeidentifyContext,
  patternDetector,
  Pseudonymizer,
  REDACTED_LABEL,
  Vault,
} from "@t3tools/privacy-gateway";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import type * as Scope from "effect/Scope";
import sharp from "sharp";

import * as Deidentification from "./DeidentificationService.ts";

/** Made-up values in the fixed formats the pattern detector finds without any service. */
const IBAN = "SA0380000000608010167519";
const EMAIL = "huda.alsubaie@example.com";
const LETTER = `Dear team,\nPlease pay to ${IBAN} and write to ${EMAIL}.\nThank you.\n`;
const SHEET = `Name,IBAN,Note\nHuda,${IBAN},first\nSara,${IBAN},second\n`;

const PROJECT = "project-1";

interface Fixture {
  readonly service: Deidentification.DeidentificationService["Service"];
  readonly root: string;
  readonly stateDir: string;
  readonly vault: Vault;
  readonly write: (path: string, content: string | Buffer) => void;
  readonly file: (path: string) => DeidentifyFileRef;
}

/** The service over a project folder and a state folder of its own, and a vault to look into. */
const withService = <A, E>(use: (fixture: Fixture) => Effect.Effect<A, E, Scope.Scope>) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "deidentify-project-" });
    const stateDir = yield* fs.makeTempDirectoryScoped({ prefix: "deidentify-state-" });
    const vault = new Vault(NodePath.join(stateDir, "vault.json"));
    const context: DeidentifyContext = {
      pseudonymizer: new Pseudonymizer(vault, patternDetector),
    };
    const sources = Layer.succeed(Deidentification.DeidentificationSources, {
      stateDir,
      attachmentsDir: NodePath.join(stateDir, "attachments"),
      context: Effect.succeed(context),
      projectRoot: (projectId) => Effect.succeed(projectId === PROJECT ? root : undefined),
      reveal: () => Effect.succeed(true),
    });
    const service = yield* Deidentification.DeidentificationService.pipe(
      Effect.provide(Deidentification.layerWithSources.pipe(Layer.provide(sources))),
    );
    return yield* use({
      service,
      root,
      stateDir,
      vault,
      write: (path, content) => {
        const target = NodePath.join(root, path);
        NodeFS.mkdirSync(NodePath.dirname(target), { recursive: true });
        NodeFS.writeFileSync(target, content);
      },
      file: (path) => ({ kind: "workspace", projectId: PROJECT, path }),
    });
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer));

const itemOf = (items: ReadonlyArray<DeidentifyItem>, value: string): DeidentifyItem => {
  const found = items.find((item) => item.preview === value);
  if (found === undefined) throw new Error(`No item was found for ${value}.`);
  return found;
};

const whitePng = (): Promise<Buffer> =>
  sharp({ create: { width: 200, height: 120, channels: 3, background: "#ffffff" } })
    .png()
    .toBuffer();

describe("DeidentificationService", () => {
  it.effect("finds what a text file holds and shows it without touching the vault", () =>
    withService(({ service, write, file, vault }) =>
      Effect.gen(function* () {
        write("letter.txt", LETTER);
        const entries = vault.size;
        const inspected = yield* service.inspect({ file: file("letter.txt") });

        assert.strictEqual(inspected.name, "letter.txt");
        assert.strictEqual(inspected.layer.reviewState, "unreviewed");
        assert.strictEqual(inspected.layer.defaultMode, "mask");
        assert.deepStrictEqual(inspected.preview, { type: "text", text: LETTER });
        const iban = itemOf(inspected.layer.items, IBAN);
        assert.strictEqual(iban.action, "mask");
        assert.deepStrictEqual(iban.target, {
          type: "text",
          start: LETTER.indexOf(IBAN),
          end: LETTER.indexOf(IBAN) + IBAN.length,
        });
        itemOf(inspected.layer.items, EMAIL);
        // Looking makes no stand-in: only a copy does.
        assert.strictEqual(vault.size, entries);
      }),
    ),
  );

  it.effect("refuses a path that leads out of the project's folder", () =>
    withService(({ service, write, file, root }) =>
      Effect.gen(function* () {
        const outside = NodePath.join(NodePath.dirname(root), `${NodePath.basename(root)}-x.txt`);
        NodeFS.writeFileSync(outside, LETTER);
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => NodeFS.rmSync(outside, { force: true })),
        );
        write("inside.txt", LETTER);
        NodeFS.symlinkSync(outside, NodePath.join(root, "link.txt"));

        for (const path of [`../${NodePath.basename(outside)}`, outside, "link.txt"]) {
          const error = yield* Effect.flip(service.inspect({ file: file(path) }));
          assert.strictEqual(error.reason, "missing");
        }
        const error = yield* Effect.flip(
          service.inspect({ file: { kind: "workspace", projectId: "other", path: "inside.txt" } }),
        );
        assert.strictEqual(error.reason, "missing");
      }),
    ),
  );

  it.effect("changes a layer: mode, one item, a person's own span, a column and a box", () =>
    withService(({ service, write, file }) =>
      Effect.gen(function* () {
        write("letter.txt", LETTER);
        write("people.csv", SHEET);
        write("scan.png", yield* Effect.promise(whitePng));

        const letter = yield* service.inspect({ file: file("letter.txt") });
        const email = itemOf(letter.layer.items, EMAIL);
        const start = LETTER.indexOf("Thank you");
        const changed = yield* service.updateLayer({
          file: file("letter.txt"),
          changes: [
            { type: "setDefaultMode", mode: "redact" },
            { type: "setItemAction", id: email.id, action: "keep" },
            {
              type: "addItem",
              action: "mask",
              target: { type: "text", start, end: start + "Thank you".length },
            },
          ],
        });
        assert.strictEqual(changed.defaultMode, "redact");
        assert.strictEqual(itemOf(changed.items, IBAN).action, "redact");
        assert.strictEqual(itemOf(changed.items, EMAIL).action, "keep");
        const own = itemOf(changed.items, "Thank you");
        assert.strictEqual(own.source, "manual");
        assert.strictEqual(own.action, "mask");

        // What was found cannot be deleted, only kept; a person's own item can.
        const removed = yield* service.updateLayer({
          file: file("letter.txt"),
          changes: [
            { type: "removeItem", id: email.id },
            { type: "removeItem", id: own.id },
          ],
        });
        assert.deepStrictEqual(
          removed.items.map((item) => item.preview),
          [IBAN, EMAIL],
        );

        yield* service.inspect({ file: file("people.csv") });
        const column = yield* service.updateLayer({
          file: file("people.csv"),
          changes: [
            {
              type: "addItem",
              action: "redact",
              target: {
                type: "cells",
                sheet: "csv",
                scope: "column",
                startRow: 1,
                endRow: null,
                startColumn: 0,
                endColumn: 0,
              },
            },
          ],
        });
        const marked = column.items.find((item) => item.source === "manual");
        assert.strictEqual(marked?.action, "redact");
        assert.strictEqual(marked?.target.type, "cells");

        yield* service.inspect({ file: file("scan.png") });
        const polygon = [
          { x: 0.1, y: 0.1 },
          { x: 0.4, y: 0.1 },
          { x: 0.4, y: 0.5 },
          { x: 0.1, y: 0.5 },
        ];
        const boxed = yield* service.updateLayer({
          file: file("scan.png"),
          changes: [
            { type: "addItem", action: "redact", target: { type: "region", page: 0, polygon } },
          ],
        });
        const box = boxed.items.find((item) => item.source === "manual");
        assert.deepStrictEqual(box?.target, { type: "region", page: 0, polygon });
        const moved = yield* service.updateLayer({
          file: file("scan.png"),
          changes: [
            {
              type: "moveItem",
              id: box?.id ?? "",
              // A corner dragged off the page comes back to its edge.
              target: {
                type: "region",
                page: 0,
                polygon: polygon.map((p) => ({ ...p, x: p.x + 0.8 })),
              },
            },
          ],
        });
        const after = moved.items.find((item) => item.id === box?.id);
        assert.deepStrictEqual(
          after?.target.type === "region" ? after.target.polygon.map((p) => p.x) : [],
          [0.9, 1, 1, 0.9],
        );

        // A box does not fit a text file.
        const error = yield* Effect.flip(
          service.updateLayer({
            file: file("letter.txt"),
            changes: [
              { type: "addItem", action: "redact", target: { type: "region", page: 0, polygon } },
            ],
          }),
        );
        assert.strictEqual(error.reason, "invalid");
      }),
    ),
  );

  it.effect("marks a reviewed file stale once it is edited outside the app", () =>
    withService(({ service, write, file, root }) =>
      Effect.gen(function* () {
        write("letter.txt", LETTER);
        yield* service.inspect({ file: file("letter.txt") });
        const reviewed = yield* service.updateLayer({
          file: file("letter.txt"),
          changes: [{ type: "setReviewState", state: "reviewed" }],
        });
        assert.strictEqual(reviewed.reviewState, "reviewed");
        assert.strictEqual(yield* service.status(file("letter.txt")), "reviewed");

        const edited = `${LETTER}Also call +966 55 123 4567.\n`;
        write("letter.txt", edited);
        // A time of its own, in seconds, so the file's date differs whatever the clock reads.
        NodeFS.utimesSync(NodePath.join(root, "letter.txt"), 2_000_000_000, 2_000_000_000);

        assert.strictEqual(yield* service.status(file("letter.txt")), "stale");
        assert.isTrue(Option.isNone(yield* service.reviewedCopy(file("letter.txt"))));
        const listed = yield* service.workspace(PROJECT);
        assert.strictEqual(listed.files[0]?.status, "stale");

        const again = yield* service.inspect({ file: file("letter.txt") });
        assert.strictEqual(again.layer.reviewState, "stale");
        assert.deepStrictEqual(again.preview, { type: "text", text: edited });
        // What was found before is found again in the file as it is now.
        itemOf(again.layer.items, IBAN);

        const rescanned = yield* service.inspect({ file: file("letter.txt"), rescan: true });
        assert.strictEqual(rescanned.layer.reviewState, "unreviewed");
      }),
    ),
  );

  it.effect(
    "exports a scrubbed copy, leaves the file alone and files nothing for a redaction",
    () =>
      withService(({ service, write, file, root, vault }) =>
        Effect.gen(function* () {
          write("letter.txt", LETTER);
          yield* service.inspect({ file: file("letter.txt") });
          yield* service.updateLayer({
            file: file("letter.txt"),
            changes: [{ type: "setDefaultMode", mode: "redact" }],
          });
          const entries = vault.size;
          const redacted = yield* service.exportCopy(file("letter.txt"));
          const text = redacted.bytes.toString("utf8");

          assert.strictEqual(redacted.fileName, "letter.deidentified.txt");
          assert.strictEqual(redacted.mediaType, "text/plain");
          assert.notInclude(text, IBAN);
          assert.notInclude(text, EMAIL);
          assert.include(text, REDACTED_LABEL);
          assert.deepStrictEqual(redacted.counts, { mask: 0, redact: 2, keep: 0 });
          // A redacted value is in no vault: nothing can turn it back.
          assert.strictEqual(vault.size, entries);
          assert.isFalse(vault.has(IBAN));
          assert.strictEqual(
            NodeFS.readFileSync(NodePath.join(root, "letter.txt"), "utf8"),
            LETTER,
          );
          assert.deepStrictEqual(NodeFS.readdirSync(root), ["letter.txt"]);

          // A copy for a turn exists only once a person has reviewed the file.
          assert.isTrue(Option.isNone(yield* service.reviewedCopy(file("letter.txt"))));
          yield* service.updateLayer({
            file: file("letter.txt"),
            changes: [
              { type: "setDefaultMode", mode: "mask" },
              { type: "setReviewState", state: "reviewed" },
            ],
          });
          const copy = Option.getOrThrow(yield* service.reviewedCopy(file("letter.txt")));
          const masked = copy.bytes.toString("utf8");
          assert.notInclude(masked, IBAN);
          assert.notInclude(masked, REDACTED_LABEL);
          // A masked value has a stand-in the vault can turn back.
          assert.isTrue(vault.has(IBAN));
          assert.strictEqual(new Pseudonymizer(vault, patternDetector).unmask(masked), LETTER);
          assert.strictEqual(
            NodeFS.readFileSync(NodePath.join(root, "letter.txt"), "utf8"),
            LETTER,
          );
        }),
      ),
  );

  it.effect("draws a picture as it is and as the copy would show it", () =>
    withService(({ service, write, file, root, vault }) =>
      Effect.gen(function* () {
        const png = yield* Effect.promise(whitePng);
        write("scan.png", png);
        const inspected = yield* service.inspect({ file: file("scan.png") });
        assert.strictEqual(inspected.preview.type, "pages");
        if (inspected.preview.type !== "pages") return;
        assert.deepStrictEqual(
          inspected.preview.pages.map((page) => [page.index, page.width, page.height]),
          [[0, 200, 120]],
        );

        const place = { type: "page", page: 0 } as const;
        const original = yield* service.preview({
          file: file("scan.png"),
          place,
          view: "original",
        });
        const hidden = yield* service.preview({
          file: file("scan.png"),
          place,
          view: "deidentified",
        });
        assert.strictEqual(original.mediaType, "image/png");
        assert.deepStrictEqual([hidden.width, hidden.height], [200, 120]);
        // Nothing reads pictures here, so the whole of it is hidden until a person decides.
        assert.isFalse(original.bytes.equals(hidden.bytes));
        assert.strictEqual(vault.size, 0);
        assert.isTrue(NodeFS.readFileSync(NodePath.join(root, "scan.png")).equals(png));

        const error = yield* Effect.flip(
          service.preview({
            file: file("scan.png"),
            place: { type: "page", page: 3 },
            view: "original",
          }),
        );
        assert.strictEqual(error.reason, "invalid");
      }),
    ),
  );

  it.effect("lists a folder's files, scans them in a batch and keeps the folder's policy", () =>
    withService(({ service, write }) =>
      Effect.gen(function* () {
        write("letter.txt", LETTER);
        write("data/people.csv", SHEET);
        write("notes.json", "{}");
        write("node_modules/pkg/readme.md", LETTER);
        write(".cache/old.txt", LETTER);

        const before = yield* service.workspace(PROJECT);
        assert.deepStrictEqual(
          before.files.map((entry) => [entry.path, entry.family, entry.status, entry.itemCount]),
          [
            ["data/people.csv", "csv", "notScanned", 0],
            ["letter.txt", "text", "notScanned", 0],
          ],
        );
        assert.deepStrictEqual(before.policy, {
          defaultMode: "mask",
          requireReviewBeforeAi: false,
          alwaysReviewBeforeSend: false,
        });

        const policy = yield* service.policy({
          projectId: PROJECT,
          policy: { defaultMode: "redact", requireReviewBeforeAi: true },
        });
        assert.deepStrictEqual(policy, {
          defaultMode: "redact",
          requireReviewBeforeAi: true,
          alwaysReviewBeforeSend: false,
        });

        const one = yield* service.scanWorkspace({ projectId: PROJECT, paths: ["letter.txt"] });
        assert.deepStrictEqual(
          one.files.map((entry) => entry.status),
          ["notScanned", "unreviewed"],
        );

        const all = yield* service.scanWorkspace({ projectId: PROJECT });
        assert.deepStrictEqual(
          all.files.map((entry) => [entry.path, entry.status, entry.itemCount, entry.defaultMode]),
          [
            // Both IBANs, and the names its header says the first column holds.
            ["data/people.csv", "unreviewed", 4, "redact"],
            ["letter.txt", "unreviewed", 2, "redact"],
          ],
        );
        assert.deepStrictEqual(all.policy, policy);
        assert.deepStrictEqual(yield* service.policy({ projectId: PROJECT }), policy);
      }),
    ),
  );

  it.effect("reviews bytes that were sent ahead of a message", () =>
    withService(({ service, stateDir }) =>
      Effect.gen(function* () {
        const stagedId = yield* service.stage("ID card.txt", Buffer.from(LETTER));
        const ref: DeidentifyFileRef = { kind: "staged", stagedId, name: "ID card.txt" };
        const inspected = yield* service.inspect({ file: ref });
        assert.strictEqual(inspected.name, "ID card.txt");
        assert.isFalse(inspected.canReveal);
        itemOf(inspected.layer.items, IBAN);
        assert.strictEqual((yield* service.exportCopy(ref)).fileName, "ID card.deidentified.txt");
        assert.isFalse(yield* service.reveal(ref));
        assert.deepStrictEqual(NodeFS.readdirSync(NodePath.join(stateDir, "privacy", "staged")), [
          stagedId,
        ]);

        const unsupported = yield* Effect.flip(service.stage("old.doc", Buffer.from("x")));
        assert.strictEqual(unsupported.reason, "unsupported");
        const missing = yield* Effect.flip(
          service.inspect({ file: { kind: "staged", stagedId: "../vault.json" } }),
        );
        assert.strictEqual(missing.reason, "missing");
      }),
    ),
  );
});
