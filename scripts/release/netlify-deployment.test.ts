import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import {
  uploadHeldNetlifyDeployment,
  publishHeldNetlifyDeployment,
  type NetlifyDeploymentClient,
  type NetlifyDeploymentInput,
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
const metadata = { functionSchedules: [], functionsConfig: {}, functions: {} };
async function fixture() {
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
  let locked = false;
  let uploaded = false;
  let published = "baseline";
  const client: NetlifyDeploymentClient = async (operation, params) => {
    calls.push(operation);
    if (operation === "getSite")
      return {
        id: input.siteId,
        account_id: input.accountId,
        ssl_url: input.origin,
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
        site_id: input.siteId,
        draft: false,
        context: "production",
        title: `release-${input.candidate}-${input.preparation.artifacts.netlify.sha256}`,
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
    checkpoint: async ({ operation }: { operation: string }) => {
      checkpoints.push(operation);
      expect(calls.at(-1)).not.toBe(operation);
    },
  };
  const held = await uploadHeldNetlifyDeployment(input, artifacts, metadata, dependencies);
  expect(held.acknowledgedUploads).toBe(1);
  expect(calls).not.toContain("restoreSiteDeploy");
  expect(checkpoints).toEqual([
    "lockDeploy",
    "createSiteDeploy",
    "updateSiteDeploy",
    "uploadDeployFile",
  ]);
  await expect(publishHeldNetlifyDeployment(input, held, dependencies)).resolves.toEqual({
    publishedDeployId: "candidate",
  });
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
