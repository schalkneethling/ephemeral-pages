import { mkdtemp, mkdir, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { assertExternalArtifactDirectory } from "./artifact-contract.ts";
import { verifyProductionWorkspace } from "./production-workspace.ts";
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
it("accepts the retained workspace after exclusive preflight creation", async () => {
  const root = await mkdtemp(join(tmpdir(), "production-workspace-"));
  roots.push(root);
  const repository = join(root, "repo"),
    workspace = join(root, "workspace");
  await mkdir(repository);
  await assertExternalArtifactDirectory(repository, workspace);
  await mkdir(workspace);
  await expect(verifyProductionWorkspace(repository, workspace)).resolves.toBeUndefined();
  await expect(assertExternalArtifactDirectory(repository, workspace)).rejects.toThrow();
});
it("rejects a workspace symlink or one contained in the repository", async () => {
  const root = await mkdtemp(join(tmpdir(), "production-workspace-"));
  roots.push(root);
  const repo = join(root, "repo"),
    outside = join(root, "outside"),
    link = join(root, "link");
  await mkdir(repo);
  await mkdir(outside);
  await symlink(outside, link);
  await expect(verifyProductionWorkspace(repo, link)).rejects.toThrow();
  await expect(verifyProductionWorkspace(repo, repo)).rejects.toThrow();
});
