import { beforeEach, expect, it, vi } from "vitest";

import { artifactHash } from "./artifact-contract.ts";
import { runProductionAdoptionCli } from "./production-adoption-cli.ts";

const mocks = vi.hoisted(() => ({
  context: vi.fn(),
  factory: vi.fn(),
  read: vi.fn(),
  runner: vi.fn(),
  workspace: vi.fn(),
}));

vi.mock("./files.ts", () => ({ readReleaseJson: mocks.read }));
vi.mock("./production-adoption-context.ts", async (original) => ({
  ...(await original<typeof import("./production-adoption-context.ts")>()),
  verifyProductionAdoptionContext: mocks.context,
}));
vi.mock("./production-adoption-providers.ts", () => ({
  createProductionAdoptionProviderDependencies: mocks.factory,
}));
vi.mock("./production-adoption-runner.ts", async (original) => ({
  ...(await original<typeof import("./production-adoption-runner.ts")>()),
  runProductionAdoption: mocks.runner,
}));
vi.mock("./production-workspace.ts", () => ({
  verifyProductionWorkspace: mocks.workspace,
}));

const promotionCommit = "a".repeat(40);
const candidate = "b".repeat(40);
const prepared = {
  schemaVersion: 1 as const,
  operation: "prepare" as const,
  outcome: "passed" as const,
  source: {
    candidate: promotionCommit,
    tree: "c".repeat(40),
    environment: "production" as const,
    configurationFingerprint: "d".repeat(64),
  },
  toolchain: { bun: "1.3.14" as const },
  artifacts: {
    netlify: { directory: "netlify" as const, sha256: "e".repeat(64) },
    worker: { directory: "worker" as const, sha256: "f".repeat(64) },
  },
};
const stagingEvidence = { sealed: "strict staging evidence fixture" };
const source = {
  promotionPr: 12,
  candidate,
  promotionCommit,
  tree: prepared.source.tree,
  configurationSha256: "1".repeat(64),
  productionConfigurationFingerprint: prepared.source.configurationFingerprint,
  staging: {
    runId: 34,
    workflowCommit: candidate,
    artifactId: 56,
    artifactDigest: `sha256:${"2".repeat(64)}` as const,
    artifactSizeInBytes: 2048,
    artifactExpiresAt: "2026-09-19T00:00:00Z",
    evidenceSha256: artifactHash(JSON.stringify(stagingEvidence)),
  },
};
const preflight = {
  schemaVersion: 1 as const,
  operation: "production-adoption-preflight" as const,
  runId: 78,
  source,
  preparationSha256: artifactHash(JSON.stringify(prepared)),
};
const argv = [
  "execute",
  "adopt",
  "--promotion-pr",
  "12",
  "--rehearsal-run-id",
  "34",
  "--workspace",
  "/tmp/adoption-cli-workspace",
];

beforeEach(() => {
  Object.values(mocks).forEach((mock) => mock.mockReset());
  process.env.GITHUB_RUN_ID = "78";
  process.env.GITHUB_SHA = promotionCommit;
  mocks.workspace.mockResolvedValue(undefined);
  mocks.read.mockImplementation(async (path: string) => {
    if (path.endsWith("adoption-preflight.json")) return structuredClone(preflight);
    if (path.endsWith("prepared-release.json")) return structuredClone(prepared);
    if (path.endsWith("staging-evidence.json")) return structuredClone(stagingEvidence);
    throw new Error(`Unexpected fixture path: ${path}`);
  });
  mocks.context.mockResolvedValue({
    current: { runId: 78, headSha: promotionCommit },
    promotion: { candidate, promotionTree: prepared.source.tree },
    configuration: {
      environments: {
        production: {
          netlify: { accountId: "netlify-account", siteId: "production-site" },
          cloudflare: { accountId: "worker-account", workerName: "production-worker" },
        },
      },
    },
    configurationSha256: source.configurationSha256,
    staging: {
      run: { runId: 34, workflowCommit: candidate },
      artifact: {
        artifactId: 56,
        digest: source.staging.artifactDigest,
        sizeInBytes: 2048,
        expiresAt: source.staging.artifactExpiresAt,
      },
    },
  });
  mocks.factory.mockResolvedValue({ inspect: vi.fn() });
  mocks.runner.mockImplementation(async (_input, dependencies) => {
    await dependencies.inspect();
    return { outcome: "passed" };
  });
});

it("does not create provider dependencies until protected context revalidation passes", async () => {
  mocks.context.mockRejectedValue(new Error("untrusted context"));
  await expect(runProductionAdoptionCli(argv, "/repo")).rejects.toThrow("untrusted context");
  expect(mocks.factory).not.toHaveBeenCalled();
});

it("rejects altered staging evidence before context or provider construction", async () => {
  mocks.read.mockImplementation(async (path: string) => {
    if (path.endsWith("adoption-preflight.json")) return structuredClone(preflight);
    if (path.endsWith("prepared-release.json")) return structuredClone(prepared);
    if (path.endsWith("staging-evidence.json")) return { sealed: "substitute" };
    throw new Error();
  });
  await expect(runProductionAdoptionCli(argv, "/repo")).rejects.toThrow(
    "Prepared adoption evidence differs",
  );
  expect(mocks.context).not.toHaveBeenCalled();
  expect(mocks.factory).not.toHaveBeenCalled();
});

it("revalidates every GitHub artifact binding before provider construction", async () => {
  mocks.context.mockResolvedValue({
    ...(await mocks.context()),
    staging: {
      run: { runId: 34, workflowCommit: candidate },
      artifact: {
        artifactId: 999,
        digest: source.staging.artifactDigest,
        sizeInBytes: 2048,
        expiresAt: source.staging.artifactExpiresAt,
      },
    },
  });
  await expect(runProductionAdoptionCli(argv, "/repo")).rejects.toThrow(
    "context changed during execution",
  );
  expect(mocks.factory).not.toHaveBeenCalled();
});

it("passes only sealed preparation and checked configuration to the provider factory", async () => {
  const result = await runProductionAdoptionCli(argv, "/repo");
  expect(result).toEqual({ outcome: "passed" });
  expect(mocks.factory).toHaveBeenCalledWith(
    expect.objectContaining({
      artifactDirectory: "/tmp/adoption-cli-workspace/artifacts",
      prepared,
      previous: undefined,
      repositoryRoot: "/repo",
    }),
  );
});

it("rejects a resumed archive whose sealed source differs", async () => {
  const resumedPreflight = {
    ...structuredClone(preflight),
    resumeAdoptionRunId: 70,
  };
  mocks.read.mockImplementation(async (path: string) => {
    if (path.endsWith("adoption-preflight.json")) return resumedPreflight;
    if (path.endsWith("prepared-release.json")) return structuredClone(prepared);
    if (path.endsWith("staging-evidence.json")) return structuredClone(stagingEvidence);
    if (path.endsWith("previous-adoption.json")) {
      return { source: { ...structuredClone(source), promotionPr: 999 } };
    }
    throw new Error();
  });
  await expect(
    runProductionAdoptionCli([...argv, "--resume-adoption-run-id", "70"], "/repo"),
  ).rejects.toThrow("Prepared adoption evidence differs");
  expect(mocks.context).not.toHaveBeenCalled();
  expect(mocks.factory).not.toHaveBeenCalled();
});
