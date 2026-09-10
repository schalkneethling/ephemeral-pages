import { describe, expect, it } from "vitest";

import { configurationFingerprint, releasePlan, releaseStatus } from "./planner.ts";
import { releaseConfigSchema, type ReleaseBaseline, type ReleaseConfig } from "./schema.ts";

const NETLIFY_SOURCE = "a".repeat(40);
const CLOUDFLARE_SOURCE = "b".repeat(40);
const CANDIDATE = "c".repeat(40);
const SECRET = "provider-secret-must-not-escape";

const config: ReleaseConfig = {
  version: 1,
  integrationBranch: "stage",
  environments: {
    staging: { netlify: null, cloudflare: null },
    production: {
      netlify: {
        siteId: "site-1",
        accountId: "netlify-account-1",
        expectedNonSecretVariables: { PUBLIC_URL: "https://example.test" },
        requiredSecretNames: ["SERVICE_TOKEN"],
        requiredVariableScopes: {
          PUBLIC_URL: ["builds", "functions"],
          SERVICE_TOKEN: ["functions"],
        },
      },
      cloudflare: {
        accountId: "cloudflare-account-1",
        workerName: "worker-1",
        wranglerEnvironment: "production",
        wranglerConfigPath: "collaboration-worker/wrangler.jsonc",
        expectedNonSecretVariables: { ALLOWED_ORIGINS: "https://example.test" },
        requiredSecretNames: ["ADMIN_TOKEN"],
      },
    },
  },
};

const baseline: ReleaseBaseline = {
  version: 1,
  environment: "production",
  providers: {
    netlify: {
      siteId: "site-1",
      sourceCommit: NETLIFY_SOURCE,
      publishedDeployId: "netlify-deploy-1",
      publishLocked: false,
    },
    cloudflare: {
      accountId: "cloudflare-account-1",
      workerName: "worker-1",
      sourceCommit: CLOUDFLARE_SOURCE,
      deploymentId: "cloudflare-deploy-1",
      traffic: [{ versionId: "worker-version-1", percentage: 100 }],
    },
  },
};

const netlifyInspection = {
  siteId: "site-1",
  publishedDeployId: "netlify-deploy-1",
  publishLocked: false,
  publishedDeploySource: { commitRef: NETLIFY_SOURCE, branch: "main", context: "production" },
  nonSecretVariables: { PUBLIC_URL: { present: true, matchesExpected: true } },
  requiredSecrets: { SERVICE_TOKEN: true },
  variableScopesMatch: true,
};

const cloudflareInspection = {
  accountId: "cloudflare-account-1",
  workerName: "worker-1",
  deploymentId: "cloudflare-deploy-1",
  traffic: [{ versionId: "worker-version-1", percentage: 100 }],
  nonSecretVariables: { ALLOWED_ORIGINS: { present: true, matchesExpected: true } },
  requiredSecrets: { ADMIN_TOKEN: true },
};

function dependencies({
  paths = [],
  clean = true,
  reachable = true,
  commitExists = () => true,
  candidateConfig = config,
  inspectNetlify = async () => netlifyInspection,
  inspectCloudflare = async () => cloudflareInspection,
  providerTimeoutMs = 100,
  checkedOutWranglerConfig = "wrangler-config",
  candidateWranglerConfig = "wrangler-config",
}: {
  paths?: readonly string[] | ((from: string) => readonly string[]);
  clean?: boolean;
  reachable?: boolean;
  commitExists?: (commit: string) => boolean;
  candidateConfig?: ReleaseConfig;
  inspectNetlify?: () => Promise<typeof netlifyInspection>;
  inspectCloudflare?: () => Promise<typeof cloudflareInspection>;
  providerTimeoutMs?: number;
  checkedOutWranglerConfig?: string;
  candidateWranglerConfig?: string;
} = {}) {
  const providerCalls: string[] = [];
  const changedFrom: string[] = [];
  return {
    providerCalls,
    changedFrom,
    value: {
      git: {
        isClean: async () => clean,
        commitExists: async (commit: string) => commitExists(commit),
        isReachableFrom: async () => reachable,
        changedFiles: async (from: string) => {
          changedFrom.push(from);
          return typeof paths === "function" ? paths(from) : paths;
        },
        readFileAtCommit: async (commit: string, path: string) => {
          if (path === config.environments.production.cloudflare!.wranglerConfigPath) {
            return commit === "HEAD" ? checkedOutWranglerConfig : candidateWranglerConfig;
          }
          return JSON.stringify(candidateConfig);
        },
      },
      inspectNetlify: async () => {
        providerCalls.push("netlify");
        return inspectNetlify();
      },
      inspectCloudflare: async () => {
        providerCalls.push("cloudflare");
        return inspectCloudflare();
      },
      createProviderRunner: () => async () => "",
      providerTimeoutMs,
    },
  };
}

const input = {
  baseline,
  config,
  configRepositoryPath: "scripts/release/environments.json",
  configSource: "default" as const,
  environment: "production" as const,
};

describe("release plan", () => {
  it("uses each provider source commit and retains verified baselines for docs-only changes", async () => {
    expect(releaseConfigSchema.safeParse(config).success).toBe(true);
    expect(
      configurationFingerprint(releaseConfigSchema.parse(JSON.parse(JSON.stringify(config)))),
    ).toBe(configurationFingerprint(config));
    const harness = dependencies({ paths: ["docs/releases.md"] });
    const report = await releasePlan({ ...input, candidate: CANDIDATE }, harness.value);
    expect(report.checks.filter(({ outcome }) => outcome === "blocked")).toEqual([]);
    expect(report.outcome, "provider baselines must still be inspected").toBe("passed");
    expect(report.deploymentPlan).toEqual([
      { provider: "netlify", action: "retain" },
      { provider: "cloudflare", action: "retain" },
    ]);
    expect(harness.providerCalls.sort()).toEqual(["cloudflare", "netlify"]);
    expect(harness.changedFrom).toEqual([NETLIFY_SOURCE, CLOUDFLARE_SOURCE]);
  });

  it.each([
    ["netlify/functions/pages.ts", ["deploy", "retain"]],
    ["collaboration-worker/src/index.ts", ["retain", "deploy"]],
    ["src/domain.ts", ["deploy", "deploy"]],
    ["unclassified.config", ["deploy", "deploy"]],
  ] as const)("classifies %s conservatively", async (path, expected) => {
    const report = await releasePlan(
      { ...input, candidate: CANDIDATE },
      dependencies({ paths: [path] }).value,
    );
    expect(report.deploymentPlan?.map(({ action }) => action)).toEqual(expected);
  });

  it("blocks dirty, unknown, unreachable, and unbound candidates", async () => {
    const changedConfig = structuredClone(config);
    changedConfig.environments.production.cloudflare!.workerName = "different-worker";
    const harness = dependencies({
      clean: false,
      reachable: false,
      commitExists: (commit) => commit !== CLOUDFLARE_SOURCE,
      candidateConfig: changedConfig,
    });
    const report = await releasePlan(
      { ...input, candidate: CANDIDATE, configSource: "override" },
      harness.value,
    );
    expect(report.outcome).toBe("blocked");
    expect(report.configuration).toEqual({
      source: "override",
      fingerprint: configurationFingerprint(config),
      candidateBound: false,
    });
    expect(report.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "git.clean", outcome: "blocked" }),
        expect.objectContaining({ id: "git.integration-branch", outcome: "blocked" }),
        expect.objectContaining({ id: "cloudflare.baseline-source", outcome: "blocked" }),
        expect.objectContaining({ id: "config.candidate-bound", outcome: "blocked" }),
      ]),
    );
    expect(report.deploymentPlan?.every(({ action }) => action === "blocked")).toBe(true);
    expect(harness.providerCalls).toEqual([]);
  });

  it("blocks a checked-out Wrangler config that differs from the candidate before inspection", async () => {
    const harness = dependencies({ checkedOutWranglerConfig: "different" });
    const report = await releasePlan({ ...input, candidate: CANDIDATE }, harness.value);
    expect(report.checks).toContainEqual({
      id: "config.wrangler-candidate-bound",
      outcome: "blocked",
      summary: "Wrangler configuration is missing or differs from the candidate commit.",
    });
    expect(harness.providerCalls).toEqual([]);
  });
});

describe("release status", () => {
  it("blocks when observed Netlify variable scopes differ", async () => {
    const report = await releaseStatus(
      input,
      dependencies({
        inspectNetlify: async () => ({ ...netlifyInspection, variableScopesMatch: false }),
      }).value,
    );
    expect(report.checks).toContainEqual({
      id: "netlify.variable-scopes",
      outcome: "blocked",
      summary: "One or more required Netlify variable scopes are missing.",
    });
  });

  it("blocks baseline identity and live deployment mismatches", async () => {
    const mismatchedBaseline = structuredClone(baseline);
    mismatchedBaseline.providers.netlify!.siteId = "other-site";
    const mismatchedNetlify = {
      ...netlifyInspection,
      publishedDeployId: "other-deploy",
      publishedDeploySource: { ...netlifyInspection.publishedDeploySource, commitRef: CANDIDATE },
    };
    const report = await releaseStatus(
      { ...input, baseline: mismatchedBaseline },
      dependencies({ inspectNetlify: async () => mismatchedNetlify }).value,
    );
    expect(report.outcome).toBe("blocked");
    expect(report.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "netlify.baseline-target", outcome: "blocked" }),
        expect.objectContaining({ id: "netlify.observed-baseline", outcome: "blocked" }),
      ]),
    );
  });

  it("turns missing credentials and provider errors into redacted blocked results", async () => {
    const report = await releaseStatus(
      input,
      dependencies({
        inspectNetlify: async () => {
          throw new Error(`missing token ${SECRET}`);
        },
        inspectCloudflare: async () => {
          throw new Error(`missing token ${SECRET}`);
        },
      }).value,
    );
    expect(report.outcome).toBe("blocked");
    expect(JSON.stringify(report)).not.toContain(SECRET);
    expect(report.providers.netlify.observed).toBeNull();
    expect(report.providers.cloudflare.observed).toBeNull();
  });

  it("bounds provider inspection and never retains timeout details", async () => {
    const report = await releaseStatus(
      input,
      dependencies({
        providerTimeoutMs: 1,
        inspectNetlify: () => new Promise(() => {}),
      }).value,
    );
    expect(report.outcome).toBe("blocked");
    expect(JSON.stringify(report)).not.toContain(SECRET);
    expect(report.checks).toContainEqual({
      id: "netlify.inspection",
      outcome: "blocked",
      summary: "Netlify inspection is unavailable.",
    });
  });
});
