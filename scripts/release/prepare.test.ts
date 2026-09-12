import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createCandidateCheckout } from "./prepare.ts";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const git = (cwd: string, args: string[]): string =>
  execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
  }).trim();

describe("candidate preparation checkout", () => {
  it("builds from a detached copied candidate after the caller worktree changes", async () => {
    const parent = await mkdtemp(join(tmpdir(), "release-candidate-test-"));
    roots.push(parent);
    const repository = join(parent, "repository");
    await mkdir(repository);
    await writeFile(join(repository, "frozen.txt"), "candidate contents\n");
    git(repository, ["init", "-q"]);
    git(repository, ["add", "."]);
    git(repository, [
      "-c",
      "user.name=Release test",
      "-c",
      "user.email=release@example.invalid",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "-qm",
      "candidate",
    ]);
    const candidate = git(repository, ["rev-parse", "HEAD"]);
    const checkout = await createCandidateCheckout(repository, candidate);
    try {
      await writeFile(join(repository, "frozen.txt"), "caller changed\n");
      expect(await readFile(join(checkout.repositoryRoot, "frozen.txt"), "utf8")).toBe(
        "candidate contents\n",
      );
      expect(git(checkout.repositoryRoot, ["rev-parse", "--abbrev-ref", "HEAD"])).toBe("HEAD");
      expect(git(checkout.repositoryRoot, ["rev-parse", "HEAD"])).toBe(candidate);
    } finally {
      const directory = checkout.repositoryRoot;
      await checkout.remove();
      await expect(readFile(join(directory, "frozen.txt"))).rejects.toThrow();
    }
  });
});
