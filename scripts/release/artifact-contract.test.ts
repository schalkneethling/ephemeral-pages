import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  artifactBuildEnvironment,
  assertExternalArtifactDirectory,
  rejectLocalBuildInputs,
  verifyArtifactSource,
} from "./artifact-contract.ts";
import { parsePrepareArguments } from "./prepare-args.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function fixture() {
  const parent = await mkdtemp(join(tmpdir(), "release-contract-"));
  roots.push(parent);
  const repository = join(parent, "repo");
  await mkdir(repository);
  await mkdir(join(repository, "collaboration-worker"));
  return { parent, repository };
}
describe("artifact preparation boundary", () => {
  it("rejects output redirected into the repository through a symlink", async () => {
    const { parent, repository } = await fixture();
    await symlink(repository, join(parent, "alias"));
    await expect(
      assertExternalArtifactDirectory(repository, join(parent, "alias/output")),
    ).rejects.toThrow();
    await expect(
      assertExternalArtifactDirectory(repository, join(parent, "new-output")),
    ).resolves.toBeUndefined();
    await expect(assertExternalArtifactDirectory(repository, repository)).rejects.toThrow();
  });
  it("never reuses an existing output path, including dangling symlinks", async () => {
    const { parent, repository } = await fixture();
    await symlink(join(parent, "missing"), join(parent, "output"));
    await expect(
      assertExternalArtifactDirectory(repository, join(parent, "output")),
    ).rejects.toThrow();
  });
  it("blocks local dotenv overrides without reading their values", async () => {
    const { repository } = await fixture();
    await expect(rejectLocalBuildInputs(repository)).resolves.toBeUndefined();
    await writeFile(join(repository, "collaboration-worker/.env.staging"), "IGNORED=fixture");
    await expect(rejectLocalBuildInputs(repository)).rejects.toThrow();
  });
  it("build environment includes only its explicit allowlist", () => {
    const environment = artifactBuildEnvironment("wss://worker.example.com");
    expect(
      Object.keys(environment).every((key) =>
        [
          "COLLABORATION_WEBSOCKET_URL",
          "CI",
          "PATH",
          "HOME",
          "TMPDIR",
          "LANG",
          "LC_ALL",
          "SYSTEMROOT",
        ].includes(key),
      ),
    ).toBe(true);
    expect(environment.COLLABORATION_WEBSOCKET_URL).toBe("wss://worker.example.com");
  });
  it("requires full candidate identity, explicit environment and a new output destination", () => {
    const args = [
      "--environment",
      "staging",
      "--candidate",
      "a".repeat(40),
      "--output",
      "../artifacts",
    ];
    expect(parsePrepareArguments(args, "/repo", "/repo")).toEqual({
      repositoryRoot: "/repo",
      environment: "staging",
      candidate: "a".repeat(40),
      artifactDirectory: "/artifacts",
    });
    expect(() => parsePrepareArguments(args.slice(0, -2), "/repo", "/repo")).toThrow();
    expect(() =>
      parsePrepareArguments([...args, "--config", "/elsewhere"], "/repo", "/repo"),
    ).toThrow();
    expect(() =>
      parsePrepareArguments(
        args.map((arg) => (arg === "a".repeat(40) ? "main" : arg)),
        "/repo",
        "/repo",
      ),
    ).toThrow();
  });
});

it("binds preparation to the clean candidate commit and rejects later source changes", async () => {
  const { repository } = await fixture();
  const { readFile } = await import("node:fs/promises");
  const { execFileSync } = await import("node:child_process");
  await mkdir(join(repository, "scripts/release"), { recursive: true });
  const currentRoot = new URL("../..", import.meta.url);
  await writeFile(
    join(repository, "scripts/release/environments.json"),
    await readFile(new URL("scripts/release/environments.json", currentRoot)),
  );
  await writeFile(join(repository, "collaboration-worker/wrangler.jsonc"), "{}\n");
  const git = (args: string[]) =>
    execFileSync("git", args, {
      cwd: repository,
      encoding: "utf8",
      env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
    }).trim();
  git(["init", "-q"]);
  git(["add", "."]);
  git([
    "-c",
    "user.name=Release test",
    "-c",
    "user.email=release@example.invalid",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "-qm",
    "fixture",
  ]);
  const commit = git(["rev-parse", "HEAD"]);
  const originalGitDirectory = process.env.GIT_DIR;
  const originalGitWorkTree = process.env.GIT_WORK_TREE;
  try {
    // These values redirect ordinary Git commands. Verification uses an
    // allowlisted environment and must remain bound to its explicit cwd.
    process.env.GIT_DIR = join(repository, "attacker-git-dir");
    process.env.GIT_WORK_TREE = join(repository, "attacker-worktree");
    await expect(verifyArtifactSource(repository, commit, "staging")).resolves.toMatchObject({
      source: { candidate: commit, environment: "staging" },
    });
  } finally {
    if (originalGitDirectory === undefined) delete process.env.GIT_DIR;
    else process.env.GIT_DIR = originalGitDirectory;
    if (originalGitWorkTree === undefined) delete process.env.GIT_WORK_TREE;
    else process.env.GIT_WORK_TREE = originalGitWorkTree;
  }
  await writeFile(join(repository, "collaboration-worker/wrangler.jsonc"), '{"changed":true}\n');
  await expect(verifyArtifactSource(repository, commit, "staging")).rejects.toMatchObject({
    kind: "candidate",
  });
});
