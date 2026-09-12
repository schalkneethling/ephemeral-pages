import { constants } from "node:fs";
import { mkdtemp, open, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { z } from "zod/v4";

import { artifactHash, sourceContractSchema } from "./artifact-contract.ts";
import {
  downloadGitHubArtifact,
  extractVerifiedGitHubArtifact,
  GITHUB_RELEASE_REPOSITORY,
  GITHUB_RELEASE_WORKFLOWS,
  type GitHubReleaseApi,
  type VerifiedStagingInvocation,
} from "./github-release.ts";
import { configurationFingerprint } from "./planner.ts";
import { successfulRehearsalSchema } from "./production-approval.ts";
import { digestSchema, pairSchema, providerIdSchema } from "./production-record.ts";
import { recoveryTargetEvidenceSchema } from "./recovery-record.ts";
import type { DeploymentPair } from "./rehearsal.ts";
import { releaseConfigSchema } from "./schema.ts";

const REHEARSAL_JOB_NAME = "Staging release rehearsal";
const PREMUTATION_STEP_NAME = "Establish rehearsal pre-mutation checkpoint";
const REHEARSAL_STEP_NAME = "Rehearse the staging release";
const DIAGNOSTICS_STEP_NAME = "Retain sanitized rehearsal diagnostics";
const DIAGNOSTICS_ARTIFACT_NAME = "release-rehearsal-diagnostics";
const MAX_ITEMS = 100;
const MAX_HISTORY_PAGES = 3;
const MAX_JSON_BYTES = 1024 * 1024;
const MAX_ARTIFACT_BYTES = 128 * 1024 * 1024;
const RESOLUTION_DIRECTORY = "docs/release-evidence/rehearsal-resolutions";

const positiveIntegerSchema = z.number().int().positive().safe();
const timestampSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u)
  .refine((value) => Number.isFinite(Date.parse(value)));
const artifactDigestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/u);
const workflowSchema = z.object({
  id: positiveIntegerSchema,
  path: z.literal(GITHUB_RELEASE_WORKFLOWS.rehearsal),
  state: z.literal("active"),
});
const runSchema = z.object({
  id: positiveIntegerSchema,
  run_attempt: positiveIntegerSchema,
  event: z.string(),
  status: z.string(),
  conclusion: z.string().nullable(),
  head_branch: z.string().nullable(),
  head_sha: z.string().regex(/^[a-f0-9]{40}$/u),
  path: z.string(),
  workflow_id: positiveIntegerSchema,
  created_at: timestampSchema,
  updated_at: timestampSchema,
  repository: z.object({ full_name: z.string() }),
});
const runsSchema = z.object({
  total_count: z.number().int().nonnegative().safe(),
  workflow_runs: z.array(runSchema).max(MAX_ITEMS),
});
const jobsSchema = z.object({
  total_count: z.number().int().nonnegative().safe(),
  jobs: z
    .array(
      z.object({
        id: positiveIntegerSchema,
        name: z.string(),
        head_sha: z.string().regex(/^[a-f0-9]{40}$/u),
        status: z.string(),
        conclusion: z.string().nullable(),
        steps: z
          .array(
            z.object({
              name: z.string(),
              status: z.string(),
              conclusion: z.string().nullable(),
              number: positiveIntegerSchema,
            }),
          )
          .max(MAX_ITEMS),
      }),
    )
    .max(MAX_ITEMS),
});
const artifactSchema = z.object({
  id: positiveIntegerSchema,
  name: z.string(),
  size_in_bytes: z.number().int().positive().max(MAX_ARTIFACT_BYTES),
  expired: z.boolean(),
  created_at: timestampSchema,
  updated_at: timestampSchema,
  expires_at: timestampSchema,
  digest: z.string(),
  workflow_run: z.object({
    id: positiveIntegerSchema,
    head_branch: z.string(),
    head_sha: z.string().regex(/^[a-f0-9]{40}$/u),
  }),
});
const artifactsSchema = z.object({
  total_count: z.number().int().nonnegative().safe(),
  artifacts: z.array(artifactSchema).max(MAX_ITEMS),
});

const safeFailureKindSchema = z.enum([
  "timeout",
  "spawn",
  "output-limit",
  "failed",
  "preflight",
  "checkpoint",
  "ambiguous",
  "verification",
  "artifact",
  "authentication",
  "unknown",
]);
export const readOnlyRehearsalFailureSchema = z.strictObject({
  schemaVersion: z.literal(1),
  operation: z.literal("rehearse"),
  outcome: z.enum(["blocked", "failed"]),
  source: sourceContractSchema,
  preparationSha256: digestSchema,
  priorPair: pairSchema.optional(),
  stages: z.strictObject({ inspect: z.enum(["blocked", "failed"]) }),
  failure: z.strictObject({ stage: z.literal("inspect"), kind: safeFailureKindSchema }),
  recovery: z.literal("none"),
});

export const rehearsalPreflightRecordSchema = z.strictObject({
  schemaVersion: z.literal(1),
  operation: z.literal("staging-rehearsal-preflight"),
  runId: positiveIntegerSchema,
  workflowCommit: z.string().regex(/^[a-f0-9]{40}$/u),
  calibrationOnly: z.boolean(),
  preparationSha256: digestSchema,
  outcome: z.literal("passed"),
});
export type RehearsalPreflightRecord = z.infer<typeof rehearsalPreflightRecordSchema>;

const rehearsalStepSchema = z.enum([
  "inspect",
  "hold-netlify",
  "upload-worker",
  "activate-worker",
  "observe-worker",
  "prepublish-check",
  "observe-netlify",
  "verify-transition",
  "publish-netlify",
  "verify-pair",
]);
export const unresolvedRehearsalSchema = z.strictObject({
  schemaVersion: z.literal(1),
  operation: z.literal("rehearse"),
  outcome: z.enum(["blocked", "failed"]),
  source: sourceContractSchema,
  preparationSha256: digestSchema,
  priorPair: pairSchema,
  observedPair: pairSchema.optional(),
  activatedWorker: z
    .strictObject({
      deploymentId: pairSchema.shape.workerDeploymentId,
      versionId: pairSchema.shape.workerVersionId,
    })
    .optional(),
  publishedNetlify: z
    .strictObject({ publishedDeployId: pairSchema.shape.netlifyDeployId })
    .optional(),
  stages: z.partialRecord(
    rehearsalStepSchema,
    z.enum(["pending", "running", "passed", "failed", "blocked"]),
  ),
  failure: z.strictObject({ stage: rehearsalStepSchema, kind: safeFailureKindSchema }),
  recovery: z.literal("inspect-recorded-targets-before-recovery"),
});

const recoveryArtifactHashesSchema = z.strictObject({
  metadata: digestSchema,
  targetPrepared: digestSchema,
  targetWorker: digestSchema,
  targetComplete: digestSchema,
  targetRehearsal: digestSchema,
  targetTransition: digestSchema,
  targetWorkerResult: digestSchema,
  failedPrepared: digestSchema,
  failedWorker: digestSchema,
  failedComplete: digestSchema,
  failedRehearsal: digestSchema,
  failedTransition: digestSchema,
  failedWorkerResult: digestSchema,
});

export const stagingWorkerResolutionAuditSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    operation: z.literal("staging-worker-resolution"),
    phase: z.literal("verified"),
    metadataSha256: digestSchema,
    targetRunId: positiveIntegerSchema,
    failedRunId: positiveIntegerSchema,
    expectedCurrent: pairSchema,
    requested: pairSchema,
    recoveredPair: pairSchema,
    inspectionSha256: digestSchema,
    targetEvidence: recoveryTargetEvidenceSchema,
    artifactHashes: recoveryArtifactHashesSchema,
    returnedDeploymentId: providerIdSchema,
    returnedVersionId: providerIdSchema,
  })
  .superRefine((value, context) => {
    const secretNames = value.targetEvidence.workerSecretBindingNames;
    if (
      value.metadataSha256 !== value.artifactHashes.metadata ||
      value.inspectionSha256 !== value.targetEvidence.inspectionSha256 ||
      JSON.stringify(value.expectedCurrent) !==
        JSON.stringify(value.targetEvidence.expectedCurrent) ||
      JSON.stringify(value.requested) !== JSON.stringify(value.targetEvidence.requested) ||
      value.targetEvidence.netlifyIdentity !== "release-artifact" ||
      value.targetEvidence.workerArtifactSha256 !== value.artifactHashes.targetWorker ||
      secretNames.length !== new Set(secretNames).size ||
      value.recoveredPair.netlifyDeployId !== value.requested.netlifyDeployId ||
      value.recoveredPair.workerDeploymentId !== value.returnedDeploymentId ||
      value.recoveredPair.workerVersionId !== value.returnedVersionId ||
      value.recoveredPair.workerVersionId !== value.requested.workerVersionId
    ) {
      context.addIssue({ code: "custom", message: "Worker resolution evidence differs." });
    }
  });

export const stagingRehearsalRecoveryRecordSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    operation: z.literal("staging-rehearsal-recovery"),
    environment: z.literal("staging"),
    failedRunId: positiveIntegerSchema,
    failedDiagnosticsDigest: artifactDigestSchema,
    failedRehearsalSha256: digestSchema,
    configurationSha256: digestSchema,
    resolutionRecordSha256: digestSchema,
    workerResolutionJson: z.string().min(2).max(MAX_JSON_BYTES),
    pairSmokeSha256: digestSchema,
    startingPair: pairSchema,
    targetPair: pairSchema,
    observedPair: pairSchema,
    recoveredPair: pairSchema,
    workerResolution: stagingWorkerResolutionAuditSchema,
    outcome: z.literal("passed"),
    stages: z.strictObject({
      inspect: z.literal("passed"),
      "restore-worker": z.literal("passed"),
      "verify-pair": z.literal("passed"),
    }),
  })
  .superRefine((value, context) => {
    const audit = value.workerResolution;
    let parsedAudit: unknown;
    try {
      if (!value.workerResolutionJson.endsWith("\n") || value.workerResolutionJson.includes("\r")) {
        throw new Error();
      }
      parsedAudit = JSON.parse(value.workerResolutionJson) as unknown;
    } catch {
      parsedAudit = null;
    }
    const parsedAuditRecord = stagingWorkerResolutionAuditSchema.safeParse(parsedAudit);
    if (
      value.failedRunId !== audit.failedRunId ||
      value.failedRehearsalSha256 !== audit.artifactHashes.failedRehearsal ||
      value.resolutionRecordSha256 !== artifactHash(value.workerResolutionJson) ||
      !parsedAuditRecord.success ||
      JSON.stringify(parsedAuditRecord.data) !== JSON.stringify(audit) ||
      JSON.stringify(value.startingPair) !== JSON.stringify(audit.expectedCurrent) ||
      JSON.stringify(value.targetPair) !== JSON.stringify(audit.requested) ||
      JSON.stringify(value.observedPair) !== JSON.stringify(value.recoveredPair) ||
      JSON.stringify(value.recoveredPair) !== JSON.stringify(audit.recoveredPair) ||
      value.startingPair.netlifyDeployId !== value.targetPair.netlifyDeployId ||
      value.targetPair.netlifyDeployId !== value.recoveredPair.netlifyDeployId ||
      value.startingPair.workerVersionId === value.targetPair.workerVersionId
    ) {
      context.addIssue({ code: "custom", message: "Staging recovery evidence differs." });
    }
  });
export type StagingRehearsalRecoveryRecord = z.infer<typeof stagingRehearsalRecoveryRecordSchema>;

const smokeCheckSchema = z.strictObject({
  id: z.enum([
    "upload.collaboration",
    "roles.editor-viewer",
    "sync.two-editors-viewer",
    "persistence.reload",
    "recovery.network-loss",
    "capture.png",
  ]),
  outcome: z.literal("passed"),
  summary: z.string().min(1).max(512),
});
export const passedStagingSmokeSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    operation: z.literal("collaboration-smoke"),
    outcome: z.literal("passed"),
    environment: z.literal("staging"),
    configuration: z.strictObject({
      source: z.literal("default"),
      fingerprint: digestSchema,
    }),
    checks: z.array(smokeCheckSchema).length(6),
    usage: z.strictObject({
      uploads: z.literal(1),
      captureRequested: z.literal(true),
      captureRequests: z.literal(1),
    }),
  })
  .superRefine((value, context) => {
    if (new Set(value.checks.map(({ id }) => id)).size !== 6) {
      context.addIssue({ code: "custom", message: "Staging smoke evidence differs." });
    }
  });

const resolutionReferenceSchema = z.strictObject({
  path: z.string().min(1).max(512),
  sha256: digestSchema,
});
export const rehearsalResolutionSchema = z.strictObject({
  schemaVersion: z.literal(1),
  operation: z.literal("resolve-staging-rehearsal"),
  failedRunId: positiveIntegerSchema,
  failedDiagnosticsDigest: artifactDigestSchema,
  failedRehearsalSha256: digestSchema,
  restoredPair: pairSchema,
  recoveryRecord: resolutionReferenceSchema,
  passedSmoke: resolutionReferenceSchema,
});
export type RehearsalResolution = z.infer<typeof rehearsalResolutionSchema>;

export class RehearsalHistoryError extends Error {
  constructor() {
    super("Staging rehearsal history could not be verified.");
    this.name = "RehearsalHistoryError";
  }
}

type VerifiedDiagnosticsArtifact = {
  artifactId: number;
  digest: `sha256:${string}`;
  sizeInBytes: number;
};

export type RehearsalHistoryResult = {
  resolvedBy: "none" | "successful-run" | "passed-report" | "reviewed-recovery";
  runId?: number;
  skippedReadOnlyRunIds: readonly number[];
};

export type RehearsalHistoryDependencies = {
  downloadArtifact: typeof downloadGitHubArtifact;
  extractArtifact: typeof extractVerifiedGitHubArtifact;
  inspectCurrentPair: () => Promise<DeploymentPair>;
};

const repositoryPath = (suffix: string): string => `/repos/${GITHUB_RELEASE_REPOSITORY}/${suffix}`;
const workflowPath = (): string => repositoryPath("actions/workflows/release-rehearsal.yml");
const samePair = (left: DeploymentPair, right: DeploymentPair): boolean =>
  left.netlifyDeployId === right.netlifyDeployId &&
  left.workerDeploymentId === right.workerDeploymentId &&
  left.workerVersionId === right.workerVersionId;

const parse = <T>(schema: z.ZodType<T>, value: unknown): T => {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new RehearsalHistoryError();
  return parsed.data;
};

const validRunPath = (path: string): boolean =>
  path === GITHUB_RELEASE_WORKFLOWS.rehearsal ||
  path === `${GITHUB_RELEASE_WORKFLOWS.rehearsal}@stage`;

const verifyRunSource = (run: z.infer<typeof runSchema>, workflowId: number): void => {
  if (
    run.repository.full_name !== GITHUB_RELEASE_REPOSITORY ||
    run.workflow_id !== workflowId ||
    !validRunPath(run.path) ||
    run.event !== "workflow_dispatch" ||
    run.head_branch !== "stage" ||
    run.run_attempt !== 1 ||
    Date.parse(run.updated_at) < Date.parse(run.created_at)
  ) {
    throw new RehearsalHistoryError();
  }
};

const readRehearsalJob = async (
  api: GitHubReleaseApi,
  run: z.infer<typeof runSchema>,
): Promise<z.infer<typeof jobsSchema>["jobs"][number]> => {
  const response = parse(
    jobsSchema,
    await api.get({
      path: repositoryPath(`actions/runs/${run.id}/attempts/1/jobs`),
      query: { page: "1", per_page: String(MAX_ITEMS) },
    }),
  );
  const job = response.jobs[0];
  if (
    response.total_count !== 1 ||
    response.jobs.length !== 1 ||
    !job ||
    job.name !== REHEARSAL_JOB_NAME ||
    job.head_sha !== run.head_sha ||
    job.status !== "completed" ||
    job.conclusion === null
  ) {
    throw new RehearsalHistoryError();
  }
  return job;
};

const exactCompletedStep = (
  job: z.infer<typeof jobsSchema>["jobs"][number],
  name: string,
  conclusion: "success" | "skipped",
): boolean => {
  const matches = job.steps.filter((step) => step.name === name);
  return (
    matches.length === 1 &&
    matches[0].status === "completed" &&
    matches[0].conclusion === conclusion
  );
};

const verifySuccessfulJob = async (
  api: GitHubReleaseApi,
  run: z.infer<typeof runSchema>,
): Promise<void> => {
  const job = await readRehearsalJob(api, run);
  if (
    job.conclusion !== "success" ||
    !exactCompletedStep(job, REHEARSAL_STEP_NAME, "success") ||
    !exactCompletedStep(job, DIAGNOSTICS_STEP_NAME, "success")
  ) {
    throw new RehearsalHistoryError();
  }
};

const rehearsalMutationStepWasSkipped = async (
  api: GitHubReleaseApi,
  run: z.infer<typeof runSchema>,
): Promise<boolean> => {
  const job = await readRehearsalJob(api, run);
  const preflight = job.steps.filter((step) => step.name === PREMUTATION_STEP_NAME);
  return (
    preflight.length === 1 &&
    preflight[0].status === "completed" &&
    preflight[0].conclusion !== null &&
    exactCompletedStep(job, REHEARSAL_STEP_NAME, "skipped")
  );
};

const readDiagnosticsArtifact = async (
  api: GitHubReleaseApi,
  run: z.infer<typeof runSchema>,
  now: Date,
): Promise<VerifiedDiagnosticsArtifact> => {
  const response = parse(
    artifactsSchema,
    await api.get({
      path: repositoryPath(`actions/runs/${run.id}/artifacts`),
      query: { page: "1", per_page: String(MAX_ITEMS) },
    }),
  );
  const matches = response.artifacts.filter(({ name }) => name === DIAGNOSTICS_ARTIFACT_NAME);
  const artifact = matches[0];
  const digest = artifactDigestSchema.safeParse(artifact?.digest);
  if (
    response.total_count !== response.artifacts.length ||
    matches.length !== 1 ||
    !artifact ||
    !digest.success ||
    artifact.expired ||
    artifact.workflow_run.id !== run.id ||
    artifact.workflow_run.head_branch !== "stage" ||
    artifact.workflow_run.head_sha !== run.head_sha ||
    Date.parse(artifact.created_at) < Date.parse(run.created_at) ||
    Date.parse(artifact.updated_at) < Date.parse(artifact.created_at) ||
    Date.parse(artifact.expires_at) <= now.getTime()
  ) {
    throw new RehearsalHistoryError();
  }
  return {
    artifactId: artifact.id,
    digest: digest.data as `sha256:${string}`,
    sizeInBytes: artifact.size_in_bytes,
  };
};

const readBytes = async (path: string): Promise<Uint8Array> => {
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY);
    const before = await handle.stat();
    if (!before.isFile() || before.size < 2 || before.size > MAX_JSON_BYTES) throw new Error();
    const chunks: Uint8Array[] = [];
    let total = 0;
    while (total <= MAX_JSON_BYTES) {
      const chunk = Buffer.alloc(Math.min(64 * 1024, MAX_JSON_BYTES + 1 - total));
      const result = await handle.read(chunk, 0, chunk.length, null);
      if (result.bytesRead === 0) break;
      total += result.bytesRead;
      chunks.push(chunk.subarray(0, result.bytesRead));
    }
    const after = await handle.stat();
    if (
      total < 2 ||
      total > MAX_JSON_BYTES ||
      total !== before.size ||
      after.size !== before.size ||
      after.dev !== before.dev ||
      after.ino !== before.ino
    ) {
      throw new Error();
    }
    return Buffer.concat(chunks, total);
  } catch {
    throw new RehearsalHistoryError();
  } finally {
    await handle?.close().catch(() => undefined);
  }
};

const readNames = async (path: string): Promise<string[]> => {
  try {
    return await readdir(path);
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
      return [];
    }
    throw new RehearsalHistoryError();
  }
};

const parseBytes = <T>(bytes: Uint8Array, schema: z.ZodType<T>): T => {
  try {
    return parse(schema, JSON.parse(Buffer.from(bytes).toString("utf8")) as unknown);
  } catch {
    throw new RehearsalHistoryError();
  }
};

const verifyPassedReport = (value: unknown, runSha: string): boolean => {
  const parsed = successfulRehearsalSchema.safeParse(value);
  if (!parsed.success) return false;
  const report = parsed.data;
  return (
    report.source.candidate === runSha &&
    report.observedPair.netlifyDeployId === report.publishedNetlify.publishedDeployId &&
    report.observedPair.workerDeploymentId === report.activatedWorker.deploymentId &&
    report.observedPair.workerVersionId === report.activatedWorker.versionId
  );
};

const resolutionPaths = (failedRunId: number) => {
  const prefix = `${RESOLUTION_DIRECTORY}/${failedRunId}`;
  return {
    resolution: `${prefix}.json`,
    recovery: `${prefix}-recovery.json`,
    smoke: `${prefix}-smoke.json`,
  };
};

const verifyResolution = async (
  repositoryRoot: string,
  run: z.infer<typeof runSchema>,
  artifact: VerifiedDiagnosticsArtifact,
  rehearsalBytes: Uint8Array,
  inspectCurrentPair: () => Promise<DeploymentPair>,
): Promise<void> => {
  const paths = resolutionPaths(run.id);
  const [resolutionBytes, recoveryBytes, smokeBytes, configBytes] = await Promise.all([
    readBytes(resolve(repositoryRoot, paths.resolution)),
    readBytes(resolve(repositoryRoot, paths.recovery)),
    readBytes(resolve(repositoryRoot, paths.smoke)),
    readBytes(resolve(repositoryRoot, "scripts/release/environments.json")),
  ]);
  const resolution = parseBytes(resolutionBytes, rehearsalResolutionSchema);
  const recovery = parseBytes(recoveryBytes, stagingRehearsalRecoveryRecordSchema);
  const smoke = parseBytes(smokeBytes, passedStagingSmokeSchema);
  const configuration = parseBytes(configBytes, releaseConfigSchema);
  const rehearsalSha256 = artifactHash(rehearsalBytes);
  const recoverySha256 = artifactHash(recoveryBytes);
  const smokeSha256 = artifactHash(smokeBytes);
  if (
    resolution.failedRunId !== run.id ||
    resolution.failedDiagnosticsDigest !== artifact.digest ||
    resolution.failedRehearsalSha256 !== rehearsalSha256 ||
    resolution.recoveryRecord.path !== paths.recovery ||
    resolution.recoveryRecord.sha256 !== recoverySha256 ||
    resolution.passedSmoke.path !== paths.smoke ||
    resolution.passedSmoke.sha256 !== smokeSha256 ||
    recovery.failedRunId !== run.id ||
    recovery.failedDiagnosticsDigest !== artifact.digest ||
    recovery.failedRehearsalSha256 !== rehearsalSha256 ||
    recovery.pairSmokeSha256 !== smokeSha256 ||
    recovery.configurationSha256 !== configurationFingerprint(configuration) ||
    smoke.configuration.fingerprint !== recovery.configurationSha256 ||
    !samePair(resolution.restoredPair, recovery.recoveredPair)
  ) {
    throw new RehearsalHistoryError();
  }
  const current = await inspectCurrentPair();
  if (!samePair(current, resolution.restoredPair)) throw new RehearsalHistoryError();
};

const inspectFailedRun = async (
  api: GitHubReleaseApi,
  input: {
    run: z.infer<typeof runSchema>;
    token: string;
    repositoryRoot: string;
    now: Date;
  },
  dependencies: RehearsalHistoryDependencies,
): Promise<"passed" | "read-only" | "resolved"> => {
  const artifact = await readDiagnosticsArtifact(api, input.run, input.now);
  const parent = await mkdtemp(join(tmpdir(), "release-rehearsal-history-"));
  const directory = join(parent, "diagnostics");
  try {
    const archive = await dependencies.downloadArtifact({
      token: input.token,
      artifactId: artifact.artifactId,
      expectedDigest: artifact.digest,
      expectedSizeInBytes: artifact.sizeInBytes,
    });
    await dependencies.extractArtifact(archive, directory, input.repositoryRoot);
    const reportDirectory = resolve(directory, "reports");
    const names = await readNames(reportDirectory);
    if (!names.includes("rehearsal.json")) {
      throw new RehearsalHistoryError();
    }
    const rehearsalBytes = await readBytes(resolve(reportDirectory, "rehearsal.json"));
    let value: unknown;
    try {
      value = JSON.parse(Buffer.from(rehearsalBytes).toString("utf8")) as unknown;
    } catch {
      throw new RehearsalHistoryError();
    }
    if (verifyPassedReport(value, input.run.head_sha)) return "passed";
    const readOnly = readOnlyRehearsalFailureSchema.safeParse(value);
    if (readOnly.success && readOnly.data.source.candidate === input.run.head_sha) {
      if (names.some((name) => name.startsWith("provider-") && name.endsWith(".json"))) {
        throw new RehearsalHistoryError();
      }
      if (names.some((name) => !["complete.json", "rehearsal.json"].includes(name))) {
        throw new RehearsalHistoryError();
      }
      return "read-only";
    }
    const unresolved = unresolvedRehearsalSchema.safeParse(value);
    if (!unresolved.success || unresolved.data.source.candidate !== input.run.head_sha) {
      throw new RehearsalHistoryError();
    }
    await verifyResolution(input.repositoryRoot, input.run, artifact, rehearsalBytes, () =>
      dependencies.inspectCurrentPair(),
    );
    return "resolved";
  } finally {
    await rm(parent, { recursive: true, force: true }).catch(() => undefined);
  }
};

export async function verifyRehearsalHistory(
  api: GitHubReleaseApi,
  input: {
    current: VerifiedStagingInvocation;
    token: string;
    repositoryRoot: string;
    now?: Date;
  },
  dependencies: RehearsalHistoryDependencies,
): Promise<RehearsalHistoryResult> {
  const now = input.now ?? new Date();
  if (
    !input.token ||
    input.token.length > 4096 ||
    !Number.isFinite(now.getTime()) ||
    input.current.workflowPath !== GITHUB_RELEASE_WORKFLOWS.rehearsal ||
    input.current.branch !== "stage" ||
    input.current.runAttempt !== 1 ||
    input.current.environment.name !== "staging" ||
    input.current.environment.branch !== "stage"
  ) {
    throw new RehearsalHistoryError();
  }
  const workflow = parse(workflowSchema, await api.get({ path: workflowPath() }));
  if (workflow.id !== input.current.workflowId) throw new RehearsalHistoryError();
  const seenIds = new Set<number>();
  const skippedReadOnlyRunIds: number[] = [];
  let foundCurrent = false;
  let seen = 0;
  let lastCreatedAt = Number.POSITIVE_INFINITY;
  let lastRunId = Number.POSITIVE_INFINITY;
  let totalCount: number | undefined;
  for (let page = 1; page <= MAX_HISTORY_PAGES; page += 1) {
    const response = parse(
      runsSchema,
      await api.get({
        path: `${workflowPath()}/runs`,
        query: {
          branch: "stage",
          event: "workflow_dispatch",
          page: String(page),
          per_page: String(MAX_ITEMS),
        },
      }),
    );
    totalCount ??= response.total_count;
    if (response.workflow_runs.length === 0 && seen < response.total_count) {
      throw new RehearsalHistoryError();
    }
    if (
      response.total_count !== totalCount ||
      response.total_count < seen + response.workflow_runs.length
    ) {
      throw new RehearsalHistoryError();
    }
    for (const run of response.workflow_runs) {
      seen += 1;
      const createdAt = Date.parse(run.created_at);
      if (
        seenIds.has(run.id) ||
        createdAt > lastCreatedAt ||
        (createdAt === lastCreatedAt && run.id >= lastRunId)
      ) {
        throw new RehearsalHistoryError();
      }
      seenIds.add(run.id);
      lastCreatedAt = createdAt;
      lastRunId = run.id;
      verifyRunSource(run, workflow.id);
      if (!foundCurrent) {
        if (run.id === input.current.runId) {
          if (
            run.head_sha !== input.current.headSha ||
            run.created_at !== input.current.createdAt ||
            run.status !== "in_progress" ||
            run.conclusion !== null
          ) {
            throw new RehearsalHistoryError();
          }
          foundCurrent = true;
        }
        continue;
      }
      if (run.status !== "completed" || run.conclusion === null) {
        throw new RehearsalHistoryError();
      }
      if (run.conclusion === "success") {
        await verifySuccessfulJob(api, run);
        return { resolvedBy: "successful-run", runId: run.id, skippedReadOnlyRunIds };
      }
      if (await rehearsalMutationStepWasSkipped(api, run)) {
        skippedReadOnlyRunIds.push(run.id);
        continue;
      }
      const state = await inspectFailedRun(
        api,
        { run, token: input.token, repositoryRoot: input.repositoryRoot, now },
        dependencies,
      );
      if (state === "read-only") {
        skippedReadOnlyRunIds.push(run.id);
        continue;
      }
      return {
        resolvedBy: state === "passed" ? "passed-report" : "reviewed-recovery",
        runId: run.id,
        skippedReadOnlyRunIds,
      };
    }
    if (seen >= response.total_count) {
      if (!foundCurrent) throw new RehearsalHistoryError();
      return { resolvedBy: "none", skippedReadOnlyRunIds };
    }
  }
  throw new RehearsalHistoryError();
}

export const defaultRehearsalHistoryDependencies = (
  inspectCurrentPair: () => Promise<DeploymentPair>,
): RehearsalHistoryDependencies => ({
  downloadArtifact: downloadGitHubArtifact,
  extractArtifact: extractVerifiedGitHubArtifact,
  inspectCurrentPair,
});
