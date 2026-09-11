import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import {
  artifactBuildEnvironment,
  artifactHash,
  assertExternalArtifactDirectory,
  verifyArtifactSource,
} from "./artifact-contract.ts";
import { readBoundedJson } from "./bootstrap-safety.ts";
import { runCommand } from "./command.ts";
import {
  verifyNetlifyArtifacts,
  type NetlifyArtifactInventory,
  type PreparedNetlifyArtifacts,
} from "./netlify-artifacts.ts";
import {
  createAuthenticatedNetlifyDeploymentClient,
  publishHeldProductionNetlifyDeployment,
  reconcileNetlifyDeployment,
  uploadHeldProductionNetlifyDeployment,
  verifyRetainedNetlifyDeployment,
  type NetlifyDeploymentClient,
  type NetlifyDeploymentReconciliation,
  type ProductionNetlifyDeploymentInput,
} from "./netlify-deployment.ts";
import { preparedReleaseSchema, type PreparedRelease } from "./prepare.ts";
import type { ProductionProviderAuthorization } from "./production-authorization.ts";
import {
  approvalSchema,
  productionRecordSchema,
  type ProductionRecord,
  type ProductionResults,
  type ReleaseApproval,
} from "./production-record.ts";
import type { ProductionDependencies, ProductionMutationStep } from "./production-runner.ts";
import {
  inspectCloudflare,
  inspectNetlify,
  type CloudflareInspection,
  type NetlifyInspection,
  type ProviderCommandRunner,
} from "./providers.ts";
import { releaseConfigSchema, type ReleaseConfig } from "./schema.ts";
import { runCollaborationSmoke, type CollaborationSmokeReport } from "./smoke.ts";
import {
  verifyWorkerArtifacts,
  type PreparedWorkerArtifacts,
  type WorkerArtifactManifest,
} from "./worker-artifacts.ts";
import {
  activatePreparedProductionWorker,
  createCloudflareWorkerFetchTransport,
  createWranglerAccessTokenResolver,
  reconcileWorkerRelease,
  uploadPreparedProductionWorker,
  verifyRetainedWorkerRelease,
  type PreparedProductionWorkerRelease,
  type WorkerReleaseReconciliation,
  type WorkerReleaseTransport,
} from "./worker-release.ts";

export type ProductionProviderFactoryInput = {
  approval: ReleaseApproval;
  artifactDirectory: string;
  authorization: ProductionProviderAuthorization;
  configuration: ReleaseConfig;
  prepared: PreparedRelease;
  repositoryRoot: string;
  smokeOutputDirectory: string;
};

export type ProductionProviderFactoryOverrides = {
  adapters?: {
    activateWorker?: typeof activatePreparedProductionWorker;
    holdNetlify?: typeof uploadHeldProductionNetlifyDeployment;
    publishNetlify?: typeof publishHeldProductionNetlifyDeployment;
    reconcileNetlify?: typeof reconcileNetlifyDeployment;
    reconcileWorker?: typeof reconcileWorkerRelease;
    uploadWorker?: typeof uploadPreparedProductionWorker;
    verifyRetainedNetlify?: typeof verifyRetainedNetlifyDeployment;
    verifyRetainedWorker?: typeof verifyRetainedWorkerRelease;
  };
  createNetlifyClient?: (repositoryRoot: string) => Promise<NetlifyDeploymentClient>;
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
  verifyNetlifyArtifacts?: typeof verifyNetlifyArtifacts;
  verifySource?: typeof verifyArtifactSource;
  verifyWorkerArtifacts?: typeof verifyWorkerArtifacts;
};

export type ProductionProviderDependencies = ProductionDependencies & {
  verifyRetained(record: ProductionRecord): Promise<void>;
};

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

const inspectionIsConfigured = (app: NetlifyInspection, worker: CloudflareInspection): boolean =>
  app.publishLocked &&
  app.variableScopesMatch &&
  Object.values(app.nonSecretVariables).every((value) => value.present && value.matchesExpected) &&
  Object.values(app.requiredSecrets).every(Boolean) &&
  Object.values(worker.nonSecretVariables).every(
    (value) => value.present && value.matchesExpected,
  ) &&
  Object.values(worker.requiredSecrets).every(Boolean) &&
  worker.traffic.length === 1 &&
  worker.traffic[0].percentage === 100;

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
    typeof report.configuration.fingerprint !== "string" ||
    !/^[a-f0-9]{64}$/u.test(report.configuration.fingerprint) ||
    report.configuration.source !== "default" ||
    (report.retryAfterSeconds !== undefined &&
      (!Number.isSafeInteger(report.retryAfterSeconds) || report.retryAfterSeconds < 1)) ||
    (report.usage.uploads !== 0 && report.usage.uploads !== 1) ||
    report.usage.captureRequested !== true ||
    (report.usage.captureRequests !== 0 && report.usage.captureRequests !== 1)
  ) {
    throw new Error("Production smoke report is invalid.");
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

const latestJournalValue = (
  record: ProductionRecord,
  step: ProductionMutationStep,
  predicate: (value: ProductionRecord["journal"][number]["value"]) => boolean,
) => record.journal.filter((entry) => entry.step === step && predicate(entry.value)).at(-1)?.value;

export async function createProductionProviderDependencies(
  rawInput: ProductionProviderFactoryInput,
  overrides: ProductionProviderFactoryOverrides = {},
): Promise<ProductionProviderDependencies> {
  const repositoryRoot = resolve(rawInput.repositoryRoot);
  const artifactDirectory = resolve(rawInput.artifactDirectory);
  const smokeOutputDirectory = resolve(rawInput.smokeOutputDirectory);
  const prepared = preparedReleaseSchema.parse(rawInput.prepared);
  const configuration = releaseConfigSchema.parse(rawInput.configuration);
  const approval = approvalSchema.parse(rawInput.approval);
  const { authorization } = rawInput;
  const target = configuration.environments.production;
  const appTarget = target.netlify;
  const workerTarget = target.cloudflare;
  const appBaseline = approval.baseline.providers.netlify;
  const workerBaseline = approval.baseline.providers.cloudflare;
  if (
    prepared.source.environment !== "production" ||
    prepared.source.tree !== approval.tree ||
    approval.configurationFingerprint !== artifactHash(JSON.stringify(configuration)) ||
    !appTarget ||
    !workerTarget ||
    !appBaseline ||
    !workerBaseline ||
    appBaseline.siteId !== appTarget.siteId ||
    workerBaseline.accountId !== workerTarget.accountId ||
    workerBaseline.workerName !== workerTarget.workerName ||
    appBaseline.publishLocked !== true ||
    workerTarget.wranglerEnvironment !== "production" ||
    !exactOrigin(appTarget.expectedNonSecretVariables.PUBLIC_BASE_URL)
  ) {
    throw new Error("Production provider input is invalid.");
  }
  const verified = await (overrides.verifySource ?? verifyArtifactSource)(
    repositoryRoot,
    prepared.source.candidate,
    "production",
  );
  if (
    JSON.stringify(verified.source) !== JSON.stringify(prepared.source) ||
    JSON.stringify(verified.configuration) !== JSON.stringify(configuration)
  ) {
    throw new Error("Production source or configuration differs.");
  }
  try {
    authorization.assertArtifact(
      "netlify",
      { accountId: appTarget.accountId, siteId: appTarget.siteId },
      prepared.artifacts.netlify.sha256,
    );
    authorization.assertArtifact(
      "cloudflare",
      { accountId: workerTarget.accountId, workerName: workerTarget.workerName },
      prepared.artifacts.worker.sha256,
    );
  } catch {
    throw new Error("Production provider authorization differs.");
  }

  const netlifyArtifactDirectory = resolve(artifactDirectory, prepared.artifacts.netlify.directory);
  const workerArtifactDirectory = resolve(artifactDirectory, prepared.artifacts.worker.directory);
  const netlify: PreparedNetlifyArtifacts = {
    artifactDirectory: netlifyArtifactDirectory,
    inventorySha256: prepared.artifacts.netlify.sha256,
    inventory: (await readBoundedJson(
      resolve(netlifyArtifactDirectory, "inventory.json"),
      1024 * 1024,
      () => new Error("Invalid Netlify artifact inventory."),
    )) as NetlifyArtifactInventory,
  };
  const worker: PreparedWorkerArtifacts = {
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
    productionWorkerName: workerTarget.workerName,
    repositoryRoot,
    sourceConfigSha256: artifactHash(
      await readFile(resolve(repositoryRoot, workerTarget.wranglerConfigPath)),
    ),
    target: workerTarget,
  };
  await (overrides.verifyNetlifyArtifacts ?? verifyNetlifyArtifacts)(netlify);
  await (overrides.verifyWorkerArtifacts ?? verifyWorkerArtifacts)(workerArtifactInput, worker);
  await assertExternalArtifactDirectory(repositoryRoot, smokeOutputDirectory);
  await mkdir(smokeOutputDirectory, { mode: 0o700 });

  const providerRun: ProviderCommandRunner =
    overrides.providerRun ??
    (async (executable, args, extra = {}) => {
      const result = await (overrides.run ?? runCommand)(executable, args, {
        cwd: repositoryRoot,
        env: {
          ...artifactBuildEnvironment(
            appTarget.expectedNonSecretVariables.COLLABORATION_WEBSOCKET_URL,
          ),
          ...selectedEnvironment(executable),
          ...extra,
        },
        inheritEnv: false,
        timeoutMs: 60_000,
      });
      if (result.exitCode !== 0) throw new Error("Production provider inspection failed.");
      return result.stdout;
    });
  const inspect = async () => {
    const [app, workerState] = await Promise.all([
      (overrides.inspectNetlify ?? inspectNetlify)(appTarget, providerRun),
      (overrides.inspectCloudflare ?? inspectCloudflare)(
        {
          ...workerTarget,
          wranglerConfigPath: resolve(repositoryRoot, workerTarget.wranglerConfigPath),
        },
        providerRun,
      ),
    ]);
    if (
      app.siteId !== appTarget.siteId ||
      workerState.accountId !== workerTarget.accountId ||
      workerState.workerName !== workerTarget.workerName ||
      !inspectionIsConfigured(app, workerState)
    ) {
      throw new Error("Production provider inspection did not pass.");
    }
    return {
      netlifyDeployId: app.publishedDeployId,
      workerDeploymentId: workerState.deploymentId,
      workerVersionId: workerState.traffic[0].versionId,
    };
  };
  await inspect();

  let netlifyClient: Promise<NetlifyDeploymentClient> | undefined;
  const getNetlifyClient = () =>
    (netlifyClient ??= (
      overrides.createNetlifyClient ?? createAuthenticatedNetlifyDeploymentClient
    )(repositoryRoot));
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
  const netlifyInput: ProductionNetlifyDeploymentInput = {
    accountId: appTarget.accountId,
    authorization,
    baselineDeployId: appBaseline.publishedDeployId,
    candidate: prepared.source.candidate,
    environment: "production",
    origin: appTarget.expectedNonSecretVariables.PUBLIC_BASE_URL,
    preparation: prepared,
    productionSiteId: appTarget.siteId,
    siteId: appTarget.siteId,
  };
  const workerInput: PreparedProductionWorkerRelease = {
    artifactInput: workerArtifactInput,
    authorization,
    expectedBaselineDeploymentId: workerBaseline.deploymentId,
    migrationPolicy: approval.migration,
    prepared: worker,
  };
  const netlifyMetadata = {
    functionSchedules: netlify.inventory.functionSchedules,
    functionsConfig: netlify.inventory.functionsConfig,
    functions: Object.fromEntries(
      netlify.inventory.functions.map((entry) => [
        entry.name,
        {
          invocationMode: entry.invocationMode,
          runtime: entry.runtimeVersion ?? entry.runtime,
          timeout: entry.timeout,
        },
      ]),
    ),
  };
  const netlifyDependencies = async (checkpoint: (value: unknown) => Promise<void>) => ({
    checkpoint,
    client: await getNetlifyClient(),
  });
  const workerDependencies = async (checkpoint: (value: unknown) => Promise<void>) => ({
    checkpoint,
    transport: await getWorkerTransport(),
  });
  const writeSmoke = async (phase: "pair" | "transition") => {
    const report = safeSmokeReport(
      await (overrides.runSmoke ?? runCollaborationSmoke)(
        {
          capture: true,
          configPath: resolve(repositoryRoot, "scripts/release/environments.json"),
          configSource: "default",
          environment: "production",
          origin: appTarget.expectedNonSecretVariables.PUBLIC_BASE_URL,
        },
        configuration,
      ),
    );
    const id = (overrides.uniqueId ?? randomUUID)();
    if (!SAFE_REPORT_ID.test(id)) throw new Error("Production smoke report ID is invalid.");
    await writeFile(
      resolve(smokeOutputDirectory, `${phase}-${id}.json`),
      `${JSON.stringify(report)}\n`,
      { flag: "wx", mode: 0o600 },
    );
    return report.outcome === "passed";
  };

  const dependencies: ProductionProviderDependencies = {
    inspect,
    holdNetlify: async (checkpoint) =>
      (overrides.adapters?.holdNetlify ?? uploadHeldProductionNetlifyDeployment)(
        netlifyInput,
        netlify,
        netlifyMetadata,
        await netlifyDependencies(checkpoint),
      ),
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
    publishNetlify: async (held, checkpoint) =>
      (overrides.adapters?.publishNetlify ?? publishHeldProductionNetlifyDeployment)(
        netlifyInput,
        held,
        await netlifyDependencies(checkpoint),
      ),
    reconcile: async (step, rawRecord): Promise<ProductionResults> => {
      const record = productionRecordSchema.parse(rawRecord);
      if (step === "hold-netlify") {
        const response = latestJournalValue(
          record,
          step,
          (value) =>
            value.operation === "createSiteDeploy" &&
            value.phase === "mutation-response-received" &&
            value.artifactSha256 === prepared.artifacts.netlify.sha256 &&
            typeof value.deployId === "string",
        );
        const reconciliation: NetlifyDeploymentReconciliation = response?.deployId
          ? { deployId: response.deployId, phase: "candidate-create-response-received" }
          : { phase: "candidate-create-pending" };
        const held = await (overrides.adapters?.reconcileNetlify ?? reconcileNetlifyDeployment)(
          netlifyInput,
          reconciliation,
          await netlifyDependencies(async () => undefined),
        );
        if (!("candidateDeployId" in held)) throw new Error("Netlify recovery is invalid.");
        return { heldNetlify: held };
      }
      if (step === "upload-worker") {
        const response = latestJournalValue(
          record,
          step,
          (value) =>
            value.phase === "version-upload-response-received" &&
            value.accountId === workerTarget.accountId &&
            value.workerName === workerTarget.workerName &&
            value.artifactManifestSha256 === prepared.artifacts.worker.sha256 &&
            typeof value.versionId === "string",
        );
        const reconciliation: WorkerReleaseReconciliation = response?.versionId
          ? { phase: "version-upload-response-received", versionId: response.versionId }
          : { phase: "version-upload-pending" };
        const upload = await (overrides.adapters?.reconcileWorker ?? reconcileWorkerRelease)(
          workerInput,
          reconciliation,
          await workerDependencies(async () => undefined),
        );
        if (upload.status !== "uploaded") throw new Error("Worker upload recovery is invalid.");
        return { uploadedWorker: upload };
      }
      if (step === "activate-worker") {
        const upload = record.results.uploadedWorker;
        if (!upload) throw new Error("Worker upload evidence is missing.");
        const response = latestJournalValue(
          record,
          step,
          (value) =>
            value.phase === "activation-response-received" &&
            value.accountId === workerTarget.accountId &&
            value.workerName === workerTarget.workerName &&
            value.artifactManifestSha256 === prepared.artifacts.worker.sha256 &&
            value.versionId === upload.versionId &&
            typeof value.deploymentId === "string",
        );
        const reconciliation: WorkerReleaseReconciliation = response?.deploymentId
          ? {
              deploymentId: response.deploymentId,
              phase: "activation-response-received",
              upload,
            }
          : { phase: "activation-pending", upload };
        const activation = await (overrides.adapters?.reconcileWorker ?? reconcileWorkerRelease)(
          workerInput,
          reconciliation,
          await workerDependencies(async () => undefined),
        );
        if (activation.status !== "activated") {
          throw new Error("Worker activation recovery is invalid.");
        }
        return {
          activatedWorker: {
            deploymentId: activation.deploymentId,
            versionId: activation.versionId,
          },
        };
      }
      const held = record.results.heldNetlify;
      if (!held) throw new Error("Held Netlify evidence is missing.");
      const response = latestJournalValue(
        record,
        step,
        (value) =>
          value.operation === "restoreSiteDeploy" &&
          value.phase === "mutation-response-received" &&
          value.artifactSha256 === held.artifactSha256 &&
          value.deployId === held.candidateDeployId &&
          typeof value.publishedDeployId === "string",
      );
      const reconciliation: NetlifyDeploymentReconciliation = response?.publishedDeployId
        ? {
            held,
            phase: "publish-response-received",
            publishedDeployId: response.publishedDeployId,
          }
        : { held, phase: "publish-pending" };
      const publication = await (
        overrides.adapters?.reconcileNetlify ?? reconcileNetlifyDeployment
      )(netlifyInput, reconciliation, await netlifyDependencies(async () => undefined));
      if (!("publishedDeployId" in publication)) {
        throw new Error("Netlify publication recovery is invalid.");
      }
      return { publishedNetlify: publication };
    },
    verifyRetained: async (rawRecord) => {
      const record = productionRecordSchema.parse(rawRecord);
      const held = record.results.heldNetlify;
      const published = record.results.publishedNetlify;
      if (published && !held) throw new Error("Published Netlify evidence is incomplete.");
      if (held) {
        await (overrides.adapters?.verifyRetainedNetlify ?? verifyRetainedNetlifyDeployment)(
          netlifyInput,
          held,
          published?.publishedDeployId ?? record.priorPair.netlifyDeployId,
          await netlifyDependencies(async () => undefined),
        );
      }
      const upload = record.results.uploadedWorker;
      const activation = record.results.activatedWorker;
      if (activation && !upload) throw new Error("Activated Worker evidence is incomplete.");
      if (upload) {
        await (overrides.adapters?.verifyRetainedWorker ?? verifyRetainedWorkerRelease)(
          workerInput,
          upload,
          activation,
          await workerDependencies(async () => undefined),
        );
      }
    },
    verifyTransition: () => writeSmoke("transition"),
    verifyPair: () => writeSmoke("pair"),
  };
  return dependencies;
}
