import { COLLABORATION_LIMITS } from "../../src/collaboration/protocol.ts";

export type MutationBudget = {
  burstTokens: number;
  burstRefillAt: number;
  sustainedTokens: number;
  sustainedRefillAt: number;
};

export function newMutationBudget(now: number): MutationBudget {
  return {
    burstTokens: COLLABORATION_LIMITS.mutationBurstPerSecond,
    burstRefillAt: now,
    sustainedTokens: COLLABORATION_LIMITS.mutationsPerMinute,
    sustainedRefillAt: now,
  };
}

export function consumeMutation(
  budget: MutationBudget,
  now: number,
): { allowed: boolean; budget: MutationBudget } {
  const next = {
    burstTokens: refill(
      budget.burstTokens,
      budget.burstRefillAt,
      now,
      COLLABORATION_LIMITS.mutationBurstPerSecond,
      COLLABORATION_LIMITS.mutationBurstPerSecond / 1_000,
    ),
    burstRefillAt: now,
    sustainedTokens: refill(
      budget.sustainedTokens,
      budget.sustainedRefillAt,
      now,
      COLLABORATION_LIMITS.mutationsPerMinute,
      COLLABORATION_LIMITS.mutationsPerMinute / 60_000,
    ),
    sustainedRefillAt: now,
  };

  if (next.burstTokens < 1 || next.sustainedTokens < 1) {
    return { allowed: false, budget: next };
  }

  next.burstTokens -= 1;
  next.sustainedTokens -= 1;
  return { allowed: true, budget: next };
}

function refill(
  tokens: number,
  refillAt: number,
  now: number,
  capacity: number,
  tokensPerMillisecond: number,
): number {
  const elapsed = Math.max(0, now - refillAt);
  return Math.min(capacity, tokens + elapsed * tokensPerMillisecond);
}
