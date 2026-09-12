import { spawnSync } from "node:child_process";
import { mkdtemp, open, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { stagingBootstrapFingerprint, type NetlifyStagingBootstrapInput } from "./bootstrap.ts";
import {
  createPendingLocalSecretsCheckpoint,
  finalizeLocalSecretsCheckpoint,
  parseLocalSecretsArguments,
  runLocalSecretsCli,
  type LocalSecretsCliDependencies,
  type LocalSecretsFinalCheckpoint,
  type LocalSecretsPendingCheckpoint,
} from "./local-secrets-cli.ts";
import type {
  LocalSecretsProvisionResult,
  NetlifyLocalSecretsTarget,
  StagingLocalSecretValues,
} from "./local-secrets.ts";

const SECRET_SENTINEL = "cli-secret-sentinel-must-never-escape-0001";
const SECOND_SECRET = "cli-secret-sentinel-must-never-escape-0002";
const THIRD_SECRET = "cli-secret-sentinel-must-never-escape-000003";
const FOURTH_SECRET = "d".repeat(40);
const repositoryRoot = fileURLToPath(new URL("../..", import.meta.url));
const cliPath = fileURLToPath(new URL("local-secrets-cli.ts", import.meta.url));

const productionSiteId = "production-site-456";
const input = {
  accountId: "account-123",
  accountSlug: "schalkneethling",
  siteName: "ephemeral-pages-staging",
  nonSecretVariables: {
    PUBLIC_BASE_URL: "https://ephemeral-pages-staging.netlify.app",
    COLLABORATION_SERVICE_URL: "https://ephemeral-pages-collaboration-staging.example.workers.dev",
    COLLABORATION_WEBSOCKET_URL: "wss://ephemeral-pages-collaboration-staging.example.workers.dev",
    COLLABORATION_TICKET_AUDIENCE: "ephemeral-pages-collaboration-staging",
    COLLABORATION_CAPABILITY_CURRENT_VERSION: "v1",
    COLLABORATION_ENABLED: "true",
    GITHUB_OIDC_AUDIENCE: "https://ephemeral-pages-staging.netlify.app",
  },
};
const completeInput: NetlifyStagingBootstrapInput = { ...input, productionSiteId };
const configurationFingerprint = stagingBootstrapFingerprint(completeInput);
const bootstrapCheckpoint = {
  schemaVersion: 1,
  inputFingerprint: configurationFingerprint,
  phase: "awaiting-operator-secrets",
  siteId: "staging-site-123",
};
const productionConfig = {
  version: 1,
  integrationBranch: "stage",
  environments: {
    staging: { netlify: null, cloudflare: null },
    production: {
      netlify: {
        siteId: productionSiteId,
        accountId: input.accountId,
        expectedNonSecretVariables: {},
        requiredSecretNames: [
          "COLLABORATION_CAPABILITY_CURRENT_SECRET",
          "COLLABORATION_TICKET_SECRET",
          "COLLABORATION_SERVICE_TOKEN",
          "RATE_LIMIT_SECRET",
        ],
        requiredVariableScopes: {
          COLLABORATION_CAPABILITY_CURRENT_SECRET: ["functions"],
          COLLABORATION_TICKET_SECRET: ["functions"],
          COLLABORATION_SERVICE_TOKEN: ["functions"],
          RATE_LIMIT_SECRET: ["functions"],
        },
      },
      cloudflare: null,
    },
  },
};

const args = [
  "--input",
  "bootstrap.json",
  "--bootstrap-checkpoint",
  "bootstrap-state.json",
  "--checkpoint",
  "secret-state.json",
] as const;

const harness = (
  options: {
    bootstrap?: unknown;
    environment?: Record<string, string | undefined>;
    input?: unknown;
    productionConfig?: unknown;
    provision?: (
      target: NetlifyLocalSecretsTarget,
      values: StagingLocalSecretValues,
    ) => Promise<LocalSecretsProvisionResult>;
    rejectPending?: boolean;
  } = {},
) => {
  const environment = options.environment ?? {
    STAGE_COLLABORATION_CAPABILITY_CURRENT_SECRET: SECRET_SENTINEL,
    STAGE_COLLABORATION_TICKET_SECRET: SECOND_SECRET,
    STAGE_COLLABORATION_SERVICE_TOKEN: THIRD_SECRET,
    STAGE_RATE_LIMIT_SECRET: FOURTH_SECRET,
    UNRELATED: "retained",
  };
  const events: string[] = [];
  const pending: LocalSecretsPendingCheckpoint[] = [];
  const final: LocalSecretsFinalCheckpoint[] = [];
  let provisionedTarget: NetlifyLocalSecretsTarget | undefined;
  let provisionedValues: StagingLocalSecretValues | undefined;
  const dependencies: Partial<LocalSecretsCliDependencies> = {
    environment,
    productionConfigPath: "/repo/scripts/release/environments.json",
    readJson: async (path) => {
      events.push(`read:${path}`);
      if (path.endsWith("bootstrap.json")) return options.input ?? input;
      if (path.endsWith("bootstrap-state.json")) {
        return options.bootstrap ?? bootstrapCheckpoint;
      }
      return options.productionConfig ?? productionConfig;
    },
    createPendingCheckpoint: async (_path, checkpoint) => {
      events.push("pending");
      if (options.rejectPending) throw new Error(SECRET_SENTINEL);
      pending.push(structuredClone(checkpoint));
    },
    finalizeCheckpoint: async (_path, checkpoint) => {
      events.push("final");
      final.push(structuredClone(checkpoint));
    },
    provision: async (target, values) => {
      events.push("provision");
      provisionedTarget = structuredClone(target);
      provisionedValues = structuredClone(values);
      return options.provision?.(target, values) ?? { outcome: "passed", stage: "complete" };
    },
  };
  return {
    dependencies,
    environment,
    events,
    final,
    pending,
    get provisionedTarget() {
      return provisionedTarget;
    },
    get provisionedValues() {
      return provisionedValues;
    },
  };
};

describe("local secret CLI argument parsing", () => {
  it("accepts exactly one of each documented option", () => {
    expect(parseLocalSecretsArguments(args, "/work")).toEqual({
      inputPath: "/work/bootstrap.json",
      bootstrapCheckpointPath: "/work/bootstrap-state.json",
      checkpointPath: "/work/secret-state.json",
    });
  });

  it("rejects missing, duplicate, positional, and unknown arguments", () => {
    const invalid = [
      args.slice(0, -2),
      [...args, "--checkpoint", "other.json"],
      [...args, "positional"],
      [...args, "--secret", SECRET_SENTINEL],
    ];
    for (const candidate of invalid) {
      expect(() => parseLocalSecretsArguments(candidate, "/work")).toThrow(
        "Staging local-secret provisioning could not continue safely.",
      );
    }
  });

  it("emits only a fixed redacted result when invoked directly", () => {
    const result = spawnSync("bun", [cliPath, "--secret", SECRET_SENTINEL], {
      cwd: repositoryRoot,
      encoding: "utf8",
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toEqual({
      outcome: "blocked",
      stage: "configuration",
    });
    expect(`${result.stdout}${result.stderr}`).not.toContain(SECRET_SENTINEL);
  });
});

describe("local secret checkpoint persistence", () => {
  it("claims a 0600 checkpoint exclusively and atomically replaces only that pending state", async () => {
    const directory = await mkdtemp(join(tmpdir(), "local-secret-checkpoint-"));
    const checkpointPath = join(directory, "checkpoint.json");
    const identity = {
      schemaVersion: 1 as const,
      operation: "staging-local-secrets" as const,
      accountId: input.accountId,
      siteId: bootstrapCheckpoint.siteId,
      siteName: input.siteName,
      productionSiteId,
      configurationFingerprint,
    };
    const pending: LocalSecretsPendingCheckpoint = {
      ...identity,
      phase: "pending-secret-provision",
      result: null,
    };
    const final: LocalSecretsFinalCheckpoint = {
      ...identity,
      phase: "complete",
      result: { outcome: "passed", stage: "complete" },
    };

    try {
      await createPendingLocalSecretsCheckpoint(checkpointPath, pending);
      const pendingHandle = await open(checkpointPath, "r");
      try {
        expect((await pendingHandle.stat()).mode & 0o777).toBe(0o600);
        expect(JSON.parse(await pendingHandle.readFile("utf8"))).toEqual(pending);
      } finally {
        await pendingHandle.close();
      }
      await expect(createPendingLocalSecretsCheckpoint(checkpointPath, pending)).rejects.toThrow(
        "Staging local-secret provisioning could not continue safely.",
      );

      await finalizeLocalSecretsCheckpoint(checkpointPath, final);
      const finalHandle = await open(checkpointPath, "r");
      try {
        const contents = await finalHandle.readFile("utf8");
        expect(JSON.parse(contents)).toEqual(final);
        expect((await finalHandle.stat()).mode & 0o777).toBe(0o600);
        expect(contents).not.toContain(SECRET_SENTINEL);
      } finally {
        await finalHandle.close();
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

describe("runLocalSecretsCli", () => {
  it("binds the confirmed staging target, scrubs source variables, and persists sanitized state", async () => {
    const state = harness();
    const argvBefore = [...process.argv];

    const result = await runLocalSecretsCli(args, "/work", state.dependencies);

    expect(result).toEqual({ outcome: "passed", stage: "complete" });
    expect(state.provisionedTarget).toEqual({
      accountId: input.accountId,
      productionSiteId,
      siteId: bootstrapCheckpoint.siteId,
      siteName: input.siteName,
    });
    expect(state.provisionedValues).toEqual({
      STAGE_COLLABORATION_CAPABILITY_CURRENT_SECRET: SECRET_SENTINEL,
      STAGE_COLLABORATION_TICKET_SECRET: SECOND_SECRET,
      STAGE_COLLABORATION_SERVICE_TOKEN: THIRD_SECRET,
      STAGE_RATE_LIMIT_SECRET: FOURTH_SECRET,
    });
    expect(state.environment).toEqual({ UNRELATED: "retained" });
    expect(process.argv).toEqual(argvBefore);
    expect(state.events.slice(-3)).toEqual(["pending", "provision", "final"]);
    expect(state.pending).toEqual([
      {
        schemaVersion: 1,
        operation: "staging-local-secrets",
        accountId: input.accountId,
        siteId: bootstrapCheckpoint.siteId,
        siteName: input.siteName,
        productionSiteId,
        configurationFingerprint,
        phase: "pending-secret-provision",
        result: null,
      },
    ]);
    expect(state.final[0]).toEqual({
      ...state.pending[0],
      phase: "complete",
      result,
    });
    expect(JSON.stringify({ pending: state.pending, final: state.final, result })).not.toContain(
      SECRET_SENTINEL,
    );
  });

  it("rejects stale, wrong-phase, unknown, and production-colliding bootstrap state", async () => {
    const invalid = [
      { ...bootstrapCheckpoint, inputFingerprint: "a".repeat(64) },
      { ...bootstrapCheckpoint, phase: "pending-non-secret-configuration" },
      { ...bootstrapCheckpoint, unexpected: true },
      { ...bootstrapCheckpoint, siteId: productionSiteId },
    ];
    for (const bootstrap of invalid) {
      const state = harness({ bootstrap });
      const result = await runLocalSecretsCli(args, "/work", state.dependencies);
      expect(result.outcome).toBe("blocked");
      expect(["configuration", "target"]).toContain(result.stage);
      expect(state.pending).toEqual([]);
      expect(state.events).not.toContain("provision");
    }
  });

  it("uses the closed bootstrap schema and binds the account to production configuration", async () => {
    const extraInput = { ...input, STAGE_COLLABORATION_SERVICE_TOKEN: SECRET_SENTINEL };
    const wrongAccountConfig = structuredClone(productionConfig);
    wrongAccountConfig.environments.production.netlify!.accountId = "other-account";
    const incompleteSecretConfig = structuredClone(productionConfig);
    incompleteSecretConfig.environments.production.netlify!.requiredSecretNames.pop();
    delete (
      incompleteSecretConfig.environments.production.netlify!.requiredVariableScopes as Record<
        string,
        string[]
      >
    ).RATE_LIMIT_SECRET;
    for (const options of [
      { input: extraInput },
      { productionConfig: wrongAccountConfig },
      { productionConfig: incompleteSecretConfig },
      { productionConfig: { ...productionConfig, unexpected: true } },
    ]) {
      const state = harness(options);
      const result = await runLocalSecretsCli(args, "/work", state.dependencies);
      expect(result.outcome).toBe("blocked");
      expect(state.events).not.toContain("provision");
    }
  });

  it("blocks an existing local-secret checkpoint before provider access", async () => {
    const state = harness({ rejectPending: true });
    const result = await runLocalSecretsCli(args, "/work", state.dependencies);

    expect(result).toEqual({ outcome: "blocked", stage: "preflight" });
    expect(state.events).not.toContain("provision");
    expect(JSON.stringify(result)).not.toContain(SECRET_SENTINEL);
  });

  it("atomically records a sanitized blocked result after an ambiguous adapter return", async () => {
    const state = harness({
      provision: async () =>
        ({
          outcome: "blocked",
          stage: "mutation",
          detail: SECRET_SENTINEL,
        }) as LocalSecretsProvisionResult,
    });
    const result = await runLocalSecretsCli(args, "/work", state.dependencies);

    expect(result).toEqual({ outcome: "blocked", stage: "mutation" });
    expect(state.final[0]?.phase).toBe("blocked");
    expect(state.final[0]?.result).toEqual(result);
    expect(JSON.stringify(state.final)).not.toContain(SECRET_SENTINEL);
  });

  it("redacts thrown adapter errors and leaves a final state that blocks blind retry", async () => {
    const state = harness({
      provision: async () => {
        throw new Error(SECRET_SENTINEL);
      },
    });
    const result = await runLocalSecretsCli(args, "/work", state.dependencies);

    expect(result).toEqual({ outcome: "blocked", stage: "mutation" });
    expect(state.final[0]).toMatchObject({ phase: "blocked", result });
    expect(JSON.stringify({ result, final: state.final })).not.toContain(SECRET_SENTINEL);
  });
});
