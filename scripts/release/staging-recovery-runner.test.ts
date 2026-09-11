import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";

import { artifactConfigurationFingerprint, artifactHash } from "./artifact-contract.ts";
import type { PreparedRelease } from "./prepare.ts";
import type { ReleaseConfig } from "./schema.ts";
import {
  runStagingRecovery,
  type StagingRecoveryDependencies,
  type StagingRecoveryRunInput,
} from "./staging-recovery-runner.ts";
import type { StagingRecoverySource, StagingReleaseEvidence } from "./staging-recovery-source.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const configuration: ReleaseConfig = {
  version: 1,
  integrationBranch: "stage",
  environments: {
    staging: {
      netlify: {
        siteId: "staging-site",
        accountId: "netlify-account",
        expectedNonSecretVariables: { PUBLIC_BASE_URL: "https://staging.example.com" },
        requiredSecretNames: ["STAGE_SECRET"],
        requiredVariableScopes: {
          PUBLIC_BASE_URL: ["builds"],
          STAGE_SECRET: ["functions"],
        },
      },
      cloudflare: {
        accountId: "worker-account",
        workerName: "staging-worker",
        wranglerEnvironment: "staging",
        wranglerConfigPath: "collaboration-worker/wrangler.jsonc",
        expectedNonSecretVariables: { PUBLIC_WORKER_ORIGIN: "https://worker.example.com" },
        requiredSecretNames: ["WORKER_SECRET"],
      },
    },
    production: {
      netlify: {
        siteId: "production-site",
        accountId: "netlify-account",
        expectedNonSecretVariables: { PUBLIC_BASE_URL: "https://example.com" },
        requiredSecretNames: ["PRODUCTION_SECRET"],
        requiredVariableScopes: {
          PUBLIC_BASE_URL: ["builds"],
          PRODUCTION_SECRET: ["functions"],
        },
      },
      cloudflare: {
        accountId: "worker-account",
        workerName: "production-worker",
        wranglerEnvironment: "production",
        wranglerConfigPath: "collaboration-worker/wrangler.jsonc",
        expectedNonSecretVariables: { PUBLIC_WORKER_ORIGIN: "https://prod-worker.example.com" },
        requiredSecretNames: ["WORKER_SECRET"],
      },
    },
  },
};
const workerConfig = "{ name: 'staging-worker' }";
const configurationFingerprint = artifactConfigurationFingerprint(
  configuration.environments.staging,
  workerConfig,
);

const pair = (prefix: string) => ({
  netlifyDeployId: `${prefix}-app`,
  workerDeploymentId: `${prefix}-worker-deployment`,
  workerVersionId: `${prefix}-worker-version`,
});

const release = (
  prefix: string,
  candidate: string,
  runId: number,
  priorPair: ReturnType<typeof pair>,
): StagingReleaseEvidence => {
  const observedPair = pair(prefix);
  const prepared: PreparedRelease = {
    schemaVersion: 1,
    operation: "prepare",
    outcome: "passed",
    source: {
      candidate,
      tree: prefix.repeat(40).slice(0, 40),
      environment: "staging",
      configurationFingerprint,
    },
    toolchain: { bun: "1.3.14" },
    artifacts: {
      netlify: { directory: "netlify", sha256: "d".repeat(64) },
      worker: { directory: "worker", sha256: "e".repeat(64) },
    },
  };
  return {
    workflow: {
      artifactDigest: `sha256:${prefix.repeat(64).slice(0, 64)}`,
      artifactName: "release-rehearsal-diagnostics",
      runId,
      sizeInBytes: 1_024,
      workflowCommit: candidate,
    },
    prepared,
    rehearsal: {
      schemaVersion: 1,
      operation: "rehearse",
      outcome: "passed",
      source: prepared.source,
      preparationSha256: artifactHash(JSON.stringify(prepared)),
      priorPair,
      observedPair,
      activatedWorker: {
        deploymentId: observedPair.workerDeploymentId,
        versionId: observedPair.workerVersionId,
      },
      publishedNetlify: { publishedDeployId: observedPair.netlifyDeployId },
      stages: {
        inspect: "passed",
        "hold-netlify": "passed",
        "upload-worker": "passed",
        "activate-worker": "passed",
        "observe-worker": "passed",
        "verify-transition": "passed",
        "prepublish-check": "passed",
        "publish-netlify": "passed",
        "observe-netlify": "passed",
        "verify-pair": "passed",
      },
      recovery: "none",
    },
    provider: {
      netlify: {
        artifactSha256: prepared.artifacts.netlify.sha256,
        deployId: observedPair.netlifyDeployId,
        siteId: "staging-site",
      },
      worker: {
        accountId: "worker-account",
        artifactManifestSha256: prepared.artifacts.worker.sha256,
        deploymentId: observedPair.workerDeploymentId,
        scriptEtag: prefix.repeat(64).slice(0, 64),
        versionId: observedPair.workerVersionId,
        workerName: "staging-worker",
      },
    },
  };
};

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "staging-recovery-runner-"));
  roots.push(root);
  await mkdir(join(root, "repo"));
  const target = release("a", "a".repeat(40), 10, pair("older"));
  const source = release("b", "b".repeat(40), 20, target.rehearsal.observedPair);
  const recoverySource: StagingRecoverySource = {
    schemaVersion: 1,
    operation: "staging-recovery-source",
    configurationSha256: artifactHash(JSON.stringify(configuration)),
    source,
    target,
  };
  let livePair = { ...source.rehearsal.observedPair };
  const calls: string[] = [];
  const input: StagingRecoveryRunInput = {
    configuration,
    currentRunId: 30,
    recoveryPlanSha256: "f".repeat(64),
    reportDirectory: join(root, "run"),
    repositoryRoot: join(root, "repo"),
    source: recoverySource,
    workerConfig,
  };
  const dependencies: StagingRecoveryDependencies = {
    inspect: async () => ({ ...livePair }),
    verifyTargets: async () => {
      calls.push("verify-targets");
      return {
        inspectionVersion: 2,
        inspectionSha256: "f".repeat(64),
        requested: target.rehearsal.observedPair,
        expectedCurrent: source.rehearsal.observedPair,
        netlifyIdentity: "release-artifact",
        netlifyVariablesVerified: true,
        workerArtifactSha256: target.prepared.artifacts.worker.sha256,
        workerMigrationTag: "v1",
        workerScriptEtag: target.provider.worker.scriptEtag,
        workerSecretBindingNames: ["WORKER_SECRET"],
        workerSecretValuesObservable: false,
      };
    },
    restoreNetlify: async (checkpoint) => {
      calls.push("restore-netlify");
      await checkpoint({
        operation: "restoreSiteDeploy",
        phase: "pending-mutation",
        deployId: target.rehearsal.observedPair.netlifyDeployId,
      });
      livePair.netlifyDeployId = target.rehearsal.observedPair.netlifyDeployId;
      await checkpoint({
        operation: "restoreSiteDeploy",
        phase: "mutation-response-received",
        deployId: livePair.netlifyDeployId,
        publishedDeployId: livePair.netlifyDeployId,
      });
      return { publishedDeployId: livePair.netlifyDeployId };
    },
    verifyTransition: async () => {
      calls.push("verify-transition");
      expect(livePair.netlifyDeployId).toBe(target.rehearsal.observedPair.netlifyDeployId);
      expect(livePair.workerVersionId).toBe(source.rehearsal.observedPair.workerVersionId);
      return true;
    },
    restoreWorker: async (checkpoint) => {
      calls.push("restore-worker");
      await checkpoint({
        phase: "pending-activation",
        versionId: target.rehearsal.observedPair.workerVersionId,
      });
      livePair = { ...target.rehearsal.observedPair, workerDeploymentId: "rollback-deployment" };
      await checkpoint({
        phase: "activation-response-received",
        deploymentId: livePair.workerDeploymentId,
        versionId: livePair.workerVersionId,
      });
      return {
        deploymentId: livePair.workerDeploymentId,
        versionId: livePair.workerVersionId,
      };
    },
    verifyPair: async () => {
      calls.push("verify-pair");
      return true;
    },
    reconcile: async (step) => {
      calls.push(`reconcile:${step}`);
      if (step === "restore-netlify") {
        livePair.netlifyDeployId = target.rehearsal.observedPair.netlifyDeployId;
        return { netlify: { publishedDeployId: livePair.netlifyDeployId } };
      }
      livePair = { ...target.rehearsal.observedPair, workerDeploymentId: "rollback-deployment" };
      return {
        worker: {
          deploymentId: livePair.workerDeploymentId,
          versionId: livePair.workerVersionId,
        },
      };
    },
  };
  return { calls, dependencies, input, root, source, target };
}

it("uses the production recovery order while retaining staging-specific lineage", async () => {
  const fixture_ = await fixture();
  const result = await runStagingRecovery(fixture_.input, fixture_.dependencies);
  expect(result.outcome).toBe("passed");
  expect(result.operation).toBe("staging-recovery");
  expect(result.environment).toBe("staging");
  expect(result.sourceRehearsalRunId).toBe(20);
  expect(result.targetRehearsalRunId).toBe(10);
  expect(fixture_.calls).toEqual([
    "verify-targets",
    "restore-netlify",
    "verify-transition",
    "restore-worker",
    "verify-pair",
  ]);
  expect(result.recoveredPair).toEqual({
    ...fixture_.target.rehearsal.observedPair,
    workerDeploymentId: "rollback-deployment",
  });
  expect(
    JSON.parse(
      await readFile(join(fixture_.input.reportDirectory, "staging-recovery.json"), "utf8"),
    ),
  ).toEqual(result);
});

it("preserves an ambiguous mutation checkpoint and reconciles without repeating it", async () => {
  const fixture_ = await fixture();
  fixture_.dependencies.restoreNetlify = async (checkpoint) => {
    fixture_.calls.push("restore-netlify-ambiguous");
    await checkpoint({
      operation: "restoreSiteDeploy",
      phase: "pending-mutation",
      deployId: fixture_.target.rehearsal.observedPair.netlifyDeployId,
    });
    throw Object.assign(new Error("raw provider response"), { kind: "ambiguous" });
  };
  const blocked = await runStagingRecovery(fixture_.input, fixture_.dependencies);
  expect(blocked.outcome).toBe("blocked");
  expect(blocked.stages["restore-netlify"]).toBe("blocked");
  expect(blocked.journal).toHaveLength(1);
  expect(JSON.stringify(blocked)).not.toContain("raw provider response");

  fixture_.calls.length = 0;
  const resumed = await runStagingRecovery(
    {
      ...fixture_.input,
      currentRunId: 31,
      previous: blocked,
      reportDirectory: join(fixture_.root, "resume"),
    },
    fixture_.dependencies,
  );
  expect(resumed.outcome).toBe("passed");
  expect(fixture_.calls).toContain("reconcile:restore-netlify");
  expect(fixture_.calls).not.toContain("restore-netlify-ambiguous");
  expect(resumed.recoveryRunIds).toEqual([30, 31]);
});

it("migrates path-bound staging evidence before the first Worker write", async () => {
  const fixture_ = await fixture();
  fixture_.dependencies.verifyTransition = async () => {
    fixture_.calls.push("verify-transition");
    return false;
  };
  const blocked = await runStagingRecovery(fixture_.input, fixture_.dependencies);
  expect(blocked.stages["restore-netlify"]).toBe("passed");
  expect(blocked.stages["restore-worker"]).toBe("pending");
  const legacy = structuredClone(blocked);
  delete legacy.targetEvidence!.inspectionVersion;
  legacy.targetEvidence!.inspectionSha256 = "a".repeat(64);
  fixture_.calls.length = 0;
  fixture_.dependencies.verifyTransition = async () => {
    fixture_.calls.push("verify-transition");
    return true;
  };

  const resumed = await runStagingRecovery(
    {
      ...fixture_.input,
      currentRunId: 31,
      previous: legacy,
      reportDirectory: join(fixture_.root, "resume-portable"),
    },
    fixture_.dependencies,
  );

  expect(resumed.outcome).toBe("passed");
  expect(resumed.targetEvidence).toMatchObject({
    inspectionVersion: 2,
    inspectionSha256: "f".repeat(64),
  });
  expect(fixture_.calls.indexOf("verify-targets")).toBeLessThan(
    fixture_.calls.indexOf("restore-worker"),
  );
});

it("blocks legacy evidence after a Worker write has started", async () => {
  const fixture_ = await fixture();
  fixture_.dependencies.verifyTransition = async () => false;
  const blocked = await runStagingRecovery(fixture_.input, fixture_.dependencies);
  const legacy = structuredClone(blocked);
  delete legacy.targetEvidence!.inspectionVersion;
  legacy.journal.push({
    step: "restore-worker",
    value: {
      phase: "pending-activation",
      versionId: fixture_.target.rehearsal.observedPair.workerVersionId,
    },
  });

  const result = await runStagingRecovery(
    {
      ...fixture_.input,
      currentRunId: 31,
      previous: legacy,
      reportDirectory: join(fixture_.root, "unsafe-legacy"),
    },
    fixture_.dependencies,
  );

  expect(result.outcome).toBe("blocked");
  expect(result.failure).toEqual({ kind: "unknown", stage: "inspect" });
});

it("blocks changed source or configuration on resume before provider work", async () => {
  const fixture_ = await fixture();
  fixture_.dependencies.verifyPair = async () => false;
  const blocked = await runStagingRecovery(fixture_.input, fixture_.dependencies);
  fixture_.calls.length = 0;
  const changed = structuredClone(fixture_.input.configuration);
  changed.integrationBranch = "different-stage";
  await expect(
    runStagingRecovery(
      {
        ...fixture_.input,
        configuration: changed,
        currentRunId: 31,
        previous: blocked,
        reportDirectory: join(fixture_.root, "resume"),
      },
      fixture_.dependencies,
    ),
  ).rejects.toThrow("configuration differs");
  expect(fixture_.calls).toEqual([]);
});

it("requires fresh and resumed recovery runs to be strictly later", async () => {
  const fixture_ = await fixture();
  await expect(
    runStagingRecovery(
      { ...fixture_.input, currentRunId: fixture_.source.workflow.runId },
      fixture_.dependencies,
    ),
  ).rejects.toThrow("run lineage differs");
  expect(fixture_.calls).toEqual([]);

  fixture_.dependencies.verifyPair = async () => false;
  const blocked = await runStagingRecovery(fixture_.input, fixture_.dependencies);
  fixture_.calls.length = 0;
  await expect(
    runStagingRecovery(
      {
        ...fixture_.input,
        currentRunId: fixture_.input.currentRunId - 1,
        previous: blocked,
        reportDirectory: join(fixture_.root, "resume"),
      },
      fixture_.dependencies,
    ),
  ).rejects.toThrow("evidence differs");
  expect(fixture_.calls).toEqual([]);
});

it("blocks a mismatched target inspection before either restore", async () => {
  const fixture_ = await fixture();
  fixture_.dependencies.verifyTargets = async () => ({
    inspectionSha256: "f".repeat(64),
    requested: pair("substitute"),
    expectedCurrent: fixture_.source.rehearsal.observedPair,
    netlifyIdentity: "release-artifact",
    netlifyVariablesVerified: true,
    workerArtifactSha256: fixture_.target.prepared.artifacts.worker.sha256,
    workerMigrationTag: "v1",
    workerScriptEtag: fixture_.target.provider.worker.scriptEtag,
    workerSecretBindingNames: ["WORKER_SECRET"],
    workerSecretValuesObservable: false,
  });
  const result = await runStagingRecovery(fixture_.input, fixture_.dependencies);
  expect(result.outcome).toBe("blocked");
  expect(result.stages.inspect).toBe("blocked");
  expect(fixture_.calls).toEqual([]);
});
