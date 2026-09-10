import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  bootstrapNetlifyStaging,
  recoverPendingNetlifySite,
  recoverPendingNetlifyVariables,
  stagingBootstrapFingerprint,
  type NetlifyStagingBootstrapCheckpoint,
  type NetlifyStagingBootstrapDependencies,
  type NetlifyStagingBootstrapInput,
} from "./bootstrap.ts";
import {
  assertPinnedBootstrapToolVersions,
  createAtomicBootstrapStore,
  parseStagingBootstrapArguments,
  withExclusiveBootstrapLock,
} from "./bootstrap-cli.ts";

const SECRET_SENTINEL = "bootstrap-secret-sentinel-must-not-escape";
const repositoryRoot = fileURLToPath(new URL("../..", import.meta.url));

const input: NetlifyStagingBootstrapInput = {
  accountId: "account-123",
  accountSlug: "schalkneethling",
  productionSiteId: "production-site-456",
  siteName: "ephemeral-pages-staging",
  nonSecretVariables: {
    PUBLIC_BASE_URL: "https://ephemeral-pages-staging.netlify.app",
    COLLABORATION_SERVICE_URL: "https://ephemeral-pages-collaboration-staging.example.workers.dev",
    COLLABORATION_WEBSOCKET_URL: "wss://ephemeral-pages-collaboration-staging.example.workers.dev",
    COLLABORATION_TICKET_AUDIENCE: "ephemeral-pages-collaboration-staging",
    COLLABORATION_CAPABILITY_CURRENT_VERSION: "v1",
    COLLABORATION_ENABLED: "true",
  },
};

const productionResponse = {
  id: input.productionSiteId,
  name: "ephemeral-pages-production",
  account_id: input.accountId,
  account_slug: input.accountSlug,
};

const siteResponse = {
  id: "site-123",
  name: input.siteName,
  account_id: input.accountId,
  account_slug: input.accountSlug,
  ssl_url: input.nonSecretVariables.PUBLIC_BASE_URL,
  build_settings: { stop_builds: true },
  default_hooks_data: { access_token: SECRET_SENTINEL },
};

const variablesResponse: Array<Record<string, unknown>> = Object.entries(
  input.nonSecretVariables,
).map(([key, value]) => ({
  key,
  is_secret: false,
  scopes: ["builds", "functions", "runtime", "post_processing"],
  values: [{ context: "production", value }],
}));
variablesResponse.push({
  key: "UNRELATED_SECRET",
  is_secret: true,
  scopes: ["functions"],
  values: [{ context: "production", value: SECRET_SENTINEL }],
});

const harness = (initial: NetlifyStagingBootstrapCheckpoint | null = null) => {
  let checkpoint = initial;
  const saved: NetlifyStagingBootstrapCheckpoint[] = [];
  const calls: Array<{
    executable: string;
    args: readonly string[];
    checkpointPhase: NetlifyStagingBootstrapCheckpoint["phase"] | null;
  }> = [];
  const dependencies: NetlifyStagingBootstrapDependencies = {
    store: {
      load: async () => checkpoint,
      save: async (value) => {
        checkpoint = structuredClone(value);
        saved.push(structuredClone(value));
      },
    },
    run: async (executable, args) => {
      calls.push({ executable, args, checkpointPhase: checkpoint?.phase ?? null });
      if (args[1] === "createSiteInTeam") return JSON.stringify(siteResponse);
      if (args[1] === "getSite") {
        const data = JSON.parse(args[3] ?? "null") as { site_id?: string };
        return JSON.stringify(
          data.site_id === input.productionSiteId ? productionResponse : siteResponse,
        );
      }
      return JSON.stringify(variablesResponse);
    },
  };
  return {
    calls,
    dependencies,
    get checkpoint() {
      return checkpoint;
    },
    saved,
  };
};

describe("bootstrapNetlifyStaging", () => {
  it("rejects a completed checkpoint pointing at production before provider access", async () => {
    const state = harness({
      schemaVersion: 1,
      inputFingerprint: stagingBootstrapFingerprint(input),
      phase: "awaiting-operator-secrets",
      siteId: input.productionSiteId,
    });
    await expect(bootstrapNetlifyStaging(input, state.dependencies)).rejects.toThrow(
      "Staging bootstrap checkpoint is invalid.",
    );
    expect(state.calls).toEqual([]);
  });

  it("persists pending mutations and uses exact allowlisted API calls", async () => {
    const state = harness();
    const result = await bootstrapNetlifyStaging(input, state.dependencies);

    expect(result).toEqual({
      status: "awaiting-operator-secrets",
      accountId: "account-123",
      siteId: "site-123",
      siteName: "ephemeral-pages-staging",
      inputFingerprint: stagingBootstrapFingerprint(input),
    });
    expect(JSON.stringify(result)).not.toContain(SECRET_SENTINEL);
    expect(state.saved.map(({ phase }) => phase)).toEqual([
      "pending-site-creation",
      "site-created",
      "pending-non-secret-configuration",
      "awaiting-operator-secrets",
    ]);
    expect(state.calls.map(({ args, checkpointPhase }) => [args[1], checkpointPhase])).toEqual([
      ["getSite", null],
      ["createSiteInTeam", "pending-site-creation"],
      ["getSite", "site-created"],
      ["createEnvVars", "pending-non-secret-configuration"],
    ]);
    expect(
      state.calls.every(({ executable }) => executable === "./node_modules/.bin/netlify"),
    ).toBe(true);
    expect(state.calls[1]?.args).toEqual([
      "api",
      "createSiteInTeam",
      "--data",
      '{"account_slug":"schalkneethling","body":{"name":"ephemeral-pages-staging"}}',
    ]);
    expect(JSON.parse(state.calls[3]?.args[3] ?? "null")).toEqual({
      account_id: "account-123",
      site_id: "site-123",
      body: Object.entries(input.nonSecretVariables)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, value]) => ({
          key,
          is_secret: false,
          scopes: ["builds", "functions", "runtime", "post_processing"],
          values: [{ context: "production", value }],
        })),
    });
  });

  it("leaves an ambiguous site creation pending and redacts provider failures", async () => {
    const state = harness();
    const baseRun = state.dependencies.run;
    state.dependencies.run = async (executable, args, env) => {
      if (args[1] === "createSiteInTeam") throw new Error(SECRET_SENTINEL);
      return baseRun(executable, args, env);
    };

    const first = bootstrapNetlifyStaging(input, state.dependencies);
    await expect(first).rejects.toThrow("Staging bootstrap operation did not complete.");
    await expect(first).rejects.not.toThrow(SECRET_SENTINEL);
    const callCount = state.calls.length;
    await expect(bootstrapNetlifyStaging(input, state.dependencies)).rejects.toThrow(
      "Staging bootstrap is blocked pending operator inspection.",
    );
    expect(state.calls).toHaveLength(callCount);
    expect(state.checkpoint?.phase).toBe("pending-site-creation");
  });

  it("records a returned site id before an ambiguous variable mutation", async () => {
    const state = harness();
    const baseRun = state.dependencies.run;
    state.dependencies.run = async (executable, args, env) => {
      if (args[1] === "createEnvVars") throw new Error(SECRET_SENTINEL);
      return baseRun(executable, args, env);
    };

    await expect(bootstrapNetlifyStaging(input, state.dependencies)).rejects.toThrow(
      "Staging bootstrap operation did not complete.",
    );
    expect(state.checkpoint).toMatchObject({
      phase: "pending-non-secret-configuration",
      siteId: "site-123",
    });
  });

  it("recovers pending stages only through matching read-only inspection", async () => {
    const fingerprint = stagingBootstrapFingerprint(input);
    const site = harness({
      schemaVersion: 1,
      inputFingerprint: fingerprint,
      phase: "pending-site-creation",
      siteId: null,
    });
    await recoverPendingNetlifySite(input, "site-123", site.dependencies);
    expect(site.checkpoint?.phase).toBe("site-created");
    expect(site.calls.map(({ args }) => args[1])).toEqual(["getSite", "getSite"]);

    const variables = harness({
      schemaVersion: 1,
      inputFingerprint: fingerprint,
      phase: "pending-non-secret-configuration",
      siteId: "site-123",
    });
    await recoverPendingNetlifyVariables(input, variables.dependencies);
    expect(variables.checkpoint?.phase).toBe("awaiting-operator-secrets");
    expect(variables.calls.map(({ args }) => args[1])).toEqual([
      "getSite",
      "getSite",
      "getEnvVars",
    ]);
  });

  it("accepts the observed empty build settings of an unlinked site", async () => {
    const state = harness();
    const originalRun = state.dependencies.run;
    state.dependencies.run = async (executable, args, env) => {
      const result = JSON.parse(await originalRun(executable, args, env));
      if (result.id === siteResponse.id) result.build_settings = {};
      return JSON.stringify(result);
    };
    await expect(bootstrapNetlifyStaging(input, state.dependencies)).resolves.toHaveProperty(
      "siteId",
      siteResponse.id,
    );
  });

  it("allows a configuration retry only after all expected keys are confirmed absent", async () => {
    const state = harness({
      schemaVersion: 1,
      inputFingerprint: stagingBootstrapFingerprint(input),
      phase: "pending-non-secret-configuration",
      siteId: siteResponse.id,
    });
    const originalRun = state.dependencies.run;
    state.dependencies.run = async (exe, args, env) =>
      args[1] === "getEnvVars" ? "[]" : originalRun(exe, args, env);
    await expect(recoverPendingNetlifyVariables(input, state.dependencies)).resolves.toBe(
      "site-created",
    );
    expect(state.checkpoint?.phase).toBe("site-created");
    expect(state.calls.every(({ args }) => args[1] === "getSite")).toBe(true);
  });

  it("rejects production identity and unverified staging settings before mutation", async () => {
    const productionCollision = harness();
    const baseProductionRun = productionCollision.dependencies.run;
    productionCollision.dependencies.run = async (executable, args, env) => {
      if (args[1] === "getSite") {
        return JSON.stringify({ ...productionResponse, name: input.siteName });
      }
      return baseProductionRun(executable, args, env);
    };
    await expect(bootstrapNetlifyStaging(input, productionCollision.dependencies)).rejects.toThrow(
      "Staging bootstrap input is invalid.",
    );
    expect(productionCollision.saved).toEqual([]);

    const wrongSettings = harness();
    const baseSettingsRun = wrongSettings.dependencies.run;
    wrongSettings.dependencies.run = async (executable, args, env) => {
      if (args[1] === "createSiteInTeam") {
        return JSON.stringify({
          ...siteResponse,
          build_settings: { repo_url: "https://example.test/repository" },
        });
      }
      return baseSettingsRun(executable, args, env);
    };
    await expect(bootstrapNetlifyStaging(input, wrongSettings.dependencies)).rejects.toThrow(
      "Staging bootstrap operation did not complete.",
    );
    expect(wrongSettings.calls.map(({ args }) => args[1])).toEqual(["getSite"]);
    expect(wrongSettings.saved.map(({ phase }) => phase)).toEqual(["pending-site-creation"]);
  });

  it("blocks input drift and rejects unknown non-secret keys without provider calls", async () => {
    const drift = harness({
      schemaVersion: 1,
      inputFingerprint: "a".repeat(64),
      phase: "site-created",
      siteId: "site-123",
    });
    await expect(bootstrapNetlifyStaging(input, drift.dependencies)).rejects.toThrow(
      "Staging bootstrap checkpoint is invalid.",
    );
    expect(drift.calls).toEqual([]);

    const invalid = harness();
    const withSecret = {
      ...input,
      nonSecretVariables: {
        ...input.nonSecretVariables,
        COLLABORATION_TICKET_SECRET: SECRET_SENTINEL,
      },
    } as NetlifyStagingBootstrapInput;
    await expect(bootstrapNetlifyStaging(withSecret, invalid.dependencies)).rejects.toThrow(
      "Staging bootstrap input is invalid.",
    );
    expect(invalid.calls).toEqual([]);
    expect(invalid.saved).toEqual([]);
  });
});

describe("staging bootstrap CLI primitives", () => {
  it("parses only the documented mutually exclusive recovery modes", () => {
    expect(
      parseStagingBootstrapArguments(
        ["--input", "input.json", "--checkpoint", "state.json", "--recover-site", "site-123"],
        "/work",
      ),
    ).toEqual({
      inputPath: "/work/input.json",
      checkpointPath: "/work/state.json",
      recovery: { kind: "site", siteId: "site-123" },
    });
    expect(() =>
      parseStagingBootstrapArguments(
        [
          "--input",
          "input.json",
          "--checkpoint",
          "state.json",
          "--recover-site",
          "site-123",
          "--recover-variables",
        ],
        "/work",
      ),
    ).toThrow("Staging bootstrap could not start safely.");
    expect(() =>
      parseStagingBootstrapArguments(
        ["--input", "input.json", "--checkpoint", "state.json", "--secret", SECRET_SENTINEL],
        "/work",
      ),
    ).toThrow("Staging bootstrap could not start safely.");
    expect(() =>
      parseStagingBootstrapArguments(
        ["--input", "first.json", "--input", "second.json", "--checkpoint", "state.json"],
        "/work",
      ),
    ).toThrow("Staging bootstrap could not start safely.");
  });

  it("atomically persists value-free state and prevents concurrent operations", async () => {
    const directory = await mkdtemp(join(tmpdir(), "staging-bootstrap-"));
    const checkpointPath = join(directory, "checkpoint.json");
    try {
      const checkpoint: NetlifyStagingBootstrapCheckpoint = {
        schemaVersion: 1,
        inputFingerprint: "a".repeat(64),
        phase: "pending-site-creation",
        siteId: null,
      };
      const store = createAtomicBootstrapStore(checkpointPath);
      expect(await store.load()).toBeNull();
      await store.save(checkpoint);
      expect(await store.load()).toEqual(checkpoint);
      expect(await readFile(checkpointPath, "utf8")).not.toContain(SECRET_SENTINEL);

      await withExclusiveBootstrapLock(checkpointPath, async () => {
        await expect(
          withExclusiveBootstrapLock(checkpointPath, async () => undefined),
        ).rejects.toThrow("Staging bootstrap could not start safely.");
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("preserves a colliding temporary checkpoint it did not create", async () => {
    const directory = await mkdtemp(join(tmpdir(), "staging-bootstrap-collision-"));
    const checkpointPath = join(directory, "checkpoint.json");
    const temporaryPath = `${checkpointPath}.tmp-${process.pid}`;
    try {
      await writeFile(temporaryPath, "owned-by-another-writer\n", { mode: 0o600 });
      await expect(
        createAtomicBootstrapStore(checkpointPath).save({
          schemaVersion: 1,
          inputFingerprint: "a".repeat(64),
          phase: "pending-site-creation",
          siteId: null,
        }),
      ).rejects.toThrow("Staging bootstrap could not start safely.");
      await expect(readFile(temporaryPath, "utf8")).resolves.toBe("owned-by-another-writer\n");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("accepts only the repository's exact pinned provider package versions", async () => {
    await expect(assertPinnedBootstrapToolVersions(repositoryRoot)).resolves.toBeUndefined();

    const directory = await mkdtemp(join(tmpdir(), "staging-bootstrap-versions-"));
    try {
      await mkdir(join(directory, "node_modules", "netlify-cli"), { recursive: true });
      await mkdir(join(directory, "node_modules", "wrangler"), { recursive: true });
      await writeFile(
        join(directory, "node_modules", "netlify-cli", "package.json"),
        '{"version":"27.5.1"}',
      );
      await writeFile(
        join(directory, "node_modules", "wrangler", "package.json"),
        '{"version":"4.125.0"}',
      );
      await expect(assertPinnedBootstrapToolVersions(directory)).rejects.toThrow(
        "Staging bootstrap could not start safely.",
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
