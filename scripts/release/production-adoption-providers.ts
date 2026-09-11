import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import {
  artifactBuildEnvironment,
  artifactGitEnvironment,
  artifactHash,
  assertExternalArtifactDirectory,
  verifyArtifactSource,
} from "./artifact-contract.ts";
import { readBoundedJson } from "./bootstrap-safety.ts";
import { runCommand } from "./command.ts";
import { preparedReleaseSchema, type PreparedRelease } from "./prepare.ts";
import type { ProductionProviderAuthorization } from "./production-authorization.ts";
import {
  productionAdoptionInspectionSchema,
  productionAdoptionRecordSchema,
  type ProductionAdoptionInspection,
  type ProductionAdoptionRecord,
} from "./production-adoption-record.ts";
import type {
  ProductionAdoptionDependencies,
  ProductionAdoptionMutationStep,
} from "./production-adoption-runner.ts";
import { productionResultsSchema, type ProductionResults } from "./production-record.ts";
import {
  inspectCloudflare,
  inspectNetlify,
  type CloudflareInspection,
  type NetlifyInspection,
  type ProviderCommandRunner,
} from "./providers.ts";
import { releaseConfigSchema, type ReleaseConfig } from "./schema.ts";
import { runCollaborationSmoke, type CollaborationSmokeReport } from "./smoke.ts";
import { verifyWorkerArtifacts, type WorkerArtifactManifest } from "./worker-artifacts.ts";
import {
  activatePreparedProductionWorker,
  createCloudflareWorkerFetchTransport,
  createWranglerAccessTokenResolver,
  inspectPreparedProductionWorkerBaseline,
  reconcileWorkerRelease,
  uploadPreparedProductionWorker,
  verifyRetainedWorkerRelease,
  type PreparedProductionWorkerRelease,
  type WorkerReleaseReconciliation,
  type WorkerReleaseTransport,
} from "./worker-release.ts";

export type ProductionAdoptionProviderFactoryInput = {
  artifactDirectory: string;
  authorization: ProductionProviderAuthorization;
  configuration: ReleaseConfig;
  prepared: PreparedRelease;
  previous?: ProductionAdoptionRecord;
  repositoryRoot: string;
  smokeOutputDirectory: string;
};

export type ProductionAdoptionProviderFactoryOverrides = {
  adapters?: {
    activateWorker?: typeof activatePreparedProductionWorker;
    inspectWorker?: typeof inspectPreparedProductionWorkerBaseline;
    reconcileWorker?: typeof reconcileWorkerRelease;
    uploadWorker?: typeof uploadPreparedProductionWorker;
    verifyRetainedWorker?: typeof verifyRetainedWorkerRelease;
  };
  createWorkerTransport?: (input: {
    repositoryRoot: string;
    workerArtifactDirectory: string;
  }) => WorkerReleaseTransport | Promise<WorkerReleaseTransport>;
  inspectCloudflare?: typeof inspectCloudflare;
  inspectNetlify?: typeof inspectNetlify;
  providerRun?: ProviderCommandRunner;
  run?: typeof runCommand;
  runSmoke?: typeof runCollaborationSmoke;
  uniqueId?: () => string;
  verifyAncestor?: (repositoryRoot: string, ancestor: string, descendant: string) => Promise<void>;
  verifySource?: typeof verifyArtifactSource;
  verifyWorkerArtifacts?: typeof verifyWorkerArtifacts;
};

export type ProductionAdoptionProviderDependencies = ProductionAdoptionDependencies;

const SAFE_REPORT_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u;
const SYSTEM_ENVIRONMENT_KEYS = [
  "HOME",
  "LANG",
  "LC_ALL",
  "PATH",
  "SYSTEMROOT",
  "SystemRoot",
  "TMPDIR",
  "XDG_CONFIG_HOME",
] as const;

const selectedEnvironment = (executable: string): Record<string, string> => {
  const names = [
    ...SYSTEM_ENVIRONMENT_KEYS,
    ...(executable.endsWith("netlify") ? (["NETLIFY_AUTH_TOKEN"] as const) : []),
    ...(executable.endsWith("wrangler")
      ? (["CLOUDFLARE_API_KEY", "CLOUDFLARE_API_TOKEN", "CLOUDFLARE_EMAIL"] as const)
      : []),
  ];
  const environment: Record<string, string> = {};
  for (const name of names) {
    const value = process.env[name];
    if (value !== undefined) environment[name] = value;
  }
  return environment;
};

const exactOrigin = (value: string | undefined): value is string => {
  if (!value) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.origin === value;
  } catch {
    return false;
  }
};

const configured = (
  values: Readonly<Record<string, { matchesExpected: boolean; present: boolean }>>,
) => Object.values(values).every((value) => value.present && value.matchesExpected);

const inspectConfiguration = (app: NetlifyInspection, worker: CloudflareInspection): boolean =>
  app.publishLocked &&
  app.variableScopesMatch &&
  configured(app.nonSecretVariables) &&
  Object.values(app.requiredSecrets).every(Boolean) &&
  configured(worker.nonSecretVariables) &&
  Object.values(worker.requiredSecrets).every(Boolean) &&
  worker.traffic.length === 1 &&
  worker.traffic[0]?.percentage === 100;

const same = (left: unknown, right: unknown): boolean =>
  JSON.stringify(left) === JSON.stringify(right);

const sameMigration = (value: unknown): boolean =>
  typeof value === "object" &&
  value !== null &&
  !Array.isArray(value) &&
  "artifactTag" in value &&
  value.artifactTag === "v1" &&
  "expectedCurrentTag" in value &&
  value.expectedCurrentTag === "v1" &&
  "change" in value &&
  value.change === "none";

const safeSmokeReport = (report: CollaborationSmokeReport): CollaborationSmokeReport => {
  if (
    report.schemaVersion !== 1 ||
    report.operation !== "collaboration-smoke" ||
    report.environment !== "production" ||
    (report.outcome !== "passed" && report.outcome !== "blocked") ||
    !Array.isArray(report.checks) ||
    report.checks.some(
      (check) =>
        !/^[a-z0-9][a-z0-9.-]{0,127}$/u.test(check.id) ||
        (check.outcome !== "passed" && check.outcome !== "blocked") ||
        typeof check.summary !== "string" ||
        check.summary.length < 1 ||
        check.summary.length > 512 ||
        /[\r\n]/u.test(check.summary) ||
        check.summary.includes("\0"),
    ) ||
    !/^[a-f0-9]{64}$/u.test(report.configuration.fingerprint) ||
    report.configuration.source !== "default" ||
    (report.retryAfterSeconds !== undefined &&
      (!Number.isSafeInteger(report.retryAfterSeconds) || report.retryAfterSeconds < 1)) ||
    (report.usage.uploads !== 0 && report.usage.uploads !== 1) ||
    report.usage.captureRequested !== true ||
    (report.usage.captureRequests !== 0 && report.usage.captureRequests !== 1)
  ) {
    throw new Error("Production adoption smoke report is invalid.");
  }
  return {
    schemaVersion: 1,
    operation: "collaboration-smoke",
    outcome: report.outcome,
    environment: "production",
    configuration: {
      fingerprint: report.configuration.fingerprint,
      source: "default",
    },
    checks: report.checks.map(({ id, outcome, summary }) => ({ id, outcome, summary })),
    usage: {
      captureRequested: true,
      captureRequests: report.usage.captureRequests,
      uploads: report.usage.uploads,
    },
    ...(report.retryAfterSeconds === undefined
      ? {}
      : { retryAfterSeconds: report.retryAfterSeconds }),
  };
};

const verifyAncestor = async (
  repositoryRoot: string,
  ancestor: string,
  descendant: string,
): Promise<void> => {
  const result = await runCommand("git", ["merge-base", "--is-ancestor", ancestor, descendant], {
    cwd: repositoryRoot,
    env: artifactGitEnvironment(),
    inheritEnv: false,
    timeoutMs: 30_000,
  });
  if (result.exitCode !== 0) throw new Error("Production Netlify source is not on main history.");
};

const expectedPair = (record: ProductionAdoptionRecord) => ({
  netlifyDeployId: record.inspection!.pair.netlifyDeployId,
  workerDeploymentId:
    record.results.activatedWorker?.deploymentId ?? record.inspection!.pair.workerDeploymentId,
  workerVersionId:
    record.results.activatedWorker?.versionId ?? record.inspection!.pair.workerVersionId,
});

const latestJournalValue = (
  record: ProductionAdoptionRecord,
  step: ProductionAdoptionMutationStep,
  predicate: (value: ProductionAdoptionRecord["journal"][number]["value"]) => boolean,
) => record.journal.filter((entry) => entry.step === step && predicate(entry.value)).at(-1)?.value;

export async function createProductionAdoptionProviderDependencies(
  rawInput: ProductionAdoptionProviderFactoryInput,
  overrides: ProductionAdoptionProviderFactoryOverrides = {},
): Promise<ProductionAdoptionProviderDependencies> {
  const repositoryRoot = resolve(rawInput.repositoryRoot);
  const artifactDirectory = resolve(rawInput.artifactDirectory);
  const smokeOutputDirectory = resolve(rawInput.smokeOutputDirectory);
  const configuration = releaseConfigSchema.parse(rawInput.configuration);
  const prepared = preparedReleaseSchema.parse(rawInput.prepared);
  const previous = rawInput.previous
    ? productionAdoptionRecordSchema.parse(rawInput.previous)
    : undefined;
  const target = configuration.environments.production;
  const staging = configuration.environments.staging;
  if (
    prepared.source.environment !== "production" ||
    !target.netlify ||
    !target.cloudflare ||
    !staging.netlify ||
    !staging.cloudflare ||
    target.netlify.siteId === staging.netlify.siteId ||
    target.cloudflare.workerName === staging.cloudflare.workerName ||
    target.cloudflare.wranglerEnvironment !== "production" ||
    !exactOrigin(target.netlify.expectedNonSecretVariables.PUBLIC_BASE_URL) ||
    (previous &&
      (previous.preparationSha256 !== artifactHash(JSON.stringify(prepared)) ||
        previous.source.promotionCommit !== prepared.source.candidate ||
        previous.source.tree !== prepared.source.tree ||
        previous.source.configurationSha256 !== artifactHash(JSON.stringify(configuration)) ||
        previous.results.heldNetlify !== undefined ||
        previous.results.publishedNetlify !== undefined))
  ) {
    throw new Error("Production adoption provider input is invalid.");
  }
  const verified = await (overrides.verifySource ?? verifyArtifactSource)(
    repositoryRoot,
    prepared.source.candidate,
    "production",
  );
  if (!same(verified.source, prepared.source) || !same(verified.configuration, configuration)) {
    throw new Error("Production adoption source or configuration differs.");
  }

  const workerArtifactDirectory = resolve(artifactDirectory, prepared.artifacts.worker.directory);
  const worker = {
    artifactDirectory: workerArtifactDirectory,
    manifestSha256: prepared.artifacts.worker.sha256,
    manifest: (await readBoundedJson(
      resolve(workerArtifactDirectory, "worker-artifact.json"),
      1024 * 1024,
      () => new Error("Invalid Worker artifact manifest."),
    )) as WorkerArtifactManifest,
  };
  const workerArtifactInput = {
    artifactDirectory: workerArtifactDirectory,
    environment: "production" as const,
    productionWorkerName: target.cloudflare.workerName,
    repositoryRoot,
    sourceConfigSha256: artifactHash(
      await readFile(resolve(repositoryRoot, target.cloudflare.wranglerConfigPath)),
    ),
    target: target.cloudflare,
  };
  const verifiedWorkerManifest = await (overrides.verifyWorkerArtifacts ?? verifyWorkerArtifacts)(
    workerArtifactInput,
    worker,
  );
  await assertExternalArtifactDirectory(repositoryRoot, smokeOutputDirectory);

  const providerRun: ProviderCommandRunner =
    overrides.providerRun ??
    (async (executable, args, extra = {}) => {
      const result = await (overrides.run ?? runCommand)(executable, args, {
        cwd: repositoryRoot,
        env: {
          ...artifactBuildEnvironment(
            target.netlify!.expectedNonSecretVariables.COLLABORATION_WEBSOCKET_URL,
          ),
          ...selectedEnvironment(executable),
          ...extra,
        },
        inheritEnv: false,
        timeoutMs: 60_000,
      });
      if (result.exitCode !== 0) throw new Error("Production adoption inspection failed.");
      return result.stdout;
    });
  let workerTransport: Promise<WorkerReleaseTransport> | undefined;
  const getWorkerTransport = () =>
    (workerTransport ??= Promise.resolve(
      overrides.createWorkerTransport
        ? overrides.createWorkerTransport({ repositoryRoot, workerArtifactDirectory })
        : createCloudflareWorkerFetchTransport({
            resolveAccessToken: createWranglerAccessTokenResolver({
              repositoryRoot,
              workingDirectory: workerArtifactDirectory,
            }),
          }),
    ));
  const workerDependencies = async (checkpoint: (value: unknown) => Promise<void>) => ({
    checkpoint,
    transport: await getWorkerTransport(),
  });
  const readInspection = async (): Promise<ProductionAdoptionInspection> => {
    const [app, workerState] = await Promise.all([
      (overrides.inspectNetlify ?? inspectNetlify)(target.netlify!, providerRun),
      (overrides.inspectCloudflare ?? inspectCloudflare)(
        {
          ...target.cloudflare!,
          wranglerConfigPath: resolve(repositoryRoot, target.cloudflare!.wranglerConfigPath),
        },
        providerRun,
      ),
    ]);
    if (
      app.siteId !== target.netlify!.siteId ||
      app.publishedDeploySource.branch !== "main" ||
      app.publishedDeploySource.context !== "production" ||
      app.publishedDeploySource.commitRef === null ||
      workerState.accountId !== target.cloudflare!.accountId ||
      workerState.workerName !== target.cloudflare!.workerName ||
      !inspectConfiguration(app, workerState)
    ) {
      throw new Error("Production adoption provider inspection did not pass.");
    }
    await (overrides.verifyAncestor ?? verifyAncestor)(
      repositoryRoot,
      app.publishedDeploySource.commitRef,
      prepared.source.candidate,
    );
    const versionId = workerState.traffic[0]!.versionId;
    const inspectedWorker = await (
      overrides.adapters?.inspectWorker ?? inspectPreparedProductionWorkerBaseline
    )(
      {
        artifactInput: workerArtifactInput,
        authorization: rawInput.authorization,
        expectedBaselineDeploymentId: workerState.deploymentId,
        migrationPolicy: { artifactTag: "v1", change: "none", expectedCurrentTag: "v1" },
        prepared: worker,
      },
      await workerDependencies(async () => undefined),
    );
    if (
      inspectedWorker.accountId !== target.cloudflare!.accountId ||
      inspectedWorker.workerName !== target.cloudflare!.workerName ||
      inspectedWorker.deploymentId !== workerState.deploymentId ||
      inspectedWorker.versionId !== versionId ||
      !same(
        inspectedWorker.requiredSecretBindingNames,
        [...verifiedWorkerManifest.policy.requiredSecretNames].sort(),
      )
    ) {
      throw new Error("Production adoption Worker inspection changed.");
    }
    return productionAdoptionInspectionSchema.parse({
      pair: {
        netlifyDeployId: app.publishedDeployId,
        workerDeploymentId: inspectedWorker.deploymentId,
        workerVersionId: inspectedWorker.versionId,
      },
      netlify: {
        branch: "main",
        context: "production",
        publishLocked: true,
        publishedDeployId: app.publishedDeployId,
        siteId: app.siteId,
        sourceCommit: app.publishedDeploySource.commitRef,
      },
      worker: inspectedWorker,
    });
  };

  const initialInspection = await readInspection();
  if (previous) {
    const mutationEvidenceExists =
      previous.journal.length > 0 ||
      previous.results.uploadedWorker !== undefined ||
      previous.results.activatedWorker !== undefined ||
      previous.stages["upload-worker"] !== "pending" ||
      previous.stages["activate-worker"] !== "pending";
    const activationUnresolved = ["running", "failed", "blocked"].includes(
      previous.stages["activate-worker"],
    );
    if (
      (previous.inspection === undefined && mutationEvidenceExists) ||
      (previous.inspection !== undefined &&
        (!same(previous.inspection.netlify, initialInspection.netlify) ||
          previous.inspection.worker.accountId !== initialInspection.worker.accountId ||
          previous.inspection.worker.workerName !== initialInspection.worker.workerName ||
          previous.inspection.worker.migrationTag !== initialInspection.worker.migrationTag ||
          !same(
            previous.inspection.worker.requiredSecretBindingNames,
            initialInspection.worker.requiredSecretBindingNames,
          ) ||
          previous.inspection.worker.secretValuesObservable !== false ||
          (!activationUnresolved && !same(expectedPair(previous), initialInspection.pair))))
    ) {
      throw new Error("Production adoption resume inspection differs.");
    }
  }
  const baselineDeploymentId =
    previous?.inspection?.worker.deploymentId ?? initialInspection.worker.deploymentId;
  const workerInput: PreparedProductionWorkerRelease = {
    artifactInput: workerArtifactInput,
    authorization: rawInput.authorization,
    expectedBaselineDeploymentId: baselineDeploymentId,
    migrationPolicy: { artifactTag: "v1", change: "none", expectedCurrentTag: "v1" },
    prepared: worker,
  };
  const inspect = async () => {
    const current = await readInspection();
    if (!same(current.netlify, initialInspection.netlify)) {
      throw new Error("Production Netlify publication changed during adoption.");
    }
    return current;
  };
  const validateRecord = (record: ProductionAdoptionRecord): void => {
    if (
      record.preparationSha256 !== artifactHash(JSON.stringify(prepared)) ||
      record.source.promotionCommit !== prepared.source.candidate ||
      record.source.tree !== prepared.source.tree ||
      record.source.configurationSha256 !== artifactHash(JSON.stringify(configuration)) ||
      record.source.productionConfigurationFingerprint !==
        prepared.source.configurationFingerprint ||
      !record.inspection ||
      !same(record.inspection.netlify, initialInspection.netlify) ||
      record.inspection.worker.accountId !== target.cloudflare!.accountId ||
      record.inspection.worker.workerName !== target.cloudflare!.workerName ||
      record.inspection.worker.deploymentId !== baselineDeploymentId ||
      record.results.heldNetlify !== undefined ||
      record.results.publishedNetlify !== undefined
    ) {
      throw new Error("Production adoption evidence differs.");
    }
  };
  const writeSmoke = async () => {
    await mkdir(smokeOutputDirectory, { mode: 0o700 });
    const report = safeSmokeReport(
      await (overrides.runSmoke ?? runCollaborationSmoke)(
        {
          capture: true,
          configPath: resolve(repositoryRoot, "scripts/release/environments.json"),
          configSource: "default",
          environment: "production",
          origin: target.netlify!.expectedNonSecretVariables.PUBLIC_BASE_URL,
        },
        configuration,
      ),
    );
    const id = (overrides.uniqueId ?? randomUUID)();
    if (!SAFE_REPORT_ID.test(id))
      throw new Error("Production adoption smoke report ID is invalid.");
    await writeFile(
      resolve(smokeOutputDirectory, `pair-${id}.json`),
      `${JSON.stringify(report)}\n`,
      { flag: "wx", mode: 0o600 },
    );
    return report.outcome === "passed";
  };

  return {
    inspect,
    uploadWorker: async (checkpoint) =>
      (overrides.adapters?.uploadWorker ?? uploadPreparedProductionWorker)(
        workerInput,
        await workerDependencies(checkpoint),
      ),
    activateWorker: async (upload, checkpoint) => {
      const activated = await (
        overrides.adapters?.activateWorker ?? activatePreparedProductionWorker
      )({ ...workerInput, upload }, await workerDependencies(checkpoint));
      return { deploymentId: activated.deploymentId, versionId: activated.versionId };
    },
    reconcile: async (step, rawRecord): Promise<ProductionResults> => {
      const record = productionAdoptionRecordSchema.parse(rawRecord);
      validateRecord(record);
      if (step === "upload-worker") {
        const response = latestJournalValue(record, step, (value) =>
          Boolean(
            value.phase === "version-upload-response-received" &&
            value.artifactManifestSha256 === prepared.artifacts.worker.sha256 &&
            value.accountId === target.cloudflare!.accountId &&
            value.workerName === target.cloudflare!.workerName &&
            value.baselineDeploymentId === baselineDeploymentId &&
            sameMigration(value.migrationPolicy) &&
            typeof value.versionId === "string",
          ),
        );
        const reconciliation: WorkerReleaseReconciliation =
          response?.versionId !== undefined
            ? { phase: "version-upload-response-received", versionId: response.versionId }
            : { phase: "version-upload-pending" };
        const result = await (overrides.adapters?.reconcileWorker ?? reconcileWorkerRelease)(
          workerInput,
          reconciliation,
          await workerDependencies(async () => undefined),
        );
        if (result.status !== "uploaded") throw new Error("Worker adoption recovery is invalid.");
        return productionResultsSchema.parse({ uploadedWorker: result });
      }
      const upload = record.results.uploadedWorker;
      if (!upload) throw new Error("Worker adoption upload evidence is missing.");
      const response = latestJournalValue(record, step, (value) =>
        Boolean(
          value.phase === "activation-response-received" &&
          value.artifactManifestSha256 === prepared.artifacts.worker.sha256 &&
          value.accountId === target.cloudflare!.accountId &&
          value.workerName === target.cloudflare!.workerName &&
          value.baselineDeploymentId === baselineDeploymentId &&
          sameMigration(value.migrationPolicy) &&
          value.versionId === upload.versionId &&
          typeof value.deploymentId === "string",
        ),
      );
      const reconciliation: WorkerReleaseReconciliation =
        response?.deploymentId !== undefined
          ? {
              deploymentId: response.deploymentId,
              phase: "activation-response-received",
              upload,
            }
          : { phase: "activation-pending", upload };
      const result = await (overrides.adapters?.reconcileWorker ?? reconcileWorkerRelease)(
        workerInput,
        reconciliation,
        await workerDependencies(async () => undefined),
      );
      if (result.status !== "activated") throw new Error("Worker adoption recovery is invalid.");
      return productionResultsSchema.parse({
        activatedWorker: { deploymentId: result.deploymentId, versionId: result.versionId },
      });
    },
    verifyRetained: async (rawRecord) => {
      const record = productionAdoptionRecordSchema.parse(rawRecord);
      validateRecord(record);
      const upload = record.results.uploadedWorker;
      if (!upload) return;
      const activation = record.results.activatedWorker;
      await (overrides.adapters?.verifyRetainedWorker ?? verifyRetainedWorkerRelease)(
        workerInput,
        upload,
        activation,
        await workerDependencies(async () => undefined),
      );
    },
    verifyPair: writeSmoke,
  };
}
