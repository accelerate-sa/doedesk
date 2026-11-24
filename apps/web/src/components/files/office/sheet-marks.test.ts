import { describe, expect, it } from "vite-plus/test";

import { visibleRuns } from "./sheet-marks";

describe("visibleRuns", () => {
  it.each([
    ["a plain frame", 40, undefined, [0, 20, 40, 60], [[40, 42]]],
    [
      "a frozen header row, then rows far down the sheet",
      0,
      [0, 5000, 5001],
      [0, 20, 40, 60],
      [
        [0, 0],
        [5000, 5001],
      ],
    ],
    ["nothing to show", 3, undefined, [0], []],
  ] as const)("%s", (_name, start, indices, offsets, runs) => {
    expect(visibleRuns(start, indices, offsets)).toEqual(runs);
  });
});
