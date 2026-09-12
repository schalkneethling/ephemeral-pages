import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createAtomicJsonStore } from "./bootstrap-safety.ts";
import { preparedReleaseSchema, type PreparedRelease } from "./prepare.ts";
import { readReleaseJson } from "./files.ts";
import {
  providerInspectionDiagnosticSchema,
  type ProviderInspectionDiagnostic,
} from "./providers.ts";
import {
  artifactHash,
  assertExternalArtifactDirectory,
  verifyArtifactSource,
} from "./artifact-contract.ts";

export type DeploymentPair = {
  netlifyDeployId: string;
  workerDeploymentId: string;
  workerVersionId: string;
};
export type RehearsalStep =
  | "inspect"
  | "hold-netlify"
  | "upload-worker"
  | "activate-worker"
  | "observe-worker"
  | "prepublish-check"
  | "observe-netlify"
  | "verify-transition"
  | "publish-netlify"
  | "verify-pair";
export type RehearsalOutcome = "pending" | "running" | "passed" | "failed" | "blocked";
export type RehearsalRecord = {
  schemaVersion: 1;
  operation: "rehearse";
  outcome: RehearsalOutcome;
  source: PreparedRelease["source"];
  preparationSha256: string;
  priorPair?: DeploymentPair;
  observedPair?: DeploymentPair;
  activatedWorker?: { deploymentId: string; versionId: string };
  publishedNetlify?: { publishedDeployId: string };
  stages: Partial<Record<RehearsalStep, RehearsalOutcome>>;
  failure?: {
    stage: RehearsalStep;
    kind: string;
    diagnostic?: ProviderInspectionDiagnostic;
  };
  recovery: "none" | "inspect-recorded-targets-before-recovery";
};
export type RehearsalDependencies = {
  inspect: () => Promise<DeploymentPair>;
  observePublishedPair: (expectedPair: DeploymentPair) => Promise<DeploymentPair>;
  holdNetlify: () => Promise<void>;
  uploadWorker: () => Promise<void>;
  activateWorker: () => Promise<{ deploymentId: string; versionId: string }>;
  verifyTransition: () => Promise<boolean>;
  publishNetlify: () => Promise<{ publishedDeployId: string }>;
  verifyPair: () => Promise<boolean>;
};

// Provider adapters additionally persist IDs immediately before each individual mutation.
// Re-running into the same directory is blocked, including after interrupted operations.
export async function rehearsePreparedRelease(
  input: {
    repositoryRoot: string;
    artifactDirectory: string;
    reportDirectory: string;
  },
  dependencies: RehearsalDependencies,
): Promise<RehearsalRecord> {
  const prepared = await readReleaseJson(
    resolve(input.artifactDirectory, "prepared-release.json"),
    preparedReleaseSchema,
  );
  if (prepared.source.environment !== "staging")
    throw new Error("Rehearsal requires staging artifacts.");
  const current = await verifyArtifactSource(
    input.repositoryRoot,
    prepared.source.candidate,
    "staging",
  );
  if (JSON.stringify(current.source) !== JSON.stringify(prepared.source))
    throw new Error("Prepared source no longer matches.");
  // mkdir is exclusive: no stale checkpoints can silently become permission to retry.
  await assertExternalArtifactDirectory(input.repositoryRoot, input.reportDirectory);
  await mkdir(input.reportDirectory, { mode: 0o700 });
  const store = createAtomicJsonStore<RehearsalRecord>(
    resolve(input.reportDirectory, "rehearsal.json"),
    1024 * 1024,
    () => new Error("Cannot persist rehearsal evidence."),
  );
  const record: RehearsalRecord = {
    schemaVersion: 1,
    operation: "rehearse",
    outcome: "running",
    source: prepared.source,
    preparationSha256: artifactHash(JSON.stringify(prepared)),
    stages: {},
    recovery: "none",
  };
  await store.save(record);
  const stage = async (
    name: RehearsalStep,
    operation: () => Promise<void>,
    failure: "blocked" | "failed" = "blocked",
  ) => {
    record.stages[name] = "running";
    await store.save(record);
    try {
      await operation();
      record.stages[name] = "passed";
      await store.save(record);
    } catch (error) {
      const kind =
        typeof error === "object" && error !== null && "kind" in error ? error.kind : "unknown";
      const safeKinds = [
        "timeout",
        "spawn",
        "output-limit",
        "failed",
        "preflight",
        "checkpoint",
        "ambiguous",
        "verification",
        "artifact",
        "authentication",
      ];
      record.failure = {
        stage: name,
        kind: typeof kind === "string" && safeKinds.includes(kind) ? kind : "unknown",
        ...(typeof error === "object" && error !== null && "diagnostic" in error
          ? (() => {
              const diagnostic = providerInspectionDiagnosticSchema.safeParse(error.diagnostic);
              return diagnostic.success ? { diagnostic: diagnostic.data } : {};
            })()
          : {}),
      };
      record.stages[name] = failure;
      throw new Error("Rehearsal stage stopped.", { cause: error });
    }
  };
  let expectedPair: DeploymentPair | undefined;
  const inspectExpectedPair = async () => {
    delete record.observedPair;
    const observed = await dependencies.inspect();
    record.observedPair = observed;
    if (!expectedPair || JSON.stringify(observed) !== JSON.stringify(expectedPair))
      throw new Error("Live deployment pair changed.");
  };
  try {
    await stage("inspect", async () => {
      record.priorPair = await dependencies.inspect();
    });
    record.recovery = "inspect-recorded-targets-before-recovery";
    await stage("hold-netlify", dependencies.holdNetlify);
    await stage("upload-worker", dependencies.uploadWorker);
    await stage("activate-worker", async () => {
      const activated = await dependencies.activateWorker();
      record.activatedWorker = {
        deploymentId: activated.deploymentId,
        versionId: activated.versionId,
      };
      expectedPair = {
        netlifyDeployId: record.priorPair!.netlifyDeployId,
        workerDeploymentId: activated.deploymentId,
        workerVersionId: activated.versionId,
      };
    });
    await stage("observe-worker", inspectExpectedPair, "failed");
    await stage("verify-transition", async () => {
      if (!(await dependencies.verifyTransition()))
        throw new Error("Transition verification did not pass.");
    });
    await stage("prepublish-check", inspectExpectedPair, "failed");
    await stage("publish-netlify", async () => {
      const published = await dependencies.publishNetlify();
      record.publishedNetlify = { publishedDeployId: published.publishedDeployId };
      expectedPair = { ...expectedPair!, netlifyDeployId: published.publishedDeployId };
    });
    await stage(
      "observe-netlify",
      async () => {
        if (!expectedPair) throw new Error("Missing expected deployment pair.");
        delete record.observedPair;
        const observed = await dependencies.observePublishedPair(expectedPair);
        record.observedPair = observed;
        if (JSON.stringify(observed) !== JSON.stringify(expectedPair))
          throw new Error("Live deployment pair changed.");
      },
      "failed",
    );
    await stage("verify-pair", async () => {
      if (!(await dependencies.verifyPair())) throw new Error("Pair verification did not pass.");
      await inspectExpectedPair();
    });
    record.outcome = "passed";
    record.recovery = "none";
  } catch {
    record.outcome = Object.values(record.stages).includes("failed") ? "failed" : "blocked";
    // No automatic rollback. Retain every completed stage and any known live pair.
  }
  await store.save(record);
  await writeFile(
    resolve(input.reportDirectory, "complete.json"),
    `${JSON.stringify({ outcome: record.outcome })}\n`,
    { flag: "wx", mode: 0o400 },
  );
  return record;
}
