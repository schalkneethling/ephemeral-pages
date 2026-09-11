import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { assertExternalArtifactDirectory } from "./artifact-contract.ts";
import { runCommand } from "./command.ts";
import {
  inspectRecoveryTargets,
  reconcileRecoveryNetlify,
  reconcileRecoveryWorker,
  restoreRecoveryNetlify,
  rollbackRecoveryWorker,
  verifyRecoveryTargets,
  createAuthenticatedRecoveryNetlifyClient,
  type NetlifyRecoveryResult,
  type RecoveryProviderCheckpoint,
  type RecoveryProviderDependencies as AdapterDependencies,
  type RecoveryProviderPlan,
  type RecoveryTargetEvidence,
} from "./recovery-provider-adapters.ts";
import { recoveryRecordSchema, type RecoveryRecord } from "./recovery-record.ts";
import type { RecoveryDependencies } from "./recovery-runner.ts";
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
  createCloudflareWorkerFetchTransport,
  createWranglerAccessTokenResolver,
  type WorkerReleaseTransport,
} from "./worker-release.ts";
import {
  stagingRecoveryRecordSchema,
  type StagingRecoveryDependencies,
  type StagingRecoveryRecord,
} from "./staging-recovery-runner.ts";

export type RecoveryProviderFactoryInput = {
  configuration: ReleaseConfig;
  plan: RecoveryProviderPlan;
  previous?: RecoveryRecord;
  repositoryRoot: string;
  smokeOutputDirectory: string;
};

export type StagingRecoveryProviderFactoryInput = Omit<
  RecoveryProviderFactoryInput,
  "plan" | "previous"
> & {
  plan: RecoveryProviderPlan & { environment: "staging" };
  previous?: StagingRecoveryRecord;
};

export type RecoveryProviderFactoryOverrides = {
  adapters?: {
    inspectTargets?: typeof inspectRecoveryTargets;
    reconcileNetlify?: typeof reconcileRecoveryNetlify;
    reconcileWorker?: typeof reconcileRecoveryWorker;
    restoreNetlify?: typeof restoreRecoveryNetlify;
    restoreWorker?: typeof rollbackRecoveryWorker;
    verifyTargets?: typeof verifyRecoveryTargets;
  };
  createNetlifyClient?: typeof createAuthenticatedRecoveryNetlifyClient;
  createWorkerTransport?: (input: {
    repositoryRoot: string;
    workerArtifactDirectory: string;
  }) => Promise<WorkerReleaseTransport> | WorkerReleaseTransport;
  inspectCloudflare?: typeof inspectCloudflare;
  inspectNetlify?: typeof inspectNetlify;
  providerRun?: ProviderCommandRunner;
  run?: typeof runCommand;
  runSmoke?: typeof runCollaborationSmoke;
  uniqueId?: () => string;
};

export type RecoveryProviderFactoryDependencies = RecoveryDependencies;
export type StagingRecoveryProviderFactoryDependencies = StagingRecoveryDependencies;

type ProviderRecoveryRecord = RecoveryRecord | StagingRecoveryRecord;
type ProviderDependenciesFor<Record extends ProviderRecoveryRecord> = Omit<
  RecoveryDependencies,
  "reconcile"
> & {
  reconcile(step: "restore-netlify" | "restore-worker", record: Record): Promise<Record["results"]>;
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

const stable = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(stable);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, stable(item)]),
  );
};

const same = (left: unknown, right: unknown): boolean =>
  JSON.stringify(stable(left)) === JSON.stringify(stable(right));

const exactOrigin = (value: string | undefined): value is string => {
  if (!value) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.origin === value;
  } catch {
    return false;
  }
};

const selectedEnvironment = (executable: string): Record<string, string> => {
  const names = [
    ...SYSTEM_ENVIRONMENT_KEYS,
    ...(executable.endsWith("netlify") ? (["NETLIFY_AUTH_TOKEN"] as const) : []),
    ...(executable.endsWith("wrangler")
      ? (["CLOUDFLARE_API_KEY", "CLOUDFLARE_API_TOKEN", "CLOUDFLARE_EMAIL"] as const)
      : []),
  ];
  const environment: Record<string, string> = { CI: "true", NO_COLOR: "1" };
  for (const name of names) {
    const value = process.env[name];
    if (value !== undefined) environment[name] = value;
  }
  return environment;
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

const safeSmokeReport = (
  report: CollaborationSmokeReport,
  environment: "production" | "staging",
): CollaborationSmokeReport => {
  if (
    report.schemaVersion !== 1 ||
    report.operation !== "collaboration-smoke" ||
    report.environment !== environment ||
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
  )
    throw new Error("Recovery smoke report is invalid.");
  return {
    checks: report.checks.map(({ id, outcome, summary }) => ({ id, outcome, summary })),
    configuration: { fingerprint: report.configuration.fingerprint, source: "default" },
    environment,
    operation: "collaboration-smoke",
    outcome: report.outcome,
    ...(report.retryAfterSeconds === undefined
      ? {}
      : { retryAfterSeconds: report.retryAfterSeconds }),
    schemaVersion: 1,
    usage: {
      captureRequested: true,
      captureRequests: report.usage.captureRequests,
      uploads: report.usage.uploads,
    },
  };
};

const translateCheckpoint = (
  value: RecoveryProviderCheckpoint,
  plan: RecoveryProviderPlan,
): Record<string, unknown> => {
  const worker = {
    accountId: plan.worker.accountId,
    artifactManifestSha256: plan.worker.targetArtifactSha256,
    baselineDeploymentId: plan.expectedCurrent.workerDeploymentId,
    migrationPolicy: { artifactTag: "v1", change: "none", expectedCurrentTag: "v1" },
    workerName: plan.worker.workerName,
  } as const;
  if (value.phase === "netlify-restore-pending") {
    return {
      deployId: value.targetDeployId,
      operation: "restoreSiteDeploy",
      phase: "pending-mutation",
      siteId: plan.netlify.siteId,
      ...(plan.netlify.targetIdentity.kind === "release-artifact"
        ? { artifactSha256: plan.netlify.targetIdentity.artifactSha256 }
        : {}),
    };
  }
  if (value.phase === "netlify-restore-response-received") {
    return {
      deployId: value.restoredDeployId,
      operation: "restoreSiteDeploy",
      phase: "mutation-response-received",
      publishedDeployId: value.restoredDeployId,
      siteId: plan.netlify.siteId,
      ...(plan.netlify.targetIdentity.kind === "release-artifact"
        ? { artifactSha256: plan.netlify.targetIdentity.artifactSha256 }
        : {}),
    };
  }
  if (value.phase === "worker-rollback-pending") {
    return { ...worker, phase: "pending-activation", versionId: value.targetVersionId };
  }
  return {
    ...worker,
    deploymentId: value.deploymentId,
    phase: "activation-response-received",
    versionId: value.versionId,
  };
};

const latestWorkerResponseId = (record: ProviderRecoveryRecord): string | undefined =>
  record.journal
    .filter(
      ({ step, value }) =>
        step === "restore-worker" &&
        value.phase === "activation-response-received" &&
        typeof value.deploymentId === "string",
    )
    .at(-1)?.value.deploymentId;

const mutationStartedWithoutEvidence = (record: ProviderRecoveryRecord): boolean =>
  !record.targetEvidence &&
  (record.stages["restore-netlify"] !== "pending" ||
    record.stages["restore-worker"] !== "pending" ||
    record.journal.some(({ step }) => step === "restore-netlify" || step === "restore-worker"));

async function createProviderDependencies<Record extends ProviderRecoveryRecord>(
  rawInput: Omit<RecoveryProviderFactoryInput, "previous"> & { previous?: Record },
  parseRecord: (value: unknown) => Record,
  overrides: RecoveryProviderFactoryOverrides = {},
): Promise<ProviderDependenciesFor<Record>> {
  const repositoryRoot = resolve(rawInput.repositoryRoot);
  const smokeOutputDirectory = resolve(rawInput.smokeOutputDirectory);
  const configuration = releaseConfigSchema.parse(rawInput.configuration);
  const plan = rawInput.plan;
  const previous = rawInput.previous ? parseRecord(rawInput.previous) : undefined;
  const target = configuration.environments[plan.environment];
  const production = configuration.environments.production;
  if (!target.netlify || !target.cloudflare || !production.netlify || !production.cloudflare)
    throw new Error("Recovery provider input is invalid.");
  const appTarget = target.netlify;
  const workerTarget = target.cloudflare;
  const productionAppTarget = production.netlify;
  const productionWorkerTarget = production.cloudflare;
  if (
    plan.productionSiteId !== productionAppTarget.siteId ||
    plan.productionWorkerName !== productionWorkerTarget.workerName ||
    resolve(plan.worker.artifactInput.repositoryRoot) !== repositoryRoot ||
    plan.worker.artifactInput.environment !== plan.environment ||
    plan.worker.artifactInput.productionWorkerName !== productionWorkerTarget.workerName ||
    plan.worker.accountId !== workerTarget.accountId ||
    plan.worker.workerName !== workerTarget.workerName ||
    !same(plan.worker.artifactInput.target, workerTarget) ||
    plan.netlify.accountId !== appTarget.accountId ||
    plan.netlify.siteId !== appTarget.siteId ||
    !same(plan.netlify.expectedNonSecretVariables, appTarget.expectedNonSecretVariables) ||
    !same(plan.netlify.requiredSecretNames, appTarget.requiredSecretNames) ||
    !same(plan.netlify.requiredVariableScopes, appTarget.requiredVariableScopes) ||
    plan.netlify.origin !== appTarget.expectedNonSecretVariables.PUBLIC_BASE_URL ||
    !exactOrigin(plan.netlify.origin) ||
    (previous &&
      (previous.environment !== plan.environment ||
        !same(previous.startingPair, plan.expectedCurrent) ||
        !same(previous.targetPair, plan.requested))) ||
    (previous && mutationStartedWithoutEvidence(previous))
  )
    throw new Error("Recovery provider input is invalid.");

  const providerRun: ProviderCommandRunner =
    overrides.providerRun ??
    (async (executable, args, extra = {}) => {
      const result = await (overrides.run ?? runCommand)(executable, args, {
        cwd: repositoryRoot,
        env: { ...selectedEnvironment(executable), ...extra },
        inheritEnv: false,
        timeoutMs: 60_000,
      });
      if (result.exitCode !== 0) throw new Error("Recovery provider inspection failed.");
      return result.stdout;
    });

  const inspect = async () => {
    const [app, worker] = await Promise.all([
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
      worker.accountId !== workerTarget.accountId ||
      worker.workerName !== workerTarget.workerName ||
      !inspectionIsConfigured(app, worker)
    )
      throw new Error("Recovery provider inspection did not pass.");
    return {
      netlifyDeployId: app.publishedDeployId,
      workerDeploymentId: worker.deploymentId,
      workerVersionId: worker.traffic[0].versionId,
    };
  };

  let netlifyClient: ReturnType<typeof createAuthenticatedRecoveryNetlifyClient> | undefined;
  const getNetlifyClient = () =>
    (netlifyClient ??= (overrides.createNetlifyClient ?? createAuthenticatedRecoveryNetlifyClient)(
      repositoryRoot,
    ));
  let workerTransport: Promise<WorkerReleaseTransport> | undefined;
  const getWorkerTransport = () =>
    (workerTransport ??= Promise.resolve(
      overrides.createWorkerTransport
        ? overrides.createWorkerTransport({
            repositoryRoot,
            workerArtifactDirectory: plan.worker.preparedArtifacts.artifactDirectory,
          })
        : createCloudflareWorkerFetchTransport({
            resolveAccessToken: createWranglerAccessTokenResolver({
              repositoryRoot,
              workingDirectory: plan.worker.preparedArtifacts.artifactDirectory,
            }),
          }),
    ));
  const adapterDependencies = async (
    runnerCheckpoint: (value: unknown) => Promise<void> = async () => undefined,
  ): Promise<AdapterDependencies> => ({
    checkpoint: (value) => runnerCheckpoint(translateCheckpoint(value, plan)),
    netlifyClient: await getNetlifyClient(),
    workerTransport: await getWorkerTransport(),
  });

  let evidence: RecoveryTargetEvidence | undefined = previous?.targetEvidence;
  const requireEvidence = (): RecoveryTargetEvidence => {
    if (!evidence) throw new Error("Recovery target evidence is unavailable.");
    return evidence;
  };
  const restoredNetlify = (currentEvidence: RecoveryTargetEvidence): NetlifyRecoveryResult => ({
    deployId: plan.requested.netlifyDeployId,
    inspectionSha256: currentEvidence.inspectionSha256,
    status: "restored-and-locked",
  });

  let smokeDirectoryReady: Promise<void> | undefined;
  const prepareSmokeDirectory = () =>
    (smokeDirectoryReady ??= (async () => {
      await assertExternalArtifactDirectory(repositoryRoot, smokeOutputDirectory);
      await mkdir(smokeOutputDirectory, { mode: 0o700 });
    })());
  const writeSmoke = async (phase: "pair" | "transition") => {
    await prepareSmokeDirectory();
    const report = safeSmokeReport(
      await (overrides.runSmoke ?? runCollaborationSmoke)(
        {
          capture: true,
          configPath: resolve(repositoryRoot, "scripts/release/environments.json"),
          configSource: "default",
          environment: plan.environment,
          origin: plan.netlify.origin,
        },
        configuration,
      ),
      plan.environment,
    );
    const id = (overrides.uniqueId ?? randomUUID)();
    if (!SAFE_REPORT_ID.test(id)) throw new Error("Recovery smoke report ID is invalid.");
    await writeFile(
      resolve(smokeOutputDirectory, `${phase}-${id}.json`),
      `${JSON.stringify(report)}\n`,
      { flag: "wx", mode: 0o600 },
    );
    return report.outcome === "passed";
  };

  return {
    inspect,
    reconcile: async (step, rawRecord) => {
      const record = parseRecord(rawRecord);
      if (!record.targetEvidence) throw new Error("Recovery target evidence is missing.");
      evidence = record.targetEvidence;
      const dependencies = await adapterDependencies();
      if (step === "restore-netlify") {
        const result = await (overrides.adapters?.reconcileNetlify ?? reconcileRecoveryNetlify)(
          plan,
          evidence,
          dependencies,
        );
        if (result.status !== "completed") throw new Error("Netlify recovery is ambiguous.");
        return { netlify: { publishedDeployId: result.result.deployId } };
      }
      if (!record.results.netlify) throw new Error("Netlify recovery evidence is missing.");
      const result = await (overrides.adapters?.reconcileWorker ?? reconcileRecoveryWorker)(
        plan,
        evidence,
        restoredNetlify(evidence),
        latestWorkerResponseId(record),
        dependencies,
      );
      if (result.status !== "completed") throw new Error("Worker recovery is ambiguous.");
      return {
        worker: {
          deploymentId: result.result.deploymentId,
          versionId: result.result.versionId,
        },
      };
    },
    restoreNetlify: async (runnerCheckpoint) => {
      const result = await (overrides.adapters?.restoreNetlify ?? restoreRecoveryNetlify)(
        plan,
        requireEvidence(),
        await adapterDependencies(runnerCheckpoint),
      );
      return { publishedDeployId: result.deployId };
    },
    restoreWorker: async (runnerCheckpoint) => {
      const currentEvidence = requireEvidence();
      const result = await (overrides.adapters?.restoreWorker ?? rollbackRecoveryWorker)(
        plan,
        currentEvidence,
        restoredNetlify(currentEvidence),
        await adapterDependencies(runnerCheckpoint),
      );
      return { deploymentId: result.deploymentId, versionId: result.versionId };
    },
    verifyPair: () => writeSmoke("pair"),
    verifyTargets: async () => {
      if (!evidence) {
        evidence = await (overrides.adapters?.inspectTargets ?? inspectRecoveryTargets)(
          plan,
          await adapterDependencies(),
        );
        return evidence;
      }
      const current = await inspect();
      evidence = await (overrides.adapters?.verifyTargets ?? verifyRecoveryTargets)(
        plan,
        evidence,
        current,
        await adapterDependencies(),
      );
      return evidence;
    },
    verifyTransition: () => writeSmoke("transition"),
  };
}

export async function createRecoveryProviderDependencies(
  rawInput: RecoveryProviderFactoryInput,
  overrides: RecoveryProviderFactoryOverrides = {},
): Promise<RecoveryProviderFactoryDependencies> {
  if (rawInput.plan.environment !== "production")
    throw new Error("Recovery provider input is invalid.");
  return createProviderDependencies(
    rawInput,
    (value) => recoveryRecordSchema.parse(value),
    overrides,
  );
}

export async function createStagingRecoveryProviderDependencies(
  rawInput: StagingRecoveryProviderFactoryInput,
  overrides: RecoveryProviderFactoryOverrides = {},
): Promise<StagingRecoveryProviderFactoryDependencies> {
  if (rawInput.plan.environment !== "staging")
    throw new Error("Staging recovery provider input is invalid.");
  return createProviderDependencies(
    rawInput,
    (value) => stagingRecoveryRecordSchema.parse(value),
    overrides,
  );
}
