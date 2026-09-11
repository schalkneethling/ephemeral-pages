import { beforeEach, expect, it, vi } from "vitest";
import { verifyProductionContext } from "./production-context.ts";
import type { GitHubRuntimeEnvironment } from "./github-release.ts";
const mocks = vi.hoisted(() => ({
  read: vi.fn(),
  api: vi.fn(),
  invoke: vi.fn(),
  git: vi.fn(),
  promotion: vi.fn(),
  ci: vi.fn(),
  rehearsal: vi.fn(),
  prior: vi.fn(),
}));
vi.mock("./files.ts", () => ({ readReleaseJson: mocks.read }));
vi.mock("./production-approval.ts", async (original) => ({
  ...(await original<typeof import("./production-approval.ts")>()),
  gitReleaseValue: mocks.git,
}));
vi.mock("./github-release.ts", async (original) => ({
  ...(await original<typeof import("./github-release.ts")>()),
  createGitHubReleaseApi: mocks.api,
  verifyProductionInvocation: mocks.invoke,
  verifyPromotionEvidence: mocks.promotion,
  verifyCiValidation: mocks.ci,
  verifyRehearsalEvidence: mocks.rehearsal,
  inspectPreviousProductionRun: mocks.prior,
}));
const args = {
  operation: "promote" as const,
  promotionPr: 50,
  rehearsalRunId: 100,
  approvalSha256: "a".repeat(64),
  workspace: "/tmp/release",
};
beforeEach(() => {
  Object.values(mocks).forEach((mock) => mock.mockReset());
  mocks.read.mockImplementation(async (path: string) =>
    path.endsWith("production-policy.json")
      ? { productionEnabled: true, maximumEvidenceAgeHours: 168 }
      : {},
  );
  mocks.invoke.mockResolvedValue({ headSha: "b".repeat(40), runId: 101 });
  mocks.git.mockImplementation(async (_root, args: string[]) =>
    args[1] === "HEAD" ? "b".repeat(40) : "c".repeat(40),
  );
  mocks.api.mockReturnValue({});
  mocks.promotion.mockResolvedValue({ candidate: "c".repeat(40) });
});
it("blocks the default-off rollout before GitHub or provider operations", async () => {
  mocks.read.mockResolvedValue({ productionEnabled: false });
  await expect(
    verifyProductionContext("/repo", args, {} as GitHubRuntimeEnvironment, "token"),
  ).rejects.toThrow("not enabled");
  expect(mocks.api).not.toHaveBeenCalled();
});
it("rejects a checkout that differs from the trusted workflow commit", async () => {
  mocks.git.mockResolvedValue("d".repeat(40));
  await expect(
    verifyProductionContext("/repo", args, {} as GitHubRuntimeEnvironment, "token"),
  ).rejects.toThrow("Checked-out source");
  expect(mocks.promotion).not.toHaveBeenCalled();
});
it("requires promotion, exact CI, recent rehearsal and unresolved-run checks", async () => {
  await verifyProductionContext("/repo", args, {} as GitHubRuntimeEnvironment, "token");
  expect(mocks.ci).toHaveBeenCalledWith({}, "b".repeat(40));
  expect(mocks.rehearsal).toHaveBeenCalledWith(
    {},
    { runId: 100, candidate: "c".repeat(40), maximumAgeMs: 604800000 },
  );
  expect(mocks.prior).toHaveBeenCalledWith(
    {},
    { current: { headSha: "b".repeat(40), runId: 101 }, resumeRunId: undefined },
  );
});
it("does not bypass an unresolved prior run", async () => {
  mocks.prior.mockRejectedValue(new Error("Unresolved prior release"));
  await expect(
    verifyProductionContext("/repo", args, {} as GitHubRuntimeEnvironment, "token"),
  ).rejects.toThrow("Unresolved prior release");
});
