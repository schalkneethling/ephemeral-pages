import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { artifactHash } from "./artifact-contract.ts";
import { preparedReleaseSchema } from "./prepare.ts";
import { releaseConfigSchema } from "./schema.ts";
import {
  approvalBytes,
  successfulRehearsalSchema,
  validateApprovalBundle,
} from "./production-approval.ts";
import { approvalSchema } from "./production-record.ts";
const { run } = vi.hoisted(() => ({ run: vi.fn() }));
vi.mock("./command.ts", () => ({ runCommand: run }));
const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});
beforeEach(() => {
  run.mockReset();
});
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "production-approval-"));
  directories.push(directory);
  const config = releaseConfigSchema.parse(
    JSON.parse(await readFile(new URL("./environments.json", import.meta.url), "utf8")),
  );
  const prepared = preparedReleaseSchema.parse(
    JSON.parse(
      await readFile(
        new URL(
          "../../docs/release-evidence/2026-09-10-staging/staging-preparation.json",
          import.meta.url,
        ),
        "utf8",
      ),
    ),
  );
  const rehearsal = successfulRehearsalSchema.parse(
    JSON.parse(
      await readFile(
        new URL("../../docs/release-evidence/2026-09-10-staging/rehearsal.json", import.meta.url),
        "utf8",
      ),
    ),
  );
  const workerConfig = (
    await readFile(new URL("../../collaboration-worker/wrangler.jsonc", import.meta.url), "utf8")
  ).trim();
  prepared.source.configurationFingerprint = artifactHash(
    JSON.stringify({ target: config.environments.staging, workerConfig }),
  );
  rehearsal.source = structuredClone(prepared.source);
  rehearsal.preparationSha256 = artifactHash(JSON.stringify(prepared));
  const production = config.environments.production;
  const approval = approvalSchema.parse({
    schemaVersion: 1,
    operation: "release-approval",
    candidate: prepared.source.candidate,
    tree: prepared.source.tree,
    configurationFingerprint: artifactHash(JSON.stringify(config)),
    stagingPreparationSha256: artifactHash(JSON.stringify(prepared)),
    stagingRehearsalSha256: artifactHash(JSON.stringify(rehearsal)),
    baseline: {
      version: 1,
      environment: "production",
      providers: {
        netlify: {
          siteId: production.netlify!.siteId,
          sourceCommit: "a".repeat(40),
          publishedDeployId: "old-app",
          publishLocked: true,
        },
        cloudflare: {
          accountId: production.cloudflare!.accountId,
          workerName: production.cloudflare!.workerName,
          sourceCommit: "b".repeat(40),
          deploymentId: "old-worker",
          traffic: [{ versionId: "old-version", percentage: 100 }],
        },
      },
    },
    affected: { netlify: true, cloudflare: true },
    compatibility: "compatible",
    migration: { artifactTag: "v1", expectedCurrentTag: "v1", change: "none" },
    recoveryOrder: ["netlify", "cloudflare"],
  });
  run.mockImplementation(async (_command, args: string[]) => ({
    exitCode: 0,
    stdout:
      args[0] === "diff"
        ? "package.json\0"
        : args[0] === "show"
          ? args[1].endsWith("environments.json")
            ? JSON.stringify(config)
            : workerConfig
          : approval.tree + "\n",
    stderr: "",
  }));
  const save = async () => {
    const bytes = approvalBytes(approval);
    await Promise.all([
      writeFile(join(directory, "approval.json"), bytes),
      writeFile(join(directory, "staging-preparation.json"), JSON.stringify(prepared)),
      writeFile(join(directory, "rehearsal.json"), JSON.stringify(rehearsal)),
    ]);
    return artifactHash(bytes);
  };
  return { directory, config, prepared, rehearsal, approval, save, workerConfig };
}
it("binds canonical approval, rehearsal and independent live-service source commits", async () => {
  const f = await fixture();
  await expect(
    validateApprovalBundle("/repository", f.directory, await f.save(), f.config),
  ).resolves.toMatchObject({ approval: f.approval });
  const diffs = run.mock.calls.filter((call) => call[1][0] === "diff");
  expect(diffs.map((call) => call[1][4])).toEqual(["a".repeat(40), "b".repeat(40)]);
});
it.each(["candidate", "tree", "configuration", "artifact", "observed-pair", "affected"])(
  "rejects changed %s evidence",
  async (kind) => {
    const f = await fixture();
    if (kind === "candidate") f.prepared.source.candidate = "c".repeat(40);
    if (kind === "tree") f.prepared.source.tree = "d".repeat(40);
    if (kind === "configuration")
      f.config.environments.production.netlify!.expectedNonSecretVariables.PUBLIC_BASE_URL =
        "https://different.example";
    if (kind === "artifact") f.prepared.artifacts.netlify.sha256 = "e".repeat(64);
    if (kind === "observed-pair") f.rehearsal.observedPair.workerVersionId = "different";
    if (kind === "affected") f.approval.affected.netlify = false;
    await expect(
      validateApprovalBundle("/repository", f.directory, await f.save(), f.config),
    ).rejects.toThrow();
  },
);
it("does not trim a leading space from a changed source filename", async () => {
  const f = await fixture();
  run.mockImplementation(async (_command, args: string[]) => ({
    exitCode: 0,
    stdout:
      args[0] === "diff"
        ? " docs/config.ts\0"
        : args[0] === "show"
          ? args[1].endsWith("environments.json")
            ? JSON.stringify(f.config)
            : f.workerConfig
          : f.approval.tree + "\n",
    stderr: "",
  }));
  await expect(
    validateApprovalBundle("/repository", f.directory, await f.save(), f.config),
  ).resolves.toBeDefined();
});
it("rejects even semantically equivalent bytes that were not approved", async () => {
  const f = await fixture();
  const sha = await f.save();
  await writeFile(join(f.directory, "approval.json"), JSON.stringify(f.approval));
  await expect(validateApprovalBundle("/repository", f.directory, sha, f.config)).rejects.toThrow(
    "Approval digest differs",
  );
});

it("rejects a worktree configuration absent from the approved Git tree", async () => {
  const f = await fixture();
  const candidateConfig = structuredClone(f.config);
  candidateConfig.environments.production.netlify!.expectedNonSecretVariables.PUBLIC_BASE_URL =
    "https://candidate.example";
  const original = run.getMockImplementation()!;
  run.mockImplementation(async (command, args: string[], options) =>
    args[0] === "show" && args[1].endsWith("environments.json")
      ? { exitCode: 0, stdout: JSON.stringify(candidateConfig), stderr: "" }
      : original(command, args, options),
  );
  await expect(
    validateApprovalBundle("/repository", f.directory, await f.save(), f.config),
  ).rejects.toThrow("Candidate configuration differs");
});
