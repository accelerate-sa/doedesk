import type { PrivacySealedListing, PrivacyStatus } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  fileNameOf,
  folderSealing,
  groupSealedListing,
  readByReadingServiceFirst,
  sealableImage,
  sealedDocumentAt,
  sealedFolderAt,
  sealedFolderHolding,
  sealedFolderToUnseal,
  sealingOffered,
  sealReaderHost,
} from "./sealedFiles.logic";
import { workerChoicesFor } from "./SealedWorker.logic";
import {
  accountRegionExplained,
  answerRouteLabel,
  managedWorkerNote,
  sealedReaderSentences,
  sealReader,
  sealReaderLines,
  whoReadsSealedFiles,
} from "./sealReader";

const worker = (change: Partial<NonNullable<PrivacyStatus["worker"]>>) =>
  ({
    active: true,
    worker: {
      kind: "off",
      address: null,
      model: null,
      driver: null,
      reasoningEffort: null,
      available: false,
      servedFrom: null,
      ...change,
    },
  }) as PrivacyStatus;

describe("who reads a sealed file", () => {
  it("is nobody until the person's own server is connected, then that server's host", () => {
    expect(sealReaderHost({ active: true } as PrivacyStatus)).toBeNull();
    expect(sealReaderHost(worker({}))).toBeNull();
    expect(sealReaderHost(worker({ kind: "custom", address: "http://localhost:11434/v1" }))).toBe(
      "localhost:11434",
    );
    // A key at a hosted service is named by its host: the file goes there.
    expect(
      sealReaderHost(worker({ kind: "custom", address: "https://api.example.com/openai/v1" })),
    ).toBe("api.example.com");
  });

  it("is the reading service first for a PDF or an image, and only images it takes are sealed", () => {
    expect(["scan.PDF", "id.png", "photo.jpeg", "page.tif"].map(readByReadingServiceFirst)).toEqual(
      [true, true, true, true],
    );
    expect(["lease.docx", "notes.txt"].map(readByReadingServiceFirst)).toEqual([false, false]);
    expect(["id.png", "photo.JPG", "page.webp"].map(sealableImage)).toEqual([true, true, true]);
    // The reading service takes neither, so sealing either would only fail.
    expect(["live.heic", "clip.gif", "scan.pdf"].map(sealableImage)).toEqual([false, false, false]);
  });

  it("is offered only while masking runs", () => {
    expect(sealingOffered(null)).toBe(false);
    expect(sealingOffered({ active: false } as PrivacyStatus)).toBe(false);
    expect(sealingOffered({ active: true } as PrivacyStatus)).toBe(true);
  });

  it("is done here for a folder on this computer, and on the other computer for a folder there", () => {
    const folder = {
      environmentId: "this-computer",
      primaryEnvironmentId: "this-computer",
      projectId: "p",
      status: { active: true } as PrivacyStatus,
    };
    expect(folderSealing(folder)).toBe("here");
    expect(folderSealing({ ...folder, environmentId: "office-computer" })).toBe("elsewhere");
    expect(folderSealing({ ...folder, status: { active: false } as PrivacyStatus })).toBe("none");
    expect(folderSealing({ ...folder, projectId: null })).toBe("none");
    expect(folderSealing({ ...folder, environmentId: null })).toBe("none");
  });
});

describe("the sealed file behind a path", () => {
  const listing = {
    documents: [
      { handle: "DOC_1", name: "lease.txt", origin: "/work/case/lease.txt" },
      { handle: "DOC_2", name: "upload.pdf" },
      { handle: "DOC_3", name: "id.png", origin: "C:\\work\\case\\id.png" },
    ],
  } as unknown as PrivacySealedListing;

  it("is found by the place it was moved out of, whatever the slashes", () => {
    expect(sealedDocumentAt(listing, "/work/case/lease.txt")?.handle).toBe("DOC_1");
    expect(sealedDocumentAt(listing, "C:/work/case/id.png")?.handle).toBe("DOC_3");
    expect(sealedDocumentAt(listing, "/work/case/other.txt")).toBeUndefined();
    expect(sealedDocumentAt(listing, null)).toBeUndefined();
    expect(sealedDocumentAt(null, "/work/case/lease.txt")).toBeUndefined();
  });

  it("names a file by the last part of its path", () => {
    expect(fileNameOf("/work/case/lease.txt")).toBe("lease.txt");
    expect(fileNameOf("C:\\work\\case\\id.png")).toBe("id.png");
    expect(fileNameOf("lease.txt")).toBe("lease.txt");
  });
});

describe("a sealed folder in the list", () => {
  const listing = {
    documents: [
      { handle: "DOC_1", name: "lease.txt", origin: "/work/case/contracts/lease.txt" },
      { handle: "DOC_2", name: "annex.md", origin: "/work/case/contracts/2024/annex.md" },
      { handle: "DOC_3", name: "notes.txt", origin: "/work/case/notes.txt" },
      { handle: "DOC_4", name: "upload.pdf" },
      { handle: "DOC_5", name: "old.txt", origin: "/work/case/contracts-old/old.txt" },
    ],
    folders: [
      {
        path: "/work/case/contracts",
        sealedAt: "2026-11-24T09:00:00.000Z",
        left: [{ path: "/work/case/contracts/signing.mp4", message: "Cannot be sealed." }],
      },
    ],
  } as unknown as PrivacySealedListing;

  it("is one row holding its files, apart from the files sealed one by one", () => {
    const grouped = groupSealedListing(listing);
    expect(
      grouped.folders.map((group) => [
        group.name,
        group.documents.map(({ document, path }) => [document.handle, path]),
        group.left,
      ]),
    ).toEqual([
      [
        "contracts",
        [
          ["DOC_1", "lease.txt"],
          ["DOC_2", "2024/annex.md"],
        ],
        [{ path: "signing.mp4", message: "Cannot be sealed." }],
      ],
    ]);
    // A folder whose name only starts the same is not part of it.
    expect(grouped.loose.map((document) => document.handle)).toEqual(["DOC_3", "DOC_4", "DOC_5"]);
    // A listing from a server that knows no sealed folders lists every file on its own.
    expect(groupSealedListing({ ...listing, folders: undefined } as never).loose).toHaveLength(5);
  });

  it("is found at its own path and for any path inside it", () => {
    expect(sealedFolderAt(listing, "/work/case/contracts/")?.path).toBe("/work/case/contracts");
    expect(sealedFolderAt(listing, "/work/case/contracts/2024")).toBeUndefined();
    expect(sealedFolderHolding(listing, "/work/case/contracts/2024/annex.md")?.path).toBe(
      "/work/case/contracts",
    );
    expect(sealedFolderHolding(listing, "/work/case/contracts")).toBeUndefined();
    expect(sealedFolderHolding(listing, "/work/case/contracts-old/old.txt")).toBeUndefined();
    expect(sealedFolderToUnseal(listing, "/work/case/contracts/lease.txt")).toEqual({
      name: "contracts",
      path: "/work/case/contracts",
      files: 2,
    });
    expect(sealedFolderToUnseal(listing, "/work/case/notes.txt")).toBeUndefined();
  });
});

describe("who the confirmation says will read the files", () => {
  const ownServer = worker({ kind: "custom", address: "http://localhost:11434/v1" });
  const hosted = (region: "sa" | "eu" | "global" | null, available = true) => ({
    ...worker({ kind: "cloud", address: "https://api.doedesk.com/v1/worker", region, available }),
    mode: "cloud" as const,
  });

  it("names the person's own server, and states how many files it will read", () => {
    const reader = sealReader(ownServer);
    expect(reader).toEqual({ kind: "ownServer", host: "localhost:11434" });
    expect(sealReader(worker({}))).toBeNull();
    expect(sealReader(null)).toBeNull();
    if (reader === null) return;
    // The confirmation states the count and the host, whichever of the three it is for.
    expect(whoReadsSealedFiles(reader, { kind: "files", count: 12 })).toMatch(
      /localhost:11434 .* 12 files/,
    );
    expect(whoReadsSealedFiles(reader, { kind: "folder", count: 40 })).toMatch(
      /localhost:11434 .* 40 files/,
    );
    // Their own reading service reads a PDF first; DoeDesk Cloud does when they are signed in for masking.
    expect(sealReaderLines({ ...ownServer, mode: "selfHosted" }, { kind: "file" }, 1)).toEqual([
      expect.stringMatching(/your own server at localhost:11434/),
      expect.stringMatching(/your reading service reads its text first/),
    ]);
    expect(sealReaderLines({ ...ownServer, mode: "cloud" }, { kind: "file" }, 1)?.[1]).toMatch(
      /DoeDesk Cloud reads its text first/,
    );
    expect(sealReaderLines(worker({}), { kind: "file" }, 0)).toBeNull();
  });

  it("is DoeDesk Cloud's worker in the account's region for a signed-in account, for one file, several and a folder", () => {
    expect(sealReader(hosted("eu"))).toEqual({ kind: "hosted", region: "eu", operator: null });
    // The relay's address is never taken for the person's own server.
    expect(sealReaderHost(hosted("eu"))).toBeNull();
    const [who, first, ...rest] = sealReaderLines(hosted("sa"), { kind: "file" }, 1) ?? [];
    expect(who).toMatch(
      /DoeDesk Cloud \(in Saudi Arabia\) receives the file's text and, without storing it, sends it to the worker model at deep\.sa, in Saudi Arabia according to deep\.sa\./,
    );
    expect(first).toMatch(/DoeDesk Cloud reads its text first in Saudi Arabia/);
    expect(rest).toEqual([]);
    expect(sealReaderLines(hosted("eu"), { kind: "file" }, 0)).toEqual([
      expect.stringMatching(
        /and, without storing it, sends it to the worker model for the European Union region\./,
      ),
    ]);
    // Several files and a folder say the same of DoeDesk Cloud, with their count.
    expect(sealReaderLines(hosted("eu"), { kind: "files", count: 12 }, 3)).toEqual([
      expect.stringMatching(
        /one of these 12 files, DoeDesk Cloud \(in Saudi Arabia\) receives that file's text and, without storing it, sends it to the worker model for the European Union region\./,
      ),
      expect.stringMatching(
        /3 of them are PDFs or images, so DoeDesk Cloud reads their text first/,
      ),
    ]);
    expect(sealReaderLines(hosted("global"), { kind: "folder", count: 40 }, 0)).toEqual([
      expect.stringMatching(
        /one of the 40 files in this folder, or about a file added later, DoeDesk Cloud \(in Saudi Arabia\) receives that file's text and, without storing it, sends it to OpenRouter's global endpoint/,
      ),
    ]);
    // One readable file among several chosen is not "this file", and one file is not "1 of them".
    expect(sealReaderLines(hosted("eu"), { kind: "files", count: 1 }, 1)).toEqual([
      expect.stringMatching(
        /^Each time your AI asks about the one file here that DoeDesk can read, .* receives its text/,
      ),
      expect.stringMatching(/^That one file is a PDF or an image/),
    ]);
    expect(sealReaderLines(hosted("eu"), { kind: "folder", count: 1 }, 1)?.[1]).toMatch(
      /^That one file is a PDF or an image/,
    );
    expect(sealReaderLines(hosted("eu"), { kind: "folder", count: 5 }, 1)?.[1]).toMatch(
      /^One of them is a PDF or an image/,
    );
    // A region DoeDesk Cloud has not named yet is not guessed.
    expect(sealReaderLines(hosted(null), { kind: "file" }, 0)?.[0]).toMatch(
      /without storing it, sends it to the worker model for your account's region\./,
    );
  });

  it("says what DoeDesk Cloud reports when the region's operator is not the one its sentences name", () => {
    const moved = {
      ...hosted("sa"),
      accountRegion: "sa" as const,
      hostedWorker: { host: "Another Host", location: "Saudi Arabia, according to Another Host" },
    };
    expect(sealReader(moved)).toEqual({
      kind: "hosted",
      region: "sa",
      operator: { host: "Another Host", location: "Saudi Arabia, according to Another Host" },
    });
    for (const sentence of [
      sealReaderLines(moved, { kind: "file" }, 0)?.[0],
      sealReaderLines(moved, { kind: "files", count: 2 }, 0)?.[0],
      sealedReaderSentences(moved)[0],
      accountRegionExplained(moved, "sa"),
    ]) {
      expect(sentence).toContain("Another Host (Saudi Arabia, according to Another Host)");
      expect(sentence).not.toContain("deep.sa");
    }
    // The operator the sentences were written for is said in the app's own words.
    const same = { ...moved, hostedWorker: { host: "deep.sa", location: "anything" } };
    expect(sealReaderLines(same, { kind: "file" }, 0)?.[0]).toMatch(/the worker model at deep\.sa/);
  });

  it("says beside a chat who reads, that a region that is down is not replaced, and busy as a state", () => {
    expect(sealedReaderSentences(hosted("eu"))).toEqual([
      "Sealed files are read through DoeDesk Cloud in Saudi Arabia by the worker model for the European Union region.",
    ]);
    expect(sealedReaderSentences(hosted("sa", false))).toEqual([
      "Sealed files are read through DoeDesk Cloud in Saudi Arabia by deep.sa, in Saudi Arabia according to deep.sa.",
      "The worker in this region is not answering. DoeDesk does not route sealed files to another region.",
    ]);
    const busy = hosted("eu");
    expect(
      sealedReaderSentences({ ...busy, worker: { ...busy.worker!, busy: { waiting: 4 } } })[1],
    ).toBe(
      "The worker in this region is busy, with 4 waiting. DoeDesk does not route sealed files to another region.",
    );
    expect(sealedReaderSentences(ownServer)).toEqual([
      "Sealed files are read by your own server at localhost:11434.",
    ]);
    expect(sealedReaderSentences(worker({}))).toEqual([
      "No worker is connected, so your AI cannot ask about sealed files.",
    ]);
    // An account that lost DoeDesk Cloud's worker is told its files are still sealed, and where they go: nowhere.
    expect(sealedReaderSentences(worker({ notIncluded: true }))).toEqual([
      "DoeDesk Cloud's worker is not included in this account. Your sealed files stay sealed and encrypted on this computer, and nothing is sent anywhere else. Connect your own server to ask about them again.",
    ]);
    // A region where DoeDesk Cloud offers no worker yet: nobody is named as the reader, here or
    // in another region, and it is said as a state, not as a fault.
    const none = { ...hosted("eu", false), hostedWorkerEntitled: true, hostedWorkerOffered: false };
    expect(sealReader(none)).toBeNull();
    expect(sealReaderLines(none, { kind: "file" }, 0)).toBeNull();
    expect(sealedReaderSentences(none)).toEqual([
      "DoeDesk Cloud's worker is not available in your region yet. Your sealed files stay sealed and encrypted on this computer, and nothing is sent to another region. Connect your own server to ask about them.",
    ]);
    expect(managedWorkerNote(none)).toMatch(
      /^DoeDesk Cloud's worker is not available in your region yet\./,
    );
    expect(workerChoicesFor(none).map((choice) => choice.value)).toEqual(["custom", "off"]);
    expect(accountRegionExplained(none, "eu")).toMatch(
      /^DoeDesk Cloud's worker for sealed files is not available in the European Union region yet\./,
    );
    // An account whose region has one is offered it as before.
    expect(
      workerChoicesFor({ ...hosted("sa"), hostedWorkerEntitled: true }).map(
        (choice) => choice.value,
      ),
    ).toContain("cloud");
    // The record names the worker that gave each answer.
    expect(answerRouteLabel("eu")).toBe("Answered by DoeDesk Cloud's worker, European Union");
    expect(answerRouteLabel("custom:localhost:11434")).toBe(
      "Answered by your own server at localhost:11434",
    );
  });
});
