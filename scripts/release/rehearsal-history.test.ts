import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { artifactHash } from "./artifact-contract.ts";
import {
  GITHUB_RELEASE_WORKFLOWS,
  type GitHubApiRequest,
  type GitHubReleaseApi,
  type VerifiedStagingInvocation,
} from "./github-release.ts";
import { configurationFingerprint } from "./planner.ts";
import {
  type RehearsalHistoryDependencies,
  rehearsalResolutionSchema,
  stagingRehearsalFinalPairRecordSchema,
  stagingRehearsalRecoveryRecordSchema,
  stagingWorkerResolutionAuditSchema,
  verifyRehearsalHistory,
} from "./rehearsal-history.ts";
import { releaseConfigSchema } from "./schema.ts";

const repositoryPath = "/repos/schalkneethling/ephemeral-pages";
const workflowPath = `${repositoryPath}/actions/workflows/release-rehearsal.yml`;
const runsPath = `${workflowPath}/runs`;
const sha = "a".repeat(40);
const digest = (character: string) => character.repeat(64);
const now = new Date("2026-09-12T12:00:00.000Z");
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const api = (handler: (request: GitHubApiRequest) => unknown): GitHubReleaseApi => ({
  get: async (request) => handler(request),
});

const current: VerifiedStagingInvocation = {
  runId: 300,
  runAttempt: 1,
  workflowId: 10,
  workflowPath: GITHUB_RELEASE_WORKFLOWS.rehearsal,
  branch: "stage",
  headSha: sha,
  createdAt: "2026-09-12T11:00:00Z",
  updatedAt: "2026-09-12T11:01:00Z",
  environment: { name: "staging", branch: "stage", policyId: 90 },
};

const run = (
  id: number,
  input: {
    conclusion?: string | null;
    status?: string;
    createdAt: string;
    updatedAt?: string;
    headSha?: string;
  },
) => ({
  id,
  run_attempt: 1,
  event: "workflow_dispatch",
  status: input.status ?? "completed",
  conclusion: input.conclusion === undefined ? "failure" : input.conclusion,
  head_branch: "stage",
  head_sha: input.headSha ?? sha,
  path: GITHUB_RELEASE_WORKFLOWS.rehearsal,
  workflow_id: 10,
  created_at: input.createdAt,
  updated_at: input.updatedAt ?? input.createdAt,
  repository: { full_name: "schalkneethling/ephemeral-pages" },
});

const currentRun = () =>
  run(300, {
    status: "in_progress",
    conclusion: null,
    createdAt: current.createdAt,
    updatedAt: current.updatedAt,
  });

const job = (input: {
  preflight?: "success" | "failure" | "skipped";
  rehearsal?: "success" | "failure" | "skipped";
  diagnostics?: "success" | "failure" | "skipped";
  conclusion?: "success" | "failure" | "skipped";
}) => ({
  id: 800,
  name: "Staging release rehearsal",
  head_sha: sha,
  status: "completed",
  conclusion: input.conclusion ?? "success",
  steps: [
    {
      name: "Establish rehearsal pre-mutation checkpoint",
      status: "completed",
      conclusion: input.preflight ?? "success",
      number: 5,
    },
    {
      name: "Rehearse the staging release",
      status: "completed",
      conclusion: input.rehearsal ?? "success",
      number: 6,
    },
    {
      name: "Retain sanitized rehearsal diagnostics",
      status: "completed",
      conclusion: input.diagnostics ?? "success",
      number: 8,
    },
  ],
});
const ranFailedJob = () =>
  job({ conclusion: "failure", preflight: "success", rehearsal: "failure" });

const artifact = (runId: number, input: { expired?: boolean; digest?: string } = {}) => ({
  id: 900 + runId,
  name: "release-rehearsal-diagnostics",
  size_in_bytes: 1024,
  expired: input.expired ?? false,
  created_at: "2026-09-12T10:01:00Z",
  updated_at: "2026-09-12T10:02:00Z",
  expires_at: "2026-09-19T10:02:00Z",
  digest: input.digest ?? `sha256:${digest("b")}`,
  workflow_run: { id: runId, head_branch: "stage", head_sha: sha },
});

const successfulClient = (
  priorJob: unknown,
  currentUpdatedAt = current.updatedAt,
): GitHubReleaseApi =>
  api(({ path }) => {
    if (path === workflowPath)
      return { id: 10, path: GITHUB_RELEASE_WORKFLOWS.rehearsal, state: "active" };
    if (path === runsPath)
      return {
        total_count: 2,
        workflow_runs: [
          { ...currentRun(), updated_at: currentUpdatedAt },
          run(299, { conclusion: "success", createdAt: "2026-09-12T10:00:00Z" }),
        ],
      };
    if (path.endsWith("/actions/runs/299/attempts/1/jobs"))
      return { total_count: 1, jobs: [priorJob] };
    throw new Error(`unexpected ${path}`);
  });

const inertDependencies = (): RehearsalHistoryDependencies => ({
  downloadArtifact: vi.fn(async () => new Uint8Array([1])),
  extractArtifact: vi.fn(async () => undefined),
  inspectCurrentPair: vi.fn(async () => ({
    netlifyDeployId: "netlify-current",
    workerDeploymentId: "worker-current",
    workerVersionId: "version-current",
  })),
});

const input = (repositoryRoot = "/tmp/rehearsal-history-unused") => ({
  current,
  token: "token",
  repositoryRoot,
  now,
});

describe("rehearsal GitHub history", () => {
  it("accepts a terminal successful job without requiring its expired diagnostics archive", async () => {
    const dependencies = inertDependencies();
    await expect(
      verifyRehearsalHistory(successfulClient(job({})), input(), dependencies),
    ).resolves.toEqual({
      resolvedBy: "successful-run",
      runId: 299,
      skippedReadOnlyRunIds: [],
    });
    expect(dependencies.downloadArtifact).not.toHaveBeenCalled();
  });

  it("does not bind the active run to a mutable GitHub updated timestamp", async () => {
    await expect(
      verifyRehearsalHistory(
        successfulClient(job({}), "2026-09-12T11:02:00Z"),
        input(),
        inertDependencies(),
      ),
    ).resolves.toMatchObject({ resolvedBy: "successful-run", runId: 299 });
  });

  it.each([
    job({ rehearsal: "skipped" }),
    job({ diagnostics: "failure" }),
    { ...job({}), conclusion: "skipped" },
    { ...job({}), name: "Foreign job" },
  ])(
    "rejects a top-level success without the exact successful critical job and steps",
    async (value) => {
      await expect(
        verifyRehearsalHistory(successfulClient(value), input(), inertDependencies()),
      ).rejects.toThrow();
    },
  );

  it("skips a proven read-only failure and finds the older successful terminal run", async () => {
    const root = await mkdtemp(join(tmpdir(), "rehearsal-history-read-only-"));
    roots.push(root);
    const report = {
      schemaVersion: 1,
      operation: "rehearse",
      outcome: "blocked",
      source: {
        candidate: sha,
        tree: "c".repeat(40),
        environment: "staging",
        configurationFingerprint: digest("d"),
      },
      preparationSha256: digest("e"),
      stages: { inspect: "blocked" },
      failure: { stage: "inspect", kind: "failed" },
      recovery: "none",
    };
    const dependencies = inertDependencies();
    const inspectCurrentPair = dependencies.inspectCurrentPair;
    dependencies.extractArtifact = vi.fn(async (_archive, directory) => {
      await mkdir(resolve(directory, "reports"), { recursive: true });
      await writeFile(resolve(directory, "reports/rehearsal.json"), `${JSON.stringify(report)}\n`);
    });
    const client = api(({ path }) => {
      if (path === workflowPath)
        return { id: 10, path: GITHUB_RELEASE_WORKFLOWS.rehearsal, state: "active" };
      if (path === runsPath)
        return {
          total_count: 3,
          workflow_runs: [
            currentRun(),
            run(299, { createdAt: "2026-09-12T10:00:00Z" }),
            run(298, { conclusion: "success", createdAt: "2026-09-12T09:00:00Z" }),
          ],
        };
      if (path.endsWith("/actions/runs/299/attempts/1/jobs"))
        return { total_count: 1, jobs: [ranFailedJob()] };
      if (path.endsWith("/actions/runs/299/artifacts"))
        return { total_count: 1, artifacts: [artifact(299)] };
      if (path.endsWith("/actions/runs/298/attempts/1/jobs"))
        return { total_count: 1, jobs: [job({})] };
      throw new Error(`unexpected ${path}`);
    });
    await expect(verifyRehearsalHistory(client, input(root), dependencies)).resolves.toEqual({
      resolvedBy: "successful-run",
      runId: 298,
      skippedReadOnlyRunIds: [299],
    });
    expect(inspectCurrentPair).not.toHaveBeenCalled();
  });

  it("accepts a strict passed report when later workflow retention failed", async () => {
    const root = await mkdtemp(join(tmpdir(), "rehearsal-history-passed-report-"));
    roots.push(root);
    const pair = {
      netlifyDeployId: "netlify-new",
      workerDeploymentId: "worker-new",
      workerVersionId: "version-new",
    };
    const report = {
      schemaVersion: 1,
      operation: "rehearse",
      outcome: "passed",
      source: {
        candidate: sha,
        tree: "c".repeat(40),
        environment: "staging",
        configurationFingerprint: digest("d"),
      },
      preparationSha256: digest("e"),
      priorPair: {
        netlifyDeployId: "netlify-old",
        workerDeploymentId: "worker-old",
        workerVersionId: "version-old",
      },
      observedPair: pair,
      activatedWorker: {
        deploymentId: pair.workerDeploymentId,
        versionId: pair.workerVersionId,
      },
      publishedNetlify: { publishedDeployId: pair.netlifyDeployId },
      stages: Object.fromEntries(
        [
          "inspect",
          "hold-netlify",
          "upload-worker",
          "activate-worker",
          "observe-worker",
          "verify-transition",
          "prepublish-check",
          "publish-netlify",
          "observe-netlify",
          "verify-pair",
        ].map((name) => [name, "passed"]),
      ),
      recovery: "none",
    };
    const dependencies = inertDependencies();
    dependencies.extractArtifact = vi.fn(async (_archive, directory) => {
      await mkdir(resolve(directory, "reports"), { recursive: true });
      await writeFile(resolve(directory, "reports/rehearsal.json"), `${JSON.stringify(report)}\n`);
    });
    const client = api(({ path }) => {
      if (path === workflowPath)
        return { id: 10, path: GITHUB_RELEASE_WORKFLOWS.rehearsal, state: "active" };
      if (path === runsPath)
        return {
          total_count: 2,
          workflow_runs: [currentRun(), run(299, { createdAt: "2026-09-12T10:00:00Z" })],
        };
      if (path.endsWith("/actions/runs/299/attempts/1/jobs"))
        return { total_count: 1, jobs: [ranFailedJob()] };
      if (path.endsWith("/actions/runs/299/artifacts"))
        return { total_count: 1, artifacts: [artifact(299)] };
      throw new Error(`unexpected ${path}`);
    });
    await expect(verifyRehearsalHistory(client, input(root), dependencies)).resolves.toEqual({
      resolvedBy: "passed-report",
      runId: 299,
      skippedReadOnlyRunIds: [],
    });
  });

  it("blocks preflight-only diagnostics when the credentialed rehearsal step ran", async () => {
    const root = await mkdtemp(join(tmpdir(), "rehearsal-history-preflight-only-"));
    roots.push(root);
    const dependencies = inertDependencies();
    const inspectCurrentPair = dependencies.inspectCurrentPair;
    dependencies.extractArtifact = vi.fn(async (_archive, directory) => {
      await mkdir(resolve(directory, "preflight"), { recursive: true });
      await writeFile(
        resolve(directory, "preflight/rehearsal.json"),
        `${JSON.stringify({
          schemaVersion: 1,
          operation: "staging-rehearsal-preflight",
          runId: 299,
          workflowCommit: sha,
          calibrationOnly: true,
          preparationSha256: digest("e"),
          outcome: "passed",
        })}\n`,
      );
    });
    const client = api(({ path }) => {
      if (path === workflowPath)
        return { id: 10, path: GITHUB_RELEASE_WORKFLOWS.rehearsal, state: "active" };
      if (path === runsPath)
        return {
          total_count: 3,
          workflow_runs: [
            currentRun(),
            run(299, { createdAt: "2026-09-12T10:00:00Z" }),
            run(298, { conclusion: "success", createdAt: "2026-09-12T09:00:00Z" }),
          ],
        };
      if (path.endsWith("/actions/runs/299/attempts/1/jobs"))
        return { total_count: 1, jobs: [ranFailedJob()] };
      if (path.endsWith("/actions/runs/299/artifacts"))
        return { total_count: 1, artifacts: [artifact(299)] };
      throw new Error(`unexpected ${path}`);
    });
    await expect(verifyRehearsalHistory(client, input(root), dependencies)).rejects.toThrow();
    expect(inspectCurrentPair).not.toHaveBeenCalled();
  });

  it("uses the exact skipped credentialed step as read-only proof when no artifact exists", async () => {
    const dependencies = inertDependencies();
    const client = api(({ path }) => {
      if (path === workflowPath)
        return { id: 10, path: GITHUB_RELEASE_WORKFLOWS.rehearsal, state: "active" };
      if (path === runsPath)
        return {
          total_count: 3,
          workflow_runs: [
            currentRun(),
            run(299, { createdAt: "2026-09-12T10:00:00Z" }),
            run(298, { conclusion: "success", createdAt: "2026-09-12T09:00:00Z" }),
          ],
        };
      if (path.endsWith("/actions/runs/299/attempts/1/jobs"))
        return {
          total_count: 1,
          jobs: [
            job({
              conclusion: "failure",
              preflight: "failure",
              rehearsal: "skipped",
              diagnostics: "skipped",
            }),
          ],
        };
      if (path.endsWith("/actions/runs/298/attempts/1/jobs"))
        return { total_count: 1, jobs: [job({})] };
      throw new Error(`unexpected ${path}`);
    });
    await expect(verifyRehearsalHistory(client, input(), dependencies)).resolves.toEqual({
      resolvedBy: "successful-run",
      runId: 298,
      skippedReadOnlyRunIds: [299],
    });
    expect(dependencies.downloadArtifact).not.toHaveBeenCalled();
  });

  it("does not classify an inspection failure with provider checkpoints as read-only", async () => {
    const root = await mkdtemp(join(tmpdir(), "rehearsal-history-unsafe-read-"));
    roots.push(root);
    const report = {
      schemaVersion: 1,
      operation: "rehearse",
      outcome: "blocked",
      source: {
        candidate: sha,
        tree: "c".repeat(40),
        environment: "staging",
        configurationFingerprint: digest("d"),
      },
      preparationSha256: digest("e"),
      stages: { inspect: "blocked" },
      failure: { stage: "inspect", kind: "failed" },
      recovery: "none",
    };
    const dependencies = inertDependencies();
    dependencies.extractArtifact = vi.fn(async (_archive, directory) => {
      await mkdir(resolve(directory, "reports"), { recursive: true });
      await writeFile(resolve(directory, "reports/rehearsal.json"), `${JSON.stringify(report)}\n`);
      await writeFile(resolve(directory, "reports/provider-001.json"), "{}\n");
    });
    const client = api(({ path }) => {
      if (path === workflowPath)
        return { id: 10, path: GITHUB_RELEASE_WORKFLOWS.rehearsal, state: "active" };
      if (path === runsPath)
        return {
          total_count: 2,
          workflow_runs: [currentRun(), run(299, { createdAt: "2026-09-12T10:00:00Z" })],
        };
      if (path.endsWith("/actions/runs/299/attempts/1/jobs"))
        return { total_count: 1, jobs: [ranFailedJob()] };
      if (path.endsWith("/actions/runs/299/artifacts"))
        return { total_count: 1, artifacts: [artifact(299)] };
      throw new Error(`unexpected ${path}`);
    });
    await expect(verifyRehearsalHistory(client, input(root), dependencies)).rejects.toThrow();
  });

  it.each([
    { artifactValue: artifact(299, { expired: true }), label: "expired" },
    { artifactValue: undefined, label: "missing" },
  ])("blocks a $label failed-run diagnostics archive", async ({ artifactValue }) => {
    const client = api(({ path }) => {
      if (path === workflowPath)
        return { id: 10, path: GITHUB_RELEASE_WORKFLOWS.rehearsal, state: "active" };
      if (path === runsPath)
        return {
          total_count: 2,
          workflow_runs: [currentRun(), run(299, { createdAt: "2026-09-12T10:00:00Z" })],
        };
      if (path.endsWith("/actions/runs/299/attempts/1/jobs"))
        return { total_count: 1, jobs: [ranFailedJob()] };
      if (path.endsWith("/actions/runs/299/artifacts"))
        return artifactValue
          ? { total_count: 1, artifacts: [artifactValue] }
          : { total_count: 0, artifacts: [] };
      throw new Error(`unexpected ${path}`);
    });
    await expect(verifyRehearsalHistory(client, input(), inertDependencies())).rejects.toThrow();
  });
});

const smokeReport = (fingerprint: string) => ({
  schemaVersion: 1,
  operation: "collaboration-smoke",
  outcome: "passed",
  environment: "staging",
  configuration: { source: "default", fingerprint },
  checks: [
    "upload.collaboration",
    "roles.editor-viewer",
    "sync.two-editors-viewer",
    "persistence.reload",
    "recovery.network-loss",
    "capture.png",
  ].map((id) => ({ id, outcome: "passed", summary: "verified" })),
  usage: { uploads: 1, captureRequested: true, captureRequests: 1 },
});

async function resolvedFixture(pairMismatch?: "starting" | "target") {
  const root = await mkdtemp(join(tmpdir(), "rehearsal-history-resolution-"));
  roots.push(root);
  const configBytes = await readFile(new URL("./environments.json", import.meta.url));
  await mkdir(resolve(root, "scripts/release"), { recursive: true });
  await writeFile(resolve(root, "scripts/release/environments.json"), configBytes);
  const configuration = releaseConfigSchema.parse(JSON.parse(configBytes.toString("utf8")));
  const reportStartingPair = {
    netlifyDeployId: "netlify-a",
    workerDeploymentId: "worker-b",
    workerVersionId: "version-b",
  };
  const reportTargetPair = {
    netlifyDeployId: "netlify-a",
    workerDeploymentId: "worker-a",
    workerVersionId: "version-a",
  };
  const unresolved = {
    schemaVersion: 1,
    operation: "rehearse",
    outcome: "blocked",
    source: {
      candidate: sha,
      tree: "c".repeat(40),
      environment: "staging",
      configurationFingerprint: digest("d"),
    },
    preparationSha256: digest("e"),
    priorPair: reportTargetPair,
    observedPair: reportStartingPair,
    activatedWorker: {
      deploymentId: reportStartingPair.workerDeploymentId,
      versionId: reportStartingPair.workerVersionId,
    },
    stages: {
      inspect: "passed",
      "hold-netlify": "passed",
      "upload-worker": "passed",
      "activate-worker": "passed",
      "observe-worker": "passed",
      "verify-transition": "blocked",
    },
    failure: { stage: "verify-transition", kind: "unknown" },
    recovery: "inspect-recorded-targets-before-recovery",
  };
  const startingPair =
    pairMismatch === "starting"
      ? { ...reportStartingPair, workerDeploymentId: "worker-unrelated" }
      : reportStartingPair;
  const targetPair =
    pairMismatch === "target"
      ? { ...reportTargetPair, workerDeploymentId: "worker-unrelated" }
      : reportTargetPair;
  const recoveredPair = { ...targetPair, workerDeploymentId: "worker-recovered" };
  const rehearsalBytes = Buffer.from(`${JSON.stringify(unresolved)}\n`);
  const failedRehearsalSha256 = artifactHash(rehearsalBytes);
  const hashes = {
    metadata: digest("1"),
    targetPrepared: digest("2"),
    targetWorker: digest("3"),
    targetComplete: digest("4"),
    targetRehearsal: digest("5"),
    targetTransition: digest("6"),
    targetWorkerResult: digest("7"),
    failedPrepared: digest("8"),
    failedWorker: digest("9"),
    failedComplete: digest("a"),
    failedRehearsal: failedRehearsalSha256,
    failedTransition: digest("c"),
    failedWorkerResult: digest("d"),
  };
  const inspectionSha256 = digest("f");
  const workerResolution = {
    schemaVersion: 1,
    operation: "staging-worker-resolution",
    phase: "verified",
    metadataSha256: hashes.metadata,
    targetRunId: 250,
    failedRunId: 299,
    expectedCurrent: startingPair,
    requested: targetPair,
    recoveredPair,
    inspectionSha256,
    targetEvidence: {
      inspectionVersion: 2,
      inspectionSha256,
      requested: targetPair,
      expectedCurrent: startingPair,
      netlifyIdentity: "release-artifact",
      netlifyVariablesVerified: true,
      workerArtifactSha256: hashes.targetWorker,
      workerMigrationTag: "v1",
      workerScriptEtag: "f".repeat(64),
      workerSecretBindingNames: ["SESSION_SIGNING_KEY"],
      workerSecretValuesObservable: false,
    },
    artifactHashes: hashes,
    returnedDeploymentId: recoveredPair.workerDeploymentId,
    returnedVersionId: recoveredPair.workerVersionId,
  };
  const workerResolutionJson = `${JSON.stringify(workerResolution)}\n`;
  const smoke = smokeReport(configurationFingerprint(configuration));
  const smokeBytes = Buffer.from(`${JSON.stringify(smoke)}\n`);
  const recovery = stagingRehearsalRecoveryRecordSchema.parse({
    schemaVersion: 1,
    operation: "staging-rehearsal-recovery",
    environment: "staging",
    failedRunId: 299,
    failedDiagnosticsDigest: `sha256:${digest("b")}`,
    failedRehearsalSha256,
    configurationSha256: configurationFingerprint(configuration),
    resolutionRecordSha256: artifactHash(workerResolutionJson),
    workerResolutionJson,
    pairSmokeSha256: artifactHash(smokeBytes),
    startingPair,
    targetPair,
    observedPair: recoveredPair,
    recoveredPair,
    workerResolution,
    outcome: "passed",
    stages: { inspect: "passed", "restore-worker": "passed", "verify-pair": "passed" },
  });
  const recoveryBytes = Buffer.from(`${JSON.stringify(recovery)}\n`);
  const prefix = resolve(root, "docs/release-evidence/rehearsal-resolutions/299");
  await mkdir(resolve(prefix, ".."), { recursive: true });
  const resolution = rehearsalResolutionSchema.parse({
    schemaVersion: 1,
    operation: "resolve-staging-rehearsal",
    failedRunId: 299,
    failedDiagnosticsDigest: `sha256:${digest("b")}`,
    failedRehearsalSha256,
    restoredPair: recoveredPair,
    recoveryRecord: {
      path: "docs/release-evidence/rehearsal-resolutions/299-recovery.json",
      sha256: artifactHash(recoveryBytes),
    },
    passedSmoke: {
      path: "docs/release-evidence/rehearsal-resolutions/299-smoke.json",
      sha256: artifactHash(smokeBytes),
    },
  });
  await Promise.all([
    writeFile(`${prefix}.json`, `${JSON.stringify(resolution)}\n`),
    writeFile(`${prefix}-recovery.json`, recoveryBytes),
    writeFile(`${prefix}-smoke.json`, smokeBytes),
  ]);
  return { root, rehearsalBytes, recoveredPair, prefix, workerResolution };
}

async function finalPairFixture(change?: "incomplete-writes" | "pair" | "configuration" | "smoke") {
  const root = await mkdtemp(join(tmpdir(), "rehearsal-history-final-pair-"));
  roots.push(root);
  const configBytes = await readFile(new URL("./environments.json", import.meta.url));
  await mkdir(resolve(root, "scripts/release"), { recursive: true });
  await writeFile(resolve(root, "scripts/release/environments.json"), configBytes);
  const configuration = releaseConfigSchema.parse(JSON.parse(configBytes.toString("utf8")));
  const fingerprint = configurationFingerprint(configuration);
  const finalPair = {
    netlifyDeployId: "netlify-final",
    workerDeploymentId: "worker-final",
    workerVersionId: "version-final",
  };
  const unresolved = {
    schemaVersion: 1,
    operation: "rehearse",
    outcome: "failed",
    source: {
      candidate: sha,
      tree: "c".repeat(40),
      environment: "staging",
      configurationFingerprint: digest("f"),
    },
    preparationSha256: digest("e"),
    priorPair: {
      netlifyDeployId: "netlify-prior",
      workerDeploymentId: "worker-prior",
      workerVersionId: "version-prior",
    },
    activatedWorker: {
      deploymentId: finalPair.workerDeploymentId,
      versionId: finalPair.workerVersionId,
    },
    publishedNetlify: { publishedDeployId: finalPair.netlifyDeployId },
    stages: {
      inspect: "passed",
      "hold-netlify": "passed",
      "upload-worker": "passed",
      "activate-worker": "passed",
      "observe-worker": "passed",
      "verify-transition": "passed",
      "prepublish-check": "passed",
      "publish-netlify": change === "incomplete-writes" ? "failed" : "passed",
      "observe-netlify": "failed",
    },
    failure: { stage: "observe-netlify", kind: "failed" },
    recovery: "inspect-recorded-targets-before-recovery",
  };
  const rehearsalBytes = Buffer.from(`${JSON.stringify(unresolved)}\n`);
  const failedRehearsalSha256 = artifactHash(rehearsalBytes);
  const smoke = smokeReport(fingerprint);
  if (change === "smoke") smoke.checks.pop();
  const smokeBytes = Buffer.from(`${JSON.stringify(smoke)}\n`);
  const recordedPair =
    change === "pair" ? { ...finalPair, workerVersionId: "version-unrelated" } : finalPair;
  const recovery = stagingRehearsalFinalPairRecordSchema.parse({
    schemaVersion: 1,
    operation: "staging-rehearsal-final-pair",
    environment: "staging",
    failedRunId: 299,
    failedDiagnosticsDigest: `sha256:${digest("b")}`,
    failedRehearsalSha256,
    preparedConfigurationFingerprint:
      change === "configuration" ? digest("0") : unresolved.source.configurationFingerprint,
    configurationSha256: fingerprint,
    pairSmokeSha256: artifactHash(smokeBytes),
    finalPair: recordedPair,
    outcome: "passed",
    stages: { inspect: "passed", "verify-pair": "passed" },
  });
  const recoveryBytes = Buffer.from(`${JSON.stringify(recovery)}\n`);
  const prefix = resolve(root, "docs/release-evidence/rehearsal-resolutions/299");
  await mkdir(resolve(prefix, ".."), { recursive: true });
  const resolution = rehearsalResolutionSchema.parse({
    schemaVersion: 1,
    operation: "resolve-staging-rehearsal",
    failedRunId: 299,
    failedDiagnosticsDigest: `sha256:${digest("b")}`,
    failedRehearsalSha256,
    restoredPair: recordedPair,
    recoveryRecord: {
      path: "docs/release-evidence/rehearsal-resolutions/299-recovery.json",
      sha256: artifactHash(recoveryBytes),
    },
    passedSmoke: {
      path: "docs/release-evidence/rehearsal-resolutions/299-smoke.json",
      sha256: artifactHash(smokeBytes),
    },
  });
  await Promise.all([
    writeFile(`${prefix}.json`, `${JSON.stringify(resolution)}\n`),
    writeFile(`${prefix}-recovery.json`, recoveryBytes),
    writeFile(`${prefix}-smoke.json`, smokeBytes),
  ]);
  return { root, rehearsalBytes, finalPair };
}

describe("reviewed rehearsal recovery", () => {
  const client = (): GitHubReleaseApi =>
    api(({ path }) => {
      if (path === workflowPath)
        return { id: 10, path: GITHUB_RELEASE_WORKFLOWS.rehearsal, state: "active" };
      if (path === runsPath)
        return {
          total_count: 2,
          workflow_runs: [currentRun(), run(299, { createdAt: "2026-09-12T10:00:00Z" })],
        };
      if (path.endsWith("/actions/runs/299/attempts/1/jobs"))
        return { total_count: 1, jobs: [ranFailedJob()] };
      if (path.endsWith("/actions/runs/299/artifacts"))
        return { total_count: 1, artifacts: [artifact(299)] };
      throw new Error(`unexpected ${path}`);
    });

  it("accepts unique Worker secret names in retained API order and rejects duplicates", async () => {
    const fixture = await resolvedFixture();
    const reordered = structuredClone(fixture.workerResolution);
    reordered.targetEvidence.workerSecretBindingNames = ["SYNC_SECRET", "SESSION_SIGNING_KEY"];
    expect(stagingWorkerResolutionAuditSchema.safeParse(reordered).success).toBe(true);
    reordered.targetEvidence.workerSecretBindingNames = [
      "SESSION_SIGNING_KEY",
      "SESSION_SIGNING_KEY",
    ];
    expect(stagingWorkerResolutionAuditSchema.safeParse(reordered).success).toBe(false);
  });

  it("accepts a reviewed final pair after only the postpublication readback failed", async () => {
    const fixture = await finalPairFixture();
    const dependencies = inertDependencies();
    dependencies.extractArtifact = vi.fn(async (_archive, directory) => {
      await mkdir(resolve(directory, "reports"), { recursive: true });
      await writeFile(resolve(directory, "reports/rehearsal.json"), fixture.rehearsalBytes);
    });
    dependencies.inspectCurrentPair = vi.fn(async () => fixture.finalPair);
    await expect(
      verifyRehearsalHistory(client(), input(fixture.root), dependencies),
    ).resolves.toMatchObject({ resolvedBy: "reviewed-final-pair", runId: 299 });
    expect(dependencies.inspectCurrentPair).toHaveBeenCalledOnce();
  });

  it.each(["incomplete-writes", "pair", "configuration", "smoke"] as const)(
    "blocks reviewed final-pair evidence with changed %s evidence",
    async (change) => {
      const fixture = await finalPairFixture(change);
      const dependencies = inertDependencies();
      dependencies.extractArtifact = vi.fn(async (_archive, directory) => {
        await mkdir(resolve(directory, "reports"), { recursive: true });
        await writeFile(resolve(directory, "reports/rehearsal.json"), fixture.rehearsalBytes);
      });
      dependencies.inspectCurrentPair = vi.fn(async () => fixture.finalPair);
      await expect(
        verifyRehearsalHistory(client(), input(fixture.root), dependencies),
      ).rejects.toThrow();
      expect(dependencies.inspectCurrentPair).not.toHaveBeenCalled();
    },
  );

  it("blocks reviewed final-pair evidence when the fresh provider readback drifts", async () => {
    const fixture = await finalPairFixture();
    const dependencies = inertDependencies();
    dependencies.extractArtifact = vi.fn(async (_archive, directory) => {
      await mkdir(resolve(directory, "reports"), { recursive: true });
      await writeFile(resolve(directory, "reports/rehearsal.json"), fixture.rehearsalBytes);
    });
    dependencies.inspectCurrentPair = vi.fn(async () => ({
      ...fixture.finalPair,
      workerDeploymentId: "worker-drifted",
    }));
    await expect(
      verifyRehearsalHistory(client(), input(fixture.root), dependencies),
    ).rejects.toThrow();
    expect(dependencies.inspectCurrentPair).toHaveBeenCalledOnce();
  });

  it("accepts exact recovery, smoke, failed artifact, and current restored-pair bindings", async () => {
    const fixture = await resolvedFixture();
    const dependencies = inertDependencies();
    dependencies.extractArtifact = vi.fn(async (_archive, directory) => {
      await mkdir(resolve(directory, "reports"), { recursive: true });
      await writeFile(resolve(directory, "reports/rehearsal.json"), fixture.rehearsalBytes);
    });
    dependencies.inspectCurrentPair = vi.fn(async () => fixture.recoveredPair);
    const inspectCurrentPair = dependencies.inspectCurrentPair;
    await expect(
      verifyRehearsalHistory(client(), input(fixture.root), dependencies),
    ).resolves.toMatchObject({ resolvedBy: "reviewed-recovery", runId: 299 });
    expect(inspectCurrentPair).toHaveBeenCalledOnce();
  });

  it.each(["starting", "target"] as const)(
    "blocks an internally valid recovery whose %s pair differs from the failed report",
    async (pair) => {
      const fixture = await resolvedFixture(pair);
      const dependencies = inertDependencies();
      dependencies.extractArtifact = vi.fn(async (_archive, directory) => {
        await mkdir(resolve(directory, "reports"), { recursive: true });
        await writeFile(resolve(directory, "reports/rehearsal.json"), fixture.rehearsalBytes);
      });
      dependencies.inspectCurrentPair = vi.fn(async () => fixture.recoveredPair);
      const inspectCurrentPair = dependencies.inspectCurrentPair;
      await expect(
        verifyRehearsalHistory(client(), input(fixture.root), dependencies),
      ).rejects.toThrow();
      expect(inspectCurrentPair).not.toHaveBeenCalled();
    },
  );

  it("blocks mutation-possible history when no reviewed resolution exists", async () => {
    const fixture = await resolvedFixture();
    await rm(`${fixture.prefix}.json`);
    const dependencies = inertDependencies();
    const inspectCurrentPair = dependencies.inspectCurrentPair;
    dependencies.extractArtifact = vi.fn(async (_archive, directory) => {
      await mkdir(resolve(directory, "reports"), { recursive: true });
      await writeFile(resolve(directory, "reports/rehearsal.json"), fixture.rehearsalBytes);
    });
    await expect(
      verifyRehearsalHistory(client(), input(fixture.root), dependencies),
    ).rejects.toThrow();
    expect(inspectCurrentPair).not.toHaveBeenCalled();
  });

  it.each(["resolution", "helper-record", "smoke", "configuration", "current-pair"] as const)(
    "blocks stale or changed %s evidence before a new rehearsal",
    async (change) => {
      const fixture = await resolvedFixture();
      const dependencies = inertDependencies();
      dependencies.extractArtifact = vi.fn(async (_archive, directory) => {
        await mkdir(resolve(directory, "reports"), { recursive: true });
        await writeFile(resolve(directory, "reports/rehearsal.json"), fixture.rehearsalBytes);
      });
      if (change === "resolution") {
        const path = `${fixture.prefix}.json`;
        const value = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
        value.failedRehearsalSha256 = digest("0");
        await writeFile(path, `${JSON.stringify(value)}\n`);
      } else if (change === "helper-record") {
        const path = `${fixture.prefix}-recovery.json`;
        const value = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
        value.workerResolutionJson = "{}\n";
        await writeFile(path, `${JSON.stringify(value)}\n`);
      } else if (change === "smoke") {
        await writeFile(`${fixture.prefix}-smoke.json`, "{}\n");
      } else if (change === "configuration") {
        const path = resolve(fixture.root, "scripts/release/environments.json");
        const value = JSON.parse(await readFile(path, "utf8")) as {
          environments: { staging: { integrationBranch: string } };
        };
        value.environments.staging.integrationBranch = "changed-stage";
        await writeFile(path, `${JSON.stringify(value)}\n`);
      } else {
        dependencies.inspectCurrentPair = vi.fn(async () => ({
          ...fixture.recoveredPair,
          workerVersionId: "drifted-version",
        }));
      }
      await expect(
        verifyRehearsalHistory(client(), input(fixture.root), dependencies),
      ).rejects.toThrow();
    },
  );
});
