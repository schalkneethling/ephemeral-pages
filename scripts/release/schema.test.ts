import { describe, expect, it } from "vitest";

import { parseReleaseArguments, ReleaseUsageError } from "./args.ts";
import { affectedServices } from "./changes.ts";
import {
  cloudflareTargetSchema,
  fullCommitSchema,
  releaseBaselineSchema,
  releaseConfigSchema,
} from "./schema.ts";

describe("release input grammar", () => {
  it("accepts version 1 placeholders and rejects unknown configuration fields", () => {
    const config = {
      version: 1,
      integrationBranch: "stage",
      environments: {
        staging: { netlify: null, cloudflare: null },
        production: { netlify: null, cloudflare: null },
      },
    };
    expect(releaseConfigSchema.safeParse(config).success).toBe(true);
    expect(releaseConfigSchema.safeParse({ ...config, unexpected: true }).success).toBe(false);
  });

  it("requires exact unique Netlify scope coverage", () => {
    const target = {
      siteId: "site",
      accountId: "account",
      expectedNonSecretVariables: { PUBLIC_URL: "https://example.test" },
      requiredSecretNames: ["TOKEN"],
      requiredVariableScopes: {
        PUBLIC_URL: ["builds", "functions"],
        TOKEN: ["functions"],
      },
    };
    const environments = {
      staging: { netlify: target, cloudflare: null },
      production: { netlify: null, cloudflare: null },
    };
    expect(
      releaseConfigSchema.safeParse({ version: 1, integrationBranch: "stage", environments })
        .success,
    ).toBe(true);
    expect(
      releaseConfigSchema.safeParse({
        version: 1,
        integrationBranch: "stage",
        environments: {
          ...environments,
          staging: {
            ...environments.staging,
            netlify: { ...target, requiredVariableScopes: { PUBLIC_URL: ["builds"] } },
          },
        },
      }).success,
    ).toBe(false);
  });

  it("requires full lowercase commit identities in baselines", () => {
    expect(fullCommitSchema.safeParse("a".repeat(40)).success).toBe(true);
    expect(fullCommitSchema.safeParse("a".repeat(39)).success).toBe(false);
    expect(fullCommitSchema.safeParse("A".repeat(40)).success).toBe(false);
    expect(
      releaseBaselineSchema.safeParse({
        version: 1,
        environment: "staging",
        providers: { netlify: null, cloudflare: null },
      }).success,
    ).toBe(true);
  });

  it("requires a repository-relative Wrangler config path", () => {
    const target = {
      accountId: "account",
      workerName: "worker",
      wranglerEnvironment: "production",
      wranglerConfigPath: "collaboration-worker/wrangler.jsonc",
      expectedNonSecretVariables: {},
      requiredSecretNames: [],
    };
    expect(cloudflareTargetSchema.safeParse(target).success).toBe(true);
    expect(
      cloudflareTargetSchema.safeParse({ ...target, wranglerConfigPath: "../wrangler.jsonc" })
        .success,
    ).toBe(false);
  });
});

describe("release CLI grammar", () => {
  const context = { cwd: "/work", repositoryRoot: "/repo" };

  it("parses plan and status without an environment fallback", () => {
    expect(
      parseReleaseArguments(
        [
          "plan",
          "--environment",
          "staging",
          "--candidate",
          "a".repeat(40),
          "--baseline",
          "baseline.json",
          "--json",
        ],
        context,
      ),
    ).toEqual({
      operation: "plan",
      environment: "staging",
      candidate: "a".repeat(40),
      baselinePath: "/work/baseline.json",
      configPath: "/repo/scripts/release/environments.json",
      configSource: "default",
      json: true,
    });
    expect(() => parseReleaseArguments(["status", "--baseline", "baseline.json"], context)).toThrow(
      ReleaseUsageError,
    );
  });

  it("marks an explicit config path as an override and rejects candidate on status", () => {
    expect(
      parseReleaseArguments(
        [
          "status",
          "--environment",
          "production",
          "--baseline",
          "baseline.json",
          "--config",
          "other.json",
        ],
        context,
      ),
    ).toMatchObject({ configPath: "/work/other.json", configSource: "override" });
    expect(() =>
      parseReleaseArguments(
        [
          "status",
          "--environment",
          "production",
          "--baseline",
          "baseline.json",
          "--candidate",
          "a".repeat(40),
        ],
        context,
      ),
    ).toThrow(ReleaseUsageError);
  });
});

describe("affected service classification", () => {
  it("keeps repository documentation deployment-neutral", () => {
    expect(affectedServices(["docs/releases.md", "CHANGELOG.md"])).toEqual(new Set());
  });

  it("does not treat deployed or Worker markdown as repository-only documentation", () => {
    expect(affectedServices(["public/help.md"])).toEqual(new Set(["netlify"]));
    expect(affectedServices(["collaboration-worker/README.md"])).toEqual(new Set(["cloudflare"]));
  });

  it("classifies provider, shared, and unknown paths conservatively", () => {
    expect(affectedServices(["netlify/functions/pages.ts"])).toEqual(new Set(["netlify"]));
    expect(affectedServices(["collaboration-worker/src/index.ts"])).toEqual(
      new Set(["cloudflare"]),
    );
    for (const path of [
      "src/domain.ts",
      "src/csp.ts",
      "src/collaboration/protocol.ts",
      "bun.lock",
      "unknown.file",
    ]) {
      expect(affectedServices([path])).toEqual(new Set(["netlify", "cloudflare"]));
    }
  });
});
