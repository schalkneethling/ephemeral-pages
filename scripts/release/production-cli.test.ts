import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { runProductionCli } from "./production-cli.ts";
import { preparedReleaseSchema } from "./prepare.ts";
import { approvalSchema } from "./production-record.ts";
import { approvalBytes } from "./production-approval.ts";
import { artifactHash } from "./artifact-contract.ts";
const mocks = vi.hoisted(() => ({
  context: vi.fn(),
  local: vi.fn(),
  prepare: vi.fn(),
  download: vi.fn(),
  extract: vi.fn(),
  factory: vi.fn(),
  run: vi.fn(),
  bind: vi.fn(),
  restore: vi.fn(),
  productionArtifact: vi.fn(),
}));
vi.mock("./production-context.ts", async (original) => ({
  ...(await original<typeof import("./production-context.ts")>()),
  verifyProductionContext: mocks.context,
  verifyLocalProductionEvidence: mocks.local,
}));
vi.mock("./prepare.ts", async (original) => ({
  ...(await original<typeof import("./prepare.ts")>()),
  prepareRelease: mocks.prepare,
}));
vi.mock("./github-release.ts", async (original) => ({
  ...(await original<typeof import("./github-release.ts")>()),
  downloadGitHubArtifact: mocks.download,
  extractVerifiedGitHubArtifact: mocks.extract,
  verifyProductionArtifact: mocks.productionArtifact,
}));
vi.mock("./production-providers.ts", () => ({
  createProductionProviderDependencies: mocks.factory,
}));
vi.mock("./production-runner.ts", () => ({ runProductionRelease: mocks.run }));
vi.mock("./production-authorization.ts", () => ({
  bindProductionProviderAuthorization: mocks.bind,
}));
vi.mock("./restore-release-artifacts.ts", () => ({
  restoreExtractedReleaseArtifacts: mocks.restore,
}));
const roots: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
beforeEach(() => {
  Object.values(mocks).forEach((mock) => mock.mockReset());
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "production-cli-"));
  roots.push(root);
  const repository = join(root, "repo"),
    workspace = join(root, "release");
  await mkdir(repository);
  const prepared = preparedReleaseSchema.parse(
    JSON.parse(
      await readFile(
        new URL(
          "../../docs/release-evidence/2026-09-10-staging/production-preparation.json",
          import.meta.url,
        ),
        "utf8",
      ),
    ),
  );
  const approval = approvalSchema.parse({
    schemaVersion: 1,
    operation: "release-approval",
    candidate: prepared.source.candidate,
    tree: prepared.source.tree,
    configurationFingerprint: "d".repeat(64),
    stagingPreparationSha256: "e".repeat(64),
    stagingRehearsalSha256: "f".repeat(64),
    affected: { netlify: true, cloudflare: true },
    compatibility: "compatible",
    migration: { artifactTag: "v1", expectedCurrentTag: "v1", change: "none" },
    recoveryOrder: ["netlify", "cloudflare"],
    baseline: {
      version: 1,
      environment: "production",
      providers: {
        netlify: {
          siteId: "site",
          sourceCommit: "a".repeat(40),
          publishedDeployId: "old-app",
          publishLocked: true,
        },
        cloudflare: {
          accountId: "account",
          workerName: "worker",
          sourceCommit: "b".repeat(40),
          deploymentId: "old-worker",
          traffic: [{ versionId: "old-version", percentage: 100 }],
        },
      },
    },
  });
  vi.stubEnv("GITHUB_RUN_ID", "101");
  vi.stubEnv("GITHUB_SHA", prepared.source.candidate);
  const flags = [
    "promote",
    "--promotion-pr",
    "50",
    "--rehearsal-run-id",
    "100",
    "--approval-sha256",
    artifactHash(approvalBytes(approval)),
    "--workspace",
    workspace,
  ];
  mocks.context.mockResolvedValue({
    current: { runId: 101, headSha: prepared.source.candidate },
    rehearsal: {
      artifact: { artifactId: 102, digest: `sha256:${"b".repeat(64)}`, sizeInBytes: 100 },
    },
    configuration: {},
  });
  mocks.local.mockResolvedValue({ approval, previous: undefined });
  mocks.download.mockResolvedValue(new Uint8Array(100));
  mocks.extract.mockImplementation(async (_bytes, directory) => {
    if (directory.endsWith("/approval")) {
      await mkdir(directory);
      await writeFile(join(directory, "approval.json"), approvalBytes(approval));
    } else {
      await mkdir(join(directory, "run"), { recursive: true });
      await mkdir(join(directory, "artifacts"), { recursive: true });
      await writeFile(join(directory, "run/production.json"), "{}\n");
      await writeFile(join(directory, "artifacts/prepared-release.json"), JSON.stringify(prepared));
    }
  });
  mocks.productionArtifact.mockResolvedValue({
    artifact: { artifactId: 103, digest: `sha256:${"c".repeat(64)}`, sizeInBytes: 100 },
  });
  mocks.prepare.mockImplementation(async ({ artifactDirectory }) => {
    await mkdir(artifactDirectory);
    await writeFile(join(artifactDirectory, "prepared-release.json"), JSON.stringify(prepared));
    return prepared;
  });
  mocks.factory.mockResolvedValue({ inspect: async () => ({}) });
  mocks.run.mockImplementation(async (_input, deps) => {
    await deps.inspect();
    return { outcome: "passed" };
  });
  return { repository, workspace, flags, prepared };
}
it("executes from the workspace created by credential-free preflight without rebuilding", async () => {
  const f = await fixture();
  await expect(runProductionCli(["preflight", ...f.flags], f.repository)).resolves.toMatchObject({
    outcome: "passed",
  });
  expect(mocks.factory).not.toHaveBeenCalled();
  expect(mocks.bind).not.toHaveBeenCalled();
  await expect(runProductionCli(["execute", ...f.flags], f.repository)).resolves.toMatchObject({
    outcome: "passed",
  });
  expect(mocks.prepare).toHaveBeenCalledTimes(1);
  expect(mocks.context).toHaveBeenCalledTimes(2);
  expect(mocks.local).toHaveBeenCalledTimes(2);
  expect(mocks.factory).toHaveBeenCalledTimes(1);
  expect(mocks.run).toHaveBeenCalledTimes(1);
});
it("blocks modified preflight evidence before provider authorization", async () => {
  const f = await fixture();
  await runProductionCli(["preflight", ...f.flags], f.repository);
  const path = join(f.workspace, "preflight.json"),
    record = JSON.parse(await readFile(path, "utf8"));
  record.runId = 999;
  await writeFile(path, JSON.stringify(record));
  await expect(runProductionCli(["execute", ...f.flags], f.repository)).rejects.toThrow(
    "Prepared evidence differs",
  );
  expect(mocks.factory).not.toHaveBeenCalled();
  expect(mocks.bind).not.toHaveBeenCalled();
});
it("rejects repeated preflight rather than overwriting retained evidence", async () => {
  const f = await fixture();
  await runProductionCli(["preflight", ...f.flags], f.repository);
  await expect(runProductionCli(["preflight", ...f.flags], f.repository)).rejects.toThrow();
  expect(mocks.prepare).toHaveBeenCalledTimes(1);
});

it("restores verified artifact modes before accepting a resume archive", async () => {
  const f = await fixture();
  const flags = ["resume", ...f.flags.slice(1), "--resume-run-id", "99"];

  await expect(runProductionCli(["preflight", ...flags], f.repository)).resolves.toMatchObject({
    outcome: "passed",
  });
  expect(mocks.restore).toHaveBeenCalledExactlyOnceWith(
    f.repository,
    join(f.workspace, "previous/artifacts"),
    expect.anything(),
  );
});

it("retains a runner record when execute-phase GitHub verification is temporarily unavailable", async () => {
  const f = await fixture();
  await runProductionCli(["preflight", ...f.flags], f.repository);
  const real =
    await vi.importActual<typeof import("./production-runner.ts")>("./production-runner.ts");
  mocks.run.mockImplementation(real.runProductionRelease);
  mocks.context.mockRejectedValue(new Error("Remote verification unavailable"));
  await expect(runProductionCli(["execute", ...f.flags], f.repository)).resolves.toMatchObject({
    outcome: "failed",
    stages: { inspect: "failed" },
  });
  const record = JSON.parse(await readFile(join(f.workspace, "run/production.json"), "utf8"));
  expect(record.runIds).toEqual([101]);
  expect(mocks.factory).not.toHaveBeenCalled();
  expect(mocks.bind).not.toHaveBeenCalled();
});

it("flushes a failed record and exits despite a lingering process handle", () => {
  const moduleUrl = new URL("./production-cli.ts", import.meta.url).href;
  const output = `${JSON.stringify({ outcome: "failed" })}\n`;
  const result = spawnSync(
    "bun",
    [
      "-e",
      `import { exitAfterProductionCliFailure } from ${JSON.stringify(moduleUrl)}; setInterval(() => {}, 60_000); exitAfterProductionCliFailure(${JSON.stringify(output)}, process.stdout);`,
    ],
    { encoding: "utf8", timeout: 5_000 },
  );

  expect(result.error).toBeUndefined();
  expect(result.status).toBe(1);
  expect(result.stdout).toBe(output);
});
