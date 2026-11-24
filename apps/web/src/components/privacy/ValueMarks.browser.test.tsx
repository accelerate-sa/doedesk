import type { PrivacyKnownValues, PrivacyStatus, PrivacyTurnRecord } from "@t3tools/contracts";
import { EnvironmentId, RunId, ThreadId } from "@t3tools/contracts";
import { useState, type ReactNode } from "react";
import { describe, expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";
import "~/index.css";

import { act, render } from "../../../test/render";
import { AppAtomRegistryProvider } from "~/rpc/atomRegistry";

// The values come from the server in one request; the test answers it and counts the asks.
const server = vi.hoisted(() => ({ knownValues: vi.fn() }));
// What the app's stores would hold. The mocked hooks subscribe to it, as the real ones do to
// theirs, so a change re-renders exactly the components that read it.
const world = vi.hoisted(() => {
  const listeners = new Set<() => void>();
  let state: { privacy: unknown; turns: ReadonlyArray<unknown>; primary: unknown } = {
    privacy: { kind: "loading" },
    turns: [],
    primary: undefined,
  };
  return {
    read: () => state,
    write: (next: Partial<typeof state>) => {
      state = { ...state, ...next };
      for (const listener of listeners) listener();
    },
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
});
vi.mock("~/privacy/privacyClient", async () => {
  const { useSyncExternalStore } = await import("react");
  return {
    fetchKnownValues: server.knownValues,
    usePrivacyStatus: () => useSyncExternalStore(world.subscribe, () => world.read().privacy),
  };
});
vi.mock("~/state/entities", async () => {
  const { useSyncExternalStore } = await import("react");
  return {
    useThreadRunPrivacy: (ref: unknown) =>
      useSyncExternalStore(world.subscribe, () => (ref === null ? NO_TURNS : world.read().turns)),
  };
});
vi.mock("~/state/environments", async () => {
  const { useSyncExternalStore } = await import("react");
  return {
    usePrimaryEnvironmentId: () =>
      useSyncExternalStore(world.subscribe, () => world.read().primary),
  };
});
const NO_TURNS = vi.hoisted(() => Object.freeze([]));

import { ChatValueMarks } from "./ChatValueMarks";
import {
  FileValueMarksNotice,
  FileValueMarksProvider,
  FileValueMarksToggle,
} from "./FileValueMarks";
import { FileValueMarkSurface, TextlessFileValueMarkSurface } from "./FileValueMarkSurface";
import { CHAT_VALUE_MARK, FILE_VALUE_MARK } from "./valueMarkRanges";

const environmentId = EnvironmentId.make("environment-here");
const threadRef = { environmentId, threadId: ThreadId.make("thread-1") };

const PERSON = "[PERSON_FBJD2]";
const PHONE = "[PHONE_K7QW3]";
const KNOWN: PrivacyKnownValues["values"] = [
  { token: PERSON, surfaces: ["Khalid Al-Otaibi", "خالد العتيبي", "Khalid"], sealed: false },
  { token: PHONE, surfaces: ["0551234567", "٠٥٥١٢٣٤٥٦٧"], sealed: false },
];

const MASKED: PrivacyTurnRecord = {
  state: "masked",
  replaced: [
    { kind: "PERSON", count: 1 },
    { kind: "PHONE", count: 1 },
  ],
  rewritten: 2,
  refused: 0,
  redacted: 0,
  read: 0,
  withheld: 0,
  sealed: 0,
  attribution: "session",
};

let vaultSize = 0;
/** Each test gets a vault of another size, so no test reads what an earlier one was answered. */
const setup = (overrides: Partial<PrivacyStatus> = {}) => {
  server.knownValues.mockReset();
  vaultSize += 1;
  const status: PrivacyStatus = {
    mode: "cloud",
    active: true,
    accountLabel: "person@example.com",
    endpoint: null,
    vaultSize,
    problem: null,
    profileAnswered: true,
    directProviders: [],
    ...overrides,
  };
  world.write({ privacy: { kind: "ready", status }, turns: [], primary: environmentId });
  server.knownValues.mockImplementation(
    async (payload: { scope: string; runIds?: ReadonlyArray<string> }) => ({
      values: KNOWN,
      turns: (payload.runIds ?? []).map((runId) => ({ runId, tokens: [PERSON, PHONE] })),
    }),
  );
  localStorage.removeItem("doedesk.highlightReplacedValues");
  return status;
};

const recorded = (...runIds: ReadonlyArray<string>) =>
  world.write({ turns: runIds.map((runId) => ({ runId: RunId.make(runId), privacy: MASKED })) });

const marked = (name: string): ReadonlyArray<string> =>
  [...(CSS.highlights.get(name)?.keys() ?? [])].map((range) => (range as Range).toString());

const rangeFor = (name: string, text: string): Range => {
  const range = [...(CSS.highlights.get(name)?.keys() ?? [])].find(
    (candidate) => (candidate as Range).toString() === text,
  );
  if (!range) throw new Error(`No mark on ${text}`);
  return range as Range;
};

/** Rests the pointer in the middle of a mark, as a person reading would. */
const restOn = (host: Element, range: Range) => {
  const rect = range.getClientRects()[0]!;
  host.dispatchEvent(
    new PointerEvent("pointermove", {
      bubbles: true,
      clientX: rect.left + rect.width / 2,
      clientY: rect.top + rect.height / 2,
    }),
  );
};

function Timeline({ children }: { readonly children: ReactNode }) {
  const [container, setContainer] = useState<HTMLDivElement | null>(null);
  return (
    <AppAtomRegistryProvider>
      <div ref={setContainer} data-testid="timeline" className="h-[400px] overflow-auto">
        <ChatValueMarks container={container} threadRef={threadRef} environmentId={environmentId} />
        {children}
      </div>
    </AppAtomRegistryProvider>
  );
}

function Row(props: {
  readonly id: string;
  readonly runId?: string;
  readonly role: "user" | "assistant";
  readonly children: ReactNode;
}) {
  return (
    <div data-timeline-row-id={props.id} data-run-id={props.runId} data-message-role={props.role}>
      <div data-thread-find-text="true">{props.children}</div>
    </div>
  );
}

const COMMAND = 'grep -rn "Khalid Al-Otaibi" ./contracts/2026 | head -20';

describe("marks in the chat", () => {
  it("marks every recorded turn in one read, changes no text, and names the stand-in on hover", async () => {
    setup();
    recorded("run-1", "run-2");
    await using screen = await render(
      <Timeline>
        <Row id="u1" runId="run-1" role="user">
          <p>
            Draft a letter to <strong>Khalid</strong> Al-Otaibi, phone 0551234567.
          </p>
        </Row>
        <Row id="a1" runId="run-1" role="assistant">
          <p>Dear Khalid Al-Otaibi,</p>
          <pre>
            <code>{COMMAND}</code>
          </pre>
        </Row>
        <Row id="u2" runId="run-2" role="user">
          <p>Khalidiyah is a district, and 05512345678 is another number.</p>
        </Row>
        <Row id="tool" role="assistant">
          <p>Khalid Al-Otaibi in a row that belongs to no turn</p>
        </Row>
      </Timeline>,
    );
    const timeline = screen.getByTestId("timeline").element();
    const before = timeline.innerHTML;
    const height = timeline.scrollHeight;
    await vi.waitFor(() =>
      expect(marked(CHAT_VALUE_MARK)).toEqual([
        // Across the bold run, in the reply, and inside the command.
        "Khalid Al-Otaibi",
        "0551234567",
        "Khalid Al-Otaibi",
        "Khalid Al-Otaibi",
      ]),
    );
    expect(server.knownValues).toHaveBeenCalledTimes(1);
    expect(server.knownValues).toHaveBeenCalledWith({ scope: "turns", runIds: ["run-1", "run-2"] });

    // A mark is paint over a range: the nodes, the layout, and what is selected are untouched.
    expect(timeline.innerHTML).toBe(before);
    expect(timeline.scrollHeight).toBe(height);
    const code = timeline.querySelector("code")!;
    document.getSelection()!.selectAllChildren(code);
    expect(document.getSelection()!.toString()).toBe(COMMAND);
    document.getSelection()!.removeAllRanges();

    restOn(timeline, rangeFor(CHAT_VALUE_MARK, "0551234567"));
    const tooltip = page.getByText(PHONE);
    await expect.element(tooltip).toBeVisible();
    await expect.element(page.getByText(/Sent to the AI as/)).toBeVisible();
    await expect.element(page.getByText("Phone numbers")).toBeVisible();
    // The stand-in reads left to right inside any sentence.
    expect(tooltip.element().closest("code")?.getAttribute("dir")).toBe("ltr");
    timeline.dispatchEvent(new PointerEvent("pointerleave"));
    await expect.element(tooltip).not.toBeInTheDocument();
  });

  it("leaves a reply alone while it streams, and marks the turn when its record arrives", async () => {
    setup();
    recorded("run-1");
    const rows = (
      <>
        <Row id="u1" runId="run-1" role="user">
          <p>Call Khalid Al-Otaibi.</p>
        </Row>
        <Row id="u2" runId="run-2" role="user">
          <p>And message 0551234567.</p>
        </Row>
        <Row id="a2" runId="run-2" role="assistant">
          <p data-testid="streaming">Writing to</p>
        </Row>
      </>
    );
    await using screen = await render(<Timeline>{rows}</Timeline>);
    await vi.waitFor(() => expect(marked(CHAT_VALUE_MARK)).toEqual(["Khalid Al-Otaibi"]));

    using added = vi.spyOn(Highlight.prototype, "add");
    using removed = vi.spyOn(Highlight.prototype, "delete");
    const streaming = screen.getByTestId("streaming").element().firstChild as Text;
    for (const word of [" Khalid", " Al-Otaibi", " at", " 0551234567"]) streaming.appendData(word);
    // The record of the turn arrives: only now is its text looked at, in one more read.
    await act(() => recorded("run-1", "run-2"));
    await vi.waitFor(() =>
      expect(marked(CHAT_VALUE_MARK)).toEqual([
        "Khalid Al-Otaibi",
        "0551234567",
        "Khalid Al-Otaibi",
        "0551234567",
      ]),
    );
    // Nothing was repainted for the streamed words: the three new marks, and no mark taken away.
    expect(added).toHaveBeenCalledTimes(3);
    expect(removed).not.toHaveBeenCalled();
    expect(server.knownValues).toHaveBeenCalledTimes(2);
    expect(server.knownValues).toHaveBeenLastCalledWith({ scope: "turns", runIds: ["run-2"] });
  });

  it("sits on Arabic text, leaves an attached letter outside, and knows Arabic-Indic digits", async () => {
    setup();
    recorded("run-1");
    await using screen = await render(
      <Timeline>
        <Row id="u1" runId="run-1" role="user">
          <p dir="rtl" data-testid="arabic" className="w-[320px] text-lg">
            أرسلت العقد لخالد العتيبي ورقم جواله ٠٥٥١٢٣٤٥٦٧ واسمه بالإنجليزية Khalid في الملف
          </p>
        </Row>
      </Timeline>,
    );
    await vi.waitFor(() =>
      expect(marked(CHAT_VALUE_MARK)).toEqual(["خالد العتيبي", "٠٥٥١٢٣٤٥٦٧", "Khalid"]),
    );
    const paragraph = screen.getByTestId("arabic").element().getBoundingClientRect();
    for (const text of marked(CHAT_VALUE_MARK)) {
      // Every piece of a mark lies on the paragraph's lines, wherever the direction puts it.
      const rects = [...rangeFor(CHAT_VALUE_MARK, text).getClientRects()];
      expect(rects.length).toBeGreaterThan(0);
      for (const rect of rects) {
        expect(rect.width).toBeGreaterThan(0);
        expect(rect.left).toBeGreaterThanOrEqual(paragraph.left - 1);
        expect(rect.right).toBeLessThanOrEqual(paragraph.right + 1);
        expect(rect.top).toBeGreaterThanOrEqual(paragraph.top - 1);
        expect(rect.bottom).toBeLessThanOrEqual(paragraph.bottom + 1);
      }
    }
    // In a right-to-left line the name starts at its right edge, after the attached letter.
    const name = rangeFor(CHAT_VALUE_MARK, "خالد العتيبي");
    const letter = document.createRange();
    letter.setStart(name.startContainer, name.startOffset - 1);
    letter.setEnd(name.startContainer, name.startOffset);
    expect(letter.toString()).toBe("ل");
    expect(letter.getBoundingClientRect().left).toBeGreaterThanOrEqual(
      name.getClientRects()[0]!.right - 1,
    );

    restOn(screen.getByTestId("timeline").element(), name);
    await expect.element(page.getByText(PERSON)).toBeVisible();
    await expect.element(page.getByText("People")).toBeVisible();
  });

  it("has no marks while masking is off, for a deleted value, or for a chat on another computer", async () => {
    const status = setup();
    recorded("run-1");
    const rows = (
      <Row id="u1" runId="run-1" role="user">
        <p>Call Khalid Al-Otaibi.</p>
      </Row>
    );
    await using screen = await render(<Timeline>{rows}</Timeline>);
    await vi.waitFor(() => expect(marked(CHAT_VALUE_MARK)).toEqual(["Khalid Al-Otaibi"]));

    await act(() =>
      world.write({ privacy: { kind: "ready", status: { ...status, mode: "off" } } }),
    );
    await vi.waitFor(() => expect(marked(CHAT_VALUE_MARK)).toEqual([]));

    // Back on: the marks return.
    await act(() => world.write({ privacy: { kind: "ready", status } }));
    await vi.waitFor(() => expect(marked(CHAT_VALUE_MARK)).toEqual(["Khalid Al-Otaibi"]));

    // The name is deleted from the vault: the turn is read again and the mark goes.
    server.knownValues.mockResolvedValue({
      values: KNOWN.slice(1),
      turns: [{ runId: "run-1", tokens: [PERSON, PHONE] }],
    });
    const smaller = { ...status, vaultSize: status.vaultSize + 1000 };
    await act(() => world.write({ privacy: { kind: "ready", status: smaller } }));
    await vi.waitFor(() => expect(marked(CHAT_VALUE_MARK)).toEqual([]));
    server.knownValues.mockResolvedValue({
      values: KNOWN,
      turns: [{ runId: "run-1", tokens: [PERSON, PHONE] }],
    });
    await act(() => world.write({ privacy: { kind: "ready", status } }));
    await vi.waitFor(() => expect(marked(CHAT_VALUE_MARK)).toEqual(["Khalid Al-Otaibi"]));

    // The same chat as seen from another computer: the vault is not there, so nothing is marked.
    await act(() => world.write({ primary: EnvironmentId.make("another-computer") }));
    await vi.waitFor(() => expect(marked(CHAT_VALUE_MARK)).toEqual([]));
    expect(screen.container.textContent).toContain("Call Khalid Al-Otaibi.");
  });
});

function Viewer(props: { readonly fileKey: string; readonly children: ReactNode }) {
  return (
    <AppAtomRegistryProvider>
      <FileValueMarksProvider environmentId={environmentId} fileKey={props.fileKey}>
        <FileValueMarksToggle />
        <FileValueMarksNotice />
        <div data-testid="viewer" className="flex h-[400px] flex-col">
          {props.children}
        </div>
      </FileValueMarksProvider>
    </AppAtomRegistryProvider>
  );
}

const table = (...cells: ReadonlyArray<string>) => (
  <>
    <FileValueMarkSurface unitSelector="[data-preview-row]" />
    <div data-preview-row="0">
      {cells.map((cell) => (
        <div key={cell}>{cell}</div>
      ))}
    </div>
  </>
);

describe("the highlight in a file viewer", () => {
  it("is off until switched on, reads the values once for each file, and says what it shows", async () => {
    setup();
    const contract = table("Khalid Al-Otaibi", "0551234567", "Riyadh");
    await using screen = await render(<Viewer fileKey="contract.csv">{contract}</Viewer>);
    const on = screen.getByRole("button", { name: "Highlight what DoeDesk replaces" });
    await expect.element(on).toBeVisible();
    expect(server.knownValues).not.toHaveBeenCalled();
    expect(marked(FILE_VALUE_MARK)).toEqual([]);
    expect(screen.container.querySelector("[data-file-value-marks-notice]")).toBeNull();

    await on.click();
    await vi.waitFor(() =>
      expect(marked(FILE_VALUE_MARK)).toEqual(["Khalid Al-Otaibi", "0551234567"]),
    );
    expect(server.knownValues).toHaveBeenCalledTimes(1);
    expect(server.knownValues).toHaveBeenCalledWith({ scope: "vault" });
    await expect
      .element(screen.getByText(/Highlights show only values DoeDesk has replaced before\./))
      .toBeVisible();

    restOn(screen.getByTestId("viewer").element(), rangeFor(FILE_VALUE_MARK, "Khalid Al-Otaibi"));
    await expect.element(page.getByText(PERSON)).toBeVisible();
    await expect.element(page.getByText(/DoeDesk sends/)).toBeVisible();

    // Another file, with nothing DoeDesk knows: read once more, and not called clean.
    await screen.rerender(<Viewer fileKey="notes.txt">{table("Riyadh", "Invoice 12")}</Viewer>);
    await expect
      .element(screen.getByText(/Nothing on screen matches a value DoeDesk has replaced before\./))
      .toBeVisible();
    expect(marked(FILE_VALUE_MARK)).toEqual([]);
    expect(server.knownValues).toHaveBeenCalledTimes(2);

    // The way out, which the next file remembers.
    await screen.rerender(<Viewer fileKey="contract.csv">{contract}</Viewer>);
    await vi.waitFor(() => expect(marked(FILE_VALUE_MARK)).toHaveLength(2));
    await screen.getByRole("button", { name: "Hide highlights" }).click();
    await vi.waitFor(() => expect(marked(FILE_VALUE_MARK)).toEqual([]));
    expect(screen.container.querySelector("[data-file-value-marks-notice]")).toBeNull();
    expect(server.knownValues).toHaveBeenCalledTimes(3);
  });

  it("offers nothing while masking is off, and says an image has no text to highlight", async () => {
    const status = setup({ mode: "off" });
    await using screen = await render(
      <Viewer fileKey="scan.png">
        <TextlessFileValueMarkSurface />
      </Viewer>,
    );
    expect(screen.container.querySelector("button")).toBeNull();

    await act(() =>
      world.write({ privacy: { kind: "ready", status: { ...status, mode: "cloud" } } }),
    );
    await screen.getByRole("button", { name: "Highlight what DoeDesk replaces" }).click();
    await expect.element(screen.getByText(/This file has no text to highlight\./)).toBeVisible();
    await expect
      .element(screen.getByRole("button", { name: "See what was sent in place of files" }))
      .toBeVisible();
    // Nothing to mark, so nothing is read.
    expect(server.knownValues).not.toHaveBeenCalled();
  });
});
