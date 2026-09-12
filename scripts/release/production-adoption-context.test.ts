import { beforeEach, expect, it, vi } from "vitest";

import type { GitHubRuntimeEnvironment } from "./github-release.ts";
import { verifyProductionAdoptionContext } from "./production-adoption-context.ts";
import { productionPolicySchema } from "./production-approval.ts";

const mocks = vi.hoisted(() => ({
  api: vi.fn(),
  ci: vi.fn(),
  diagnostics: vi.fn(),
  git: vi.fn(),
  invocation: vi.fn(),
  prior: vi.fn(),
  promotion: vi.fn(),
  read: vi.fn(),
}));

vi.mock("./files.ts", () => ({ readReleaseJson: mocks.read }));
vi.mock("./production-approval.ts", async (original) => ({
  ...(await original<typeof import("./production-approval.ts")>()),
  gitReleaseValue: mocks.git,
}));
vi.mock("./github-release.ts", async (original) => ({
  ...(await original<typeof import("./github-release.ts")>()),
  createGitHubReleaseApi: mocks.api,
  inspectPreviousProductionRun: mocks.prior,
  verifyCiValidation: mocks.ci,
  verifyProductionInvocation: mocks.invocation,
  verifyPromotionEvidence: mocks.promotion,
}));
vi.mock("./staging-recovery-github.ts", async (original) => ({
  ...(await original<typeof import("./staging-recovery-github.ts")>()),
  verifyStagingDiagnosticsArtifact: mocks.diagnostics,
}));

const args = {
  promotionPr: 12,
  rehearsalRunId: 34,
  workspace: "/tmp/adoption",
};

beforeEach(() => {
  Object.values(mocks).forEach((mock) => mock.mockReset());
  mocks.read.mockImplementation(async (path: string) =>
    path.endsWith("production-policy.json")
      ? {
          productionEnabled: false,
          adoptionEnabled: true,
          maximumEvidenceAgeHours: 168,
        }
      : { version: 1 },
  );
  mocks.api.mockReturnValue({});
  mocks.invocation.mockResolvedValue({ headSha: "a".repeat(40), runId: 50 });
  mocks.git.mockImplementation(async (_root, values: string[]) =>
    values.at(-1) === "HEAD" ? "a".repeat(40) : "b".repeat(40),
  );
  mocks.promotion.mockResolvedValue({ candidate: "b".repeat(40) });
  mocks.diagnostics.mockResolvedValue({
    run: {
      runId: 34,
      workflowCommit: "b".repeat(40),
      createdAt: new Date().toISOString(),
    },
    artifact: {},
  });
  mocks.prior.mockResolvedValue({ previous: null, requiredOperation: "none" });
});

it("blocks while the distinct adoption policy remains off", async () => {
  mocks.read.mockImplementation(async (path: string) =>
    path.endsWith("production-policy.json")
      ? { productionEnabled: false, adoptionEnabled: false, maximumEvidenceAgeHours: 168 }
      : { version: 1 },
  );
  await expect(
    verifyProductionAdoptionContext("/repo", args, {} as GitHubRuntimeEnvironment, "token"),
  ).rejects.toThrow("not enabled");
  expect(mocks.api).not.toHaveBeenCalled();
});

it("rejects enabling ordinary production and adoption together", () => {
  expect(() =>
    productionPolicySchema.parse({
      schemaVersion: 1,
      productionEnabled: true,
      adoptionEnabled: true,
      repository: "schalkneethling/ephemeral-pages",
      productionWorkflow: ".github/workflows/release-production.yml",
      rehearsalWorkflow: ".github/workflows/release-rehearsal.yml",
      maximumEvidenceAgeHours: 168,
    }),
  ).toThrow();
});

it("requires exact promotion, CI, diagnostics, and adoption-aware history", async () => {
  await verifyProductionAdoptionContext("/repo", args, {} as GitHubRuntimeEnvironment, "token");
  expect(mocks.promotion).toHaveBeenCalledWith(
    {},
    expect.objectContaining({ pullRequestNumber: 12, candidate: "b".repeat(40) }),
  );
  expect(mocks.ci).toHaveBeenCalledWith({}, "a".repeat(40));
  expect(mocks.diagnostics).toHaveBeenCalledWith({}, { runId: 34 });
  expect(mocks.prior).toHaveBeenCalledWith(
    {},
    expect.objectContaining({
      current: { headSha: "a".repeat(40), runId: 50 },
      adoption: { resumeAdoptionRunId: undefined },
      verifyCompletedAdoption: expect.any(Function),
    }),
  );
});

it("rejects staging evidence from another candidate", async () => {
  mocks.diagnostics.mockResolvedValue({
    run: {
      runId: 34,
      workflowCommit: "c".repeat(40),
      createdAt: new Date().toISOString(),
    },
    artifact: {},
  });
  await expect(
    verifyProductionAdoptionContext("/repo", args, {} as GitHubRuntimeEnvironment, "token"),
  ).rejects.toThrow("differs from promotion");
});
