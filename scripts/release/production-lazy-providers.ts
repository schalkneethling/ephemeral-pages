import type { ProductionDependencies } from "./production-runner.ts";

// Defer credentialed inspection until the runner has durably recorded its start.
// A transient factory/preflight failure can then be resumed from that record.
export function lazyProductionDependencies(
  create: () => Promise<ProductionDependencies>,
): ProductionDependencies {
  let pending: Promise<ProductionDependencies> | undefined;
  const get = () => (pending ??= create());
  return {
    inspect: async () => (await get()).inspect(),
    verifyRetained: async (record) => (await get()).verifyRetained(record),
    holdNetlify: async (checkpoint) => (await get()).holdNetlify(checkpoint),
    uploadWorker: async (checkpoint) => (await get()).uploadWorker(checkpoint),
    activateWorker: async (upload, checkpoint) => (await get()).activateWorker(upload, checkpoint),
    publishNetlify: async (held, checkpoint) => (await get()).publishNetlify(held, checkpoint),
    reconcile: async (step, record) => (await get()).reconcile(step, record),
    verifyTransition: async () => (await get()).verifyTransition(),
    verifyPair: async () => (await get()).verifyPair(),
  };
}
