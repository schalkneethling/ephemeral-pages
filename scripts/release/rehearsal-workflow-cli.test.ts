import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { GitHubReleaseError } from "./github-release.ts";
import {
  parseRehearsalWorkflowArguments,
  rehearsalWorkflowFailureCode,
  runRehearsalWorkflow,
} from "./rehearsal-workflow-cli.ts";
const mocks = vi.hoisted(() => ({ prepare: vi.fn(), rehearse: vi.fn() }));
vi.mock("./github-release.ts", async (original) => ({
  ...(await original<typeof import("./github-release.ts")>()),
  createGitHubReleaseApi: () => ({}),
  verifyStagingInvocation: async () => ({ headSha: "a".repeat(40) }),
}));
vi.mock("./prepare.ts", async (original) => ({
  ...(await original<typeof import("./prepare.ts")>()),
  prepareRelease: mocks.prepare,
}));
vi.mock("./rehearsal-cli.ts", () => ({ runRehearsalCli: mocks.rehearse }));
const roots: string[] = [];
beforeEach(() => {
  mocks.prepare.mockReset();
  mocks.rehearse.mockReset();
});
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
it("requires explicit quota authorization and an external workspace argument", () => {
  expect(
    parseRehearsalWorkflowArguments(
      ["--workspace", "new", "--confirm-external-smoke", "--capture"],
      "/tmp",
    ),
  ).toEqual({ workspace: "/tmp/new", calibrationOnly: false });
  expect(() => parseRehearsalWorkflowArguments(["--workspace", "new"], "/tmp")).toThrow();
  expect(() =>
    parseRehearsalWorkflowArguments(
      ["--workspace", "new", "--workspace", "different", "--confirm-external-smoke", "--capture"],
      "/tmp",
    ),
  ).toThrow();
});
it("runs a calibration without reading or issuing a production approval", async () => {
  const root = await mkdtemp(join(tmpdir(), "rehearsal-calibration-"));
  roots.push(root);
  const repo = join(root, "repo");
  await mkdir(repo);
  mocks.prepare.mockResolvedValue({ source: { candidate: "a".repeat(40) } });
  mocks.rehearse.mockResolvedValue({ outcome: "passed" });

  await expect(
    runRehearsalWorkflow(
      [
        "--workspace",
        join(root, "release"),
        "--confirm-external-smoke",
        "--capture",
        "--calibration-only",
      ],
      repo,
    ),
  ).resolves.toEqual({
    schemaVersion: 1,
    operation: "staging-calibration",
    outcome: "passed",
  });
  expect(mocks.prepare).toHaveBeenCalledOnce();
  expect(mocks.rehearse).toHaveBeenCalledOnce();
});
it("blocks a missing attributable production baseline before building or consuming quotas", async () => {
  const root = await mkdtemp(join(tmpdir(), "rehearsal-workflow-"));
  roots.push(root);
  const repo = join(root, "repo");
  await mkdir(repo);
  await expect(
    runRehearsalWorkflow(
      ["--workspace", join(root, "release"), "--confirm-external-smoke", "--capture"],
      repo,
    ),
  ).rejects.toThrow();
  expect(mocks.prepare).not.toHaveBeenCalled();
  expect(mocks.rehearse).not.toHaveBeenCalled();
});
it("reports only a bounded diagnostic code for GitHub evidence failures", () => {
  expect(rehearsalWorkflowFailureCode(new GitHubReleaseError("source"))).toBe("github-source");
  expect(rehearsalWorkflowFailureCode(new Error("secret-value"))).toBe("rehearsal-blocked");
});
