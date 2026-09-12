import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import {
  runProductionRelease,
  type ProductionDependencies,
  type ProductionRunInput,
} from "./production-runner.ts";
import { lazyProductionDependencies } from "./production-lazy-providers.ts";
import type { ProductionResults } from "./production-record.ts";
import { ProviderInspectionError } from "./providers.ts";
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function fixture(netlify = true, cloudflare = true) {
  const root = await mkdtemp(join(tmpdir(), "production-runner-"));
  roots.push(root);
  await mkdir(join(root, "repository"));
  const input: ProductionRunInput = {
    repositoryRoot: join(root, "repository"),
    reportDirectory: join(root, "first"),
    currentRunId: 1,
    promotionCommit: "b".repeat(40),
    approval: {
      schemaVersion: 1,
      operation: "release-approval",
      candidate: "a".repeat(40),
      tree: "c".repeat(40),
      configurationFingerprint: "d".repeat(64),
      stagingPreparationSha256: "e".repeat(64),
      stagingRehearsalSha256: "f".repeat(64),
      affected: { netlify, cloudflare },
      compatibility: "compatible",
      migration: { artifactTag: "v1", expectedCurrentTag: "v1", change: "none" },
      recoveryOrder: ["netlify", "cloudflare"],
      baseline: {
        version: 1,
        environment: "production",
        providers: {
          netlify: {
            siteId: "site",
            sourceCommit: "d".repeat(40),
            publishedDeployId: "old-app",
            publishLocked: true,
          },
          cloudflare: {
            accountId: "account",
            workerName: "worker",
            sourceCommit: "e".repeat(40),
            deploymentId: "old-worker",
            traffic: [{ versionId: "old-version", percentage: 100 }],
          },
        },
      },
    },
    prepared: {
      schemaVersion: 1,
      operation: "prepare",
      outcome: "passed",
      source: {
        candidate: "b".repeat(40),
        tree: "c".repeat(40),
        environment: "production",
        configurationFingerprint: "f".repeat(64),
      },
      toolchain: { bun: "1.3.14" },
      artifacts: {
        netlify: { directory: "netlify", sha256: "a".repeat(64) },
        worker: { directory: "worker", sha256: "b".repeat(64) },
      },
    },
  };
  const results: Required<ProductionResults> = {
    heldNetlify: {
      siteId: "site",
      baselineDeployId: "old-app",
      candidateDeployId: "new-app",
      candidate: input.promotionCommit,
      artifactSha256: "a".repeat(64),
      context: "production",
      state: "ready",
      acknowledgedUploads: 1,
    },
    uploadedWorker: {
      accountId: "account",
      artifactManifestSha256: "b".repeat(64),
      baselineDeploymentId: "old-worker",
      migrationPolicy: input.approval.migration,
      scriptEtag: "c".repeat(64),
      status: "uploaded",
      versionId: "new-version",
      workerName: "worker",
    },
    activatedWorker: { deploymentId: "new-worker", versionId: "new-version" },
    publishedNetlify: { publishedDeployId: "new-app" },
  };
  let pair = {
    netlifyDeployId: "old-app",
    workerDeploymentId: "old-worker",
    workerVersionId: "old-version",
  };
  const calls: string[] = [];
  const deps: ProductionDependencies = {
    inspect: async () => ({ ...pair }),
    verifyRetained: async () => {},
    holdNetlify: async (checkpoint) => {
      calls.push("hold");
      await checkpoint({ operation: "createSiteDeploy", artifactSha256: "a".repeat(64) });
      return results.heldNetlify;
    },
    uploadWorker: async (checkpoint) => {
      calls.push("upload");
      await checkpoint({ phase: "pending-version-upload", artifactManifestSha256: "b".repeat(64) });
      return results.uploadedWorker;
    },
    activateWorker: async (_upload, checkpoint) => {
      calls.push("activate");
      pair = { ...pair, workerDeploymentId: "new-worker", workerVersionId: "new-version" };
      await checkpoint({
        phase: "activation-response-received",
        deploymentId: "new-worker",
        versionId: "new-version",
      });
      return results.activatedWorker;
    },
    publishNetlify: async () => {
      calls.push("publish");
      pair = { ...pair, netlifyDeployId: "new-app" };
      return results.publishedNetlify;
    },
    verifyTransition: async () => {
      calls.push("transition");
      return true;
    },
    verifyPair: async () => {
      calls.push("verify");
      return true;
    },
    reconcile: async (step) => {
      calls.push("reconcile:" + step);
      if (step === "activate-worker") return { activatedWorker: results.activatedWorker };
      throw Error("No authoritative match");
    },
  };
  return {
    root,
    input,
    deps,
    calls,
    results,
    setPair: (next: typeof pair) => {
      pair = next;
    },
  };
}
it("activates the compatible Worker before publishing the held app", async () => {
  const f = await fixture();
  const result = await runProductionRelease(f.input, f.deps);
  expect(result.outcome).toBe("passed");
  expect(f.calls).toEqual(["hold", "upload", "activate", "transition", "publish", "verify"]);
  expect(result.observedPair).toEqual({
    netlifyDeployId: "new-app",
    workerDeploymentId: "new-worker",
    workerVersionId: "new-version",
  });
});
it.each([
  [false, false],
  [true, false],
  [false, true],
])("retains unchanged services (app %s / Worker %s)", async (app, worker) => {
  const f = await fixture(app, worker);
  const result = await runProductionRelease(f.input, f.deps);
  expect(result.outcome).toBe("passed");
  expect(f.calls.includes("publish")).toBe(app);
  expect(f.calls.includes("activate")).toBe(worker);
  expect(result.observedPair?.netlifyDeployId).toBe(app ? "new-app" : "old-app");
  if (!app && !worker) expect(f.calls).toEqual([]);
});
it("reports the mixed pair when Worker succeeds and Netlify fails without rollback", async () => {
  const f = await fixture();
  f.deps.publishNetlify = async () => {
    f.calls.push("publish");
    throw Object.assign(Error("secret payload"), { kind: "ambiguous" });
  };
  const result = await runProductionRelease(f.input, f.deps);
  expect(result.outcome).toBe("blocked");
  expect(result.stages["activate-worker"]).toBe("passed");
  expect(result.observedPair).toEqual({
    netlifyDeployId: "old-app",
    workerDeploymentId: "new-worker",
    workerVersionId: "new-version",
  });
  expect(JSON.stringify(result)).not.toContain("secret payload");
  expect(f.calls).not.toContain("verify");
});
it("retains only a structured provider diagnostic when its cause is sensitive", async () => {
  const f = await fixture();
  const cause = new Error("secret-bearing-provider-cause");
  f.deps.inspect = async () => {
    throw new ProviderInspectionError(
      {
        provider: "netlify",
        operation: "getSite",
        classification: "command",
        commandKind: "failed",
        exitCode: 23,
      },
      cause,
    );
  };

  const result = await runProductionRelease(f.input, f.deps);
  expect(result.failure).toEqual({
    stage: "inspect",
    kind: "unknown",
    diagnostic: {
      provider: "netlify",
      operation: "getSite",
      classification: "command",
      commandKind: "failed",
      exitCode: 23,
    },
  });
  expect(JSON.stringify(result)).not.toContain("secret-bearing-provider-cause");
});
it("records a known local artifact failure without retaining its cause", async () => {
  const f = await fixture();
  f.deps.inspect = async () => {
    throw new ProviderInspectionError(
      {
        provider: "netlify",
        operation: "verifyArtifacts",
        classification: "assertion",
        assertion: "artifact-state",
      },
      new Error("secret-bearing-artifact-cause"),
    );
  };

  const result = await runProductionRelease(f.input, f.deps);
  expect(result.failure).toEqual({
    stage: "inspect",
    kind: "unknown",
    diagnostic: {
      provider: "netlify",
      operation: "verifyArtifacts",
      classification: "assertion",
      assertion: "artifact-state",
    },
  });
  expect(JSON.stringify(result)).not.toContain("secret-bearing-artifact-cause");
});
it("reconciles a returned activation ID without dispatching the activation again", async () => {
  const f = await fixture();
  const activate = f.deps.activateWorker.bind(f.deps);
  f.deps.activateWorker = async (...args) => {
    await activate(...args);
    throw Object.assign(Error(), { kind: "ambiguous" });
  };
  const previous = await runProductionRelease(f.input, f.deps);
  expect(previous.journal.at(-1)?.value.deploymentId).toBe("new-worker");
  const resumed = await runProductionRelease(
    { ...f.input, previous, currentRunId: 2, reportDirectory: join(f.root, "resume") },
    f.deps,
  );
  expect(resumed.outcome).toBe("passed");
  expect(resumed.originalRunId).toBe(1);
  expect(resumed.runIds).toEqual([1, 2]);
  expect(f.calls.filter((call) => call === "activate")).toHaveLength(1);
  expect(f.calls).toContain("reconcile:activate-worker");
});
it("attributes retained verification failure to inspection after reconciliation", async () => {
  const f = await fixture();
  const activate = f.deps.activateWorker.bind(f.deps);
  f.deps.activateWorker = async (...args) => {
    await activate(...args);
    throw Object.assign(Error(), { kind: "ambiguous" });
  };
  const previous = await runProductionRelease(f.input, f.deps);
  f.deps.verifyRetained = async () => {
    throw Error("Live artifact differs");
  };
  const resumed = await runProductionRelease(
    { ...f.input, previous, currentRunId: 2, reportDirectory: join(f.root, "resume") },
    f.deps,
  );
  expect(resumed.stages["activate-worker"]).toBe("passed");
  expect(resumed.stages.inspect).toBe("failed");
  expect(resumed.failure?.stage).toBe("inspect");
  expect(f.calls.filter((call) => call === "activate")).toHaveLength(1);
});
it("blocks ambiguous reconciliation rather than uploading a duplicate", async () => {
  const f = await fixture();
  f.deps.uploadWorker = async () => {
    f.calls.push("upload");
    throw Object.assign(Error(), { kind: "ambiguous" });
  };
  const previous = await runProductionRelease(f.input, f.deps);
  const resumed = await runProductionRelease(
    { ...f.input, previous, currentRunId: 2, reportDirectory: join(f.root, "resume") },
    f.deps,
  );
  expect(resumed.outcome).toBe("blocked");
  expect(f.calls.filter((call) => call === "upload")).toHaveLength(1);
});
it("rejects changed source and artifacts before provider calls", async () => {
  const f = await fixture();
  const previous = await runProductionRelease(f.input, f.deps);
  f.calls.length = 0;
  const prepared = structuredClone(f.input.prepared);
  prepared.artifacts.netlify.sha256 = "f".repeat(64);
  await expect(
    runProductionRelease(
      { ...f.input, prepared, previous, currentRunId: 2, reportDirectory: join(f.root, "resume") },
      f.deps,
    ),
  ).rejects.toThrow("Prior evidence");
  expect(f.calls).toEqual([]);
});
it("blocks publication when the live Worker changes after transition smoke", async () => {
  const f = await fixture();
  f.deps.verifyTransition = async () => {
    f.setPair({
      netlifyDeployId: "old-app",
      workerDeploymentId: "other-worker",
      workerVersionId: "other-version",
    });
    return true;
  };
  const result = await runProductionRelease(f.input, f.deps);
  expect(result.outcome).toBe("failed");
  expect(f.calls).not.toContain("publish");
});

it("rejects a retained service stage made pending in prior evidence", async () => {
  const f = await fixture(false, false);
  const previous = await runProductionRelease(f.input, f.deps);
  previous.stages["hold-netlify"] = "pending";
  await expect(
    runProductionRelease(
      { ...f.input, previous, currentRunId: 2, reportDirectory: join(f.root, "resume") },
      f.deps,
    ),
  ).rejects.toThrow("Incomplete prior evidence");
  expect(f.calls).toEqual([]);
});
it("rejects an activation result substituted from another upload", async () => {
  const f = await fixture();
  const previous = await runProductionRelease(f.input, f.deps);
  previous.results.activatedWorker!.versionId = "different-version";
  f.calls.length = 0;
  await expect(
    runProductionRelease(
      { ...f.input, previous, currentRunId: 2, reportDirectory: join(f.root, "resume") },
      f.deps,
    ),
  ).rejects.toThrow("Activated Worker differs");
  expect(f.calls).toEqual([]);
});

it("blocks retained provider IDs whose live artifact identity cannot be verified", async () => {
  const f = await fixture();
  const previous = await runProductionRelease(f.input, f.deps);
  f.calls.length = 0;
  f.deps.verifyRetained = async () => {
    throw Error("Live artifact differs");
  };
  const result = await runProductionRelease(
    { ...f.input, previous, currentRunId: 2, reportDirectory: join(f.root, "resume") },
    f.deps,
  );
  expect(result.outcome).toBe("failed");
  expect(f.calls).toEqual([]);
});

it("retains resumable state before the credentialed provider factory can fail", async () => {
  const f = await fixture();
  let calls = 0;
  const dependencies = lazyProductionDependencies(async () => {
    calls++;
    throw Error("Provider unavailable");
  });
  const previous = await runProductionRelease(f.input, dependencies);
  expect(previous.stages.inspect).toBe("failed");
  expect(calls).toBe(1);
  const resumed = await runProductionRelease(
    { ...f.input, previous, currentRunId: 2, reportDirectory: join(f.root, "resume") },
    f.deps,
  );
  expect(resumed.outcome).toBe("passed");
});
