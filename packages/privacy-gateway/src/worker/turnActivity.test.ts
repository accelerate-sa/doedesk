import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { describe, expect, it } from "vite-plus/test";

import { SealedStore } from "./store.ts";
import { noteSealedAsk, sealedTurn, takeSealedTurn } from "./turnActivity.ts";

const setup = () => {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "doedesk-sealed-turns-"));
  const store = new SealedStore(root);
  store.add("p", "lease.txt", "Rent is SAR 84,000 a year.", "text/plain");
  store.add("p", "payroll.csv", "name,salary", "text/plain");
  // The first file's name was checked; the second is still told as its handle and type.
  store.setLabels("p", [{ handle: "DOC_1", label: "lease.txt" }]);
  return { root, store, [Symbol.dispose]: () => NodeFS.rmSync(root, { recursive: true }) };
};

const answer = (handle: string, asked: string, kind: "yes" | "no") => ({
  at: "2026-11-24T09:00:00.000Z",
  handle,
  document: handle === "DOC_1" ? "lease.txt" : "payroll.csv",
  asked,
  kind,
  value: null,
});

describe("the record of what a turn asked of sealed files", () => {
  it("gathers a thread's calls into the turn that ends, each file once, by the name it had", () => {
    using context = setup();
    const late = answer("DOC_1", "late: is the rent overdue?", "yes");
    const signed = answer("DOC_2", "signed: is it signed?", "no");
    noteSealedAsk(context.store, "p", "thread-1", ["DOC_1"], [late]);
    noteSealedAsk(context.store, "p", "thread-1", ["DOC_1", "DOC_2"], [signed]);
    noteSealedAsk(context.store, "p", "thread-2", ["DOC_2"], []);

    expect(takeSealedTurn(context.store, "thread-1", "run-1")).toEqual({
      // With what the AI company was told each file is called at the time.
      asked: [
        { handle: "DOC_1", name: "lease.txt", label: "lease.txt" },
        { handle: "DOC_2", name: "payroll.csv", label: "DOC_2.csv" },
      ],
      answers: [late, signed],
    });
    // The next turn of the thread starts empty; the other thread's calls are its own.
    expect(takeSealedTurn(context.store, "thread-1", "run-2")).toBeUndefined();
    expect(takeSealedTurn(context.store, "thread-2", "run-3")?.asked).toEqual([
      { handle: "DOC_2", name: "payroll.csv", label: "DOC_2.csv" },
    ]);
  });

  it("keeps a turn's record across a restart and after its file is unsealed", () => {
    using context = setup();
    noteSealedAsk(context.store, "p", "thread-1", ["DOC_1"], []);
    takeSealedTurn(context.store, "thread-1", "run-1");
    context.store.remove("p", "DOC_1");

    const reopened = new SealedStore(context.root);
    expect(sealedTurn(reopened, "run-1")).toEqual({
      asked: [{ handle: "DOC_1", name: "lease.txt", label: "lease.txt" }],
      answers: [],
    });
    expect(sealedTurn(reopened, "run-9")).toBeUndefined();
  });
});
