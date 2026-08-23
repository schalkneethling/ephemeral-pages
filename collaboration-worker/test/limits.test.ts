import { describe, expect, it } from "vitest";

import { COLLABORATION_LIMITS } from "../../src/collaboration/protocol.ts";
import { consumeMutation, newMutationBudget } from "../src/limits.ts";

describe("mutation token buckets", () => {
  it("enforces burst capacity and refills continuously", () => {
    let budget = newMutationBudget(1_000);
    for (let index = 0; index < COLLABORATION_LIMITS.mutationBurstPerSecond; index += 1) {
      const result = consumeMutation(budget, 1_000);
      expect(result.allowed).toBe(true);
      budget = result.budget;
    }
    expect(consumeMutation(budget, 1_000).allowed).toBe(false);
    expect(consumeMutation(budget, 1_100).allowed).toBe(true);
  });

  it("does not refill when the clock moves backwards", () => {
    const budget = newMutationBudget(2_000);
    const consumed = consumeMutation(budget, 2_000).budget;
    const backwards = consumeMutation(consumed, 1_000);
    expect(backwards.allowed).toBe(true);
    expect(backwards.budget.burstTokens).toBe(COLLABORATION_LIMITS.mutationBurstPerSecond - 2);
  });
});
