import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  prepareWorkerArtifacts,
  verifyWorkerArtifacts,
  WorkerArtifactError,
  type PrepareWorkerArtifactsInput,
  type WorkerArtifactCommandRunner,
} from "./worker-artifacts.ts";

const SECRET_SENTINEL = "artifact-secret-sentinel-must-not-escape";

const hash = (value: Buffer | string): string => createHash("sha256").update(value).digest("hex");

const createFixture = (environment: "staging" | "production" = "staging") => {
  const parent = mkdtempSync(join(tmpdir(), "worker-artifact-test-"));
  const repositoryRoot = join(parent, "repository");
  const configRelativePath = "collaboration-worker/wrangler.jsonc";
  const configPath = join(repositoryRoot, configRelativePath);
  const artifactDirectory = join(parent, `artifact-${environment}`);
  mkdirSync(dirname(configPath), { recursive: true });
  mkdirSync(join(repositoryRoot, "node_modules/wrangler"), { recursive: true });
  writeFileSync(
    join(repositoryRoot, "node_modules/wrangler/package.json"),
    JSON.stringify({ version: "4.125.0" }),
  );

  const targets = {
    staging: {
      workerName: "ephemeral-pages-collaboration-staging",
      origins: "https://ephemeral-pages-staging.example",
      publicOrigin: "https://ephemeral-pages-collaboration-staging.example.workers.dev",
    },
    production: {
      workerName: "ephemeral-pages-collaboration",
      origins: "https://ephemeral.example",
      publicOrigin: "https://ephemeral-pages-collaboration.example.workers.dev",
    },
  } as const;
  const variables = (target: (typeof targets)[keyof typeof targets]) => ({
    ALLOWED_ORIGINS: target.origins,
    PAGE_CONTENT_ORIGIN: target.origins,
    PUBLIC_WORKER_ORIGIN: target.publicOrigin,
    TICKET_AUDIENCE: target.workerName,
  });
  const targetEnvironment = (target: (typeof targets)[keyof typeof targets]) => ({
    name: target.workerName,
    workers_dev: true,
    secrets: { required: ["TICKET_HMAC_SECRET", "ADMIN_TOKEN"] },
    durable_objects: {
      bindings: [{ name: "COLLABORATION_ROOMS", class_name: "CollaborationRoom" }],
    },
    browser: { binding: "BROWSER" },
    vars: variables(target),
  });
  const config = {
    name: targets.production.workerName,
    main: "src/index.ts",
    compatibility_date: "2026-08-23",
    compatibility_flags: ["nodejs_compat"],
    secrets: { required: ["TICKET_HMAC_SECRET", "ADMIN_TOKEN"] },
    durable_objects: {
      bindings: [{ name: "COLLABORATION_ROOMS", class_name: "CollaborationRoom" }],
    },
    migrations: [{ tag: "v1", new_sqlite_classes: ["CollaborationRoom"] }],
    browser: { binding: "BROWSER" },
    vars: variables(targets.production),
    env: {
      staging: targetEnvironment(targets.staging),
      production: targetEnvironment(targets.production),
    },
    observability: {
      enabled: true,
      logs: { enabled: true, head_sampling_rate: 0.1 },
      traces: { enabled: true, head_sampling_rate: 0.01 },
    },
  };
  const configBytes = `${JSON.stringify(config, null, 2)}\n`;
  writeFileSync(configPath, configBytes);
  const selected = targets[environment];
  const input: PrepareWorkerArtifactsInput = {
    artifactDirectory,
    environment,
    productionWorkerName: targets.production.workerName,
    repositoryRoot,
    sourceConfigSha256: hash(configBytes),
    target: {
      accountId: "account-123",
      workerName: selected.workerName,
      wranglerEnvironment: environment,
      wranglerConfigPath: configRelativePath,
      expectedNonSecretVariables: variables(selected),
      requiredSecretNames: ["TICKET_HMAC_SECRET", "ADMIN_TOKEN"],
    },
  };
  return { artifactDirectory, config, configPath, input, parent };
};

const successfulRunner =
  (
    calls: Array<{
      args: readonly string[];
      env: Readonly<Record<string, string>>;
      executable: string;
    }>,
  ): WorkerArtifactCommandRunner =>
  async (executable, args, env) => {
    calls.push({ executable, args, env });
    const outdirIndex = args.indexOf("--outdir");
    const outdir = args[outdirIndex + 1];
    if (outdirIndex === -1 || outdir === undefined) {
      return { exitCode: 1, stdout: "", stderr: SECRET_SENTINEL };
    }
    mkdirSync(outdir, { recursive: true });
    writeFileSync(join(outdir, "README.md"), "This folder contains the built output assets");
    writeFileSync(
      join(outdir, "index.js"),
      "export default { fetch() { return new Response(); } };\n",
    );
    writeFileSync(join(outdir, "index.js.map"), "{}\n");
    return { exitCode: 0, stdout: "dry run complete", stderr: "" };
  };

const makeWritable = (directory: string): void => {
  chmodSync(directory, 0o700);
  for (const child of ["bundle", "config"]) {
    const path = join(directory, child);
    chmodSync(path, 0o700);
  }
};

describe("worker artifact preparation", () => {
  it.each(["staging", "production"] as const)(
    "prepares and verifies a sealed %s artifact with the exact dry-run grammar",
    async (environment) => {
      const fixture = createFixture(environment);
      const calls: Parameters<typeof successfulRunner>[0] = [];
      process.env.STAGE_TEST_SECRET = SECRET_SENTINEL;
      try {
        const prepared = await prepareWorkerArtifacts(fixture.input, {
          run: successfulRunner(calls),
        });
        expect(calls).toHaveLength(1);
        expect(calls[0]?.args).toEqual([
          "deploy",
          "--dry-run",
          "--config",
          fixture.configPath,
          "--env",
          environment,
          "--env-file",
          expect.stringContaining(".home-"),
          "--outdir",
          expect.stringContaining("/bundle"),
          "--strict",
        ]);
        expect(calls[0]?.executable).toBe(
          join(fixture.input.repositoryRoot, "node_modules/.bin/wrangler"),
        );
        expect(calls[0]?.env).not.toHaveProperty("STAGE_TEST_SECRET");
        expect(calls[0]?.env).not.toHaveProperty("CLOUDFLARE_API_TOKEN");
        expect(calls[0]?.env).not.toHaveProperty("CLOUDFLARE_ACCOUNT_ID");

        const manifest = await verifyWorkerArtifacts(fixture.input, prepared);
        expect(manifest.target).toMatchObject({
          environment,
          workerName: fixture.input.target.workerName,
          wranglerEnvironment: environment,
        });
        expect(manifest.files.map(({ path }) => path)).toEqual([
          "bundle/index.js",
          "bundle/index.js.map",
          "config/wrangler.json",
        ]);
        expect(
          readFileSync(join(fixture.artifactDirectory, "worker-artifact.json"), "utf8"),
        ).not.toContain(SECRET_SENTINEL);
        const upload = JSON.parse(
          readFileSync(join(fixture.artifactDirectory, "config/wrangler.json"), "utf8"),
        ) as Record<string, unknown>;
        expect(upload).not.toHaveProperty("env");
        expect(upload).toMatchObject({
          name: fixture.input.target.workerName,
          no_bundle: true,
          find_additional_modules: true,
          migrations: [{ tag: "v1", new_sqlite_classes: ["CollaborationRoom"] }],
          vars: fixture.input.target.expectedNonSecretVariables,
        });
        expect(statSync(fixture.artifactDirectory).mode & 0o777).toBe(0o500);
      } finally {
        delete process.env.STAGE_TEST_SECRET;
        if (existsSync(fixture.artifactDirectory)) makeWritable(fixture.artifactDirectory);
        rmSync(fixture.parent, { recursive: true, force: true });
      }
    },
  );

  it("detects artifact and source changes", async () => {
    const fixture = createFixture();
    try {
      const prepared = await prepareWorkerArtifacts(fixture.input, {
        run: successfulRunner([]),
      });
      makeWritable(fixture.artifactDirectory);
      chmodSync(join(fixture.artifactDirectory, "bundle/index.js"), 0o600);
      writeFileSync(join(fixture.artifactDirectory, "bundle/index.js"), "tampered\n");
      await expect(verifyWorkerArtifacts(fixture.input, prepared)).rejects.toMatchObject({
        kind: "artifact",
      });

      writeFileSync(fixture.configPath, `${JSON.stringify(fixture.config)}\nchanged\n`);
      await expect(verifyWorkerArtifacts(fixture.input, prepared)).rejects.toMatchObject({
        kind: "source-drift",
      });
    } finally {
      rmSync(fixture.parent, { recursive: true, force: true });
    }
  });

  it.each([
    [
      "changed migration",
      (config: Record<string, unknown>) => {
        config.migrations = [{ tag: "v2", new_sqlite_classes: ["CollaborationRoom"] }];
      },
    ],
    [
      "service binding",
      (config: Record<string, unknown>) => {
        const env = config.env as Record<string, Record<string, unknown>>;
        env.staging.services = [{ binding: "UPSTREAM", service: "other-worker" }];
      },
    ],
    [
      "assets",
      (config: Record<string, unknown>) => {
        const env = config.env as Record<string, Record<string, unknown>>;
        env.staging.assets = { directory: "./public" };
      },
    ],
  ] as const)("blocks unsupported %s config before invoking Wrangler", async (_name, mutate) => {
    const fixture = createFixture();
    let called = false;
    try {
      mutate(fixture.config as Record<string, unknown>);
      const bytes = `${JSON.stringify(fixture.config, null, 2)}\n`;
      writeFileSync(fixture.configPath, bytes);
      fixture.input.sourceConfigSha256 = hash(bytes);
      const attempt = prepareWorkerArtifacts(fixture.input, {
        run: async () => {
          called = true;
          return { exitCode: 0, stdout: "", stderr: "" };
        },
      });
      await expect(attempt).rejects.toMatchObject({ kind: "configuration" });
      expect(called).toBe(false);
    } finally {
      rmSync(fixture.parent, { recursive: true, force: true });
    }
  });

  it("does not expose Wrangler output and never overwrites an artifact", async () => {
    const fixture = createFixture();
    try {
      const failed = prepareWorkerArtifacts(fixture.input, {
        run: async () => ({ exitCode: 1, stdout: SECRET_SENTINEL, stderr: SECRET_SENTINEL }),
      });
      await expect(failed).rejects.toEqual(new WorkerArtifactError("operation"));
      await expect(failed).rejects.not.toThrow(SECRET_SENTINEL);

      mkdirSync(fixture.artifactDirectory);
      const blocked = prepareWorkerArtifacts(fixture.input, { run: successfulRunner([]) });
      await expect(blocked).rejects.toMatchObject({ kind: "invalid-input" });
    } finally {
      rmSync(fixture.parent, { recursive: true, force: true });
    }
  });
});
