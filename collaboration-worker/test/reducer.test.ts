import { describe, expect, it } from "vitest";

import { COLLABORATION_LIMITS, type JsonObject } from "../../src/collaboration/protocol.ts";
import { applyOperations, InvalidOperationPathError, StateTooLargeError } from "../src/reducer.ts";

describe("applyOperations", () => {
  it("applies ordered set and delete operations without mutating the source", () => {
    const source: JsonObject = {
      cards: {
        first: { laneId: "todo", title: "One" },
        second: { laneId: "doing", title: "Two" },
      },
    };

    const result = applyOperations(source, [
      { type: "set", path: ["cards", "first", "laneId"], value: "done" },
      { type: "delete", path: ["cards", "second"] },
      { type: "set", path: ["cards", "third"], value: { laneId: "todo", title: "Three" } },
    ]);

    expect(result.state).toEqual({
      cards: {
        first: { laneId: "done", title: "One" },
        third: { laneId: "todo", title: "Three" },
      },
    });
    expect(source.cards).toEqual({
      first: { laneId: "todo", title: "One" },
      second: { laneId: "doing", title: "Two" },
    });
  });

  it("creates missing object containers", () => {
    expect(
      applyOperations({}, [{ type: "set", path: ["board", "cards", "one"], value: "ready" }]).state,
    ).toEqual({ board: { cards: { one: "ready" } } });
  });

  it("supports bounded array replacement, append, and deletion", () => {
    const result = applyOperations({ lanes: ["todo", "doing"] }, [
      { type: "set", path: ["lanes", "1"], value: "review" },
      { type: "set", path: ["lanes", "2"], value: "done" },
      { type: "delete", path: ["lanes", "0"] },
    ]);
    expect(result.state).toEqual({ lanes: ["review", "done"] });
  });

  it("rejects traversal through primitives and sparse array writes", () => {
    expect(() =>
      applyOperations({ value: 1 }, [{ type: "set", path: ["value", "nested"], value: true }]),
    ).toThrow(InvalidOperationPathError);
    expect(() =>
      applyOperations({ values: [] }, [{ type: "set", path: ["values", "2"], value: true }]),
    ).toThrow(InvalidOperationPathError);
  });

  it("rejects projected state above the shared state limit", () => {
    expect(() =>
      applyOperations({}, [
        {
          type: "set",
          path: ["oversized"],
          value: "x".repeat(COLLABORATION_LIMITS.stateBytes),
        },
      ]),
    ).toThrow(StateTooLargeError);
  });
});
