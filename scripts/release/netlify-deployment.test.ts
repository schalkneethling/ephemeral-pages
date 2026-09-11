import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import {
  reconcileNetlifyDeployment,
  uploadHeldNetlifyDeployment,
  uploadHeldProductionNetlifyDeployment,
  publishHeldNetlifyDeployment,
  publishHeldProductionNetlifyDeployment,
  verifyRetainedNetlifyDeployment,
  type NetlifyDeploymentClient,
  type NetlifyDeploymentInput,
  type ProductionNetlifyDeploymentInput,
} from "./netlify-deployment.ts";
import type { PreparedNetlifyArtifacts } from "./netlify-artifacts.ts";

vi.mock("./netlify-artifacts.ts", () => ({ verifyNetlifyArtifacts: vi.fn(async () => {}) }));
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});
const input: NetlifyDeploymentInput = {
  environment: "staging",
  siteId: "stage-site",
  productionSiteId: "production-site",
  accountId: "account",
  origin: "https://staging.example.com",
  baselineDeployId: "baseline",
  candidate: "a".repeat(40),
  preparation: {
    schemaVersion: 1,
    operation: "prepare",
    outcome: "passed",
    source: {
      candidate: "a".repeat(40),
      tree: "a".repeat(40),
      environment: "staging",
      configurationFingerprint: "c".repeat(64),
    },
    toolchain: { bun: "1.3.14" },
    artifacts: {
      netlify: { directory: "netlify", sha256: "b".repeat(64) },
      worker: { directory: "worker", sha256: "d".repeat(64) },
    },
  },
};
const productionAuthorization = {
  assertArtifact: vi.fn(() => undefined),
};
const productionInput: ProductionNetlifyDeploymentInput = {
  ...input,
  authorization: productionAuthorization,
  environment: "production",
  origin: "https://production.example.com",
  preparation: {
    ...input.preparation,
    source: { ...input.preparation.source, environment: "production" },
  },
  siteId: input.productionSiteId,
};
const metadata = { functionSchedules: [], functionsConfig: {}, functions: {} };
async function fixture(
  target: NetlifyDeploymentInput | ProductionNetlifyDeploymentInput = input,
  initiallyLocked = false,
) {
  const root = await mkdtemp(join(tmpdir(), "netlify-held-"));
  roots.push(root);
  await mkdir(join(root, "publish"));
  const bytes = Buffer.from('[[redirects]]\nfrom = "/api/*"\nto = "/.netlify/functions/:splat"\n');
  await writeFile(join(root, "publish/netlify.toml"), bytes);
  const file = {
    relativePath: "publish/netlify.toml",
    bytes: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
  const artifacts: PreparedNetlifyArtifacts = {
    artifactDirectory: root,
    inventorySha256: "b".repeat(64),
    inventory: {
      schemaVersion: 1,
      netlifyCliVersion: "27.5.0",
      zipItAndShipItVersion: "15.5.1",
      staticFiles: [],
      deployConfiguration: { file, sha1: createHash("sha1").update(bytes).digest("hex") },
      functionSchedules: [],
      functionsConfig: {},
      headers: file,
      functions: [],
      functionsManifest: file,
    },
  };
  const calls: string[] = [];
  let locked = initiallyLocked;
  let uploaded = false;
  let published = "baseline";
  const client: NetlifyDeploymentClient = async (operation, params) => {
    calls.push(operation);
    if (operation === "getSite")
      return {
        id: target.siteId,
        account_id: target.accountId,
        ssl_url: target.origin,
        build_settings: {},
        published_deploy: { id: published, locked },
      };
    if (operation === "lockDeploy") {
      locked = true;
      return { id: "baseline" };
    }
    if (operation === "createSiteDeploy") {
      expect(params.body).toEqual({ draft: false, deploy_source: "cli" });
      return { id: "candidate" };
    }
    if (operation === "updateSiteDeploy") return {};
    if (operation === "getSiteDeploy")
      return {
        id: "candidate",
        site_id: target.siteId,
        draft: false,
        context: "production",
        title: `release-${target.candidate}-${target.preparation.artifacts.netlify.sha256}`,
        state: uploaded ? "ready" : "prepared",
        required: [createHash("sha1").update(bytes).digest("hex")],
        required_functions: [],
      };
    if (operation === "uploadDeployFile") {
      uploaded = true;
      return {
        path: "/netlify.toml",
        size: bytes.length,
        sha: createHash("sha1").update(bytes).digest("hex"),
      };
    }
    if (operation === "restoreSiteDeploy") {
      published = "candidate";
      return { id: "candidate" };
    }
    throw new Error("Unexpected test request");
  };
  return { artifacts, calls, client };
}
it("holds the live deployment throughout upload and publishes only in the separate operation", async () => {
  const { artifacts, calls, client } = await fixture();
  const checkpoints: string[] = [];
  const dependencies = {
    client,
    checkpoint: async ({ operation, phase }: { operation: string; phase: string }) => {
      checkpoints.push(`${phase}:${operation}`);
      if (phase === "pending-mutation") expect(calls.at(-1)).not.toBe(operation);
      else expect(calls.at(-1)).toBe(operation);
    },
  };
  const held = await uploadHeldNetlifyDeployment(input, artifacts, metadata, dependencies);
  expect(held.acknowledgedUploads).toBe(1);
  expect(calls).not.toContain("restoreSiteDeploy");
  expect(checkpoints).toEqual([
    "pending-mutation:lockDeploy",
    "mutation-response-received:lockDeploy",
    "pending-mutation:createSiteDeploy",
    "mutation-response-received:createSiteDeploy",
    "pending-mutation:updateSiteDeploy",
    "pending-mutation:uploadDeployFile",
  ]);
  await expect(publishHeldNetlifyDeployment(input, held, dependencies)).resolves.toEqual({
    publishedDeployId: "candidate",
  });
  expect(checkpoints.slice(-2)).toEqual([
    "pending-mutation:restoreSiteDeploy",
    "mutation-response-received:restoreSiteDeploy",
  ]);
});
it("does not dispatch when its durable checkpoint cannot be written", async () => {
  const { artifacts, calls, client } = await fixture();
  await expect(
    uploadHeldNetlifyDeployment(input, artifacts, metadata, {
      client,
      checkpoint: async () => {
        throw new Error("private path");
      },
    }),
  ).rejects.toMatchObject({ kind: "checkpoint" });
  expect(calls).toEqual(["getSite"]);
});
it("does not retry an ambiguous candidate creation", async () => {
  const { artifacts, calls, client } = await fixture();
  let creations = 0;
  await expect(
    uploadHeldNetlifyDeployment(input, artifacts, metadata, {
      client: async (operation, ...args) => {
        if (operation === "createSiteDeploy") {
          creations += 1;
          throw new Error("private credential");
        }
        return client(operation, ...args);
      },
      checkpoint: async () => {},
    }),
  ).rejects.toMatchObject({ kind: "ambiguous" });
  expect(creations).toBe(1);
  expect(calls).not.toContain("updateSiteDeploy");
});
it("rejects provider hash requests that were never submitted", async () => {
  const { artifacts, calls, client } = await fixture();
  let reads = 0;
  await expect(
    uploadHeldNetlifyDeployment(input, artifacts, metadata, {
      client: async (operation, ...args) => {
        const value = await client(operation, ...args);
        if (operation === "getSiteDeploy" && ++reads > 1)
          return { ...(value as object), required: ["unexpected"] };
        return value;
      },
      checkpoint: async () => {},
    }),
  ).rejects.toMatchObject({ kind: "verification" });
  expect(calls).not.toContain("uploadDeployFile");
});
it("blocks production targets before inspecting or mutating providers", async () => {
  const { artifacts, calls, client } = await fixture();
  await expect(
    uploadHeldNetlifyDeployment({ ...input, siteId: input.productionSiteId }, artifacts, metadata, {
      client,
      checkpoint: async () => {},
    }),
  ).rejects.toMatchObject({ kind: "preflight" });
  expect(calls).toEqual([]);
});

it("rejects a ready deployment from a different candidate before publication", async () => {
  const { artifacts, calls, client } = await fixture();
  const dependencies = { client, checkpoint: async () => {} };
  const held = await uploadHeldNetlifyDeployment(input, artifacts, metadata, dependencies);
  await expect(
    publishHeldNetlifyDeployment(input, { ...held, candidate: "f".repeat(40) }, dependencies),
  ).rejects.toMatchObject({ kind: "preflight" });
  await expect(
    publishHeldNetlifyDeployment(input, held, {
      ...dependencies,
      client: async (operation, ...args) => {
        const value = await client(operation, ...args);
        return operation === "getSiteDeploy"
          ? { ...(value as object), title: "another-release" }
          : value;
      },
    }),
  ).rejects.toMatchObject({ kind: "verification" });
  expect(calls).not.toContain("restoreSiteDeploy");
});

it("accepts an omitted false draft flag for an explicitly production-context deploy", async () => {
  const { artifacts, client } = await fixture();
  const dependencies = {
    checkpoint: async () => {},
    client: async (
      operation: Parameters<typeof client>[0],
      ...args: Parameters<typeof client> extends [unknown, ...infer Rest] ? Rest : never
    ) => {
      const value = await client(operation, ...args);
      if (operation === "getSiteDeploy") {
        const { draft: _draft, ...remaining } = value as Record<string, unknown>;
        return remaining;
      }
      return value;
    },
  };
  await expect(
    uploadHeldNetlifyDeployment(input, artifacts, metadata, dependencies),
  ).resolves.toMatchObject({ state: "ready" });
});

it.each([
  { response: { name: "function" }, accepted: true },
  { response: { name: "function", sha: "mismatch" }, accepted: false },
  { response: { name: "another-function" }, accepted: false },
])("verifies function upload acknowledgements: $response", async ({ response, accepted }) => {
  const { artifacts, client } = await fixture();
  const bytes = Buffer.from("frozen function archive");
  const digest = createHash("sha256").update(bytes).digest("hex");
  await writeFile(join(artifacts.artifactDirectory, "function.zip"), bytes);
  artifacts.inventory.functions = [
    {
      name: "function",
      runtime: "js",
      relativePath: "function.zip",
      bytes: bytes.length,
      sha256: digest,
    },
  ];
  let functionUploaded = false;
  const result = uploadHeldNetlifyDeployment(
    input,
    artifacts,
    { ...metadata, functions: { function: { runtime: "js" } } },
    {
      checkpoint: async () => {},
      client: async (operation, ...args) => {
        if (operation === "uploadDeployFunction") {
          expect(args[0].name).toBe("function");
          functionUploaded = true;
          return response;
        }
        const value = await client(operation, ...args);
        return operation === "getSiteDeploy"
          ? { ...(value as object), required_functions: functionUploaded ? [] : [digest] }
          : value;
      },
    },
  );
  if (accepted)
    await expect(result).resolves.toMatchObject({ state: "ready", acknowledgedUploads: 2 });
  else await expect(result).rejects.toMatchObject({ kind: "verification" });
});

it("uses explicit authorization and an already locked production publication", async () => {
  productionAuthorization.assertArtifact.mockClear();
  const { artifacts, calls, client } = await fixture(productionInput, true);
  const checkpoints: Array<{ operation: string; phase: string }> = [];
  const dependencies = {
    checkpoint: async (value: { operation: string; phase: string }) => {
      checkpoints.push(value);
    },
    client,
  };

  const held = await uploadHeldProductionNetlifyDeployment(
    productionInput,
    artifacts,
    metadata,
    dependencies,
  );
  expect(productionAuthorization.assertArtifact).toHaveBeenCalledWith(
    "netlify",
    { accountId: productionInput.accountId, siteId: productionInput.siteId },
    artifacts.inventorySha256,
  );
  expect(calls).not.toContain("lockDeploy");
  expect(checkpoints.some(({ operation }) => operation === "lockDeploy")).toBe(false);
  await expect(
    publishHeldProductionNetlifyDeployment(productionInput, held, dependencies),
  ).resolves.toEqual({ publishedDeployId: "candidate" });
});

it("blocks production hold without an existing publication lock and never locks it", async () => {
  const { artifacts, calls, client } = await fixture(productionInput, false);
  await expect(
    uploadHeldProductionNetlifyDeployment(productionInput, artifacts, metadata, {
      checkpoint: async () => undefined,
      client,
    }),
  ).rejects.toMatchObject({ kind: "preflight" });
  expect(calls).toEqual(["getSite"]);
});

it("persists Netlify response IDs before readback and stops if persistence fails", async () => {
  const created = await fixture(productionInput, true);
  await expect(
    uploadHeldProductionNetlifyDeployment(productionInput, created.artifacts, metadata, {
      checkpoint: async (value) => {
        if (value.phase === "mutation-response-received") {
          expect(value).toMatchObject({ deployId: "candidate", operation: "createSiteDeploy" });
          throw new Error();
        }
      },
      client: created.client,
    }),
  ).rejects.toMatchObject({ kind: "ambiguous" });
  expect(created.calls.at(-1)).toBe("createSiteDeploy");

  const published = await fixture(productionInput, true);
  const held = await uploadHeldProductionNetlifyDeployment(
    productionInput,
    published.artifacts,
    metadata,
    { checkpoint: async () => undefined, client: published.client },
  );
  await expect(
    publishHeldProductionNetlifyDeployment(productionInput, held, {
      checkpoint: async (value) => {
        if (value.phase === "mutation-response-received") {
          expect(value).toMatchObject({
            operation: "restoreSiteDeploy",
            publishedDeployId: "candidate",
          });
          throw new Error();
        }
      },
      client: published.client,
    }),
  ).rejects.toMatchObject({ kind: "ambiguous" });
  expect(published.calls.at(-1)).toBe("restoreSiteDeploy");
});

it("authorizes before provider access and keeps staging entry points production-safe", async () => {
  const { artifacts, calls, client } = await fixture(productionInput, true);
  const denied = {
    ...productionInput,
    authorization: {
      assertArtifact: () => {
        expect(calls).toEqual([]);
        throw new Error("denied");
      },
    },
  };
  await expect(
    uploadHeldProductionNetlifyDeployment(denied, artifacts, metadata, {
      checkpoint: async () => undefined,
      client,
    }),
  ).rejects.toMatchObject({ kind: "preflight" });
  expect(calls).toEqual([]);
  await expect(
    uploadHeldNetlifyDeployment(
      productionInput as unknown as NetlifyDeploymentInput,
      artifacts,
      metadata,
      {
        checkpoint: async () => undefined,
        client,
      },
    ),
  ).rejects.toMatchObject({ kind: "preflight" });
  expect(calls).toEqual([]);
});

it("reconciles only one exact production candidate marker without mutations", async () => {
  const { artifacts, calls, client } = await fixture(productionInput, true);
  const title = `release-${productionInput.candidate}-${artifacts.inventorySha256}`;
  const readOnlyClient: NetlifyDeploymentClient = async (operation, ...args) => {
    if (operation === "listSiteDeploys") {
      calls.push(operation);
      return [{ id: "candidate", site_id: productionInput.siteId, title }];
    }
    const value = await client(operation, ...args);
    return operation === "getSiteDeploy" ? { ...(value as object), state: "ready" } : value;
  };

  await expect(
    reconcileNetlifyDeployment(
      productionInput,
      { phase: "candidate-create-pending" },
      {
        checkpoint: async () => {
          throw new Error("reconciliation must not checkpoint");
        },
        client: readOnlyClient,
      },
    ),
  ).resolves.toMatchObject({ candidateDeployId: "candidate", state: "ready" });
  expect(calls).toEqual(["getSite", "listSiteDeploys", "getSiteDeploy", "getSite"]);
});

it("blocks duplicate production reconciliation markers", async () => {
  const { artifacts, calls, client } = await fixture(productionInput, true);
  const title = `release-${productionInput.candidate}-${artifacts.inventorySha256}`;
  await expect(
    reconcileNetlifyDeployment(
      productionInput,
      { phase: "candidate-create-pending" },
      {
        checkpoint: async () => undefined,
        client: async (operation, ...args) => {
          if (operation === "listSiteDeploys") {
            calls.push(operation);
            return [
              { id: "candidate-one", title },
              { id: "candidate-two", title },
            ];
          }
          return client(operation, ...args);
        },
      },
    ),
  ).rejects.toMatchObject({ kind: "ambiguous" });
  expect(calls).not.toContain("createSiteDeploy");
});

it("checks every Netlify deploy page before accepting a unique marker", async () => {
  const { artifacts, calls, client } = await fixture(productionInput, true);
  const title = `release-${productionInput.candidate}-${artifacts.inventorySha256}`;
  const pages: number[] = [];
  const readOnlyClient: NetlifyDeploymentClient = async (operation, parameters, signal) => {
    if (operation === "listSiteDeploys") {
      calls.push(operation);
      pages.push(parameters.page as number);
      return parameters.page === 1
        ? Array.from({ length: 100 }, (_, index) => ({ id: `other-${index}` }))
        : [{ id: "candidate", title }];
    }
    const value = await client(operation, parameters, signal);
    return operation === "getSiteDeploy" ? { ...(value as object), state: "ready" } : value;
  };
  await expect(
    reconcileNetlifyDeployment(
      productionInput,
      { phase: "candidate-create-pending" },
      { checkpoint: async () => undefined, client: readOnlyClient },
    ),
  ).resolves.toMatchObject({ candidateDeployId: "candidate" });
  expect(pages).toEqual([1, 2]);
});

it("reconciles a returned candidate ID without listing or mutating deploys", async () => {
  const { calls, client } = await fixture(productionInput, true);
  const readyClient: NetlifyDeploymentClient = async (operation, parameters, signal) => {
    const value = await client(operation, parameters, signal);
    return operation === "getSiteDeploy" ? { ...(value as object), state: "ready" } : value;
  };
  await expect(
    reconcileNetlifyDeployment(
      productionInput,
      { deployId: "candidate", phase: "candidate-create-response-received" },
      { checkpoint: async () => undefined, client: readyClient },
    ),
  ).resolves.toMatchObject({
    acknowledgedUploads: null,
    candidateDeployId: "candidate",
    state: "ready",
  });
  expect(calls).toEqual(["getSite", "getSiteDeploy", "getSite"]);
});

it("reconciles publication only when the exact candidate remains published and locked", async () => {
  const { artifacts, calls, client } = await fixture(productionInput, true);
  const held = await uploadHeldProductionNetlifyDeployment(productionInput, artifacts, metadata, {
    checkpoint: async () => undefined,
    client,
  });
  calls.length = 0;
  const publishedClient: NetlifyDeploymentClient = async (operation, parameters, signal) => {
    if (operation === "getSite") {
      calls.push(operation);
      return {
        account_id: productionInput.accountId,
        build_settings: {},
        id: productionInput.siteId,
        published_deploy: { id: held.candidateDeployId, locked: true },
        ssl_url: productionInput.origin,
      };
    }
    return client(operation, parameters, signal);
  };
  await expect(
    reconcileNetlifyDeployment(
      productionInput,
      { held, phase: "publish-pending" },
      { checkpoint: async () => undefined, client: publishedClient },
    ),
  ).resolves.toEqual({ publishedDeployId: "candidate" });
  expect(calls).toEqual(["getSiteDeploy", "getSite"]);

  await expect(
    reconcileNetlifyDeployment(
      productionInput,
      { held, phase: "publish-response-received", publishedDeployId: "another-deploy" },
      { checkpoint: async () => undefined, client: publishedClient },
    ),
  ).rejects.toMatchObject({ kind: "verification" });
});

it("treats a production restore that releases the publication lock as ambiguous", async () => {
  const { artifacts, calls, client } = await fixture(productionInput, true);
  const dependencies = { checkpoint: async () => undefined, client };
  const held = await uploadHeldProductionNetlifyDeployment(
    productionInput,
    artifacts,
    metadata,
    dependencies,
  );
  await expect(
    publishHeldProductionNetlifyDeployment(productionInput, held, {
      checkpoint: async () => undefined,
      client: async (operation, parameters, signal) => {
        const value = await client(operation, parameters, signal);
        if (operation !== "getSite" || !calls.includes("restoreSiteDeploy")) return value;
        const site = value as Record<string, unknown>;
        return { ...site, published_deploy: { id: "candidate", locked: false } };
      },
    }),
  ).rejects.toMatchObject({ kind: "ambiguous" });
  expect(calls.filter((operation) => operation === "restoreSiteDeploy")).toHaveLength(1);
});

it("rejects a retained Netlify ID when the exact artifact marker belongs to another deploy", async () => {
  const { artifacts, calls, client } = await fixture(productionInput, true);
  const held = await uploadHeldProductionNetlifyDeployment(productionInput, artifacts, metadata, {
    checkpoint: async () => undefined,
    client,
  });
  calls.length = 0;
  const title = `release-${productionInput.candidate}-${artifacts.inventorySha256}`;
  await expect(
    verifyRetainedNetlifyDeployment(
      productionInput,
      { ...held, candidateDeployId: "forged-candidate" },
      productionInput.baselineDeployId,
      {
        checkpoint: async () => undefined,
        client: async (operation, parameters, signal) => {
          if (operation === "listSiteDeploys") return [{ id: "candidate", title }];
          if (operation === "getSiteDeploy") {
            return {
              context: "production",
              draft: false,
              id: "forged-candidate",
              site_id: productionInput.siteId,
              state: "ready",
              title,
            };
          }
          return client(operation, parameters, signal);
        },
      },
    ),
  ).rejects.toMatchObject({ kind: "verification" });
  expect(calls).toEqual([]);
});

it.each([false, true])(
  "bounds discovery separately from each request (exhausted: %s)",
  async (exhausted) => {
    const { artifacts, client } = await fixture(productionInput, true);
    const title = `release-${productionInput.candidate}-${artifacts.inventorySha256}`;
    let elapsed = 0;
    const clock = vi.spyOn(performance, "now").mockImplementation(() => elapsed);
    const timeout = vi.spyOn(AbortSignal, "timeout");
    const signals: AbortSignal[] = [];
    const budgets: number[] = [];
    try {
      const result = reconcileNetlifyDeployment(
        productionInput,
        { phase: "candidate-create-pending" },
        {
          checkpoint: async () => undefined,
          client: async (operation, parameters, signal) => {
            if (operation === "listSiteDeploys") {
              signals.push(signal);
              budgets.push(timeout.mock.calls.at(-1)![0]);
              elapsed += parameters.page === 5 && !exhausted ? 1_000 : 29_000;
              if (parameters.page === 5 && !exhausted) return [{ id: "candidate", title }];
              return Array.from({ length: 100 }, (_, index) => ({ id: `other-${index}` }));
            }
            const value = await client(operation, parameters, signal);
            return operation === "getSiteDeploy" ? { ...(value as object), state: "ready" } : value;
          },
        },
      );
      if (exhausted) await expect(result).rejects.toMatchObject({ kind: "verification" });
      else await expect(result).resolves.toMatchObject({ candidateDeployId: "candidate" });
      expect(budgets).toEqual([30_000, 30_000, 30_000, 30_000, 4_000]);
      expect(new Set(signals).size).toBe(5);
    } finally {
      clock.mockRestore();
      timeout.mockRestore();
    }
  },
);
