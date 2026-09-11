import { z } from "zod/v4";

import {
  GITHUB_RELEASE_REPOSITORY,
  type GitHubReleaseApi,
  type GitHubRuntimeEnvironment,
} from "./github-release.ts";

export const STAGING_RECOVERY_WORKFLOW_PATH =
  ".github/workflows/release-staging-recovery.yml" as const;
export const STAGING_RECOVERY_WORKFLOW_NAME = "Staging recovery" as const;
export const STAGING_RECOVERY_JOB_NAME = "Staging recovery" as const;
export const STAGING_RECOVERY_STEP_NAME = "Restore verified staging pair" as const;
export const STAGING_RECOVERY_ARTIFACT_NAME = "release-staging-recovery" as const;
export const STAGING_DIAGNOSTICS_ARTIFACT_NAME = "release-rehearsal-diagnostics" as const;

const positiveInteger = z.number().int().positive().safe();
const fullCommit = z.string().regex(/^[a-f0-9]{40}$/u);
const timestamp = z.string().refine((value) => Number.isFinite(Date.parse(value)));
const conclusion = z.string().nullable();
const workflowSchema = z.object({
  id: positiveInteger,
  name: z.string(),
  path: z.string(),
  state: z.string(),
});
const runSchema = z.object({
  id: positiveInteger,
  run_attempt: positiveInteger,
  event: z.string(),
  path: z.string(),
  head_branch: z.string().nullable(),
  head_sha: fullCommit,
  status: z.string(),
  conclusion,
  created_at: timestamp,
  updated_at: timestamp,
  workflow_id: positiveInteger,
  repository: z.object({ full_name: z.string() }),
});
const runsSchema = z.object({
  total_count: z.number().int().nonnegative().safe(),
  workflow_runs: z.array(runSchema).max(100),
});
const artifactSchema = z.object({
  id: positiveInteger,
  name: z.string(),
  expired: z.boolean(),
  size_in_bytes: positiveInteger,
  digest: z.string().nullable(),
  created_at: timestamp,
  updated_at: timestamp,
  expires_at: timestamp,
  workflow_run: z.object({
    id: positiveInteger,
    head_branch: z.string(),
    head_sha: fullCommit,
  }),
});
const artifactsSchema = z.object({
  total_count: z.number().int().nonnegative().safe(),
  artifacts: z.array(artifactSchema).max(100),
});
const stepSchema = z.object({
  name: z.string(),
  status: z.string(),
  conclusion,
  number: positiveInteger,
});
const jobSchema = z.object({
  id: positiveInteger,
  name: z.string(),
  head_sha: fullCommit,
  status: z.string(),
  conclusion,
  steps: z.array(stepSchema).max(100),
});
const jobsSchema = z.object({
  total_count: z.number().int().nonnegative().safe(),
  jobs: z.array(jobSchema).max(100),
});
const branchSchema = z.object({
  protected: z.literal(true),
  commit: z.object({ sha: fullCommit }),
});
const environmentSchema = z.object({
  name: z.literal("staging"),
  deployment_branch_policy: z.object({
    protected_branches: z.literal(false),
    custom_branch_policies: z.literal(true),
  }),
});
const branchPoliciesSchema = z.object({
  total_count: z.literal(1),
  branch_policies: z.tuple([
    z.object({ id: positiveInteger, name: z.literal("stage"), type: z.string().optional() }),
  ]),
});

export class StagingRecoveryGitHubError extends Error {
  constructor() {
    super("Staging recovery GitHub evidence could not be verified.");
    this.name = "StagingRecoveryGitHubError";
  }
}

export type VerifiedStagingRecoveryRun = {
  runId: number;
  runAttempt: 1;
  workflowId: number;
  workflowCommit: string;
  createdAt: string;
  updatedAt: string;
};

export type VerifiedStagingArtifact = {
  artifactId: number;
  name: typeof STAGING_DIAGNOSTICS_ARTIFACT_NAME | typeof STAGING_RECOVERY_ARTIFACT_NAME;
  digest: `sha256:${string}`;
  sizeInBytes: number;
  expiresAt: string;
};

export type VerifiedStagingRecoveryInvocation = VerifiedStagingRecoveryRun & {
  environmentPolicyId: number;
};

const repositoryPath = (suffix: string): string => `/repos/${GITHUB_RELEASE_REPOSITORY}/${suffix}`;

const parse = <T>(schema: z.ZodType<T>, value: unknown): T => {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new StagingRecoveryGitHubError();
  return parsed.data;
};

const readWorkflow = async (api: GitHubReleaseApi, path: string) => {
  const workflow = parse(
    workflowSchema,
    await api.get({ path: repositoryPath(`actions/workflows/${path}`) }),
  );
  if (workflow.path !== path || workflow.state !== "active") throw new StagingRecoveryGitHubError();
  return workflow;
};

const readRun = async (api: GitHubReleaseApi, runId: number) =>
  parse(runSchema, await api.get({ path: repositoryPath(`actions/runs/${runId}`) }));

const verifyRun = (
  run: z.infer<typeof runSchema>,
  workflow: z.infer<typeof workflowSchema>,
  expectedPath: string,
): VerifiedStagingRecoveryRun => {
  if (
    run.repository.full_name !== GITHUB_RELEASE_REPOSITORY ||
    run.workflow_id !== workflow.id ||
    run.path !== `${expectedPath}@stage` ||
    run.event !== "workflow_dispatch" ||
    run.head_branch !== "stage" ||
    run.run_attempt !== 1 ||
    Date.parse(run.updated_at) < Date.parse(run.created_at)
  ) {
    throw new StagingRecoveryGitHubError();
  }
  return {
    runId: run.id,
    runAttempt: 1,
    workflowId: run.workflow_id,
    workflowCommit: run.head_sha,
    createdAt: run.created_at,
    updatedAt: run.updated_at,
  };
};

const readArtifact = async (
  api: GitHubReleaseApi,
  run: z.infer<typeof runSchema>,
  name: VerifiedStagingArtifact["name"],
  now: Date,
): Promise<VerifiedStagingArtifact> => {
  const response = parse(
    artifactsSchema,
    await api.get({
      path: repositoryPath(`actions/runs/${run.id}/artifacts`),
      query: { page: "1", per_page: "100" },
    }),
  );
  const matches = response.artifacts.filter((artifact) => artifact.name === name);
  const artifact = matches[0];
  const digest = z
    .string()
    .regex(/^sha256:[a-f0-9]{64}$/u)
    .safeParse(artifact?.digest);
  if (
    response.total_count !== response.artifacts.length ||
    matches.length !== 1 ||
    artifact === undefined ||
    !digest.success ||
    artifact.expired ||
    artifact.workflow_run.id !== run.id ||
    artifact.workflow_run.head_branch !== "stage" ||
    artifact.workflow_run.head_sha !== run.head_sha ||
    Date.parse(artifact.created_at) < Date.parse(run.created_at) ||
    Date.parse(artifact.updated_at) < Date.parse(artifact.created_at) ||
    Date.parse(artifact.expires_at) <= now.getTime()
  ) {
    throw new StagingRecoveryGitHubError();
  }
  return {
    artifactId: artifact.id,
    name,
    digest: digest.data as `sha256:${string}`,
    sizeInBytes: artifact.size_in_bytes,
    expiresAt: artifact.expires_at,
  };
};

export async function verifyStagingRecoveryInvocation(
  api: GitHubReleaseApi,
  runtime: GitHubRuntimeEnvironment,
): Promise<VerifiedStagingRecoveryInvocation> {
  if (
    runtime.GITHUB_ACTIONS !== "true" ||
    runtime.GITHUB_EVENT_NAME !== "workflow_dispatch" ||
    runtime.GITHUB_REPOSITORY !== GITHUB_RELEASE_REPOSITORY ||
    runtime.GITHUB_REF !== "refs/heads/stage" ||
    runtime.GITHUB_REF_PROTECTED !== "true" ||
    runtime.GITHUB_RUN_ATTEMPT !== "1" ||
    runtime.GITHUB_WORKFLOW_REF !==
      `${GITHUB_RELEASE_REPOSITORY}/${STAGING_RECOVERY_WORKFLOW_PATH}@refs/heads/stage` ||
    runtime.GITHUB_WORKFLOW_SHA !== runtime.GITHUB_SHA ||
    !runtime.GITHUB_RUN_ID ||
    !/^[1-9][0-9]*$/u.test(runtime.GITHUB_RUN_ID) ||
    !runtime.GITHUB_SHA ||
    !fullCommit.safeParse(runtime.GITHUB_SHA).success
  ) {
    throw new StagingRecoveryGitHubError();
  }
  const runId = Number(runtime.GITHUB_RUN_ID);
  if (!Number.isSafeInteger(runId)) throw new StagingRecoveryGitHubError();
  const [run, workflow, branch, environment, policies] = await Promise.all([
    readRun(api, runId),
    readWorkflow(api, STAGING_RECOVERY_WORKFLOW_PATH),
    api.get({ path: repositoryPath("branches/stage") }).then((value) => parse(branchSchema, value)),
    api
      .get({ path: repositoryPath("environments/staging") })
      .then((value) => parse(environmentSchema, value)),
    api
      .get({
        path: repositoryPath("environments/staging/deployment-branch-policies"),
        query: { page: "1", per_page: "100" },
      })
      .then((value) => parse(branchPoliciesSchema, value)),
  ]);
  const verified = verifyRun(run, workflow, STAGING_RECOVERY_WORKFLOW_PATH);
  if (
    run.id !== runId ||
    run.status !== "in_progress" ||
    run.conclusion !== null ||
    verified.workflowCommit !== runtime.GITHUB_SHA ||
    branch.commit.sha !== runtime.GITHUB_SHA ||
    environment.name !== "staging"
  ) {
    throw new StagingRecoveryGitHubError();
  }
  return { ...verified, environmentPolicyId: policies.branch_policies[0].id };
}

export async function verifyStagingDiagnosticsArtifact(
  api: GitHubReleaseApi,
  input: { runId: number; now?: Date },
): Promise<{ run: VerifiedStagingRecoveryRun; artifact: VerifiedStagingArtifact }> {
  const now = input.now ?? new Date();
  if (!positiveInteger.safeParse(input.runId).success || !Number.isFinite(now.getTime()))
    throw new StagingRecoveryGitHubError();
  const [run, workflow] = await Promise.all([
    readRun(api, input.runId),
    readWorkflow(api, ".github/workflows/release-rehearsal.yml"),
  ]);
  const verified = verifyRun(run, workflow, ".github/workflows/release-rehearsal.yml");
  if (run.status !== "completed" || run.conclusion !== "success")
    throw new StagingRecoveryGitHubError();
  return {
    run: verified,
    artifact: await readArtifact(api, run, STAGING_DIAGNOSTICS_ARTIFACT_NAME, now),
  };
}

const verifyRecoveryArtifact = async (
  api: GitHubReleaseApi,
  run: z.infer<typeof runSchema>,
  now: Date,
) => readArtifact(api, run, STAGING_RECOVERY_ARTIFACT_NAME, now);

export type VerifiedStagingRecoveryHistory =
  | {
      mode: "fresh";
      completed?: { run: VerifiedStagingRecoveryRun; artifact: VerifiedStagingArtifact };
    }
  | { mode: "resume"; run: VerifiedStagingRecoveryRun; artifact: VerifiedStagingArtifact };

export async function verifyStagingRecoveryHistory(
  api: GitHubReleaseApi,
  input: {
    current: VerifiedStagingRecoveryInvocation;
    resumeRecoveryRunId?: number;
    now?: Date;
  },
): Promise<VerifiedStagingRecoveryHistory> {
  const now = input.now ?? new Date();
  if (
    !Number.isFinite(now.getTime()) ||
    (input.resumeRecoveryRunId !== undefined &&
      (!positiveInteger.safeParse(input.resumeRecoveryRunId).success ||
        input.resumeRecoveryRunId >= input.current.runId))
  ) {
    throw new StagingRecoveryGitHubError();
  }
  const workflow = await readWorkflow(api, STAGING_RECOVERY_WORKFLOW_PATH);
  const runs: z.infer<typeof runSchema>[] = [];
  let total: number | undefined;
  for (let page = 1; page <= 3; page += 1) {
    const response = parse(
      runsSchema,
      await api.get({
        path: repositoryPath(`actions/workflows/${STAGING_RECOVERY_WORKFLOW_PATH}/runs`),
        query: {
          branch: "stage",
          event: "workflow_dispatch",
          page: String(page),
          per_page: "100",
        },
      }),
    );
    total ??= response.total_count;
    if (response.total_count !== total) throw new StagingRecoveryGitHubError();
    runs.push(...response.workflow_runs);
    if (runs.length >= total) break;
  }
  if (total === undefined || total !== runs.length || total > 300)
    throw new StagingRecoveryGitHubError();
  const unique = new Set(runs.map(({ id }) => id));
  if (unique.size !== runs.length) throw new StagingRecoveryGitHubError();
  const currentIndex = runs.findIndex(
    ({ id, run_attempt }) => id === input.current.runId && run_attempt === 1,
  );
  if (currentIndex < 0) throw new StagingRecoveryGitHubError();
  for (const candidate of runs.slice(currentIndex + 1)) {
    const run = verifyRun(candidate, workflow, STAGING_RECOVERY_WORKFLOW_PATH);
    if (candidate.status !== "completed" || candidate.conclusion === null)
      throw new StagingRecoveryGitHubError();
    const jobs = parse(
      jobsSchema,
      await api.get({
        path: repositoryPath(`actions/runs/${run.runId}/attempts/1/jobs`),
        query: { page: "1", per_page: "100" },
      }),
    );
    const job = jobs.jobs[0];
    const steps = job?.steps.filter(({ name }) => name === STAGING_RECOVERY_STEP_NAME) ?? [];
    if (
      jobs.total_count !== 1 ||
      jobs.jobs.length !== 1 ||
      job === undefined ||
      job.name !== STAGING_RECOVERY_JOB_NAME ||
      job.head_sha !== run.workflowCommit ||
      job.status !== "completed" ||
      job.conclusion === null ||
      steps.length !== 1 ||
      steps[0].status !== "completed"
    ) {
      throw new StagingRecoveryGitHubError();
    }
    const step = steps[0];
    if (step.conclusion === "skipped") continue;
    const matchingOutcomes =
      (candidate.conclusion === "success" && job.conclusion === "success") ||
      (candidate.conclusion !== "success" && job.conclusion !== "success");
    if (step.conclusion === "success" && matchingOutcomes) {
      if (input.resumeRecoveryRunId !== undefined) throw new StagingRecoveryGitHubError();
      return {
        mode: "fresh",
        completed: {
          run,
          artifact: await verifyRecoveryArtifact(api, candidate, now),
        },
      };
    }
    if (input.resumeRecoveryRunId !== run.runId) throw new StagingRecoveryGitHubError();
    return {
      mode: "resume",
      run,
      artifact: await verifyRecoveryArtifact(api, candidate, now),
    };
  }
  if (input.resumeRecoveryRunId !== undefined) throw new StagingRecoveryGitHubError();
  return { mode: "fresh" };
}
