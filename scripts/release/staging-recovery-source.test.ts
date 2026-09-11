import { expect, it } from "vitest";

import { artifactConfigurationFingerprint, artifactHash } from "./artifact-contract.ts";
import type { PreparedRelease } from "./prepare.ts";
import type { ReleaseConfig } from "./schema.ts";
import {
  stagingRecoverySourceSchema,
  validateStagingRecoverySource,
  type StagingRecoverySource,
  type StagingReleaseEvidence,
} from "./staging-recovery-source.ts";

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

const fixture = (): StagingRecoverySource => {
  const target = release("a", "a".repeat(40), 10, pair("before-target"));
  const source = release("b", "b".repeat(40), 20, target.rehearsal.observedPair);
  return {
    schemaVersion: 1,
    operation: "staging-recovery-source",
    configurationSha256: artifactHash(JSON.stringify(configuration)),
    source,
    target,
  };
};

it("binds two protected staging releases and derives the exact recovery pair", () => {
  const source = fixture();
  const validated = validateStagingRecoverySource(source, configuration, workerConfig);
  expect(validated.startingPair).toEqual(source.source.rehearsal.observedPair);
  expect(validated.targetPair).toEqual(source.target.rehearsal.observedPair);
  expect(validated.sourceRehearsalSha256).toBe(
    artifactHash(JSON.stringify(source.source.rehearsal)),
  );
});

it("rejects changed artifact and provider evidence", () => {
  const changedArtifact = structuredClone(fixture());
  changedArtifact.target.provider.worker.artifactManifestSha256 = "f".repeat(64);
  expect(() => stagingRecoverySourceSchema.parse(changedArtifact)).toThrow();

  const changedPair = structuredClone(fixture());
  changedPair.source.rehearsal.priorPair.workerVersionId = "substitute-version";
  expect(() => stagingRecoverySourceSchema.parse(changedPair)).toThrow();
});

it("rejects production targets and non-distinct recovery releases", () => {
  const productionTarget = structuredClone(fixture());
  productionTarget.target.provider.netlify.siteId = "production-site";
  expect(() =>
    validateStagingRecoverySource(productionTarget, configuration, workerConfig),
  ).toThrow("provider targets");

  const sameRelease = structuredClone(fixture());
  sameRelease.source.workflow.runId = sameRelease.target.workflow.runId;
  sameRelease.source.prepared.source.candidate = sameRelease.target.prepared.source.candidate;
  expect(() => stagingRecoverySourceSchema.parse(sameRelease)).toThrow();

  const reversedRuns = structuredClone(fixture());
  reversedRuns.source.workflow.runId = reversedRuns.target.workflow.runId - 1;
  expect(() => stagingRecoverySourceSchema.parse(reversedRuns)).toThrow();
});

it("binds the checked-in release configuration", () => {
  const source = fixture();
  source.configurationSha256 = "f".repeat(64);
  expect(() => validateStagingRecoverySource(source, configuration, workerConfig)).toThrow(
    "configuration differs",
  );
});

it("rejects staging artifacts prepared from a different Worker configuration", () => {
  expect(() =>
    validateStagingRecoverySource(fixture(), configuration, "{ name: 'changed-worker' }"),
  ).toThrow("artifact configuration differs");
});

it("does not accept a production preparation or arbitrary fields", () => {
  const production = structuredClone(fixture()) as unknown as Record<string, unknown>;
  const target = production.target as StagingReleaseEvidence;
  target.prepared.source.environment = "production";
  target.rehearsal.source.environment = "production";
  expect(() => stagingRecoverySourceSchema.parse(production)).toThrow();

  expect(() => stagingRecoverySourceSchema.parse({ ...fixture(), approved: true })).toThrow();
});
