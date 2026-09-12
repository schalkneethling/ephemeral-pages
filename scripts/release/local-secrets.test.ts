import { Agent } from "node:https";
import { Socket } from "node:net";

import { describe, expect, it, vi } from "vitest";

import {
  NETLIFY_LOCAL_SECRET_KEYS,
  createOneShotNetlifyClient,
  provisionNetlifyLocalSecrets,
  safeProviderCall,
  type NetlifyLocalSecretsClient,
  type NetlifyLocalSecretsTarget,
  type StagingLocalSecretValues,
} from "./local-secrets.ts";

const SECRET_SENTINEL = "a".repeat(40);
const SECOND_SECRET = "b".repeat(40);
const THIRD_SECRET = "c".repeat(40);
const FOURTH_SECRET = "d".repeat(40);

const target: NetlifyLocalSecretsTarget = {
  accountId: "staging-account",
  productionSiteId: "production-site",
  siteId: "staging-site",
  siteName: "ephemeral-pages-staging",
};

const values: StagingLocalSecretValues = {
  STAGE_COLLABORATION_CAPABILITY_CURRENT_SECRET: SECRET_SENTINEL,
  STAGE_COLLABORATION_SERVICE_TOKEN: THIRD_SECRET,
  STAGE_COLLABORATION_TICKET_SECRET: SECOND_SECRET,
  STAGE_RATE_LIMIT_SECRET: FOURTH_SECRET,
};

const site = {
  account_id: target.accountId,
  build_settings: { repo_url: null, stop_builds: true },
  id: target.siteId,
  name: target.siteName,
  ssl_url: `https://${target.siteName}.netlify.app`,
};

const finalMetadata = NETLIFY_LOCAL_SECRET_KEYS.map((key) => ({
  is_secret: true,
  key,
  scopes: ["builds", "functions", "runtime"],
  values: [{ context: "production" }],
}));

const createClient = (
  overrides: Partial<NetlifyLocalSecretsClient> = {},
): NetlifyLocalSecretsClient => {
  let environmentReads = 0;
  return {
    createEnvVars: async () => finalMetadata,
    getEnvVars: async () => (environmentReads++ === 0 ? [] : finalMetadata),
    getSite: async () => site,
    ...overrides,
  } as NetlifyLocalSecretsClient;
};

describe("provisionNetlifyLocalSecrets", () => {
  it("bootstraps the four fixed secrets without putting their values in argv or its result", async () => {
    let mutation: unknown;
    const argvBefore = [...process.argv];
    const client = createClient({
      createEnvVars: async (params) => {
        mutation = params;
        return finalMetadata;
      },
    });

    const result = await provisionNetlifyLocalSecrets(target, values, client);

    expect(result).toEqual({ outcome: "passed", stage: "complete" });
    expect(JSON.stringify(result)).not.toContain(SECRET_SENTINEL);
    expect(process.argv).toEqual(argvBefore);
    expect(process.argv).not.toContain(SECRET_SENTINEL);
    expect(mutation).toEqual({
      accountId: target.accountId,
      siteId: target.siteId,
      body: [
        {
          is_secret: true,
          key: "COLLABORATION_CAPABILITY_CURRENT_SECRET",
          scopes: ["builds", "functions", "runtime"],
          values: [{ context: "production", value: SECRET_SENTINEL }],
        },
        {
          is_secret: true,
          key: "COLLABORATION_TICKET_SECRET",
          scopes: ["builds", "functions", "runtime"],
          values: [{ context: "production", value: SECOND_SECRET }],
        },
        {
          is_secret: true,
          key: "COLLABORATION_SERVICE_TOKEN",
          scopes: ["builds", "functions", "runtime"],
          values: [{ context: "production", value: THIRD_SECRET }],
        },
        {
          is_secret: true,
          key: "RATE_LIMIT_SECRET",
          scopes: ["builds", "functions", "runtime"],
          values: [{ context: "production", value: FOURTH_SECRET }],
        },
      ],
    });
  });

  it("fails closed before authentication for malformed, short, or duplicate values", async () => {
    let calls = 0;
    const client = createClient({
      getSite: async () => {
        calls += 1;
        return site;
      },
    });
    const malformed = { ...values, EXTRA_SECRET: "extra" } as StagingLocalSecretValues;
    const missing = {
      STAGE_COLLABORATION_CAPABILITY_CURRENT_SECRET: SECRET_SENTINEL,
      STAGE_COLLABORATION_SERVICE_TOKEN: THIRD_SECRET,
      STAGE_COLLABORATION_TICKET_SECRET: SECOND_SECRET,
    } as StagingLocalSecretValues;
    const short = { ...values, STAGE_COLLABORATION_TICKET_SECRET: "short" };
    const duplicate = {
      ...values,
      STAGE_COLLABORATION_TICKET_SECRET: SECRET_SENTINEL,
    };

    await expect(provisionNetlifyLocalSecrets(target, malformed, client)).resolves.toEqual({
      outcome: "blocked",
      stage: "configuration",
    });
    await expect(provisionNetlifyLocalSecrets(target, missing, client)).resolves.toEqual({
      outcome: "blocked",
      stage: "configuration",
    });
    await expect(provisionNetlifyLocalSecrets(target, short, client)).resolves.toEqual({
      outcome: "blocked",
      stage: "configuration",
    });
    await expect(provisionNetlifyLocalSecrets(target, duplicate, client)).resolves.toEqual({
      outcome: "blocked",
      stage: "configuration",
    });
    expect(calls).toBe(0);
  });

  it("rejects the production site and staging identity or safety mismatches", async () => {
    const mismatches = [
      { ...site, id: target.productionSiteId },
      { ...site, account_id: "other-account" },
      { ...site, name: "other-site" },
      { ...site, build_settings: { ...site.build_settings, provider: "github" } },
      { ...site, build_settings: { ...site.build_settings, repo_url: "https://example.com/repo" } },
    ];

    for (const response of mismatches) {
      const result = await provisionNetlifyLocalSecrets(
        target,
        values,
        createClient({ getSite: async () => response }),
      );
      expect(result).toEqual({ outcome: "blocked", stage: "target" });
    }
  });

  it("refuses rotation when any fixed key already exists", async () => {
    let mutations = 0;
    const client = createClient({
      createEnvVars: async () => {
        mutations += 1;
        return finalMetadata;
      },
      getEnvVars: async () => [finalMetadata[0]],
    });

    await expect(provisionNetlifyLocalSecrets(target, values, client)).resolves.toEqual({
      outcome: "blocked",
      stage: "preflight",
    });
    expect(mutations).toBe(0);
  });

  it("checks all contexts before creating secrets", async () => {
    const createEnvVars = vi.fn();
    const getEnvVars = vi.fn<NetlifyLocalSecretsClient["getEnvVars"]>(async () => [
      { ...finalMetadata[0], values: [{ context: "deploy-preview" }] },
    ]);
    const report = await provisionNetlifyLocalSecrets(
      target,
      values,
      createClient({ createEnvVars, getEnvVars }),
    );
    expect(report).toEqual({ outcome: "blocked", stage: "preflight" });
    expect(getEnvVars.mock.calls[0]?.[0]).not.toHaveProperty("contextName");
    expect(createEnvVars).not.toHaveBeenCalled();
  });

  it("accepts the empty build-settings shape of an unlinked manual site", async () => {
    const report = await provisionNetlifyLocalSecrets(
      target,
      values,
      createClient({ getSite: async () => ({ ...site, build_settings: {} }) }),
    );
    expect(report.outcome).toBe("passed");
  });

  it("rejects duplicate scope entries instead of counting them as coverage", async () => {
    let reads = 0;
    const report = await provisionNetlifyLocalSecrets(
      target,
      values,
      createClient({
        getEnvVars: async () =>
          reads++ === 0
            ? []
            : finalMetadata.map((entry) => ({ ...entry, scopes: ["builds", "builds", "builds"] })),
      }),
    );
    expect(report).toEqual({ outcome: "blocked", stage: "postflight" });
  });

  it("bounds provider backoff that does not honor AbortSignal", async () => {
    vi.useFakeTimers();
    try {
      let signal: AbortSignal | undefined;
      const request = safeProviderCall(async (value) => {
        signal = value;
        return new Promise(() => {});
      });
      const rejection = expect(request).rejects.toThrow(
        "Netlify local-secret metadata request failed.",
      );
      await vi.advanceTimersByTimeAsync(15_000);
      await rejection;
      expect(signal?.aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("redacts provider failures and identifies the blocked stage", async () => {
    const result = await provisionNetlifyLocalSecrets(
      target,
      values,
      createClient({
        createEnvVars: async () => {
          throw new Error(SECRET_SENTINEL);
        },
      }),
    );

    expect(result).toEqual({ outcome: "blocked", stage: "mutation" });
    expect(JSON.stringify(result)).not.toContain(SECRET_SENTINEL);
  });

  it("requires exact secret metadata after creation", async () => {
    const badMetadata = finalMetadata.map((entry, index) =>
      index === 0 ? { ...entry, scopes: [...entry.scopes, "post-processing"] } : entry,
    );
    let reads = 0;
    const result = await provisionNetlifyLocalSecrets(
      target,
      values,
      createClient({ getEnvVars: async () => (reads++ === 0 ? [] : badMetadata) }),
    );

    expect(result).toEqual({ outcome: "blocked", stage: "postflight" });
  });
});

describe("createOneShotNetlifyClient", () => {
  it("blocks the installed API library retry before a second transport dispatch", async () => {
    class TimeoutAgent extends Agent {
      override createConnection(
        _options: Parameters<Agent["createConnection"]>[0],
        _callback: Parameters<Agent["createConnection"]>[1],
      ): ReturnType<Agent["createConnection"]> {
        const error = new Error("fixture timeout") as Error & { code?: string };
        error.code = "ETIMEDOUT";
        const socket = new Socket();
        queueMicrotask(() => socket.destroy(error));
        return socket;
      }
    }
    const transport = new TimeoutAgent();
    const resolvedUrls: string[] = [];
    let resolutions = 0;
    const resolveTransport = (url: URL) => {
      resolutions += 1;
      resolvedUrls.push(url.href);
      return transport;
    };
    vi.useFakeTimers();

    try {
      const client = createOneShotNetlifyClient({
        accessToken: "fixture-token",
        agent: resolveTransport,
        host: "fixture.invalid",
        pathPrefix: "/api/v1",
        scheme: "https",
        userAgent: "local-test",
      });
      const request = client.createEnvVars(
        { accountId: "account", body: [], siteId: "site" },
        { redirect: "error" },
      );
      const rejection = expect(request).rejects.toThrow(
        "Additional Netlify request dispatch blocked.",
      );
      await vi.runAllTimersAsync();

      await rejection;
      expect(resolutions).toBe(1);
      expect(resolvedUrls).toEqual([
        "https://fixture.invalid/api/v1/accounts/account/env?site_id=site",
      ]);
    } finally {
      vi.useRealTimers();
      transport.destroy();
    }
  });
});
