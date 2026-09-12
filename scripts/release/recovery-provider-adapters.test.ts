import { describe, expect, it, vi } from "vitest";

import type { WorkerArtifactManifest } from "./worker-artifacts.ts";
import {
  inspectRecoveryTargets,
  reconcileRecoveryNetlify,
  reconcileRecoveryWorker,
  RecoveryProviderError,
  restoreRecoveryNetlify,
  rollbackRecoveryWorker,
  verifyRecoveryTargets,
  type RecoveryProviderCheckpoint,
  type RecoveryProviderDependencies,
  type RecoveryProviderPlan,
} from "./recovery-provider-adapters.ts";

const variables = {
  ALLOWED_ORIGINS: "https://production.example.test",
  PAGE_CONTENT_ORIGIN: "https://production.example.test",
  PUBLIC_WORKER_ORIGIN: "https://production-worker.example.workers.dev",
  TICKET_AUDIENCE: "production-worker",
} as const;

const manifest: WorkerArtifactManifest = {
  entrypoint: "bundle/index.js",
  files: [
    { bytes: 1, path: "bundle/index.js", sha256: "1".repeat(64) },
    { bytes: 1, path: "config/wrangler.json", sha256: "2".repeat(64) },
  ],
  policy: {
    browser: { binding: "BROWSER" },
    compatibilityDate: "2026-08-16",
    compatibilityFlags: ["nodejs_compat"],
    durableObjects: {
      bindings: [{ className: "CollaborationRoom", name: "COLLABORATION_ROOMS" }],
    },
    migrations: [{ newSqliteClasses: ["CollaborationRoom"], tag: "v1" }],
    observability: {
      enabled: true,
      logs: { enabled: true, head_sampling_rate: 0.1 },
      traces: { enabled: true, head_sampling_rate: 0.01 },
    },
    requiredSecretNames: ["TICKET_HMAC_SECRET", "ADMIN_TOKEN"],
    workersDev: true,
  },
  schemaVersion: 1,
  source: { configPath: "collaboration-worker/wrangler.jsonc", configSha256: "3".repeat(64) },
  target: {
    accountId: "account-id",
    environment: "production",
    productionWorkerName: "production-worker",
    workerName: "production-worker",
    wranglerEnvironment: "production",
  },
  uploadConfig: { bytes: 1, path: "config/wrangler.json", sha256: "2".repeat(64) },
  wranglerVersion: "4.125.0",
};

const plan = (): RecoveryProviderPlan => ({
  environment: "production",
  expectedCurrent: {
    netlifyDeployId: "current-netlify",
    workerDeploymentId: "current-worker-deployment",
    workerVersionId: "current-worker-version",
  },
  netlify: {
    accountId: "netlify-account",
    expectedNonSecretVariables: { APP_MODE: "production" },
    origin: "https://production.example.test",
    requiredSecretNames: ["RATE_LIMIT_SECRET"],
    requiredVariableScopes: {
      APP_MODE: ["builds", "functions", "runtime"],
      RATE_LIMIT_SECRET: ["builds", "functions", "runtime"],
    },
    siteId: "production-site",
    targetIdentity: { commitRef: "a".repeat(40), kind: "source-commit" },
  },
  productionSiteId: "production-site",
  productionWorkerName: "production-worker",
  requested: {
    netlifyDeployId: "target-netlify",
    workerDeploymentId: "target-worker-deployment",
    workerVersionId: "target-worker-version",
  },
  worker: {
    accountId: "account-id",
    artifactInput: {
      artifactDirectory: "/tmp/recovery-artifact",
      environment: "production",
      productionWorkerName: "production-worker",
      repositoryRoot: "/tmp/repository",
      sourceConfigSha256: "3".repeat(64),
      target: {
        accountId: "account-id",
        expectedNonSecretVariables: variables,
        requiredSecretNames: ["TICKET_HMAC_SECRET", "ADMIN_TOKEN"],
        workerName: "production-worker",
        wranglerConfigPath: "collaboration-worker/wrangler.jsonc",
        wranglerEnvironment: "production",
      },
    },
    preparedArtifacts: {
      artifactDirectory: "/tmp/recovery-artifact",
      manifest,
      manifestSha256: "b".repeat(64),
    },
    targetArtifactSha256: "b".repeat(64),
    targetScriptEtag: "c".repeat(64),
    workerName: "production-worker",
  },
});

const stagingPlan = (): RecoveryProviderPlan => {
  const input = plan();
  input.environment = "staging";
  input.netlify.siteId = "staging-site";
  input.worker.workerName = "staging-worker";
  input.worker.artifactInput.environment = "staging";
  input.worker.artifactInput.target.workerName = "staging-worker";
  input.worker.artifactInput.target.wranglerEnvironment = "staging";
  return input;
};

const workerBindings = () => [
  { name: "TICKET_HMAC_SECRET", type: "secret_text" },
  { name: "ADMIN_TOKEN", type: "secret_text" },
  ...Object.entries(variables).map(([name, text]) => ({ name, text, type: "plain_text" })),
  {
    class_name: "CollaborationRoom",
    name: "COLLABORATION_ROOMS",
    type: "durable_object_namespace",
  },
  { name: "BROWSER", type: "browser" },
];

const targetVersion = (input = plan()) => ({
  annotations: { "workers/tag": "b".repeat(64) },
  id: input.requested.workerVersionId,
  resources: {
    bindings: workerBindings(),
    script: { etag: `"${"c".repeat(64)}"` },
    script_runtime: {
      compatibility_date: "2026-08-16",
      compatibility_flags: ["nodejs_compat"],
    },
  },
});

const createFixture = (input = plan(), buildSettings: Record<string, unknown> = {}) => {
  let netlifyCurrent = input.expectedCurrent.netlifyDeployId;
  let workerCurrent = {
    id: input.expectedCurrent.workerDeploymentId,
    versionId: input.expectedCurrent.workerVersionId,
    marker: undefined as string | undefined,
  };
  const events: string[] = [];
  const checkpoints: RecoveryProviderCheckpoint[] = [];
  const netlifyClient: RecoveryProviderDependencies["netlifyClient"] = vi.fn(async (operation) => {
    events.push(`netlify:${operation}`);
    if (operation === "getSite")
      return {
        account_id: input.netlify.accountId,
        build_settings: buildSettings,
        id: input.netlify.siteId,
        published_deploy: { id: netlifyCurrent, locked: true, state: "ready" },
        ssl_url: input.netlify.origin,
      };
    if (operation === "getSiteDeploy")
      return {
        commit_ref: "a".repeat(40),
        context: "production",
        draft: false,
        id: input.requested.netlifyDeployId,
        site_id: input.netlify.siteId,
        state: "ready",
      };
    if (operation === "getEnvVars")
      return [
        {
          is_secret: false,
          key: "APP_MODE",
          scopes: ["builds", "functions", "runtime"],
          values: [{ context: "production", value: "production" }],
        },
        {
          is_secret: true,
          key: "RATE_LIMIT_SECRET",
          scopes: ["builds", "functions", "runtime"],
          values: [{ context: "production" }],
        },
      ];
    netlifyCurrent = input.requested.netlifyDeployId;
    return { id: input.requested.netlifyDeployId };
  });
  const workerDispatch = vi.fn(async ({ body, method, path }) => {
    events.push(`worker:${method}:${path}`);
    if (method === "POST") {
      const parsed = JSON.parse(String(body)) as {
        annotations: { "workers/message": string };
        versions: readonly { version_id: string }[];
      };
      workerCurrent = {
        id: "recovery-deployment",
        marker: parsed.annotations["workers/message"],
        versionId: parsed.versions[0].version_id,
      };
      return { id: workerCurrent.id };
    }
    if (path.endsWith("/deployments")) {
      const current = {
        annotations: workerCurrent.marker ? { "workers/message": workerCurrent.marker } : undefined,
        id: workerCurrent.id,
        versions: [{ percentage: 100, version_id: workerCurrent.versionId }],
      };
      const target = {
        id: input.requested.workerDeploymentId,
        versions: [{ percentage: 100, version_id: input.requested.workerVersionId }],
      };
      return {
        deployments:
          current.id === target.id && workerCurrent.versionId === input.requested.workerVersionId
            ? [current]
            : [current, target],
      };
    }
    if (path.endsWith("/secrets"))
      return [
        { name: "TICKET_HMAC_SECRET", type: "secret_text" },
        { name: "ADMIN_TOKEN", type: "secret_text" },
      ];
    if (path.includes("/versions/")) return targetVersion(input);
    return {
      default_environment: {
        script: {
          migration_tag: "v1",
          observability: {
            enabled: true,
            head_sampling_rate: 1,
            logs: { enabled: true, head_sampling_rate: 0.1, persist: true },
            traces: { enabled: true, head_sampling_rate: 0.01, persist: true },
          },
        },
      },
    };
  });
  const workerTransport: RecoveryProviderDependencies["workerTransport"] = {
    dispatch: workerDispatch,
  };
  const dependencies: RecoveryProviderDependencies = {
    checkpoint: vi.fn(async (value) => {
      events.push(`checkpoint:${value.phase}`);
      checkpoints.push(value);
    }),
    netlifyClient,
    verifyArtifacts: vi.fn(async () => manifest),
    workerTransport,
  };
  return {
    checkpoints,
    dependencies,
    events,
    setNetlifyCurrent(value: string) {
      netlifyCurrent = value;
    },
    setWorkerCurrent(value: typeof workerCurrent) {
      workerCurrent = value;
    },
    workerDispatch,
  };
};

describe("recovery provider adapters", () => {
  it("accepts a Git-linked locked production site and rejects a linked staging site", async () => {
    const buildSettings = {
      repo_path: "apps/ephemeral-pages",
      repo_url: "https://github.com/schalkneethling/ephemeral-pages",
    };
    const productionInput = plan();
    const production = createFixture(productionInput, buildSettings);
    const evidence = await inspectRecoveryTargets(productionInput, production.dependencies);
    await expect(
      restoreRecoveryNetlify(productionInput, evidence, production.dependencies),
    ).resolves.toMatchObject({ deployId: productionInput.requested.netlifyDeployId });

    const stagingInput = stagingPlan();
    const staging = createFixture(stagingInput, buildSettings);
    await expect(inspectRecoveryTargets(stagingInput, staging.dependencies)).rejects.toMatchObject({
      kind: "preflight",
    });
    expect(staging.events).toEqual(["netlify:getSite"]);
    expect(staging.checkpoints).toEqual([]);
  });

  it("proves retained target identity and reports secret values as unobservable", async () => {
    const fixture = createFixture();
    const evidence = await inspectRecoveryTargets(plan(), fixture.dependencies);

    expect(evidence).toMatchObject({
      inspectionVersion: 2,
      netlifyVariablesVerified: true,
      workerMigrationTag: "v1",
      workerSecretBindingNames: ["TICKET_HMAC_SECRET", "ADMIN_TOKEN"],
      workerSecretValuesObservable: false,
    });
    expect(evidence.inspectionSha256).toMatch(/^[0-9a-f]{64}$/u);
  });

  it("checkpoints Netlify before its exact restore and checkpoints the returned ID before readback", async () => {
    const fixture = createFixture();
    const input = plan();
    const evidence = await inspectRecoveryTargets(input, fixture.dependencies);
    fixture.events.length = 0;

    const result = await restoreRecoveryNetlify(input, evidence, fixture.dependencies);

    expect(result.deployId).toBe("target-netlify");
    const mutation = fixture.events.indexOf("netlify:restoreSiteDeploy");
    expect(fixture.events.indexOf("checkpoint:netlify-restore-pending")).toBeLessThan(mutation);
    expect(fixture.events.indexOf("checkpoint:netlify-restore-response-received")).toBeGreaterThan(
      mutation,
    );
    expect(fixture.events.slice(mutation + 1)).toContain("netlify:getSite");
    expect(fixture.checkpoints.at(-1)).toMatchObject({ restoredDeployId: "target-netlify" });
  });

  it("restores the Worker only after a verified Netlify result and never sets force", async () => {
    const fixture = createFixture();
    const input = plan();
    const evidence = await inspectRecoveryTargets(input, fixture.dependencies);
    const netlify = await restoreRecoveryNetlify(input, evidence, fixture.dependencies);
    fixture.events.length = 0;

    const result = await rollbackRecoveryWorker(input, evidence, netlify, fixture.dependencies);

    expect(result).toMatchObject({
      deploymentId: "recovery-deployment",
      versionId: "target-worker-version",
    });
    const mutation = fixture.events.findIndex((event) => event.startsWith("worker:POST:"));
    const request = fixture.workerDispatch.mock.calls
      .map(([value]) => value)
      .find(({ method }) => method === "POST");
    expect(request).toBeDefined();
    expect(JSON.parse(String(request?.body))).not.toHaveProperty("force");
    expect(fixture.events.indexOf("checkpoint:worker-rollback-pending")).toBeLessThan(mutation);
    expect(fixture.events.indexOf("checkpoint:worker-rollback-response-received")).toBeGreaterThan(
      mutation,
    );
    expect(fixture.events.slice(mutation + 1).some((event) => event.includes("/deployments"))).toBe(
      true,
    );
  });

  it("blocks an untagged target version even when its ID and runtime match", async () => {
    const fixture = createFixture();
    const original = fixture.workerDispatch.getMockImplementation();
    if (!original) throw new Error("missing fixture implementation");
    fixture.workerDispatch.mockImplementation(async (request) => {
      const { method, path } = request;
      if (method === "GET" && path.includes("/versions/")) {
        const value = targetVersion();
        value.annotations = { "workers/tag": "d".repeat(64) };
        return value;
      }
      return original(request);
    });

    await expect(inspectRecoveryTargets(plan(), fixture.dependencies)).rejects.toMatchObject({
      kind: "preflight",
    });
  });

  it("stops before Netlify readback when the returned-ID checkpoint fails", async () => {
    const fixture = createFixture();
    const input = plan();
    const evidence = await inspectRecoveryTargets(input, fixture.dependencies);
    let fail = false;
    fixture.dependencies.checkpoint = vi.fn(async (value) => {
      fixture.events.push(`checkpoint:${value.phase}`);
      if (fail && value.phase === "netlify-restore-response-received") throw new Error();
    });
    fixture.events.length = 0;
    fail = true;

    await expect(
      restoreRecoveryNetlify(input, evidence, fixture.dependencies),
    ).rejects.toMatchObject({ kind: "ambiguous" });
    const responseCheckpoint = fixture.events.indexOf(
      "checkpoint:netlify-restore-response-received",
    );
    expect(fixture.events.slice(responseCheckpoint + 1)).not.toContain("netlify:getSite");
  });

  it("persists the Worker response ID before readback and stops if persistence fails", async () => {
    const fixture = createFixture();
    const input = plan();
    const evidence = await inspectRecoveryTargets(input, fixture.dependencies);
    const netlify = await restoreRecoveryNetlify(input, evidence, fixture.dependencies);
    fixture.dependencies.checkpoint = vi.fn(async (value) => {
      fixture.events.push(`checkpoint:${value.phase}`);
      if (value.phase === "worker-rollback-response-received") {
        expect(value).toMatchObject({
          deploymentId: "recovery-deployment",
          versionId: "target-worker-version",
        });
        throw new Error();
      }
    });
    fixture.events.length = 0;

    await expect(
      rollbackRecoveryWorker(input, evidence, netlify, fixture.dependencies),
    ).rejects.toMatchObject({ kind: "ambiguous" });
    const responseCheckpoint = fixture.events.indexOf(
      "checkpoint:worker-rollback-response-received",
    );
    expect(responseCheckpoint).toBeGreaterThan(-1);
    expect(fixture.events.slice(responseCheckpoint + 1)).not.toContainEqual(
      expect.stringContaining("worker:GET:"),
    );
  });

  it("reconciles only the exact locked Netlify target and marked Worker deployment", async () => {
    const fixture = createFixture();
    const input = plan();
    const evidence = await inspectRecoveryTargets(input, fixture.dependencies);
    const before = await reconcileRecoveryNetlify(input, evidence, fixture.dependencies);
    expect(before).toEqual({ status: "not-completed" });

    const netlify = await restoreRecoveryNetlify(input, evidence, fixture.dependencies);
    const worker = await rollbackRecoveryWorker(input, evidence, netlify, fixture.dependencies);
    await expect(
      reconcileRecoveryNetlify(input, evidence, fixture.dependencies),
    ).resolves.toMatchObject({ status: "completed" });
    await expect(
      reconcileRecoveryWorker(input, evidence, netlify, worker.deploymentId, fixture.dependencies),
    ).resolves.toMatchObject({ result: worker, status: "completed" });

    fixture.setWorkerCurrent({
      id: "different-deployment",
      marker: worker.inspectionSha256,
      versionId: "different-version",
    });
    await expect(
      reconcileRecoveryWorker(input, evidence, netlify, worker.deploymentId, fixture.dependencies),
    ).rejects.toBeInstanceOf(RecoveryProviderError);
  });

  it("revalidates retained evidence against a partially restored live pair", async () => {
    const fixture = createFixture();
    const input = plan();
    const evidence = await inspectRecoveryTargets(input, fixture.dependencies);
    fixture.setNetlifyCurrent("target-netlify");

    await expect(
      verifyRecoveryTargets(
        input,
        evidence,
        {
          netlifyDeployId: "target-netlify",
          workerDeploymentId: "current-worker-deployment",
          workerVersionId: "current-worker-version",
        },
        fixture.dependencies,
      ),
    ).resolves.toBe(evidence);
  });

  it("keeps verified evidence stable when only workspace paths change", async () => {
    const original = plan();
    const fixture = createFixture(original);
    const evidence = await inspectRecoveryTargets(original, fixture.dependencies);
    const relocated = structuredClone(original);
    relocated.worker.artifactInput.artifactDirectory = "/different/run/artifacts";
    relocated.worker.artifactInput.repositoryRoot = "/different/checkout";
    relocated.worker.preparedArtifacts.artifactDirectory = "/different/run/artifacts";
    const relocatedFixture = createFixture(relocated);

    await expect(
      verifyRecoveryTargets(
        relocated,
        evidence,
        relocated.expectedCurrent,
        relocatedFixture.dependencies,
      ),
    ).resolves.toBe(evidence);
  });

  it("rejects semantic plan changes after workspace relocation", async () => {
    const original = plan();
    const fixture = createFixture(original);
    const evidence = await inspectRecoveryTargets(original, fixture.dependencies);
    const changed = structuredClone(original);
    changed.worker.artifactInput.artifactDirectory = "/different/run/artifacts";
    changed.worker.artifactInput.repositoryRoot = "/different/checkout";
    changed.worker.preparedArtifacts.artifactDirectory = "/different/run/artifacts";
    changed.worker.artifactInput.sourceConfigSha256 = "4".repeat(64);

    await expect(
      verifyRecoveryTargets(
        changed,
        evidence,
        changed.expectedCurrent,
        createFixture(changed).dependencies,
      ),
    ).rejects.toMatchObject({ kind: "invalid-input" });
  });

  it("migrates legacy staging evidence only through fresh read-only verification", async () => {
    const input = plan();
    input.environment = "staging";
    input.netlify.siteId = "staging-site";
    input.worker.workerName = "staging-worker";
    input.worker.artifactInput.environment = "staging";
    input.worker.artifactInput.target.workerName = "staging-worker";
    input.worker.artifactInput.target.wranglerEnvironment = "staging";
    input.worker.preparedArtifacts.manifest = structuredClone(manifest);
    input.worker.preparedArtifacts.manifest.target.environment = "staging";
    input.worker.preparedArtifacts.manifest.target.workerName = "staging-worker";
    input.worker.preparedArtifacts.manifest.target.wranglerEnvironment = "staging";
    const fixture = createFixture(input);
    fixture.dependencies.verifyArtifacts = vi.fn(
      async () => input.worker.preparedArtifacts.manifest,
    );
    const evidence = await inspectRecoveryTargets(input, fixture.dependencies);
    const legacy = { ...evidence, inspectionVersion: undefined, inspectionSha256: "f".repeat(64) };
    fixture.events.length = 0;

    const migrated = await verifyRecoveryTargets(
      input,
      legacy,
      input.expectedCurrent,
      fixture.dependencies,
    );

    expect(migrated.inspectionVersion).toBe(2);
    expect(migrated.inspectionSha256).toBe(evidence.inspectionSha256);
    expect(fixture.events).toContain("netlify:getSite");
    expect(fixture.events.some((event) => event.startsWith("worker:GET:"))).toBe(true);
    expect(fixture.events.some((event) => event.startsWith("worker:POST:"))).toBe(false);
  });

  it("rejects legacy production evidence", async () => {
    const input = plan();
    const fixture = createFixture(input);
    const evidence = await inspectRecoveryTargets(input, fixture.dependencies);
    const legacy = { ...evidence, inspectionVersion: undefined };

    await expect(
      verifyRecoveryTargets(input, legacy, input.expectedCurrent, fixture.dependencies),
    ).rejects.toMatchObject({ kind: "invalid-input" });
  });

  it("accepts a complete recovery no-op when every requested ID is already current", async () => {
    const input = plan();
    input.requested = { ...input.expectedCurrent };
    const fixture = createFixture(input);

    await expect(inspectRecoveryTargets(input, fixture.dependencies)).resolves.toMatchObject({
      expectedCurrent: input.expectedCurrent,
      requested: input.expectedCurrent,
    });
  });

  it("accepts a Netlify no-op while the Worker still differs", async () => {
    const input = plan();
    input.requested.netlifyDeployId = input.expectedCurrent.netlifyDeployId;
    const fixture = createFixture(input);

    await expect(inspectRecoveryTargets(input, fixture.dependencies)).resolves.toMatchObject({
      requested: input.requested,
    });
  });

  it("accepts an already-current Worker version when its deployment and Netlify differ", async () => {
    const input = plan();
    input.requested.workerVersionId = input.expectedCurrent.workerVersionId;
    const fixture = createFixture(input);

    await expect(inspectRecoveryTargets(input, fixture.dependencies)).resolves.toMatchObject({
      requested: input.requested,
    });
  });

  it("rejects production provider targets labeled as a staging recovery", async () => {
    const fixture = createFixture();
    const input = plan();
    input.environment = "staging";

    await expect(inspectRecoveryTargets(input, fixture.dependencies)).rejects.toMatchObject({
      kind: "invalid-input",
    });
    expect(fixture.workerDispatch).not.toHaveBeenCalled();
  });
});
