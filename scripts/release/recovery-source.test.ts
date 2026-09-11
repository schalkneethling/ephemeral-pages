import { expect, it } from "vitest";
import { artifactHash } from "./artifact-contract.ts";
import { approvalBytes } from "./production-approval.ts";
import { approvalSchema, productionRecordSchema, productionSteps } from "./production-record.ts";
import { preparedReleaseSchema } from "./prepare.ts";
import { releaseConfigSchema } from "./schema.ts";
import { verifyRecoverySourceRecords } from "./recovery-source.ts";
import { validateRecoveryTarget, recoveryTargetSchema } from "./recovery-target.ts";
import configJson from "./environments.json";
const configuration = releaseConfigSchema.parse(configJson);
const configHash = artifactHash(JSON.stringify(configuration));
function fixture() {
  const approval = approvalSchema.parse({
    schemaVersion: 1,
    operation: "release-approval",
    candidate: "a".repeat(40),
    tree: "b".repeat(40),
    configurationFingerprint: configHash,
    stagingPreparationSha256: "c".repeat(64),
    stagingRehearsalSha256: "d".repeat(64),
    affected: { netlify: true, cloudflare: true },
    compatibility: "compatible",
    migration: { artifactTag: "v1", expectedCurrentTag: "v1", change: "none" },
    recoveryOrder: ["netlify", "cloudflare"],
    baseline: {
      version: 1,
      environment: "production",
      providers: {
        netlify: {
          siteId: "site",
          sourceCommit: "e".repeat(40),
          publishedDeployId: "old-app",
          publishLocked: true,
        },
        cloudflare: {
          accountId: "account",
          workerName: "worker",
          sourceCommit: "f".repeat(40),
          deploymentId: "old-worker",
          traffic: [{ versionId: "old-version", percentage: 100 }],
        },
      },
    },
  });
  const prepared = preparedReleaseSchema.parse({
    schemaVersion: 1,
    operation: "prepare",
    outcome: "passed",
    source: {
      candidate: "c".repeat(40),
      tree: approval.tree,
      environment: "production",
      configurationFingerprint: "a".repeat(64),
    },
    toolchain: { bun: "1.3.14" },
    artifacts: {
      netlify: { directory: "netlify", sha256: "a".repeat(64) },
      worker: { directory: "worker", sha256: "b".repeat(64) },
    },
  });
  const source = productionRecordSchema.parse({
    schemaVersion: 1,
    operation: "production-release",
    approvalSha256: artifactHash(approvalBytes(approval)),
    preparationSha256: artifactHash(JSON.stringify(prepared)),
    candidate: approval.candidate,
    promotionCommit: prepared.source.candidate,
    tree: approval.tree,
    configurationFingerprint: configHash,
    originalRunId: 1,
    runIds: [1],
    createdAt: "2026-09-11T00:00:00.000Z",
    updatedAt: "2026-09-11T00:00:00.000Z",
    outcome: "blocked",
    priorPair: {
      netlifyDeployId: "old-app",
      workerDeploymentId: "old-worker",
      workerVersionId: "old-version",
    },
    stages: Object.fromEntries(productionSteps.map((step) => [step, "pending"])),
    results: {},
    journal: [],
    recovery: "none",
  });
  const target = recoveryTargetSchema.parse({
    schemaVersion: 1,
    operation: "recovery-target",
    configurationFingerprint: configHash,
    pair: source.priorPair,
    netlifySourceCommit: "e".repeat(40),
    workerSourceCommit: "f".repeat(40),
    workerArtifactRunId: 1,
    workerArtifactSha256: "d".repeat(64),
    workerScriptEtag: "a".repeat(32),
  });
  return { source, approval, prepared, target };
}
it("binds source approval, preparation and checked configuration", () => {
  const f = fixture();
  expect(() =>
    verifyRecoverySourceRecords(f.source, f.approval, f.prepared, configuration),
  ).not.toThrow();
  f.prepared.artifacts.worker.sha256 = "f".repeat(64);
  expect(() =>
    verifyRecoverySourceRecords(f.source, f.approval, f.prepared, configuration),
  ).toThrow("differs");
});
it("rejects recovery target substitution and configuration drift", () => {
  const f = fixture();
  expect(() => validateRecoveryTarget(f.target, f.source, f.approval)).not.toThrow();
  expect(() =>
    validateRecoveryTarget(
      { ...f.target, pair: { ...f.target.pair, workerVersionId: "other" } },
      f.source,
      f.approval,
    ),
  ).toThrow("differs");
  expect(() =>
    validateRecoveryTarget(
      { ...f.target, configurationFingerprint: "0".repeat(64) },
      f.source,
      f.approval,
    ),
  ).toThrow("differs");
});

it.each([[2], [1, 1], [1, 3, 2]])("rejects malformed production run lineage %j", (...runIds) => {
  const f = fixture();
  f.source.runIds = runIds;
  expect(() =>
    verifyRecoverySourceRecords(f.source, f.approval, f.prepared, configuration),
  ).toThrow("differs");
});
