import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { parseRehearsalWorkflowArguments, runRehearsalWorkflow } from "./rehearsal-workflow-cli.ts";
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
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
it("requires explicit quota authorization and an external workspace argument", () => {
  expect(
    parseRehearsalWorkflowArguments(
      ["--workspace", "new", "--confirm-external-smoke", "--capture"],
      "/tmp",
    ),
  ).toEqual({ workspace: "/tmp/new" });
  expect(() => parseRehearsalWorkflowArguments(["--workspace", "new"], "/tmp")).toThrow();
  expect(() =>
    parseRehearsalWorkflowArguments(
      ["--workspace", "new", "--workspace", "different", "--confirm-external-smoke", "--capture"],
      "/tmp",
    ),
  ).toThrow();
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
