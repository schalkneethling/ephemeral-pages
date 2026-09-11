import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { artifactHash } from "./artifact-contract.ts";
import { preparedReleaseSchema } from "./prepare.ts";
import { approvalBytes } from "./production-approval.ts";
import { approvalSchema, productionRecordSchema, productionSteps } from "./production-record.ts";
import { recoveryPreflightSchema } from "./recovery-preflight.ts";
import { recoveryRecordSchema, recoverySteps } from "./recovery-record.ts";
import { runRecoveryCli } from "./recovery-cli.ts";
import { recoveryTargetSchema } from "./recovery-target.ts";
import { releaseConfigSchema } from "./schema.ts";

const mocks = vi.hoisted(() => ({
  bind: vi.fn(),
  createApi: vi.fn(),
  download: vi.fn(),
  extract: vi.fn(),
  git: vi.fn(),
  history: vi.fn(),
  productionFactory: vi.fn(),
  recoveryFactory: vi.fn(),
  run: vi.fn(),
  targetArtifact: vi.fn(),
  verifyInvocation: vi.fn(),
}));

vi.mock("./github-release.ts", async (original) => ({
  ...(await original<typeof import("./github-release.ts")>()),
  createGitHubReleaseApi: mocks.createApi,
  downloadGitHubArtifact: mocks.download,
  extractVerifiedGitHubArtifact: mocks.extract,
  verifyProductionInvocation: mocks.verifyInvocation,
  verifyRecoveryTargetArtifact: mocks.targetArtifact,
}));
vi.mock("./recovery-github.ts", () => ({ verifyRecoveryHistory: mocks.history }));
vi.mock("./production-approval.ts", async (original) => ({
  ...(await original<typeof import("./production-approval.ts")>()),
  gitReleaseValue: mocks.git,
}));
vi.mock("./production-providers.ts", () => ({
  createProductionProviderDependencies: mocks.productionFactory,
}));
vi.mock("./production-authorization.ts", () => ({
  bindProductionProviderAuthorization: mocks.bind,
}));
vi.mock("./recovery-providers.ts", () => ({
  createRecoveryProviderDependencies: mocks.recoveryFactory,
}));
vi.mock("./recovery-runner.ts", async (original) => ({
  ...(await original<typeof import("./recovery-runner.ts")>()),
  runRecovery: mocks.run,
}));

const roots: string[] = [];
const workflowCommit = "4".repeat(40);
const sourcePromotion = "2".repeat(40);
const targetWorkerCommit = "3".repeat(40);
const targetNetlifyCommit = "6".repeat(40);
const sourceArtifact = {
  artifactId: 500,
  digest: `sha256:${"a".repeat(64)}` as const,
  sizeInBytes: 2_048,
  expiresAt: "2026-09-18T10:00:00.000Z",
};
const targetArtifact = {
  artifactId: 501,
  digest: `sha256:${"b".repeat(64)}` as const,
  sizeInBytes: 4_096,
  expiresAt: "2026-09-18T10:00:00.000Z",
};
const resumeArtifact = {
  artifactId: 600,
  digest: `sha256:${"c".repeat(64)}` as const,
  sizeInBytes: 8_192,
  expiresAt: "2026-09-18T11:00:00.000Z",
};

const writeJson = async (path: string, value: unknown): Promise<void> => {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value)}\n`);
};

type Fixture = Awaited<ReturnType<typeof fixture>>;

async function fixture(resume = false) {
  const root = await mkdtemp(join(tmpdir(), "recovery-cli-"));
  roots.push(root);
  const repository = join(root, "repo");
  const workspace = join(root, "workspace");
  await mkdir(join(repository, "scripts/release"), { recursive: true });
  await mkdir(join(repository, "docs/release-evidence"), { recursive: true });

  const configuration = releaseConfigSchema.parse(
    JSON.parse(await readFile(new URL("./environments.json", import.meta.url), "utf8")),
  );
  const configurationFingerprint = artifactHash(JSON.stringify(configuration));
  const priorPair = {
    netlifyDeployId: "prior-netlify",
    workerDeploymentId: "prior-worker-deployment",
    workerVersionId: "prior-worker-version",
  };
  const startingPair = {
    netlifyDeployId: "candidate-netlify",
    workerDeploymentId: "candidate-worker-deployment",
    workerVersionId: "candidate-worker-version",
  };
  const prepared = preparedReleaseSchema.parse({
    schemaVersion: 1,
    operation: "prepare",
    outcome: "passed",
    source: {
      candidate: sourcePromotion,
      tree: "5".repeat(40),
      environment: "production",
      configurationFingerprint,
    },
    toolchain: { bun: "1.3.14" },
    artifacts: {
      netlify: { directory: "netlify", sha256: "d".repeat(64) },
      worker: { directory: "worker", sha256: "e".repeat(64) },
    },
  });
  const approval = approvalSchema.parse({
    schemaVersion: 1,
    operation: "release-approval",
    candidate: "1".repeat(40),
    tree: prepared.source.tree,
    configurationFingerprint,
    stagingPreparationSha256: "7".repeat(64),
    stagingRehearsalSha256: "8".repeat(64),
    affected: { netlify: true, cloudflare: true },
    compatibility: "compatible",
    migration: { artifactTag: "v1", expectedCurrentTag: "v1", change: "none" },
    recoveryOrder: ["netlify", "cloudflare"],
    baseline: {
      version: 1,
      environment: "production",
      providers: {
        netlify: {
          siteId: configuration.environments.production.netlify!.siteId,
          sourceCommit: targetNetlifyCommit,
          publishedDeployId: priorPair.netlifyDeployId,
          publishLocked: true,
        },
        cloudflare: {
          accountId: configuration.environments.production.cloudflare!.accountId,
          workerName: configuration.environments.production.cloudflare!.workerName,
          sourceCommit: targetWorkerCommit,
          deploymentId: priorPair.workerDeploymentId,
          traffic: [{ versionId: priorPair.workerVersionId, percentage: 100 }],
        },
      },
    },
  });
  const source = productionRecordSchema.parse({
    schemaVersion: 1,
    operation: "production-release",
    approvalSha256: artifactHash(approvalBytes(approval)),
    candidate: approval.candidate,
    promotionCommit: sourcePromotion,
    tree: prepared.source.tree,
    configurationFingerprint,
    originalRunId: 80,
    runIds: [80, 90],
    preparationSha256: artifactHash(JSON.stringify(prepared)),
    createdAt: "2026-09-11T08:00:00.000Z",
    updatedAt: "2026-09-11T09:00:00.000Z",
    outcome: "blocked",
    priorPair,
    observedPair: startingPair,
    stages: Object.fromEntries(productionSteps.map((step) => [step, "passed"])),
    results: {
      activatedWorker: {
        deploymentId: startingPair.workerDeploymentId,
        versionId: startingPair.workerVersionId,
      },
      publishedNetlify: { publishedDeployId: startingPair.netlifyDeployId },
    },
    journal: [],
    recovery: "inspect-recorded-targets-before-recovery",
  });
  const targetPrepared = preparedReleaseSchema.parse({
    ...prepared,
    source: {
      ...prepared.source,
      candidate: targetWorkerCommit,
      tree: "9".repeat(40),
    },
    artifacts: {
      netlify: { directory: "netlify", sha256: "0".repeat(64) },
      worker: { directory: "worker", sha256: "f".repeat(64) },
    },
  });
  const target = recoveryTargetSchema.parse({
    schemaVersion: 1,
    operation: "recovery-target",
    configurationFingerprint,
    pair: priorPair,
    netlifySourceCommit: targetNetlifyCommit,
    workerSourceCommit: targetWorkerCommit,
    workerArtifactRunId: 70,
    workerArtifactSha256: targetPrepared.artifacts.worker.sha256,
    workerScriptEtag: "a".repeat(32),
  });
  const targetRecord = productionRecordSchema.parse({
    ...source,
    approvalSha256: "b".repeat(64),
    candidate: targetWorkerCommit,
    promotionCommit: targetWorkerCommit,
    tree: targetPrepared.source.tree,
    originalRunId: 70,
    runIds: [70],
    preparationSha256: artifactHash(JSON.stringify(targetPrepared)),
    outcome: "passed",
    priorPair,
    observedPair: priorPair,
    results: {
      uploadedWorker: {
        accountId: configuration.environments.production.cloudflare!.accountId,
        artifactManifestSha256: target.workerArtifactSha256,
        baselineDeploymentId: "baseline-worker",
        migrationPolicy: { artifactTag: "v1", expectedCurrentTag: "v1", change: "none" },
        scriptEtag: target.workerScriptEtag,
        status: "uploaded",
        versionId: priorPair.workerVersionId,
        workerName: configuration.environments.production.cloudflare!.workerName,
      },
      activatedWorker: {
        deploymentId: priorPair.workerDeploymentId,
        versionId: priorPair.workerVersionId,
      },
    },
    recovery: "none",
  });
  const recoveryPlanSha256 = artifactHash(JSON.stringify({ target, startingPair, targetArtifact }));
  const priorPreflight = recoveryPreflightSchema.parse({
    schemaVersion: 1,
    operation: "recovery-preflight",
    runId: 99,
    sourceRunId: 90,
    workflowCommit,
    sourceSha256: artifactHash(JSON.stringify(source)),
    targetSha256: artifactHash(JSON.stringify(target)),
    recoveryPlanSha256,
    startingPair,
    evidenceArtifact: sourceArtifact,
    targetArtifact,
    targetRunId: 70,
  });
  const previous = recoveryRecordSchema.parse({
    schemaVersion: 1,
    operation: "production-recovery",
    environment: "production",
    sourceProductionRunId: 90,
    sourceProductionRecordSha256: artifactHash(JSON.stringify(source)),
    recoveryPlanSha256,
    recoveryRunIds: [99],
    startingPair,
    targetPair: priorPair,
    outcome: "blocked",
    stages: Object.fromEntries(
      recoverySteps.map((step, index) => [
        step,
        index === 0 ? "passed" : index === 1 ? "blocked" : "pending",
      ]),
    ),
    results: {},
    journal: [],
    failure: { stage: "restore-netlify", kind: "unknown" },
  });

  await writeJson(join(repository, "scripts/release/environments.json"), configuration);
  await writeJson(join(repository, "scripts/release/production-policy.json"), {
    schemaVersion: 1,
    productionEnabled: true,
    repository: "schalkneethling/ephemeral-pages",
    productionWorkflow: ".github/workflows/release-production.yml",
    rehearsalWorkflow: ".github/workflows/release-rehearsal.yml",
    maximumEvidenceAgeHours: 168,
  });
  await writeJson(join(repository, "docs/release-evidence/recovery-target.json"), target);

  const writeSource = async (directory: string) => {
    await writeJson(join(directory, "run/production.json"), source);
    await writeJson(join(directory, "approval/approval.json"), approval);
    await writeJson(join(directory, "artifacts/prepared-release.json"), prepared);
  };
  const writeTarget = async (directory: string) => {
    await writeJson(join(directory, "run/production.json"), targetRecord);
    await writeJson(join(directory, "artifacts/prepared-release.json"), targetPrepared);
  };
  mocks.extract.mockImplementation(async (_bytes, directory: string) => {
    if (directory.endsWith("/source")) await writeSource(directory);
    else if (directory.endsWith("/target")) await writeTarget(directory);
    else {
      await writeSource(join(directory, "source"));
      await writeTarget(join(directory, "target"));
      await writeJson(join(directory, "recovery-preflight.json"), priorPreflight);
      await writeJson(join(directory, "run/recovery.json"), previous);
    }
  });

  const currentRunId = resume ? 105 : 99;
  vi.stubEnv("GITHUB_RUN_ID", String(currentRunId));
  vi.stubEnv("GITHUB_SHA", workflowCommit);
  const current = { runId: currentRunId, headSha: workflowCommit };
  mocks.createApi.mockReturnValue({});
  mocks.verifyInvocation.mockResolvedValue(current);
  mocks.git.mockResolvedValue(workflowCommit);
  mocks.download.mockResolvedValue(new Uint8Array([1]));
  mocks.targetArtifact.mockResolvedValue({ artifact: targetArtifact });
  mocks.history.mockResolvedValue({
    mode: resume ? "resume" : "fresh",
    currentRunId,
    sourceProductionRunId: 90,
    ...(resume ? { resumeRecoveryRunId: 99 } : {}),
    evidenceRun: {
      runId: resume ? 99 : 90,
      headSha: resume ? workflowCommit : sourcePromotion,
    },
    artifact: resume ? resumeArtifact : sourceArtifact,
    skippedPreflightRunIds: [],
  });
  mocks.run.mockImplementation(async (_input, dependencies) => {
    await dependencies.inspect();
    return { operation: "production-recovery", outcome: "passed" };
  });

  const flags = [
    "--recovery-source-run-id",
    "90",
    "--workspace",
    workspace,
    ...(resume ? ["--resume-recovery-run-id", "99"] : []),
  ];
  return {
    flags,
    previous,
    priorPreflight,
    repository,
    sourceArtifact,
    startingPair,
    target,
    targetArtifact,
    workspace,
  };
}

beforeEach(() => {
  Object.values(mocks).forEach((mock) => mock.mockReset());
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("recovery CLI evidence boundaries", () => {
  it("seals the API artifact identities and observed starting pair during preflight", async () => {
    const data = await fixture();
    await expect(runRecoveryCli(["preflight", ...data.flags], data.repository)).resolves.toEqual({
      schemaVersion: 1,
      operation: "recovery-preflight",
      outcome: "passed",
    });
    const preflight = recoveryPreflightSchema.parse(
      JSON.parse(await readFile(join(data.workspace, "recovery-preflight.json"), "utf8")),
    );
    expect(preflight).toMatchObject({
      evidenceArtifact: data.sourceArtifact,
      startingPair: data.startingPair,
      targetArtifact: data.targetArtifact,
      targetRunId: 70,
    });
    expect(preflight.recoveryPlanSha256).toBe(
      artifactHash(
        JSON.stringify({
          target: data.target,
          startingPair: data.startingPair,
          targetArtifact: data.targetArtifact,
        }),
      ),
    );
    expect(mocks.productionFactory).not.toHaveBeenCalled();
    expect(mocks.recoveryFactory).not.toHaveBeenCalled();
    expect(mocks.bind).not.toHaveBeenCalled();
  });

  it("rejects a substituted starting pair before trusted context or provider access", async () => {
    const data = await fixture();
    await runRecoveryCli(["preflight", ...data.flags], data.repository);
    const path = join(data.workspace, "recovery-preflight.json");
    const preflight = JSON.parse(await readFile(path, "utf8"));
    preflight.startingPair.netlifyDeployId = "substitute";
    await writeJson(path, preflight);
    mocks.verifyInvocation.mockClear();

    await expect(runRecoveryCli(["execute", ...data.flags], data.repository)).rejects.toThrow(
      "Recovery preflight differs.",
    );
    expect(mocks.verifyInvocation).not.toHaveBeenCalled();
    expect(mocks.productionFactory).not.toHaveBeenCalled();
    expect(mocks.recoveryFactory).not.toHaveBeenCalled();
  });

  it.each(["source", "target"] as const)(
    "revalidates the %s artifact identity before provider access",
    async (kind) => {
      const data = await fixture();
      await runRecoveryCli(["preflight", ...data.flags], data.repository);
      const path = join(data.workspace, "recovery-preflight.json");
      const preflight = JSON.parse(await readFile(path, "utf8"));
      if (kind === "source") preflight.evidenceArtifact.artifactId = 999;
      else {
        preflight.targetArtifact.artifactId = 999;
        preflight.recoveryPlanSha256 = artifactHash(
          JSON.stringify({
            target: data.target,
            startingPair: data.startingPair,
            targetArtifact: preflight.targetArtifact,
          }),
        );
      }
      await writeJson(path, preflight);

      await expect(runRecoveryCli(["execute", ...data.flags], data.repository)).rejects.toThrow(
        kind === "source"
          ? "Recovery source artifact changed."
          : "Recovery target artifact changed.",
      );
      expect(mocks.productionFactory).not.toHaveBeenCalled();
      expect(mocks.recoveryFactory).not.toHaveBeenCalled();
      expect(mocks.bind).not.toHaveBeenCalled();
    },
  );

  it.each([
    {
      name: "prior workflow commit",
      mutate: (data: Fixture) => {
        data.priorPreflight.workflowCommit = "0".repeat(40);
      },
    },
    {
      name: "prior source digest",
      mutate: (data: Fixture) => {
        data.priorPreflight.sourceSha256 = "0".repeat(64);
      },
    },
    {
      name: "retained target artifact",
      mutate: (data: Fixture) => {
        data.priorPreflight.targetArtifact.artifactId = 999;
      },
    },
    {
      name: "recovery run lineage",
      mutate: (data: Fixture) => {
        data.previous.recoveryRunIds = [99, 98];
      },
    },
  ])("rejects a substituted $name in a resume archive", async ({ mutate }) => {
    const data = await fixture(true);
    mutate(data);
    await expect(runRecoveryCli(["preflight", ...data.flags], data.repository)).rejects.toThrow();
    expect(mocks.targetArtifact).not.toHaveBeenCalled();
    expect(mocks.productionFactory).not.toHaveBeenCalled();
    expect(mocks.recoveryFactory).not.toHaveBeenCalled();
  });

  it("accepts an exact resume archive and carries its target artifact identity forward", async () => {
    const data = await fixture(true);
    await expect(runRecoveryCli(["preflight", ...data.flags], data.repository)).resolves.toEqual({
      schemaVersion: 1,
      operation: "recovery-preflight",
      outcome: "passed",
    });
    const preflight = recoveryPreflightSchema.parse(
      JSON.parse(await readFile(join(data.workspace, "recovery-preflight.json"), "utf8")),
    );
    expect(preflight).toMatchObject({
      evidenceArtifact: resumeArtifact,
      resumeRunId: 99,
      sourceRunId: 90,
      targetArtifact: data.targetArtifact,
      targetRunId: 70,
    });
    expect(mocks.targetArtifact).not.toHaveBeenCalled();
    expect(mocks.productionFactory).not.toHaveBeenCalled();
    expect(mocks.recoveryFactory).not.toHaveBeenCalled();
  });

  it("does not authorize or construct providers until execute re-verifies GitHub context", async () => {
    const data = await fixture();
    await runRecoveryCli(["preflight", ...data.flags], data.repository);
    mocks.verifyInvocation.mockRejectedValue(new Error("GitHub context unavailable"));

    await expect(runRecoveryCli(["execute", ...data.flags], data.repository)).rejects.toThrow(
      "GitHub context unavailable",
    );
    expect(mocks.bind).not.toHaveBeenCalled();
    expect(mocks.productionFactory).not.toHaveBeenCalled();
    expect(mocks.recoveryFactory).not.toHaveBeenCalled();
  });
});
