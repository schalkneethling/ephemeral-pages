import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  inspectCloudflare,
  inspectNetlify,
  type CloudflareInspectionConfig,
  type NetlifyInspectionConfig,
  type ProviderCommandRunner,
} from "./providers.ts";

const SECRET_SENTINEL = "provider-secret-sentinel-must-not-escape";

const netlifyConfig: NetlifyInspectionConfig = {
  siteId: "site-123",
  accountId: "account-123",
  expectedNonSecretVariables: {
    PUBLIC_BASE_URL: "https://example.com",
    COLLABORATION_SERVICE_URL: "https://worker.example.com",
    ABSENT_VALUE: "expected",
  },
  requiredSecretNames: [
    "SERVICE_TOKEN",
    "PREVIEW_ONLY_SECRET",
    "MISSING_SECRET",
    "NON_SECRET_TOKEN",
  ],
  requiredVariableScopes: {
    PUBLIC_BASE_URL: ["functions"],
    COLLABORATION_SERVICE_URL: ["builds", "functions"],
    ABSENT_VALUE: ["functions"],
    SERVICE_TOKEN: ["functions"],
    PREVIEW_ONLY_SECRET: ["functions"],
    MISSING_SECRET: ["functions"],
    NON_SECRET_TOKEN: ["functions"],
  },
};

const cloudflareConfig: CloudflareInspectionConfig = {
  accountId: "cf-account-123",
  workerName: "ephemeral-pages-collaboration",
  wranglerEnvironment: "production",
  wranglerConfigPath: "collaboration-worker/wrangler.jsonc",
  expectedNonSecretVariables: {
    ALLOWED_ORIGINS: "https://example.com",
    PAGE_CONTENT_ORIGIN: "https://example.com",
    ABSENT_VALUE: "expected",
  },
  requiredSecretNames: ["ADMIN_TOKEN", "MISSING_SECRET"],
};

describe("inspectNetlify", () => {
  it("returns only allowlisted deploy and configuration status", async () => {
    const calls: Array<{
      executable: string;
      args: readonly string[];
      env?: Record<string, string>;
    }> = [];
    const run: ProviderCommandRunner = async (executable, args, env) => {
      calls.push({ executable, args, env });
      if (args[1] === "getSite") {
        return JSON.stringify({
          id: "site-123",
          account_id: "account-123",
          name: "example",
          password: SECRET_SENTINEL,
          default_hooks_data: { access_token: SECRET_SENTINEL },
          published_deploy: {
            id: "deploy-123",
            state: "ready",
            locked: true,
            sensitive_provider_field: SECRET_SENTINEL,
          },
        });
      }
      if (args[1] === "getSiteDeploy") {
        return JSON.stringify({
          id: "deploy-123",
          site_id: "site-123",
          state: "ready",
          locked: true,
          commit_ref: SECRET_SENTINEL,
          branch: "main",
          context: "production",
          commit_url_with_credentials: SECRET_SENTINEL,
        });
      }
      return JSON.stringify([
        {
          key: "PUBLIC_BASE_URL",
          scopes: ["functions"],
          values: [{ context: "all", value: "https://example.com" }],
          is_secret: false,
        },
        {
          key: "COLLABORATION_SERVICE_URL",
          scopes: ["builds", "functions"],
          values: [
            { context: "all", value: "https://old-worker.example.com" },
            { context: "production", value: "https://wrong-worker.example.com" },
          ],
          is_secret: false,
        },
        {
          key: "SERVICE_TOKEN",
          scopes: ["functions"],
          values: [{ context: "production" }],
          is_secret: true,
        },
        {
          key: "PREVIEW_ONLY_SECRET",
          scopes: ["functions"],
          values: [{ context: "deploy-preview" }],
          is_secret: true,
        },
        {
          key: "NON_SECRET_TOKEN",
          scopes: ["functions"],
          values: [{ context: "production", value: SECRET_SENTINEL }],
          is_secret: false,
        },
        {
          key: "UNRELATED_PROVIDER_VALUE",
          scopes: ["builds"],
          values: [{ context: "production", value: SECRET_SENTINEL }],
          is_secret: false,
        },
      ]);
    };

    const result = await inspectNetlify(netlifyConfig, run);

    expect(result).toEqual({
      siteId: "site-123",
      publishedDeployId: "deploy-123",
      publishLocked: true,
      publishedDeploySource: {
        commitRef: null,
        branch: "main",
        context: "production",
      },
      variableScopesMatch: false,
      nonSecretVariables: {
        PUBLIC_BASE_URL: { present: true, matchesExpected: true },
        COLLABORATION_SERVICE_URL: { present: true, matchesExpected: false },
        ABSENT_VALUE: { present: false, matchesExpected: false },
      },
      requiredSecrets: {
        SERVICE_TOKEN: true,
        PREVIEW_ONLY_SECRET: false,
        MISSING_SECRET: false,
        NON_SECRET_TOKEN: false,
      },
    });
    expect(JSON.stringify(result)).not.toContain(SECRET_SENTINEL);
    expect(calls).toEqual([
      {
        executable: "./node_modules/.bin/netlify",
        args: ["api", "getSite", "--data", '{"site_id":"site-123"}'],
        env: undefined,
      },
      {
        executable: "./node_modules/.bin/netlify",
        args: ["api", "getSiteDeploy", "--data", '{"site_id":"site-123","deploy_id":"deploy-123"}'],
        env: undefined,
      },
      {
        executable: "./node_modules/.bin/netlify",
        args: [
          "api",
          "getEnvVars",
          "--data",
          '{"account_id":"account-123","site_id":"site-123","context_name":"production"}',
        ],
        env: undefined,
      },
    ]);
  });

  it("fails closed without leaking malformed output or command errors", async () => {
    const malformed = `${JSON.stringify({ id: "site-123" })}${SECRET_SENTINEL}`;
    await expect(inspectNetlify(netlifyConfig, async () => malformed)).rejects.toThrow(
      "Netlify inspection response is invalid.",
    );
    const commandFailure = inspectNetlify(netlifyConfig, async () => {
      throw new Error(SECRET_SENTINEL);
    });
    await expect(commandFailure).rejects.toThrow("Netlify inspection command failed.");
    await expect(commandFailure).rejects.not.toThrow(SECRET_SENTINEL);
  });

  it("rejects a published deploy that is not ready", async () => {
    let calls = 0;
    await expect(
      inspectNetlify(netlifyConfig, async () => {
        calls += 1;
        return JSON.stringify({
          id: "site-123",
          account_id: "account-123",
          published_deploy: { id: "deploy-123", state: "building", locked: true },
        });
      }),
    ).rejects.toThrow("Netlify inspection response is invalid.");
    expect(calls).toBe(1);
  });

  it("treats an explicit null deploy lock as unlocked", async () => {
    let calls = 0;
    const result = await inspectNetlify(netlifyConfig, async (_executable, args) => {
      calls += 1;
      if (args[1] === "getSite") {
        return JSON.stringify({
          id: "site-123",
          account_id: "account-123",
          published_deploy: { id: "deploy-123", state: "ready", locked: null },
        });
      }
      if (args[1] === "getSiteDeploy") {
        return JSON.stringify({
          id: "deploy-123",
          site_id: "site-123",
          state: "ready",
          locked: null,
          commit_ref: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        });
      }
      return "[]";
    });

    expect(result.publishLocked).toBe(false);
    expect(result.publishedDeploySource.commitRef).toBe("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
    expect(calls).toBe(3);
  });

  it("rejects an omitted deploy lock as unknown", async () => {
    let calls = 0;
    await expect(
      inspectNetlify(netlifyConfig, async () => {
        calls += 1;
        return JSON.stringify({
          id: "site-123",
          account_id: "account-123",
          published_deploy: { id: "deploy-123", state: "ready" },
        });
      }),
    ).rejects.toThrow("Netlify inspection response is invalid.");
    expect(calls).toBe(1);
  });

  it("normalizes all verified Envelope API scopes", async () => {
    const config: NetlifyInspectionConfig = {
      siteId: "site-123",
      accountId: "account-123",
      expectedNonSecretVariables: { ALL_SCOPES: "expected" },
      requiredSecretNames: [],
      requiredVariableScopes: {
        ALL_SCOPES: ["builds", "functions", "runtime", "post-processing"],
      },
    };

    const result = await inspectNetlify(config, async (_executable, args) => {
      if (args[1] === "getSite") {
        return JSON.stringify({
          id: "site-123",
          account_id: "account-123",
          published_deploy: { id: "deploy-123", state: "ready", locked: null },
        });
      }
      if (args[1] === "getSiteDeploy") {
        return JSON.stringify({
          id: "deploy-123",
          site_id: "site-123",
          state: "ready",
          locked: null,
        });
      }
      return JSON.stringify([
        {
          key: "ALL_SCOPES",
          scopes: ["builds", "functions", "runtime", "post_processing"],
          values: [{ context: "production", value: "expected" }],
          is_secret: false,
        },
      ]);
    });

    expect(result.variableScopesMatch).toBe(true);
    expect(result.nonSecretVariables.ALL_SCOPES).toEqual({
      present: true,
      matchesExpected: true,
    });
  });

  it("rejects scope requirements that do not exactly cover configured variables", async () => {
    let calls = 0;
    const { MISSING_SECRET: _missing, ...incompleteScopes } = netlifyConfig.requiredVariableScopes;

    await expect(
      inspectNetlify({ ...netlifyConfig, requiredVariableScopes: incompleteScopes }, async () => {
        calls += 1;
        return "[]";
      }),
    ).rejects.toThrow("Netlify inspection configuration is invalid.");
    expect(calls).toBe(0);
  });
});

describe("inspectCloudflare", () => {
  it("checks every active version and retains only allowlisted metadata", async () => {
    const calls: Array<{
      executable: string;
      args: readonly string[];
      env?: Record<string, string>;
    }> = [];
    const run: ProviderCommandRunner = async (executable, args, env) => {
      calls.push({ executable, args, env });
      if (args[0] === "deployments") {
        return JSON.stringify({
          id: "deployment-123",
          author_email: SECRET_SENTINEL,
          versions: [
            { version_id: "version-a", percentage: 60 },
            { version_id: "version-b", percentage: 40 },
          ],
        });
      }
      if (args[0] === "versions") {
        const versionId = args[2];
        return JSON.stringify({
          id: versionId,
          metadata: { author_email: SECRET_SENTINEL },
          resources: {
            bindings: [
              { name: "ALLOWED_ORIGINS", type: "plain_text", text: "https://example.com" },
              {
                name: "PAGE_CONTENT_ORIGIN",
                type: "plain_text",
                text:
                  versionId === "version-a" ? "https://example.com" : "https://wrong.example.com",
              },
              { name: "ADMIN_TOKEN", type: "secret_text", text: SECRET_SENTINEL },
              { name: "UNRELATED_PROVIDER_VALUE", type: "plain_text", text: SECRET_SENTINEL },
            ],
            script: { source: SECRET_SENTINEL },
          },
        });
      }
      return JSON.stringify([
        { name: "ADMIN_TOKEN", type: "secret_text", text: SECRET_SENTINEL },
        { name: "UNRELATED_SECRET", type: "secret_text", text: SECRET_SENTINEL },
      ]);
    };

    const result = await inspectCloudflare(cloudflareConfig, run);

    expect(result).toEqual({
      accountId: "cf-account-123",
      workerName: "ephemeral-pages-collaboration",
      deploymentId: "deployment-123",
      traffic: [
        { versionId: "version-a", percentage: 60 },
        { versionId: "version-b", percentage: 40 },
      ],
      nonSecretVariables: {
        ALLOWED_ORIGINS: { present: true, matchesExpected: true },
        PAGE_CONTENT_ORIGIN: { present: true, matchesExpected: false },
        ABSENT_VALUE: { present: false, matchesExpected: false },
      },
      requiredSecrets: { ADMIN_TOKEN: true, MISSING_SECRET: false },
    });
    expect(JSON.stringify(result)).not.toContain(SECRET_SENTINEL);

    const commonArgs = [
      "--name",
      "ephemeral-pages-collaboration",
      "--config",
      "collaboration-worker/wrangler.jsonc",
      "--env",
      "production",
    ];
    const env = { CLOUDFLARE_ACCOUNT_ID: "cf-account-123" };
    expect(calls).toEqual([
      {
        executable: "./node_modules/.bin/wrangler",
        args: ["deployments", "status", ...commonArgs, "--json"],
        env,
      },
      {
        executable: "./node_modules/.bin/wrangler",
        args: ["versions", "view", "version-a", ...commonArgs, "--json"],
        env,
      },
      {
        executable: "./node_modules/.bin/wrangler",
        args: ["versions", "view", "version-b", ...commonArgs, "--json"],
        env,
      },
      {
        executable: "./node_modules/.bin/wrangler",
        args: [
          "secret",
          "list",
          "--name",
          "ephemeral-pages-collaboration",
          "--config",
          "collaboration-worker/wrangler.jsonc",
          "--format",
          "json",
        ],
        env,
      },
    ]);
  });

  it("rejects incomplete traffic and redacts command failures", async () => {
    await expect(
      inspectCloudflare(cloudflareConfig, async () =>
        JSON.stringify({
          id: "deployment-123",
          versions: [{ version_id: SECRET_SENTINEL, percentage: 90 }],
        }),
      ),
    ).rejects.toThrow("Cloudflare inspection response is invalid.");

    const commandFailure = inspectCloudflare(cloudflareConfig, async () => {
      throw new Error(SECRET_SENTINEL);
    });
    await expect(commandFailure).rejects.toThrow("Cloudflare inspection command failed.");
    await expect(commandFailure).rejects.not.toThrow(SECRET_SENTINEL);
  });

  it("rejects base and environment account overrides before provider commands", async () => {
    let calls = 0;
    for (const accountPlacement of ["base", "environment"] as const) {
      const directory = mkdtempSync(join(tmpdir(), "provider-account-"));
      const configPath = join(directory, "wrangler.jsonc");
      writeFileSync(
        configPath,
        JSON.stringify({
          name: "ephemeral-pages-collaboration",
          account_id:
            accountPlacement === "base" ? "different-account" : cloudflareConfig.accountId,
          main: "worker.ts",
          compatibility_date: "2026-08-23",
          env: {
            production: {
              name: "ephemeral-pages-collaboration",
              ...(accountPlacement === "environment" ? { account_id: "different-account" } : {}),
            },
          },
        }),
      );

      try {
        await expect(
          inspectCloudflare({ ...cloudflareConfig, wranglerConfigPath: configPath }, async () => {
            calls += 1;
            return "{}";
          }),
        ).rejects.toThrow("Cloudflare inspection configuration is invalid.");
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    }
    expect(calls).toBe(0);
  });
});
