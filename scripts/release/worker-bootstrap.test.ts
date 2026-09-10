import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  bootstrapStagingWorker,
  recoverPendingStagingWorker,
  workerBootstrapFingerprint,
  type WorkerBootstrapCheckpoint,
  type WorkerBootstrapDependencies,
  type WorkerBootstrapInput,
} from "./worker-bootstrap.ts";
import {
  assertPinnedWranglerVersion,
  createBoundedWorkerRunner,
  parseWorkerBootstrapArguments,
  withStagingSecretsFile,
} from "./worker-bootstrap-cli.ts";

const SECRET_SENTINEL = "worker-bootstrap-secret-sentinel-must-not-escape";
const VERSION_ID = "11111111-2222-3333-4444-555555555555";
const DEPLOYMENT_ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

const createFixture = () => {
  const directory = mkdtempSync(join(tmpdir(), "worker-bootstrap-config-"));
  const configPath = join(directory, "wrangler.jsonc");
  const expectedNonSecretVariables = {
    ALLOWED_ORIGINS: "https://ephemeral-pages-staging.netlify.app",
    PAGE_CONTENT_ORIGIN: "https://ephemeral-pages-staging.netlify.app",
    PUBLIC_WORKER_ORIGIN: "https://ephemeral-pages-collaboration-staging.example.workers.dev",
    TICKET_AUDIENCE: "ephemeral-pages-collaboration-staging",
  };
  const environment = (name: string, vars: Record<string, string>) => ({
    name,
    workers_dev: true,
    secrets: { required: ["TICKET_HMAC_SECRET", "ADMIN_TOKEN"] },
    durable_objects: {
      bindings: [{ name: "COLLABORATION_ROOMS", class_name: "CollaborationRoom" }],
    },
    browser: { binding: "BROWSER" },
    vars,
  });
  writeFileSync(
    configPath,
    JSON.stringify({
      name: "ephemeral-pages-collaboration",
      main: "worker.ts",
      compatibility_date: "2026-08-23",
      secrets: { required: ["TICKET_HMAC_SECRET", "ADMIN_TOKEN"] },
      durable_objects: {
        bindings: [{ name: "COLLABORATION_ROOMS", class_name: "CollaborationRoom" }],
      },
      browser: { binding: "BROWSER" },
      migrations: [{ tag: "v1", new_sqlite_classes: ["CollaborationRoom"] }],
      vars: expectedNonSecretVariables,
      env: {
        production: environment("ephemeral-pages-collaboration", {
          ...expectedNonSecretVariables,
          TICKET_AUDIENCE: "ephemeral-pages-collaboration",
        }),
        staging: environment("ephemeral-pages-collaboration-staging", expectedNonSecretVariables),
      },
    }),
  );
  const input: WorkerBootstrapInput = {
    accountId: "account-123",
    workerName: "ephemeral-pages-collaboration-staging",
    productionWorkerName: "ephemeral-pages-collaboration",
    wranglerEnvironment: "staging",
    wranglerConfigPath: configPath,
    expectedNonSecretVariables,
  };
  return { directory, input };
};

const successfulVersion = (input: WorkerBootstrapInput) => ({
  id: VERSION_ID,
  annotations: { "workers/message": `staging-bootstrap:${workerBootstrapFingerprint(input)}` },
  resources: {
    bindings: [
      ...Object.entries(input.expectedNonSecretVariables).map(([name, text]) => ({
        name,
        type: "plain_text",
        text,
      })),
      { name: "TICKET_HMAC_SECRET", type: "secret_text", text: SECRET_SENTINEL },
      { name: "ADMIN_TOKEN", type: "secret_text", text: SECRET_SENTINEL },
      { name: "UNRELATED", type: "plain_text", text: SECRET_SENTINEL },
    ],
  },
});

const harness = (input: WorkerBootstrapInput, initial: WorkerBootstrapCheckpoint | null = null) => {
  let checkpoint = initial;
  let secretsFileUses = 0;
  const calls: Array<{
    args: readonly string[];
    env: Readonly<Record<string, string>>;
    phase: WorkerBootstrapCheckpoint["phase"] | null;
  }> = [];
  const saved: WorkerBootstrapCheckpoint[] = [];
  const dependencies: WorkerBootstrapDependencies = {
    store: {
      load: async () => checkpoint,
      save: async (value) => {
        checkpoint = structuredClone(value);
        saved.push(structuredClone(value));
      },
    },
    withSecretsFile: async (operation) => {
      secretsFileUses += 1;
      return operation("/secure/temporary/secrets.json");
    },
    run: async (_executable, args, env) => {
      calls.push({ args, env, phase: checkpoint?.phase ?? null });
      if (args[0] === "deploy" && args.length > 1) {
        return { exitCode: 0, stdout: `Current Version ID: ${VERSION_ID}\n`, stderr: "" };
      }
      if (args[0] === "versions") {
        return { exitCode: 0, stdout: JSON.stringify(successfulVersion(input)), stderr: "" };
      }
      if (checkpoint?.phase === "version-returned") {
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            id: DEPLOYMENT_ID,
            versions: [{ version_id: VERSION_ID, percentage: 100 }],
            author_email: SECRET_SENTINEL,
          }),
          stderr: "",
        };
      }
      return {
        exitCode: 1,
        stdout: "",
        stderr: `Worker missing [code: 10007] ${SECRET_SENTINEL}`,
      };
    },
  };
  return {
    calls,
    dependencies,
    saved,
    get checkpoint() {
      return checkpoint;
    },
    get secretsFileUses() {
      return secretsFileUses;
    },
  };
};

describe("bootstrapStagingWorker", () => {
  it("confirms absence, checkpoints before deploy, and records inspected IDs", async () => {
    const fixture = createFixture();
    try {
      const state = harness(fixture.input);
      const result = await bootstrapStagingWorker(fixture.input, state.dependencies);
      expect(result).toEqual({
        status: "complete",
        accountId: "account-123",
        workerName: "ephemeral-pages-collaboration-staging",
        versionId: VERSION_ID,
        deploymentId: DEPLOYMENT_ID,
        inputFingerprint: workerBootstrapFingerprint(fixture.input),
      });
      expect(JSON.stringify(result)).not.toContain(SECRET_SENTINEL);
      expect(
        state.calls.map(({ args, phase }) => [
          args[0] === "deploy" ? args.slice(0, 1) : args.slice(0, 2),
          phase,
        ]),
      ).toEqual([
        [["deployments", "status"], null],
        [["deploy"], "pending-worker-deployment"],
        [["versions", "view"], "version-returned"],
        [["deployments", "status"], "version-returned"],
      ]);
      expect(state.calls[1]?.args).toEqual([
        "deploy",
        "--config",
        fixture.input.wranglerConfigPath,
        "--env",
        "staging",
        "--secrets-file",
        "/secure/temporary/secrets.json",
        "--message",
        `staging-bootstrap:${workerBootstrapFingerprint(fixture.input)}`,
      ]);
      const commonArgs = [
        "--name",
        fixture.input.workerName,
        "--config",
        fixture.input.wranglerConfigPath,
        "--env",
        "staging",
      ];
      expect(state.calls[0]?.args).toEqual(["deployments", "status", ...commonArgs, "--json"]);
      expect(state.calls[2]?.args).toEqual([
        "versions",
        "view",
        VERSION_ID,
        ...commonArgs,
        "--json",
      ]);
      expect(state.calls[3]?.args).toEqual(["deployments", "status", ...commonArgs, "--json"]);
      expect(state.saved.map(({ phase }) => phase)).toEqual([
        "pending-worker-deployment",
        "version-returned",
        "version-returned",
        "complete",
      ]);
      expect(state.secretsFileUses).toBe(1);
      expect(
        state.calls.every(
          ({ env }) =>
            JSON.stringify(env) ===
            JSON.stringify({ CLOUDFLARE_ACCOUNT_ID: "account-123", CI: "1", NO_COLOR: "1" }),
        ),
      ).toBe(true);
    } finally {
      rmSync(fixture.directory, { recursive: true, force: true });
    }
  });

  it("blocks unknown or existing preflight state before secrets or mutation", async () => {
    const fixture = createFixture();
    try {
      for (const result of [
        { exitCode: 0, stdout: "{}", stderr: "" },
        { exitCode: 1, stdout: "", stderr: `unknown ${SECRET_SENTINEL} [code: 9109]` },
        { exitCode: null, stdout: "", stderr: "Worker missing [code: 10007]" },
      ]) {
        const state = harness(fixture.input);
        state.dependencies.run = async () => result;
        const attempt = bootstrapStagingWorker(fixture.input, state.dependencies);
        await expect(attempt).rejects.toThrow();
        await expect(attempt).rejects.not.toThrow(SECRET_SENTINEL);
        expect(state.saved).toEqual([]);
        expect(state.secretsFileUses).toBe(0);
      }
    } finally {
      rmSync(fixture.directory, { recursive: true, force: true });
    }
  });

  it("leaves an ambiguous deploy pending and requires version-based recovery", async () => {
    const fixture = createFixture();
    try {
      const state = harness(fixture.input);
      const baseRun = state.dependencies.run;
      state.dependencies.run = async (executable, args, env) => {
        if (args[0] === "deploy") throw new Error(SECRET_SENTINEL);
        return baseRun(executable, args, env);
      };
      await expect(bootstrapStagingWorker(fixture.input, state.dependencies)).rejects.toThrow(
        "Worker bootstrap operation did not complete.",
      );
      expect(state.checkpoint?.phase).toBe("pending-worker-deployment");
      const callCount = state.calls.length;
      await expect(bootstrapStagingWorker(fixture.input, state.dependencies)).rejects.toThrow(
        "Worker bootstrap is blocked pending operator inspection.",
      );
      expect(state.calls).toHaveLength(callCount);

      state.dependencies.run = baseRun;
      const recovered = await recoverPendingStagingWorker(
        fixture.input,
        VERSION_ID,
        state.dependencies,
      );
      expect(recovered.versionId).toBe(VERSION_ID);
      expect(state.secretsFileUses).toBe(1);
    } finally {
      rmSync(fixture.directory, { recursive: true, force: true });
    }
  });

  it("does not create a pending mutation when secret preparation fails", async () => {
    const fixture = createFixture();
    try {
      const state = harness(fixture.input);
      state.dependencies.withSecretsFile = async () => {
        throw new Error(SECRET_SENTINEL);
      };
      const attempt = bootstrapStagingWorker(fixture.input, state.dependencies);
      await expect(attempt).rejects.toThrow("Worker bootstrap operation did not complete.");
      await expect(attempt).rejects.not.toThrow(SECRET_SENTINEL);
      expect(state.saved).toEqual([]);
      expect(state.calls.map(({ args }) => args.slice(0, 2))).toEqual([["deployments", "status"]]);
    } finally {
      rmSync(fixture.directory, { recursive: true, force: true });
    }
  });

  it("rejects configuration drift before provider commands", async () => {
    const fixture = createFixture();
    try {
      const state = harness(fixture.input);
      await expect(
        bootstrapStagingWorker(
          {
            ...fixture.input,
            expectedNonSecretVariables: {
              ...fixture.input.expectedNonSecretVariables,
              ALLOWED_ORIGINS: "https://wrong.example.com",
              PAGE_CONTENT_ORIGIN: "https://wrong.example.com",
            },
          },
          state.dependencies,
        ),
      ).rejects.toThrow("Worker bootstrap configuration is invalid.");
      expect(state.calls).toEqual([]);
    } finally {
      rmSync(fixture.directory, { recursive: true, force: true });
    }
  });
});

describe("worker bootstrap CLI primitives", () => {
  it("parses only the documented command grammar", () => {
    expect(
      parseWorkerBootstrapArguments(
        ["--input", "worker.json", "--checkpoint", "worker.state"],
        "/work",
      ),
    ).toEqual({
      inputPath: "/work/worker.json",
      checkpointPath: "/work/worker.state",
      recoverVersion: null,
    });
    expect(() =>
      parseWorkerBootstrapArguments(
        ["--input", "one", "--input", "two", "--checkpoint", "state"],
        "/work",
      ),
    ).toThrow("Worker bootstrap could not start safely.");
    expect(() =>
      parseWorkerBootstrapArguments(
        ["--input", "one", "--checkpoint", "state", "--recover-version", "not-a-version"],
        "/work",
      ),
    ).toThrow("Worker bootstrap could not start safely.");
    expect(() =>
      parseWorkerBootstrapArguments(
        ["--input", "one", "--checkpoint", "state", "--secret", SECRET_SENTINEL],
        "/work",
      ),
    ).toThrow("Worker bootstrap could not start safely.");
  });

  it("keeps staging values in a temporary mode-0600 file and scrubs child env", async () => {
    const previous = Object.fromEntries(
      [
        "STAGE_COLLABORATION_CAPABILITY_CURRENT_SECRET",
        "STAGE_COLLABORATION_TICKET_SECRET",
        "STAGE_COLLABORATION_SERVICE_TOKEN",
        "STAGE_RATE_LIMIT_SECRET",
      ].map((name) => [name, process.env[name]]),
    );
    process.env.STAGE_COLLABORATION_CAPABILITY_CURRENT_SECRET = `a${"1".repeat(40)}`;
    process.env.STAGE_COLLABORATION_TICKET_SECRET = `b${"2".repeat(40)}`;
    process.env.STAGE_COLLABORATION_SERVICE_TOKEN = `c${"3".repeat(40)}`;
    process.env.STAGE_RATE_LIMIT_SECRET = "d".repeat(40);
    let temporaryPath = "";
    try {
      await withStagingSecretsFile(async (path) => {
        temporaryPath = path;
        expect(statSync(path).mode & 0o777).toBe(0o600);
        expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({
          TICKET_HMAC_SECRET: process.env.STAGE_COLLABORATION_TICKET_SECRET,
          ADMIN_TOKEN: process.env.STAGE_COLLABORATION_SERVICE_TOKEN,
        });
      });
      expect(existsSync(temporaryPath)).toBe(false);
      let failedPath = "";
      await expect(
        withStagingSecretsFile(async (path) => {
          failedPath = path;
          throw new Error(SECRET_SENTINEL);
        }),
      ).rejects.toThrow(SECRET_SENTINEL);
      expect(existsSync(failedPath)).toBe(false);

      const result = await createBoundedWorkerRunner({
        accountId: "account-123",
        workerName: "ephemeral-pages-collaboration-staging",
      })(
        process.execPath,
        [
          "-e",
          "process.stdout.write(String(['STAGE_COLLABORATION_CAPABILITY_CURRENT_SECRET','STAGE_COLLABORATION_TICKET_SECRET','STAGE_COLLABORATION_SERVICE_TOKEN','STAGE_RATE_LIMIT_SECRET'].some((key) => key in process.env)))",
        ],
        {},
      );
      expect(result).toEqual({ exitCode: 0, stdout: "false", stderr: "" });
    } finally {
      for (const [name, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  });

  it("pins the validated Worker target, Cloudflare endpoints, and log safety settings", async () => {
    const pinnedEnvironment = {
      CF_API_BASE_URL: "https://api.cloudflare.com/client/v4",
      CLOUDFLARE_ACCOUNT_ID: "account-123",
      CLOUDFLARE_API_BASE_URL: "https://api.cloudflare.com/client/v4",
      WRANGLER_API_ENVIRONMENT: "production",
      WRANGLER_AUTH_DOMAIN: "dash.cloudflare.com",
      WRANGLER_AUTH_URL: "https://dash.cloudflare.com/oauth2/auth",
      WRANGLER_CI_OVERRIDE_NAME: "ephemeral-pages-collaboration-staging",
      WRANGLER_LOG_SANITIZE: "true",
      WRANGLER_REVOKE_URL: "https://dash.cloudflare.com/oauth2/revoke",
      WRANGLER_TOKEN_URL: "https://dash.cloudflare.com/oauth2/token",
      WRANGLER_WRITE_LOGS: "false",
    };
    const previous = Object.fromEntries(
      Object.keys(pinnedEnvironment).map((name) => [name, process.env[name]]),
    );
    for (const name of Object.keys(pinnedEnvironment)) process.env[name] = "inherited-override";
    try {
      const result = await createBoundedWorkerRunner({
        accountId: pinnedEnvironment.CLOUDFLARE_ACCOUNT_ID,
        workerName: pinnedEnvironment.WRANGLER_CI_OVERRIDE_NAME,
      })(
        process.execPath,
        [
          "-e",
          `process.stdout.write(JSON.stringify(Object.fromEntries(${JSON.stringify(
            Object.keys(pinnedEnvironment),
          )}.map((name) => [name, process.env[name]]))))`,
        ],
        Object.fromEntries(Object.keys(pinnedEnvironment).map((name) => [name, "runner-override"])),
      );
      expect(result).toEqual({
        exitCode: 0,
        stdout: JSON.stringify(pinnedEnvironment),
        stderr: "",
      });
    } finally {
      for (const [name, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  });

  it("uses the exact pinned Wrangler package", async () => {
    await expect(assertPinnedWranglerVersion()).resolves.toBeUndefined();
  });
});
