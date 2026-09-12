import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { artifactHash } from "./artifact-contract.ts";
import { GitHubReleaseError } from "./github-release.ts";
import {
  exitAfterRehearsalWorkflowFailure,
  parseRehearsalWorkflowArguments,
  rehearsalWorkflowFailureCode,
  runRehearsalWorkflow,
} from "./rehearsal-workflow-cli.ts";

const sha = "a".repeat(40);
const prepared = {
  schemaVersion: 1,
  operation: "prepare",
  outcome: "passed",
  source: {
    candidate: sha,
    tree: "b".repeat(40),
    environment: "staging",
    configurationFingerprint: "c".repeat(64),
  },
  toolchain: { bun: "1.3.14" },
  artifacts: {
    netlify: { directory: "netlify", sha256: "d".repeat(64) },
    worker: { directory: "worker", sha256: "e".repeat(64) },
  },
} as const;
const mocks = vi.hoisted(() => ({ rehearse: vi.fn() }));

vi.mock("./github-release.ts", async (original) => ({
  ...(await original<typeof import("./github-release.ts")>()),
  createGitHubReleaseApi: () => ({}),
  verifyStagingInvocation: async () => ({ runId: 300, headSha: sha }),
}));
vi.mock("./rehearsal-cli.ts", () => ({ runRehearsalCli: mocks.rehearse }));

const roots: string[] = [];
beforeEach(() => {
  mocks.rehearse.mockReset().mockResolvedValue({ outcome: "passed" });
});
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const initializeWorkspace = async (workspace: string, calibrationOnly = true) => {
  await mkdir(join(workspace, "preflight"), { recursive: true });
  await mkdir(join(workspace, "artifacts"), { recursive: true });
  await Promise.all([
    writeFile(
      join(workspace, "preflight/rehearsal.json"),
      `${JSON.stringify({
        schemaVersion: 1,
        operation: "staging-rehearsal-preflight",
        runId: 300,
        workflowCommit: sha,
        calibrationOnly,
        preparationSha256: artifactHash(JSON.stringify(prepared)),
        outcome: "passed",
      })}\n`,
    ),
    writeFile(join(workspace, "artifacts/prepared-release.json"), `${JSON.stringify(prepared)}\n`),
  ]);
};

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

it("runs a calibration only from the sealed protected-run preparation", async () => {
  const root = await mkdtemp(join(tmpdir(), "rehearsal-calibration-"));
  roots.push(root);
  const repo = join(root, "repo");
  const workspace = join(root, "release");
  await mkdir(repo);
  await initializeWorkspace(workspace);

  await expect(
    runRehearsalWorkflow(
      ["--workspace", workspace, "--confirm-external-smoke", "--capture", "--calibration-only"],
      repo,
    ),
  ).resolves.toEqual({
    schemaVersion: 1,
    operation: "staging-calibration",
    outcome: "passed",
  });
  expect(mocks.rehearse).toHaveBeenCalledOnce();
});

it.each(["mode", "preparation", "candidate"] as const)(
  "blocks changed %s preflight evidence before the provider runner",
  async (change) => {
    const root = await mkdtemp(join(tmpdir(), "rehearsal-sealed-preflight-"));
    roots.push(root);
    const repo = join(root, "repo");
    const workspace = join(root, "release");
    await mkdir(repo);
    await initializeWorkspace(workspace, change === "mode" ? false : true);
    if (change === "preparation") {
      const changed = {
        ...prepared,
        artifacts: {
          ...prepared.artifacts,
          worker: { ...prepared.artifacts.worker, sha256: "f".repeat(64) },
        },
      };
      await writeFile(
        join(workspace, "artifacts/prepared-release.json"),
        `${JSON.stringify(changed)}\n`,
      );
    } else if (change === "candidate") {
      const changed = {
        ...prepared,
        source: { ...prepared.source, candidate: "f".repeat(40) },
      };
      const preflight = {
        schemaVersion: 1,
        operation: "staging-rehearsal-preflight",
        runId: 300,
        workflowCommit: sha,
        calibrationOnly: true,
        preparationSha256: artifactHash(JSON.stringify(changed)),
        outcome: "passed",
      };
      await Promise.all([
        writeFile(
          join(workspace, "artifacts/prepared-release.json"),
          `${JSON.stringify(changed)}\n`,
        ),
        writeFile(join(workspace, "preflight/rehearsal.json"), `${JSON.stringify(preflight)}\n`),
      ]);
    }
    await expect(
      runRehearsalWorkflow(
        ["--workspace", workspace, "--confirm-external-smoke", "--capture", "--calibration-only"],
        repo,
      ),
    ).rejects.toThrow();
    expect(mocks.rehearse).not.toHaveBeenCalled();
  },
);

it("reports only a bounded diagnostic code for GitHub evidence failures", () => {
  expect(rehearsalWorkflowFailureCode(new GitHubReleaseError("source"))).toBe("github-source");
  expect(rehearsalWorkflowFailureCode(new Error("secret-value"))).toBe("rehearsal-blocked");
});

it("exits after the sanitized failure message flushes even while another handle is active", () => {
  let flushed: (() => void) | undefined;
  const write = vi.fn((_message: string, callback: () => void) => {
    flushed = callback;
    return true;
  });
  const exit = vi.fn();
  const activeHandle = setInterval(() => undefined, 60_000);
  try {
    exitAfterRehearsalWorkflowFailure(new Error("secret-value"), { write }, exit);
    expect(write).toHaveBeenCalledWith(
      "Staging rehearsal blocked (rehearsal-blocked); inspect sanitized workflow reports.\n",
      expect.any(Function),
    );
    expect(exit).not.toHaveBeenCalled();
    flushed?.();
    expect(exit).toHaveBeenCalledExactlyOnceWith(1);
  } finally {
    clearInterval(activeHandle);
  }
});
