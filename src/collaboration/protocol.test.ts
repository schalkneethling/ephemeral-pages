import { describe, expect, it } from "vitest";

import { COLLABORATION_LIMITS, validateClientMessage, validateJsonObject } from "./protocol.ts";

describe("collaboration protocol", () => {
  it("accepts initialization and set/delete transactions", () => {
    expect(
      validateClientMessage({
        type: "initialize",
        requestId: "init-1",
        state: { cards: {}, lanes: { backlog: { title: "Backlog" } } },
      }).ok,
    ).toBe(true);
    expect(
      validateClientMessage({
        type: "transact",
        requestId: "move-1",
        operations: [
          { type: "set", path: ["cards", "card-1", "laneId"], value: "done" },
          { type: "delete", path: ["drafts", "card-1"] },
        ],
      }).ok,
    ).toBe(true);
  });

  it.each([
    ["unknown message", { type: "wat", requestId: "1" }],
    ["empty transaction", { type: "transact", requestId: "1", operations: [] }],
    [
      "prototype-polluting path",
      {
        type: "transact",
        requestId: "1",
        operations: [{ type: "set", path: ["__proto__"], value: true }],
      },
    ],
    [
      "non-finite number",
      {
        type: "transact",
        requestId: "1",
        operations: [{ type: "set", path: ["count"], value: Number.POSITIVE_INFINITY }],
      },
    ],
  ])("rejects %s", (_name, message) => {
    expect(validateClientMessage(message)).toMatchObject({ ok: false, code: "invalid_message" });
  });

  it("rejects excessive depth, transaction operations, and state size", () => {
    let nested: Record<string, unknown> = {};
    for (let index = 0; index <= COLLABORATION_LIMITS.jsonDepth; index += 1) {
      nested = { child: nested };
    }
    expect(validateJsonObject(nested).ok).toBe(false);

    expect(
      validateClientMessage({
        type: "transact",
        requestId: "many",
        operations: Array.from(
          { length: COLLABORATION_LIMITS.operationsPerTransaction + 1 },
          (_, index) => ({ type: "delete", path: [String(index)] }),
        ),
      }),
    ).toMatchObject({ ok: false, code: "state_too_large" });

    expect(
      validateJsonObject({ value: "x".repeat(COLLABORATION_LIMITS.stateBytes) }),
    ).toMatchObject({ ok: false, code: "state_too_large" });
  });

  it("rejects cyclic values without throwing", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(validateJsonObject(cyclic)).toMatchObject({ ok: false, code: "invalid_message" });
  });
});
