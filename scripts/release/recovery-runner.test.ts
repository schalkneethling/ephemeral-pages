import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { productionRecordSchema, productionSteps } from "./production-record.ts";
import {
  runRecovery,
  type RecoveryDependencies,
  type RecoveryRunInput,
} from "./recovery-runner.ts";
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "recovery-runner-"));
  roots.push(root);
  await mkdir(join(root, "repo"));
  const target = {
    netlifyDeployId: "old-app",
    workerDeploymentId: "old-deployment",
    workerVersionId: "old-version",
  };
  let pair = {
    netlifyDeployId: "new-app",
    workerDeploymentId: "new-deployment",
    workerVersionId: "new-version",
  };
  const source = productionRecordSchema.parse({
    schemaVersion: 1,
    operation: "production-release",
    approvalSha256: "a".repeat(64),
    candidate: "a".repeat(40),
    promotionCommit: "b".repeat(40),
    tree: "c".repeat(40),
    configurationFingerprint: "d".repeat(64),
    originalRunId: 1,
    runIds: [1],
    preparationSha256: "e".repeat(64),
    createdAt: "2026-09-11T00:00:00.000Z",
    updatedAt: "2026-09-11T00:00:00.000Z",
    outcome: "passed",
    priorPair: target,
    observedPair: pair,
    stages: Object.fromEntries(productionSteps.map((step) => [step, "passed"])),
    results: {},
    journal: [],
    recovery: "none",
  });
  const input: RecoveryRunInput = {
    environment: "production",
    repositoryRoot: join(root, "repo"),
    reportDirectory: join(root, "run"),
    source,
    sourceProductionRunId: 1,
    recoveryPlanSha256: "f".repeat(64),
    currentRunId: 2,
    startingPair: { ...pair },
  };
  const calls: string[] = [];
  const deps: RecoveryDependencies = {
    inspect: async () => ({ ...pair }),
    verifyTargets: async () => {
      calls.push("verify-targets");
      return {
        inspectionVersion: 2,
        inspectionSha256: "f".repeat(64),
        requested: target,
        expectedCurrent: input.startingPair,
        netlifyIdentity: "source-commit",
        netlifyVariablesVerified: true,
        workerArtifactSha256: "f".repeat(64),
        workerMigrationTag: "v1",
        workerScriptEtag: "a".repeat(32),
        workerSecretBindingNames: ["ADMIN_TOKEN", "TICKET_HMAC_SECRET"],
        workerSecretValuesObservable: false,
      };
    },
    restoreNetlify: async (checkpoint) => {
      calls.push("restore-app");
      await checkpoint({ phase: "netlify-restore-pending" });
      pair.netlifyDeployId = target.netlifyDeployId;
      await checkpoint({
        phase: "netlify-restore-response-received",
        deployId: pair.netlifyDeployId,
      });
      return { publishedDeployId: pair.netlifyDeployId };
    },
    restoreWorker: async (checkpoint) => {
      calls.push("restore-worker");
      await checkpoint({ phase: "worker-rollback-pending" });
      pair = {
        ...pair,
        workerVersionId: target.workerVersionId,
        workerDeploymentId: "recovery-deployment",
      };
      await checkpoint({
        phase: "worker-rollback-response-received",
        deploymentId: pair.workerDeploymentId,
        versionId: pair.workerVersionId,
      });
      return { deploymentId: pair.workerDeploymentId, versionId: pair.workerVersionId };
    },
    reconcile: async (step) => {
      calls.push(`reconcile:${step}`);
      if (step === "restore-netlify" && pair.netlifyDeployId === target.netlifyDeployId)
        return { netlify: { publishedDeployId: pair.netlifyDeployId } };
      if (step === "restore-worker" && pair.workerVersionId === target.workerVersionId)
        return {
          worker: { deploymentId: pair.workerDeploymentId, versionId: pair.workerVersionId },
        };
      throw Object.assign(Error(), { kind: "ambiguous" });
    },
    verifyTransition: async () => {
      calls.push("transition");
      return true;
    },
    verifyPair: async () => {
      calls.push("verify-pair");
      return true;
    },
  };
  return {
    root,
    input,
    deps,
    calls,
    setPair: (next: typeof pair) => {
      pair = next;
    },
  };
}
it("restores app before Worker and records the new Worker deployment ID", async () => {
  const f = await fixture();
  const result = await runRecovery(f.input, f.deps);
  expect(result.outcome).toBe("passed");
  expect(f.calls).toEqual([
    "verify-targets",
    "restore-app",
    "transition",
    "restore-worker",
    "verify-pair",
  ]);
  expect(result.recoveredPair).toEqual({
    ...result.targetPair,
    workerDeploymentId: "recovery-deployment",
  });
  expect(
    JSON.parse(await readFile(join(f.input.reportDirectory, "recovery.json"), "utf8")),
  ).toEqual(result);
});
it("blocks unavailable or incompatible targets before writes", async () => {
  const f = await fixture();
  f.deps.verifyTargets = async () => {
    throw Object.assign(Error("sensitive payload"), { kind: "preflight" });
  };
  const result = await runRecovery(f.input, f.deps);
  expect(result.outcome).toBe("blocked");
  expect(f.calls).toEqual([]);
  expect(JSON.stringify(result)).not.toContain("sensitive payload");
});
it("resumes a returned Worker write without repeating the mutation", async () => {
  const f = await fixture();
  const restore = f.deps.restoreWorker.bind(f.deps);
  f.deps.restoreWorker = async (checkpoint) => {
    await restore(checkpoint);
    throw Object.assign(Error(), { kind: "ambiguous" });
  };
  const previous = await runRecovery(f.input, f.deps);
  const resumed = await runRecovery(
    { ...f.input, currentRunId: 3, reportDirectory: join(f.root, "resume"), previous },
    f.deps,
  );
  expect(resumed.outcome).toBe("passed");
  expect(f.calls.filter((call) => call === "restore-worker")).toHaveLength(1);
  expect(resumed.recoveryRunIds).toEqual([2, 3]);
});
it("does not repeat an ambiguous write with no verified match", async () => {
  const f = await fixture();
  f.deps.restoreNetlify = async () => {
    f.calls.push("restore-app");
    throw Object.assign(Error(), { kind: "ambiguous" });
  };
  const previous = await runRecovery(f.input, f.deps);
  const resumed = await runRecovery(
    { ...f.input, currentRunId: 3, reportDirectory: join(f.root, "resume"), previous },
    f.deps,
  );
  expect(resumed.outcome).toBe("blocked");
  expect(f.calls.filter((call) => call === "restore-app")).toHaveLength(1);
});
it("rejects changed recovery evidence before provider calls", async () => {
  const f = await fixture();
  const previous = await runRecovery(f.input, f.deps);
  previous.outcome = "blocked";
  f.calls.length = 0;
  await expect(
    runRecovery(
      {
        ...f.input,
        currentRunId: 3,
        reportDirectory: join(f.root, "resume"),
        recoveryPlanSha256: "0".repeat(64),
        previous,
      },
      f.deps,
    ),
  ).rejects.toThrow("Recovery evidence differs");
  expect(f.calls).toEqual([]);
});
it("verifies an already restored pair without writes", async () => {
  const f = await fixture();
  f.input.startingPair = { ...f.input.source.priorPair };
  f.setPair({ ...f.input.startingPair });
  const result = await runRecovery(f.input, f.deps);
  expect(result.outcome).toBe("passed");
  expect(f.calls).toEqual(["verify-targets", "transition", "verify-pair"]);
});

it("rejects a reordered recovery history before provider calls", async () => {
  const f = await fixture();
  const previous = await runRecovery(f.input, f.deps);
  previous.outcome = "blocked";
  previous.stages["restore-netlify"] = "pending";
  delete previous.results.netlify;
  f.calls.length = 0;
  await expect(
    runRecovery(
      { ...f.input, currentRunId: 3, reportDirectory: join(f.root, "resume"), previous },
      f.deps,
    ),
  ).rejects.toThrow("out of order");
  expect(f.calls).toEqual([]);
});
it("rejects resuming an already successful recovery", async () => {
  const f = await fixture();
  const previous = await runRecovery(f.input, f.deps);
  f.calls.length = 0;
  await expect(
    runRecovery(
      { ...f.input, currentRunId: 3, reportDirectory: join(f.root, "resume"), previous },
      f.deps,
    ),
  ).rejects.toThrow("not unresolved");
  expect(f.calls).toEqual([]);
});
