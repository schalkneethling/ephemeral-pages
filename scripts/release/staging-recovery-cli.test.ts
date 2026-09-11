import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { artifactConfigurationFingerprint, artifactHash } from "./artifact-contract.ts";
import type { NetlifyDeploymentCheckpoint } from "./netlify-deployment.ts";
import { preparedReleaseSchema } from "./prepare.ts";
import { successfulRehearsalSchema } from "./production-approval.ts";
import { releaseConfigSchema } from "./schema.ts";
import {
  parseStagingRecoveryArguments,
  readStagingReleaseEvidence,
  runStagingRecoveryCli,
  stagingRecoveryPreflightSchema,
} from "./staging-recovery-cli.ts";
import { stagingRecoverySourceSchema } from "./staging-recovery-source.ts";
import { recoverySteps } from "./recovery-record.ts";
import { stagingRecoveryRecordSchema } from "./staging-recovery-runner.ts";

const mocks = vi.hoisted(() => ({
  createApi: vi.fn(),
  diagnostics: vi.fn(),
  download: vi.fn(),
  extract: vi.fn(),
  git: vi.fn(),
  history: vi.fn(),
  invocation: vi.fn(),
  providerFactory: vi.fn(),
  run: vi.fn(),
}));

vi.mock("./github-release.ts", async (original) => ({
  ...(await original<typeof import("./github-release.ts")>()),
  createGitHubReleaseApi: mocks.createApi,
  downloadGitHubArtifact: mocks.download,
  extractVerifiedGitHubArtifact: mocks.extract,
}));
vi.mock("./staging-recovery-github.ts", async (original) => ({
  ...(await original<typeof import("./staging-recovery-github.ts")>()),
  verifyStagingDiagnosticsArtifact: mocks.diagnostics,
  verifyStagingRecoveryHistory: mocks.history,
  verifyStagingRecoveryInvocation: mocks.invocation,
}));
vi.mock("./production-approval.ts", async (original) => ({
  ...(await original<typeof import("./production-approval.ts")>()),
  gitReleaseValue: mocks.git,
}));
vi.mock("./recovery-providers.ts", async (original) => ({
  ...(await original<typeof import("./recovery-providers.ts")>()),
  createStagingRecoveryProviderDependencies: mocks.providerFactory,
}));
vi.mock("./staging-recovery-runner.ts", async (original) => ({
  ...(await original<typeof import("./staging-recovery-runner.ts")>()),
  runStagingRecovery: mocks.run,
}));

const roots: string[] = [];
const currentCommit = "c".repeat(40);
const sourceCommit = "b".repeat(40);
const targetCommit = "a".repeat(40);
const sourceArtifact = {
  artifactId: 502,
  name: "release-rehearsal-diagnostics" as const,
  digest: `sha256:${"2".repeat(64)}` as const,
  sizeInBytes: 2_000,
  expiresAt: "2026-09-18T10:00:00.000Z",
};
const targetArtifact = {
  artifactId: 501,
  name: "release-rehearsal-diagnostics" as const,
  digest: `sha256:${"1".repeat(64)}` as const,
  sizeInBytes: 1_000,
  expiresAt: "2026-09-18T10:00:00.000Z",
};
const stages = [
  "inspect",
  "hold-netlify",
  "upload-worker",
  "activate-worker",
  "observe-worker",
  "verify-transition",
  "prepublish-check",
  "publish-netlify",
  "observe-netlify",
  "verify-pair",
] as const;

const writeJson = async (path: string, value: unknown) => {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value)}\n`);
};

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "staging-recovery-cli-"));
  roots.push(root);
  const repository = join(root, "repo");
  const workspace = join(root, "workspace");
  await mkdir(join(repository, "scripts/release"), { recursive: true });
  const configuration = releaseConfigSchema.parse(
    JSON.parse(await readFile(new URL("./environments.json", import.meta.url), "utf8")),
  );
  await writeJson(join(repository, "scripts/release/environments.json"), configuration);
  const configurationFingerprint = artifactConfigurationFingerprint(
    configuration.environments.staging,
    currentCommit,
  );
  const targetPair = {
    netlifyDeployId: "target-netlify",
    workerDeploymentId: "target-worker-deployment",
    workerVersionId: "target-worker-version",
  };
  const startingPair = {
    netlifyDeployId: "source-netlify",
    workerDeploymentId: "source-worker-deployment",
    workerVersionId: "source-worker-version",
  };
  const release = (input: {
    candidate: string;
    priorPair: typeof targetPair;
    observedPair: typeof targetPair;
    prefix: string;
  }) => {
    const prepared = preparedReleaseSchema.parse({
      schemaVersion: 1,
      operation: "prepare",
      outcome: "passed",
      source: {
        candidate: input.candidate,
        tree: input.prefix.repeat(40),
        environment: "staging",
        configurationFingerprint,
      },
      toolchain: { bun: "1.3.14" },
      artifacts: {
        netlify: { directory: "netlify", sha256: input.prefix.repeat(64) },
        worker: { directory: "worker", sha256: input.prefix.repeat(64) },
      },
    });
    const rehearsal = successfulRehearsalSchema.parse({
      schemaVersion: 1,
      operation: "rehearse",
      outcome: "passed",
      source: prepared.source,
      preparationSha256: artifactHash(JSON.stringify(prepared)),
      priorPair: input.priorPair,
      observedPair: input.observedPair,
      activatedWorker: {
        deploymentId: input.observedPair.workerDeploymentId,
        versionId: input.observedPair.workerVersionId,
      },
      publishedNetlify: { publishedDeployId: input.observedPair.netlifyDeployId },
      stages: Object.fromEntries(stages.map((stage) => [stage, "passed"])),
      recovery: "none",
    });
    return { prepared, rehearsal };
  };
  const target = release({
    candidate: targetCommit,
    priorPair: {
      netlifyDeployId: "older-netlify",
      workerDeploymentId: "older-worker-deployment",
      workerVersionId: "older-worker-version",
    },
    observedPair: targetPair,
    prefix: "1",
  });
  const source = release({
    candidate: sourceCommit,
    priorPair: targetPair,
    observedPair: startingPair,
    prefix: "2",
  });
  const writeRelease = async (
    directory: string,
    value: typeof source,
    pair: typeof startingPair,
  ) => {
    await writeJson(join(directory, "artifacts/prepared-release.json"), value.prepared);
    await writeJson(join(directory, "reports/rehearsal.json"), value.rehearsal);
    const held = {
      siteId: configuration.environments.staging.netlify!.siteId,
      baselineDeployId: value.rehearsal.priorPair.netlifyDeployId,
      candidateDeployId: pair.netlifyDeployId,
      candidate: value.prepared.source.candidate,
      artifactSha256: value.prepared.artifacts.netlify.sha256,
      context: "production",
      state: "ready",
      acknowledgedUploads: 1,
    };
    const uploaded = {
      accountId: configuration.environments.staging.cloudflare!.accountId,
      artifactManifestSha256: value.prepared.artifacts.worker.sha256,
      baselineDeploymentId: value.rehearsal.priorPair.workerDeploymentId,
      migrationPolicy: { artifactTag: "v1", expectedCurrentTag: "v1", change: "none" },
      scriptEtag: value.prepared.artifacts.worker.sha256,
      status: "uploaded",
      versionId: pair.workerVersionId,
      workerName: configuration.environments.staging.cloudflare!.workerName,
    };
    const publishPending = {
      operation: "restoreSiteDeploy",
      phase: "pending-mutation",
      deployId: pair.netlifyDeployId,
      artifactSha256: value.prepared.artifacts.netlify.sha256,
    } satisfies NetlifyDeploymentCheckpoint;
    const publishResponse = {
      operation: "restoreSiteDeploy",
      phase: "mutation-response-received",
      deployId: pair.netlifyDeployId,
      artifactSha256: value.prepared.artifacts.netlify.sha256,
      publishedDeployId: pair.netlifyDeployId,
    } satisfies NetlifyDeploymentCheckpoint;
    await Promise.all([
      writeJson(join(directory, "reports/provider-001.json"), held),
      writeJson(join(directory, "reports/provider-002.json"), uploaded),
      writeJson(join(directory, "reports/provider-003.json"), {
        ...uploaded,
        deploymentId: pair.workerDeploymentId,
        status: "activated",
        baselineDeploymentId: undefined,
      }),
      writeJson(join(directory, "reports/provider-004.json"), publishPending),
      writeJson(join(directory, "reports/provider-005.json"), publishResponse),
      writeJson(join(directory, "reports/provider-006.json"), {
        publishedDeployId: pair.netlifyDeployId,
      }),
    ]);
  };
  mocks.extract.mockImplementation(async (_bytes, directory: string) => {
    if (directory.endsWith("source-release")) await writeRelease(directory, source, startingPair);
    else await writeRelease(directory, target, targetPair);
  });
  mocks.createApi.mockReturnValue({});
  mocks.download.mockResolvedValue(new Uint8Array([1]));
  mocks.invocation.mockResolvedValue({ runId: 120, workflowCommit: currentCommit });
  mocks.git.mockResolvedValue(currentCommit);
  mocks.history.mockResolvedValue({ mode: "fresh" });
  mocks.diagnostics.mockImplementation(async (_api, { runId }) => ({
    run: { runId, workflowCommit: runId === 110 ? sourceCommit : targetCommit },
    artifact: runId === 110 ? sourceArtifact : targetArtifact,
  }));
  mocks.run.mockImplementation(async (_input, dependencies) => {
    await dependencies.inspect();
    return { operation: "staging-recovery", outcome: "passed" };
  });
  vi.stubEnv("GITHUB_RUN_ID", "120");
  vi.stubEnv("GITHUB_SHA", currentCommit);
  const flags = [
    "--source-rehearsal-run-id",
    "110",
    "--target-rehearsal-run-id",
    "100",
    "--workspace",
    workspace,
  ];
  return {
    configuration,
    flags,
    repository,
    sourceArtifact,
    startingPair,
    targetArtifact,
    targetPair,
    workspace,
  };
}

beforeEach(() => Object.values(mocks).forEach((mock) => mock.mockReset()));
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("staging recovery CLI", () => {
  it("requires explicit distinct A/B rehearsal evidence", () => {
    expect(
      parseStagingRecoveryArguments(
        [
          "--source-rehearsal-run-id",
          "110",
          "--target-rehearsal-run-id",
          "100",
          "--workspace",
          "new",
        ],
        "/tmp",
      ),
    ).toEqual({ sourceRehearsalRunId: 110, targetRehearsalRunId: 100, workspace: "/tmp/new" });
    expect(() =>
      parseStagingRecoveryArguments(
        [
          "--source-rehearsal-run-id",
          "100",
          "--target-rehearsal-run-id",
          "100",
          "--workspace",
          "new",
        ],
        "/tmp",
      ),
    ).toThrow();
  });

  it("builds a strict A/B source from verified diagnostics without provider access", async () => {
    const data = await fixture();
    await expect(
      runStagingRecoveryCli(["preflight", ...data.flags], data.repository),
    ).resolves.toMatchObject({ outcome: "passed", operation: "staging-recovery-preflight" });
    const source = stagingRecoverySourceSchema.parse(
      JSON.parse(await readFile(join(data.workspace, "staging-recovery-source.json"), "utf8")),
    );
    const preflight = stagingRecoveryPreflightSchema.parse(
      JSON.parse(await readFile(join(data.workspace, "staging-recovery-preflight.json"), "utf8")),
    );
    expect(source.source.rehearsal.observedPair).toEqual(data.startingPair);
    expect(source.target.rehearsal.observedPair).toEqual(data.targetPair);
    expect(preflight).toMatchObject({
      sourceArtifact: {
        artifactId: data.sourceArtifact.artifactId,
        digest: data.sourceArtifact.digest,
        sizeInBytes: data.sourceArtifact.sizeInBytes,
        expiresAt: data.sourceArtifact.expiresAt,
      },
      targetArtifact: {
        artifactId: data.targetArtifact.artifactId,
        digest: data.targetArtifact.digest,
        sizeInBytes: data.targetArtifact.sizeInBytes,
        expiresAt: data.targetArtifact.expiresAt,
      },
      startingPair: data.startingPair,
      targetPair: data.targetPair,
    });
    expect(mocks.providerFactory).not.toHaveBeenCalled();
  });

  it.each(["missing", "duplicate", "unknown"] as const)(
    "rejects %s pending Netlify restore evidence while retaining the response record",
    async (variant) => {
      const data = await fixture();
      await runStagingRecoveryCli(["preflight", ...data.flags], data.repository);
      const sourceDirectory = join(data.workspace, "source-release");
      const pendingPath = join(sourceDirectory, "reports/provider-004.json");
      const pending = JSON.parse(await readFile(pendingPath, "utf8"));
      expect(
        JSON.parse(await readFile(join(sourceDirectory, "reports/provider-005.json"), "utf8")),
      ).toMatchObject({ operation: "restoreSiteDeploy", phase: "mutation-response-received" });
      if (variant === "missing") await rm(pendingPath);
      else if (variant === "duplicate") {
        await writeJson(join(sourceDirectory, "reports/provider-007.json"), pending);
      } else {
        await writeJson(pendingPath, { ...pending, unexpected: true });
      }

      await expect(
        readStagingReleaseEvidence(
          sourceDirectory,
          {
            runId: 110,
            workflowCommit: sourceCommit,
            artifact: data.sourceArtifact,
          },
          data.configuration,
        ),
      ).rejects.toThrow("Staging provider evidence differs.");
    },
  );

  it("blocks provider construction until execute re-verifies the protected GitHub context", async () => {
    const data = await fixture();
    await runStagingRecoveryCli(["preflight", ...data.flags], data.repository);
    mocks.invocation.mockRejectedValue(new Error("GitHub context unavailable"));
    await expect(
      runStagingRecoveryCli(["execute", ...data.flags], data.repository),
    ).rejects.toThrow("GitHub context unavailable");
    expect(mocks.providerFactory).not.toHaveBeenCalled();
  });

  it("revalidates altered A/B artifact metadata before provider construction", async () => {
    const data = await fixture();
    await runStagingRecoveryCli(["preflight", ...data.flags], data.repository);
    const path = join(data.workspace, "staging-recovery-preflight.json");
    const preflight = JSON.parse(await readFile(path, "utf8"));
    preflight.sourceArtifact.artifactId = 999;
    preflight.recoveryPlanSha256 = artifactHash(
      JSON.stringify({
        sourceSha256: preflight.sourceSha256,
        startingPair: preflight.startingPair,
        targetPair: preflight.targetPair,
        sourceArtifact: preflight.sourceArtifact,
        targetArtifact: preflight.targetArtifact,
      }),
    );
    await writeJson(path, preflight);

    await expect(
      runStagingRecoveryCli(["execute", ...data.flags], data.repository),
    ).rejects.toThrow("Staging rehearsal artifacts changed.");
    expect(mocks.providerFactory).not.toHaveBeenCalled();
  });

  it("rejects a production-shaped staging configuration before provider construction", async () => {
    const data = await fixture();
    await writeJson(join(data.repository, "scripts/release/environments.json"), {
      ...data.configuration,
      environments: {
        ...data.configuration.environments,
        staging: data.configuration.environments.production,
      },
    });
    await expect(
      runStagingRecoveryCli(["preflight", ...data.flags], data.repository),
    ).rejects.toThrow();
    expect(mocks.providerFactory).not.toHaveBeenCalled();
  });

  it("binds a resumed outer artifact to its retained prior preflight", async () => {
    const data = await fixture();
    await runStagingRecoveryCli(["preflight", ...data.flags], data.repository);
    const source = stagingRecoverySourceSchema.parse(
      JSON.parse(await readFile(join(data.workspace, "staging-recovery-source.json"), "utf8")),
    );
    const priorPreflight = stagingRecoveryPreflightSchema.parse(
      JSON.parse(await readFile(join(data.workspace, "staging-recovery-preflight.json"), "utf8")),
    );
    const previous = stagingRecoveryRecordSchema.parse({
      schemaVersion: 1,
      operation: "staging-recovery",
      environment: "staging",
      sourceRehearsalRunId: 110,
      sourceRehearsalSha256: artifactHash(JSON.stringify(source.source.rehearsal)),
      targetRehearsalRunId: 100,
      targetRehearsalSha256: artifactHash(JSON.stringify(source.target.rehearsal)),
      sourceSha256: artifactHash(JSON.stringify(source)),
      configurationFingerprint: artifactHash(JSON.stringify(data.configuration)),
      recoveryPlanSha256: priorPreflight.recoveryPlanSha256,
      recoveryRunIds: [120],
      startingPair: data.startingPair,
      targetPair: data.targetPair,
      outcome: "blocked",
      stages: Object.fromEntries(
        recoverySteps.map((step, index) => [step, index === 0 ? "passed" : "pending"]),
      ),
      results: {},
      journal: [],
      failure: { stage: "restore-netlify", kind: "unknown" },
    });
    const resumeWorkspace = join(dirname(data.workspace), "resume-workspace");
    const resumeArtifact = {
      artifactId: 700,
      name: "release-staging-recovery" as const,
      digest: `sha256:${"7".repeat(64)}` as const,
      sizeInBytes: 7_000,
      expiresAt: "2026-09-18T10:00:00.000Z",
    };
    mocks.extract.mockImplementation(async (_bytes, directory: string) => {
      await cp(join(data.workspace, "source-release"), join(directory, "source-release"), {
        recursive: true,
      });
      await cp(join(data.workspace, "target-release"), join(directory, "target-release"), {
        recursive: true,
      });
      await writeJson(join(directory, "staging-recovery-source.json"), source);
      await writeJson(join(directory, "staging-recovery-preflight.json"), priorPreflight);
      await writeJson(join(directory, "run/staging-recovery.json"), previous);
    });
    vi.stubEnv("GITHUB_RUN_ID", "130");
    mocks.invocation.mockResolvedValue({ runId: 130, workflowCommit: currentCommit });
    mocks.history.mockResolvedValue({
      mode: "resume",
      run: { runId: 120, workflowCommit: currentCommit },
      artifact: resumeArtifact,
    });
    const resumeFlags = [
      "--source-rehearsal-run-id",
      "110",
      "--target-rehearsal-run-id",
      "100",
      "--resume-recovery-run-id",
      "120",
      "--workspace",
      resumeWorkspace,
    ];
    await runStagingRecoveryCli(["preflight", ...resumeFlags], data.repository);
    const resumePath = join(resumeWorkspace, "staging-recovery-preflight.json");
    const resumePreflight = JSON.parse(await readFile(resumePath, "utf8"));
    resumePreflight.resumeArtifact.artifactId = 999;
    await writeJson(resumePath, resumePreflight);

    await expect(
      runStagingRecoveryCli(["execute", ...resumeFlags], data.repository),
    ).rejects.toThrow("Staging recovery resume artifact changed.");
    expect(mocks.providerFactory).not.toHaveBeenCalled();
  });
});
