import { describe, expect, it } from "vitest";

import type {
  GitHubApiRequest,
  GitHubReleaseApi,
  GitHubRuntimeEnvironment,
} from "./github-release.ts";
import {
  STAGING_RECOVERY_ARTIFACT_NAME,
  STAGING_RECOVERY_STEP_NAME,
  STAGING_RECOVERY_WORKFLOW_PATH,
  verifyStagingDiagnosticsArtifact,
  verifyStagingRecoveryHistory,
  verifyStagingRecoveryInvocation,
} from "./staging-recovery-github.ts";

const sha = "a".repeat(40);
const now = new Date("2026-09-11T12:00:00.000Z");
const api = (handler: (request: GitHubApiRequest) => unknown): GitHubReleaseApi => ({
  get: async (request) => handler(request),
});
const workflow = (path: string, id: number) => ({ id, name: "workflow", path, state: "active" });
const run = (input: {
  id: number;
  workflowId: number;
  path: string;
  status?: string;
  conclusion?: string | null;
}) => ({
  id: input.id,
  run_attempt: 1,
  event: "workflow_dispatch",
  path: `${input.path}@stage`,
  head_branch: "stage",
  head_sha: sha,
  status: input.status ?? "completed",
  conclusion: input.conclusion === undefined ? "success" : input.conclusion,
  created_at: "2026-09-11T10:00:00.000Z",
  updated_at: "2026-09-11T10:30:00.000Z",
  workflow_id: input.workflowId,
  repository: { full_name: "schalkneethling/ephemeral-pages" },
});
const artifact = (runId: number, name: string) => ({
  id: 500 + runId,
  name,
  expired: false,
  size_in_bytes: 1024,
  digest: `sha256:${"b".repeat(64)}`,
  created_at: "2026-09-11T10:31:00.000Z",
  updated_at: "2026-09-11T10:32:00.000Z",
  expires_at: "2026-09-18T10:00:00.000Z",
  workflow_run: { id: runId, head_branch: "stage", head_sha: sha },
});
const runtime = (): GitHubRuntimeEnvironment => ({
  GITHUB_ACTIONS: "true",
  GITHUB_EVENT_NAME: "workflow_dispatch",
  GITHUB_REF: "refs/heads/stage",
  GITHUB_REF_PROTECTED: "true",
  GITHUB_REPOSITORY: "schalkneethling/ephemeral-pages",
  GITHUB_RUN_ATTEMPT: "1",
  GITHUB_RUN_ID: "101",
  GITHUB_SHA: sha,
  GITHUB_WORKFLOW_REF: `schalkneethling/ephemeral-pages/${STAGING_RECOVERY_WORKFLOW_PATH}@refs/heads/stage`,
  GITHUB_WORKFLOW_SHA: sha,
});

describe("staging recovery GitHub evidence", () => {
  it("verifies the exact protected stage recovery invocation and environment restriction", async () => {
    const client = api(({ path }) => {
      if (path.endsWith("/actions/runs/101"))
        return run({
          id: 101,
          workflowId: 12,
          path: STAGING_RECOVERY_WORKFLOW_PATH,
          status: "in_progress",
          conclusion: null,
        });
      if (path.endsWith(`/actions/workflows/${STAGING_RECOVERY_WORKFLOW_PATH}`))
        return workflow(STAGING_RECOVERY_WORKFLOW_PATH, 12);
      if (path.endsWith("/branches/stage")) return { protected: true, commit: { sha } };
      if (path.endsWith("/environments/staging"))
        return {
          name: "staging",
          deployment_branch_policy: {
            protected_branches: false,
            custom_branch_policies: true,
          },
        };
      if (path.endsWith("/environments/staging/deployment-branch-policies"))
        return { total_count: 1, branch_policies: [{ id: 80, name: "stage" }] };
      throw new Error(`unexpected ${path}`);
    });
    await expect(verifyStagingRecoveryInvocation(client, runtime())).resolves.toMatchObject({
      runId: 101,
      workflowCommit: sha,
      environmentPolicyId: 80,
    });
    await expect(
      verifyStagingRecoveryInvocation(client, {
        ...runtime(),
        GITHUB_WORKFLOW_REF:
          "schalkneethling/ephemeral-pages/.github/workflows/other.yml@refs/heads/stage",
      }),
    ).rejects.toThrow();
  });

  it("verifies a successful first-attempt diagnostics artifact without requiring current stage HEAD", async () => {
    const historicalSha = "c".repeat(40);
    const client = api(({ path }) => {
      if (path.endsWith("/actions/runs/70"))
        return {
          ...run({ id: 70, workflowId: 11, path: ".github/workflows/release-rehearsal.yml" }),
          head_sha: historicalSha,
        };
      if (path.endsWith("/actions/workflows/.github/workflows/release-rehearsal.yml"))
        return workflow(".github/workflows/release-rehearsal.yml", 11);
      if (path.endsWith("/actions/runs/70/artifacts")) {
        const value = artifact(70, "release-rehearsal-diagnostics");
        return {
          total_count: 1,
          artifacts: [
            { ...value, workflow_run: { ...value.workflow_run, head_sha: historicalSha } },
          ],
        };
      }
      throw new Error(`unexpected ${path}`);
    });
    await expect(
      verifyStagingDiagnosticsArtifact(client, { runId: 70, now }),
    ).resolves.toMatchObject({
      run: { runId: 70, workflowCommit: historicalSha },
      artifact: { name: "release-rehearsal-diagnostics" },
    });
  });

  it("ignores a proven skipped preflight and requires the latest possibly mutating run for resume", async () => {
    const current = {
      runId: 101,
      runAttempt: 1 as const,
      workflowId: 12,
      workflowCommit: sha,
      createdAt: "2026-09-11T11:00:00.000Z",
      updatedAt: "2026-09-11T11:01:00.000Z",
      environmentPolicyId: 80,
    };
    const currentRun = run({
      id: 101,
      workflowId: 12,
      path: STAGING_RECOVERY_WORKFLOW_PATH,
      status: "in_progress",
      conclusion: null,
    });
    const skipped = run({
      id: 100,
      workflowId: 12,
      path: STAGING_RECOVERY_WORKFLOW_PATH,
      conclusion: "failure",
    });
    const unresolved = run({
      id: 99,
      workflowId: 12,
      path: STAGING_RECOVERY_WORKFLOW_PATH,
      conclusion: "failure",
    });
    const job = (stepConclusion: string) => ({
      id: 700,
      name: "Staging recovery",
      head_sha: sha,
      status: "completed",
      conclusion: "failure",
      steps: [
        {
          name: STAGING_RECOVERY_STEP_NAME,
          status: "completed",
          conclusion: stepConclusion,
          number: 8,
        },
      ],
    });
    const client = api(({ path }) => {
      if (path.endsWith(`/actions/workflows/${STAGING_RECOVERY_WORKFLOW_PATH}`))
        return workflow(STAGING_RECOVERY_WORKFLOW_PATH, 12);
      if (path.endsWith(`/${STAGING_RECOVERY_WORKFLOW_PATH}/runs`))
        return { total_count: 3, workflow_runs: [currentRun, skipped, unresolved] };
      if (path.endsWith("/actions/runs/100/attempts/1/jobs"))
        return { total_count: 1, jobs: [job("skipped")] };
      if (path.endsWith("/actions/runs/99/attempts/1/jobs"))
        return { total_count: 1, jobs: [job("failure")] };
      if (path.endsWith("/actions/runs/99/artifacts"))
        return { total_count: 1, artifacts: [artifact(99, STAGING_RECOVERY_ARTIFACT_NAME)] };
      throw new Error(`unexpected ${path}`);
    });
    await expect(
      verifyStagingRecoveryHistory(client, { current, resumeRecoveryRunId: 99, now }),
    ).resolves.toMatchObject({ mode: "resume", run: { runId: 99 } });
    await expect(verifyStagingRecoveryHistory(client, { current, now })).rejects.toThrow();
  });
});
