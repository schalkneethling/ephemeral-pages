import { describe, expect, it } from "vitest";

import {
  GITHUB_RELEASE_ACTIVATION_STEP_NAME,
  GITHUB_RELEASE_ADOPTION_STEP_NAME,
  GITHUB_RELEASE_PRODUCTION_JOB_NAME,
  GITHUB_RELEASE_RECOVERY_STEP_NAME,
  GITHUB_RELEASE_REPOSITORY,
  GITHUB_RELEASE_WORKFLOWS,
  type GitHubApiRequest,
  type GitHubReleaseApi,
  type VerifiedProductionInvocation,
} from "./github-release.ts";
import { verifyRecoveryHistory } from "./recovery-github.ts";

const commit = "b".repeat(40);
const digest = `sha256:${"d".repeat(64)}`;
const now = new Date("2026-09-11T12:00:00.000Z");

const current: VerifiedProductionInvocation = {
  runId: 101,
  runAttempt: 1,
  workflowId: 10,
  workflowPath: GITHUB_RELEASE_WORKFLOWS.production,
  branch: "main",
  headSha: commit,
  createdAt: "2026-09-11T11:00:00.000Z",
  updatedAt: "2026-09-11T11:01:00.000Z",
  environment: { name: "production", branch: "main", policyId: 801 },
};

type PriorRun = {
  id: number;
  conclusion: "success" | "failure" | "cancelled";
  activation: "success" | "failure" | "cancelled" | "skipped";
  recovery: "success" | "failure" | "cancelled" | "skipped";
  createdAt: string;
  attempt?: number;
  earlierActivation?: PriorRun["activation"];
};

const workflowRun = (prior: PriorRun | { id: 101; createdAt: string }) => ({
  id: prior.id,
  run_attempt: "attempt" in prior ? (prior.attempt ?? 1) : 1,
  event: "workflow_dispatch",
  status: prior.id === 101 ? "in_progress" : "completed",
  conclusion: "conclusion" in prior ? prior.conclusion : null,
  head_branch: "main",
  head_sha: commit,
  path: `${GITHUB_RELEASE_WORKFLOWS.production}@main`,
  workflow_id: 10,
  created_at: prior.createdAt,
  updated_at: "2026-09-11T10:30:00.000Z",
  repository: { full_name: GITHUB_RELEASE_REPOSITORY },
});

const github = (runs: readonly PriorRun[], expiredRunId?: number): GitHubReleaseApi => ({
  get: async (request: GitHubApiRequest) => {
    if (request.path.endsWith("/actions/workflows/release-production.yml")) {
      return { id: 10, path: GITHUB_RELEASE_WORKFLOWS.production, state: "active" };
    }
    if (request.path.endsWith("/actions/workflows/release-production.yml/runs")) {
      return {
        total_count: runs.length + 1,
        workflow_runs: [
          workflowRun({ id: 101, createdAt: "2026-09-11T11:00:00.000Z" }),
          ...runs.map(workflowRun),
        ],
      };
    }
    const jobsMatch = request.path.match(/\/actions\/runs\/(\d+)\/attempts\/(\d+)\/jobs$/u);
    if (jobsMatch) {
      const prior = runs.find(({ id }) => id === Number(jobsMatch[1]));
      if (!prior) throw new Error("unexpected test job");
      return {
        total_count: 1,
        jobs: [
          {
            id: prior.id + 700,
            name: GITHUB_RELEASE_PRODUCTION_JOB_NAME,
            head_sha: commit,
            status: "completed",
            conclusion: prior.conclusion,
            steps: [
              {
                name: GITHUB_RELEASE_ACTIVATION_STEP_NAME,
                status: "completed",
                conclusion:
                  Number(jobsMatch[2]) === 1
                    ? (prior.earlierActivation ?? prior.activation)
                    : prior.activation,
                number: 8,
              },
              {
                name: GITHUB_RELEASE_RECOVERY_STEP_NAME,
                status: "completed",
                conclusion: prior.recovery,
                number: 9,
              },
              {
                name: GITHUB_RELEASE_ADOPTION_STEP_NAME,
                status: "completed",
                conclusion: "skipped",
                number: 10,
              },
            ],
          },
        ],
      };
    }
    const artifactMatch = request.path.match(/\/actions\/runs\/(\d+)\/artifacts$/u);
    if (artifactMatch) {
      const runId = Number(artifactMatch[1]);
      return {
        total_count: 1,
        artifacts: [
          {
            id: runId + 900,
            name: "release-production",
            size_in_bytes: 2048,
            expired: runId === expiredRunId,
            created_at: "2026-09-11T10:31:00.000Z",
            updated_at: "2026-09-11T10:32:00.000Z",
            expires_at: "2026-09-18T10:32:00.000Z",
            digest,
            workflow_run: { id: runId, head_branch: "main", head_sha: commit },
          },
        ],
      };
    }
    const runMatch = request.path.match(/\/actions\/runs\/(\d+)$/u);
    if (runMatch) {
      const prior = runs.find(({ id }) => id === Number(runMatch[1]));
      if (prior) return workflowRun(prior);
    }
    throw new Error(`unexpected test request: ${request.path}`);
  },
});

describe("recovery GitHub history", () => {
  it("rejects rerun history with missing adoption evidence", async () => {
    const base = github([
      {
        id: 100,
        attempt: 2,
        conclusion: "failure",
        activation: "skipped",
        recovery: "skipped",
        createdAt: "2026-09-11T10:00:00.000Z",
      },
      {
        id: 99,
        conclusion: "failure",
        activation: "failure",
        recovery: "skipped",
        createdAt: "2026-09-11T09:00:00.000Z",
      },
    ]);
    const api: GitHubReleaseApi = {
      get: async (request) => {
        const result = await base.get(request);
        if (request.path.endsWith("/runs/100/attempts/1/jobs")) {
          const jobs = result as { jobs: { steps: { name: string }[] }[] };
          jobs.jobs[0]!.steps = jobs.jobs[0]!.steps.filter(
            (step) => step.name !== GITHUB_RELEASE_ADOPTION_STEP_NAME,
          );
        }
        return result;
      },
    };
    await expect(
      verifyRecoveryHistory(api, { current, recoverySourceRunId: 99, now }),
    ).rejects.toMatchObject({ kind: "resume" });
  });
  it.each([GITHUB_RELEASE_RECOVERY_STEP_NAME, GITHUB_RELEASE_ADOPTION_STEP_NAME])(
    "rejects a rerun when an earlier attempt reached %s",
    async (name) => {
      const base = github([
        {
          id: 100,
          attempt: 2,
          conclusion: "failure",
          activation: "skipped",
          recovery: "skipped",
          createdAt: "2026-09-11T10:00:00.000Z",
        },
        {
          id: 99,
          conclusion: "failure",
          activation: "failure",
          recovery: "skipped",
          createdAt: "2026-09-11T09:00:00.000Z",
        },
      ]);
      const api: GitHubReleaseApi = {
        get: async (request) => {
          const result = await base.get(request);
          if (request.path.endsWith("/runs/100/attempts/1/jobs")) {
            const jobs = result as {
              jobs: {
                steps: { name: string; status: string; conclusion: string; number: number }[];
              }[];
            };
            const steps = jobs.jobs[0]!.steps;
            const existing = steps.find((step) => step.name === name);
            if (existing) existing.conclusion = "failure";
            else steps.push({ name, status: "completed", conclusion: "failure", number: 10 });
          }
          return result;
        },
      };
      await expect(
        verifyRecoveryHistory(api, { current, recoverySourceRunId: 99, now }),
      ).rejects.toMatchObject({ kind: "resume" });
    },
  );
  it.each(["skipped", "failure", "success"] as const)(
    "checks every rerun attempt before skipping preflight-only history: %s",
    async (earlierActivation) => {
      const skipped: PriorRun = {
        id: 100,
        attempt: 2,
        conclusion: "failure",
        activation: "skipped",
        earlierActivation,
        recovery: "skipped",
        createdAt: "2026-09-11T10:00:00.000Z",
      };
      const source: PriorRun = {
        id: 99,
        conclusion: "failure",
        activation: "failure",
        recovery: "skipped",
        createdAt: "2026-09-11T09:00:00.000Z",
      };
      const result = verifyRecoveryHistory(github([skipped, source]), {
        current,
        recoverySourceRunId: 99,
        now,
      });
      if (earlierActivation === "skipped") {
        await expect(result).resolves.toMatchObject({
          evidenceRun: { runId: 99 },
          skippedPreflightRunIds: [100],
        });
      } else {
        await expect(result).rejects.toMatchObject({ kind: "resume" });
      }
    },
  );

  it.each([
    { conclusion: "success", activation: "success" },
    { conclusion: "failure", activation: "failure" },
    { conclusion: "cancelled", activation: "cancelled" },
  ] as const)(
    "selects an exact successful or failed release as a fresh recovery source",
    async (state) => {
      const source: PriorRun = {
        id: 99,
        conclusion: state.conclusion,
        activation: state.activation,
        recovery: "skipped",
        createdAt: "2026-09-11T09:00:00.000Z",
      };
      await expect(
        verifyRecoveryHistory(github([source]), {
          current,
          recoverySourceRunId: 99,
          now,
        }),
      ).resolves.toMatchObject({
        mode: "fresh",
        currentRunId: 101,
        sourceProductionRunId: 99,
        evidenceRun: { runId: 99 },
        artifact: { artifactId: 999, digest },
      });
    },
  );

  it("requires the latest interrupted recovery and retains its original source identity", async () => {
    const interrupted: PriorRun = {
      id: 99,
      conclusion: "failure",
      activation: "skipped",
      recovery: "failure",
      createdAt: "2026-09-11T09:00:00.000Z",
    };
    await expect(
      verifyRecoveryHistory(github([interrupted]), {
        current,
        recoverySourceRunId: 95,
        resumeRecoveryRunId: 99,
        now,
      }),
    ).resolves.toMatchObject({
      mode: "resume",
      sourceProductionRunId: 95,
      resumeRecoveryRunId: 99,
      evidenceRun: { runId: 99 },
      artifact: { artifactId: 999 },
    });
    await expect(
      verifyRecoveryHistory(github([interrupted]), {
        current,
        recoverySourceRunId: 95,
        now,
      }),
    ).rejects.toMatchObject({ kind: "resume" });
  });

  it("does not treat a completed recovery as another recovery source", async () => {
    const completed: PriorRun = {
      id: 99,
      conclusion: "success",
      activation: "skipped",
      recovery: "success",
      createdAt: "2026-09-11T09:00:00.000Z",
    };
    await expect(
      verifyRecoveryHistory(github([completed]), {
        current,
        recoverySourceRunId: 95,
        now,
      }),
    ).rejects.toMatchObject({ kind: "resume" });
  });

  it("skips only proven no-mutation preflight failures before selecting recovery evidence", async () => {
    const skipped: PriorRun = {
      id: 99,
      conclusion: "failure",
      activation: "skipped",
      recovery: "skipped",
      createdAt: "2026-09-11T10:00:00.000Z",
    };
    const interrupted: PriorRun = {
      id: 95,
      conclusion: "failure",
      activation: "skipped",
      recovery: "failure",
      createdAt: "2026-09-11T09:00:00.000Z",
    };
    await expect(
      verifyRecoveryHistory(github([skipped, interrupted]), {
        current,
        recoverySourceRunId: 90,
        resumeRecoveryRunId: 95,
        now,
      }),
    ).resolves.toMatchObject({
      mode: "resume",
      skippedPreflightRunIds: [99],
      evidenceRun: { runId: 95 },
    });
  });

  it("rejects a non-latest source and expired retained evidence", async () => {
    const source: PriorRun = {
      id: 99,
      conclusion: "failure",
      activation: "failure",
      recovery: "skipped",
      createdAt: "2026-09-11T09:00:00.000Z",
    };
    await expect(
      verifyRecoveryHistory(github([source]), {
        current,
        recoverySourceRunId: 98,
        now,
      }),
    ).rejects.toMatchObject({ kind: "resume" });
    await expect(
      verifyRecoveryHistory(github([source], 99), {
        current,
        recoverySourceRunId: 99,
        now,
      }),
    ).rejects.toMatchObject({ kind: "resume" });
  });
});
