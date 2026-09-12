import { afterEach, describe, expect, it, vi } from "vitest";

import {
  observePublishedStagingPair,
  rehearsalInspectionCommandFailure,
  rehearsalInspectionEnvironment,
  type PostPublicationObservation,
} from "./rehearsal-cli.ts";
import { ProviderInspectionError } from "./providers.ts";

const originalNetlifyToken = process.env.NETLIFY_AUTH_TOKEN;
const originalCloudflareToken = process.env.CLOUDFLARE_API_TOKEN;

afterEach(() => {
  if (originalNetlifyToken === undefined) delete process.env.NETLIFY_AUTH_TOKEN;
  else process.env.NETLIFY_AUTH_TOKEN = originalNetlifyToken;
  if (originalCloudflareToken === undefined) delete process.env.CLOUDFLARE_API_TOKEN;
  else process.env.CLOUDFLARE_API_TOKEN = originalCloudflareToken;
});

describe("rehearsal provider inspection environment", () => {
  it("forwards only the credential for the exact provider executable", () => {
    process.env.NETLIFY_AUTH_TOKEN = "netlify-token";
    process.env.CLOUDFLARE_API_TOKEN = "cloudflare-token";

    const netlify = rehearsalInspectionEnvironment(
      "./node_modules/.bin/netlify",
      "wss://staging.example.test",
    );
    expect(netlify).toMatchObject({
      CI: "true",
      COLLABORATION_WEBSOCKET_URL: "wss://staging.example.test",
      NETLIFY_AUTH_TOKEN: "netlify-token",
    });
    expect(netlify).not.toHaveProperty("CLOUDFLARE_API_TOKEN");

    const cloudflare = rehearsalInspectionEnvironment(
      "./node_modules/.bin/wrangler",
      "wss://staging.example.test",
      { CLOUDFLARE_ACCOUNT_ID: "staging-account" },
    );
    expect(cloudflare).toMatchObject({
      CI: "true",
      CLOUDFLARE_ACCOUNT_ID: "staging-account",
      CLOUDFLARE_API_TOKEN: "cloudflare-token",
      COLLABORATION_WEBSOCKET_URL: "wss://staging.example.test",
    });
    expect(cloudflare).not.toHaveProperty("NETLIFY_AUTH_TOKEN");
  });

  it("rejects unsupported executables, metadata, and credential overrides", () => {
    process.env.NETLIFY_AUTH_TOKEN = "netlify-token";
    process.env.CLOUDFLARE_API_TOKEN = "cloudflare-token";

    expect(() =>
      rehearsalInspectionEnvironment("./node_modules/.bin/unknown", "wss://staging.example.test"),
    ).toThrow("Provider inspection failed.");
    expect(() =>
      rehearsalInspectionEnvironment("./node_modules/.bin/netlify", "wss://staging.example.test", {
        CLOUDFLARE_ACCOUNT_ID: "unexpected",
      }),
    ).toThrow("Provider inspection failed.");
    expect(() =>
      rehearsalInspectionEnvironment("./node_modules/.bin/wrangler", "wss://staging.example.test", {
        CLOUDFLARE_ACCOUNT_ID: "staging-account",
        CLOUDFLARE_API_TOKEN: "untrusted-override",
      }),
    ).toThrow("Provider inspection failed.");
  });

  it("omits an absent token so an existing local CLI login remains usable", () => {
    delete process.env.NETLIFY_AUTH_TOKEN;
    delete process.env.CLOUDFLARE_API_TOKEN;
    const environment = rehearsalInspectionEnvironment(
      "./node_modules/.bin/wrangler",
      "wss://staging.example.test",
      {
        CLOUDFLARE_ACCOUNT_ID: "staging-account",
      },
    );
    expect(environment).not.toHaveProperty("CLOUDFLARE_API_TOKEN");
    expect(environment).not.toHaveProperty("NETLIFY_AUTH_TOKEN");
  });
});

const expectedPair = {
  netlifyDeployId: "netlify-final",
  workerDeploymentId: "worker-final",
  workerVersionId: "version-final",
};
const transientNetlifyFailure = () =>
  new ProviderInspectionError({
    provider: "netlify",
    operation: "getSite",
    classification: "assertion",
    assertion: "published-deploy-ready",
  });

describe("postpublication staging observation", () => {
  it("retains a safe command cause and exit code without serializing command data", () => {
    const sentinel = "super-secret-sentinel";
    const error = rehearsalInspectionCommandFailure(
      "./node_modules/.bin/netlify",
      ["api", "getSite", "--data", sentinel],
      23,
    );

    expect(error.cause).toMatchObject({ name: "SafeCommandError", kind: "failed" });
    expect(error.diagnostic).toEqual({
      provider: "netlify",
      operation: "getSite",
      classification: "command",
      commandKind: "failed",
      exitCode: 23,
    });
    expect(JSON.stringify(error)).not.toContain(sentinel);
    expect(JSON.stringify(error.diagnostic)).not.toContain(sentinel);
  });

  it("retains an original native cause without serializing it", () => {
    const original = new Error("super-secret-sentinel");
    const error = new ProviderInspectionError(transientNetlifyFailure().diagnostic, original);

    expect(error.cause).toBe(original);
    expect(JSON.stringify(error)).not.toContain("super-secret-sentinel");
  });

  it("retains a transient failed assertion before accepting the exact pair", async () => {
    let elapsed = 0;
    const inspect = vi
      .fn<(deadlineAt: number) => Promise<typeof expectedPair>>()
      .mockRejectedValueOnce(transientNetlifyFailure())
      .mockResolvedValueOnce(expectedPair);
    const records: PostPublicationObservation[] = [];
    await expect(
      observePublishedStagingPair(
        expectedPair,
        inspect,
        async (record) => {
          records.push(structuredClone(record));
        },
        {
          now: () => elapsed,
          wait: async (milliseconds) => {
            elapsed += milliseconds;
          },
          budgetMs: 10_000,
          maxAttempts: 3,
        },
      ),
    ).resolves.toEqual(expectedPair);
    expect(inspect).toHaveBeenCalledTimes(2);
    expect(records.at(-1)).toEqual({
      schemaVersion: 1,
      operation: "observe-staging-published-pair",
      expectedPair,
      outcome: "passed",
      attempts: [
        {
          attempt: 1,
          elapsedMs: 0,
          outcome: "failed",
          diagnostic: transientNetlifyFailure().diagnostic,
        },
        { attempt: 2, elapsedMs: 2_000, outcome: "passed", pair: expectedPair },
      ],
    });
  });

  it("bounds persistent read-only inspection failures", async () => {
    let elapsed = 0;
    const inspect = vi.fn(async () => {
      throw transientNetlifyFailure();
    });
    const records: PostPublicationObservation[] = [];
    await expect(
      observePublishedStagingPair(
        expectedPair,
        inspect,
        async (record) => {
          records.push(structuredClone(record));
        },
        {
          now: () => elapsed,
          wait: async (milliseconds) => {
            elapsed += milliseconds;
          },
          budgetMs: 3_000,
          maxAttempts: 3,
        },
      ),
    ).rejects.toMatchObject({
      diagnostic: transientNetlifyFailure().diagnostic,
    });
    expect(inspect).toHaveBeenCalledTimes(3);
    expect(records.at(-1)?.outcome).toBe("failed");
    expect(records.at(-1)?.attempts).toHaveLength(3);
  });

  it("never accepts a different deployment pair", async () => {
    let elapsed = 0;
    const inspect = vi.fn(async () => ({
      ...expectedPair,
      netlifyDeployId: "netlify-stale",
    }));
    const records: PostPublicationObservation[] = [];
    await expect(
      observePublishedStagingPair(
        expectedPair,
        inspect,
        async (record) => {
          records.push(structuredClone(record));
        },
        {
          now: () => elapsed,
          wait: async (milliseconds) => {
            elapsed += milliseconds;
          },
          budgetMs: 2_000,
          maxAttempts: 2,
        },
      ),
    ).rejects.toMatchObject({
      diagnostic: {
        provider: "pair",
        operation: "expectedPair",
        classification: "mismatch",
      },
    });
    expect(records.at(-1)?.outcome).toBe("failed");
    expect(records.at(-1)?.attempts).toHaveLength(2);
  });

  it("classifies a failed observation checkpoint and preserves its cause", async () => {
    const original = new Error("super-secret-sentinel");
    const inspect = vi.fn(async () => {
      throw transientNetlifyFailure();
    });

    await expect(
      observePublishedStagingPair(expectedPair, inspect, async () => Promise.reject(original), {
        now: () => 0,
        wait: async () => {},
        budgetMs: 1_000,
        maxAttempts: 2,
      }),
    ).rejects.toMatchObject({ kind: "checkpoint", cause: original });
    expect(inspect).toHaveBeenCalledTimes(1);
  });
});
