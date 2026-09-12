import { access, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { artifactHash } from "./artifact-contract.ts";
import {
  parseRehearsalPreflightArguments,
  runRehearsalPreflight,
} from "./rehearsal-preflight-cli.ts";

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
const mocks = vi.hoisted(() => ({
  history: vi.fn(),
  inspect: vi.fn(),
  prepare: vi.fn(),
}));

vi.mock("./github-release.ts", async (original) => ({
  ...(await original<typeof import("./github-release.ts")>()),
  createGitHubReleaseApi: () => ({}),
  verifyStagingInvocation: async () => ({ runId: 300, headSha: sha }),
}));
vi.mock("./prepare.ts", async (original) => ({
  ...(await original<typeof import("./prepare.ts")>()),
  prepareRelease: mocks.prepare,
}));
vi.mock("./rehearsal-cli.ts", () => ({
  inspectStagingDeploymentPair: mocks.inspect,
}));
vi.mock("./rehearsal-history.ts", async (original) => ({
  ...(await original<typeof import("./rehearsal-history.ts")>()),
  defaultRehearsalHistoryDependencies: (inspectCurrentPair: () => unknown) => ({
    inspectCurrentPair,
  }),
  verifyRehearsalHistory: mocks.history,
}));

const roots: string[] = [];
beforeEach(() => {
  mocks.history.mockReset().mockResolvedValue({ resolvedBy: "none", skippedReadOnlyRunIds: [] });
  mocks.inspect.mockReset();
  mocks.prepare.mockReset().mockResolvedValue(prepared);
});
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

it("accepts one external workspace and the exact calibration flag", () => {
  expect(parseRehearsalPreflightArguments(["--workspace", "release"], "/tmp")).toEqual({
    workspace: "/tmp/release",
    calibrationOnly: false,
  });
  expect(
    parseRehearsalPreflightArguments(["--workspace", "release", "--calibration-only"], "/tmp"),
  ).toEqual({ workspace: "/tmp/release", calibrationOnly: true });
  expect(() => parseRehearsalPreflightArguments([], "/tmp")).toThrow();
  expect(() =>
    parseRehearsalPreflightArguments(
      ["--workspace", "release", "--workspace", "different"],
      "/tmp",
    ),
  ).toThrow();
});

it("verifies history before preparation and seals the exact protected-run preparation", async () => {
  const parent = await mkdtemp(join(tmpdir(), "rehearsal-preflight-"));
  roots.push(parent);
  const repositoryRoot = join(parent, "repo");
  const workspace = join(parent, "workspace");
  await mkdir(repositoryRoot);
  const expected = {
    schemaVersion: 1,
    operation: "staging-rehearsal-preflight",
    runId: 300,
    workflowCommit: sha,
    calibrationOnly: true,
    preparationSha256: artifactHash(JSON.stringify(prepared)),
    outcome: "passed",
  };
  await expect(
    runRehearsalPreflight(["--workspace", workspace, "--calibration-only"], repositoryRoot),
  ).resolves.toEqual(expected);
  expect(JSON.parse(await readFile(join(workspace, "preflight/rehearsal.json"), "utf8"))).toEqual(
    expected,
  );
  expect(mocks.history).toHaveBeenCalledOnce();
  expect(mocks.history.mock.invocationCallOrder[0]).toBeLessThan(
    mocks.prepare.mock.invocationCallOrder[0],
  );
  await expect(
    runRehearsalPreflight(["--workspace", workspace, "--calibration-only"], repositoryRoot),
  ).rejects.toThrow();
});

it("leaves no workspace or preparation when history is unresolved", async () => {
  const parent = await mkdtemp(join(tmpdir(), "rehearsal-preflight-history-"));
  roots.push(parent);
  const repositoryRoot = join(parent, "repo");
  const workspace = join(parent, "workspace");
  await mkdir(repositoryRoot);
  mocks.history.mockRejectedValue(new Error("unresolved"));
  await expect(
    runRehearsalPreflight(["--workspace", workspace, "--calibration-only"], repositoryRoot),
  ).rejects.toThrow();
  expect(mocks.prepare).not.toHaveBeenCalled();
  await expect(access(workspace)).rejects.toThrow();
});

it("requires an attributable production baseline for approval mode before preparation", async () => {
  const parent = await mkdtemp(join(tmpdir(), "rehearsal-preflight-baseline-"));
  roots.push(parent);
  const repositoryRoot = join(parent, "repo");
  const workspace = join(parent, "workspace");
  await mkdir(repositoryRoot);
  await expect(runRehearsalPreflight(["--workspace", workspace], repositoryRoot)).rejects.toThrow();
  expect(mocks.history).not.toHaveBeenCalled();
  expect(mocks.prepare).not.toHaveBeenCalled();
});
