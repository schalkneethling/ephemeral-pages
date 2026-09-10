import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { chmod, mkdtemp, open, readFile, rename, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

import { z } from "zod/v4";

import {
  bootstrapStagingWorker,
  recoverPendingStagingWorker,
  WorkerBootstrapError,
  type WorkerBootstrapCheckpoint,
  type WorkerBootstrapCommandResult,
  type WorkerBootstrapCommandRunner,
  type WorkerBootstrapInput,
  type WorkerBootstrapStore,
} from "./worker-bootstrap.ts";

const repositoryRoot = fileURLToPath(new URL("../..", import.meta.url));
const WRANGLER_VERSION = "4.125.0";
const MAX_INPUT_BYTES = 64 * 1024;
const MAX_CHECKPOINT_BYTES = 16 * 1024;
const MAX_COMMAND_OUTPUT_BYTES = 1024 * 1024;
const COMMAND_TIMEOUT_MS = 120_000;
const OPERATION_DEADLINE_MS = 240_000;
const CLOUDFLARE_PRODUCTION_API_BASE_URL = "https://api.cloudflare.com/client/v4";
const CLOUDFLARE_PRODUCTION_AUTH_DOMAIN = "dash.cloudflare.com";
const STAGING_SECRET_NAMES = [
  "STAGE_COLLABORATION_CAPABILITY_CURRENT_SECRET",
  "STAGE_COLLABORATION_TICKET_SECRET",
  "STAGE_COLLABORATION_SERVICE_TOKEN",
] as const;
const STAGING_SENSITIVE_ENV_NAMES = [...STAGING_SECRET_NAMES, "STAGE_RATE_LIMIT_SECRET"] as const;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

export const workerBootstrapUsage = `Usage:
  bun scripts/release/worker-bootstrap-cli.ts --input <path> --checkpoint <path>
  bun scripts/release/worker-bootstrap-cli.ts --input <path> --checkpoint <path> --recover-version <version-id>`;

const valueSchema = z.string().min(1).max(2_048);
const workerBootstrapFileInputSchema = z.strictObject({
  accountId: valueSchema,
  workerName: valueSchema,
  productionWorkerName: valueSchema,
  wranglerEnvironment: z.literal("staging"),
  wranglerConfigPath: valueSchema,
  expectedNonSecretVariables: z.strictObject({
    ALLOWED_ORIGINS: valueSchema,
    PAGE_CONTENT_ORIGIN: valueSchema,
    PUBLIC_WORKER_ORIGIN: valueSchema,
    TICKET_AUDIENCE: valueSchema,
  }),
});

export type WorkerBootstrapCliArguments = {
  inputPath: string;
  checkpointPath: string;
  recoverVersion: string | null;
};

export type WorkerBootstrapRunnerTarget = Pick<WorkerBootstrapInput, "accountId" | "workerName">;

export class WorkerBootstrapCliError extends Error {
  readonly kind:
    | "invalid-arguments"
    | "invalid-input"
    | "locked"
    | "operation"
    | "secrets"
    | "version";

  constructor(kind: WorkerBootstrapCliError["kind"]) {
    super("Worker bootstrap could not start safely.");
    this.name = "WorkerBootstrapCliError";
    this.kind = kind;
  }
}

const hasErrorCode = (error: unknown, code: string): boolean =>
  typeof error === "object" && error !== null && "code" in error && error.code === code;

export function parseWorkerBootstrapArguments(
  args: readonly string[],
  cwd: string,
): WorkerBootstrapCliArguments {
  let parsed;
  try {
    parsed = parseArgs({
      args,
      allowPositionals: false,
      strict: true,
      tokens: true,
      options: {
        input: { type: "string" },
        checkpoint: { type: "string" },
        "recover-version": { type: "string" },
      },
    });
  } catch {
    throw new WorkerBootstrapCliError("invalid-arguments");
  }
  const optionCounts = new Map<string, number>();
  for (const token of parsed.tokens) {
    if (token.kind === "option") {
      optionCounts.set(token.name, (optionCounts.get(token.name) ?? 0) + 1);
    }
  }
  if (
    !parsed.values.input ||
    !parsed.values.checkpoint ||
    (parsed.values["recover-version"] !== undefined &&
      !UUID.test(parsed.values["recover-version"])) ||
    [...optionCounts.values()].some((count) => count !== 1)
  ) {
    throw new WorkerBootstrapCliError("invalid-arguments");
  }
  return {
    inputPath: resolve(cwd, parsed.values.input),
    checkpointPath: resolve(cwd, parsed.values.checkpoint),
    recoverVersion: parsed.values["recover-version"] ?? null,
  };
}

const readBoundedJson = async (path: string, maxBytes: number): Promise<unknown> => {
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY);
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > maxBytes) throw new Error();
    const contents = await handle.readFile("utf8");
    if (Buffer.byteLength(contents, "utf8") > maxBytes) throw new Error();
    return JSON.parse(contents) as unknown;
  } catch {
    throw new WorkerBootstrapCliError("invalid-input");
  } finally {
    await handle?.close();
  }
};

const repositoryPath = (path: string): string | null => {
  const candidate = relative(repositoryRoot, path);
  if (!candidate || candidate === ".." || candidate.startsWith(`..${sep}`)) return null;
  return candidate;
};

const isInsideRepository = (path: string): boolean => {
  const candidate = relative(repositoryRoot, path);
  return candidate === "" || (!candidate.startsWith(`..${sep}`) && candidate !== "..");
};

const loadInput = async (path: string): Promise<WorkerBootstrapInput> => {
  const parsed = workerBootstrapFileInputSchema.safeParse(
    await readBoundedJson(path, MAX_INPUT_BYTES),
  );
  if (!parsed.success || isAbsolute(parsed.data.wranglerConfigPath)) {
    throw new WorkerBootstrapCliError("invalid-input");
  }
  const configPath = resolve(repositoryRoot, parsed.data.wranglerConfigPath);
  if (repositoryPath(configPath) === null) throw new WorkerBootstrapCliError("invalid-input");
  return { ...parsed.data, wranglerConfigPath: configPath };
};

export const assertPinnedWranglerVersion = async (): Promise<void> => {
  try {
    const manifest = JSON.parse(
      await readFile(resolve(repositoryRoot, "node_modules/wrangler/package.json"), "utf8"),
    ) as unknown;
    if (
      typeof manifest !== "object" ||
      manifest === null ||
      !("version" in manifest) ||
      manifest.version !== WRANGLER_VERSION
    ) {
      throw new Error();
    }
  } catch {
    throw new WorkerBootstrapCliError("version");
  }
};

export function createAtomicWorkerBootstrapStore(path: string): WorkerBootstrapStore {
  return {
    load: async () => {
      try {
        return (await readBoundedJson(path, MAX_CHECKPOINT_BYTES)) as WorkerBootstrapCheckpoint;
      } catch (error) {
        if (error instanceof WorkerBootstrapCliError && error.kind === "invalid-input") {
          try {
            await open(path, constants.O_RDONLY).then((handle) => handle.close());
          } catch (openError) {
            if (hasErrorCode(openError, "ENOENT")) return null;
          }
        }
        throw error;
      }
    },
    save: async (checkpoint) => {
      const temporaryPath = `${path}.tmp-${process.pid}`;
      let handle;
      try {
        handle = await open(
          temporaryPath,
          constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
          0o600,
        );
        await handle.writeFile(`${JSON.stringify(checkpoint)}\n`, "utf8");
        await handle.sync();
        await handle.close();
        handle = undefined;
        await rename(temporaryPath, path);
        const directory = await open(dirname(path), constants.O_RDONLY);
        try {
          await directory.sync();
        } finally {
          await directory.close();
        }
      } catch {
        await handle?.close();
        await unlink(temporaryPath).catch(() => undefined);
        throw new WorkerBootstrapCliError("invalid-input");
      }
    },
  };
}

const withExclusiveLock = async <T>(path: string, operation: () => Promise<T>): Promise<T> => {
  const lockPath = `${path}.lock`;
  let lock;
  try {
    lock = await open(lockPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
    await lock.writeFile(`${process.pid}\n`, "utf8");
  } catch (error) {
    await lock?.close();
    if (lock !== undefined) await unlink(lockPath).catch(() => undefined);
    throw new WorkerBootstrapCliError(hasErrorCode(error, "EEXIST") ? "locked" : "invalid-input");
  }
  try {
    return await operation();
  } finally {
    await lock.close().catch(() => undefined);
    await unlink(lockPath).catch(() => undefined);
  }
};

export const createBoundedWorkerRunner = (
  target: WorkerBootstrapRunnerTarget,
): WorkerBootstrapCommandRunner => {
  const deadline = Date.now() + OPERATION_DEADLINE_MS;
  return async (executable, args, environment) => {
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) throw new WorkerBootstrapCliError("operation");
    return new Promise((resolvePromise, reject) => {
      const childEnvironment = { ...process.env };
      for (const name of STAGING_SENSITIVE_ENV_NAMES) delete childEnvironment[name];
      Object.assign(childEnvironment, environment);
      Object.assign(childEnvironment, {
        CF_API_BASE_URL: CLOUDFLARE_PRODUCTION_API_BASE_URL,
        CLOUDFLARE_ACCOUNT_ID: target.accountId,
        CLOUDFLARE_API_BASE_URL: CLOUDFLARE_PRODUCTION_API_BASE_URL,
        WRANGLER_API_ENVIRONMENT: "production",
        WRANGLER_AUTH_DOMAIN: CLOUDFLARE_PRODUCTION_AUTH_DOMAIN,
        WRANGLER_AUTH_URL: `https://${CLOUDFLARE_PRODUCTION_AUTH_DOMAIN}/oauth2/auth`,
        WRANGLER_CI_OVERRIDE_NAME: target.workerName,
        WRANGLER_LOG_SANITIZE: "true",
        WRANGLER_REVOKE_URL: `https://${CLOUDFLARE_PRODUCTION_AUTH_DOMAIN}/oauth2/revoke`,
        WRANGLER_TOKEN_URL: `https://${CLOUDFLARE_PRODUCTION_AUTH_DOMAIN}/oauth2/token`,
        WRANGLER_WRITE_LOGS: "false",
      });
      const detached = process.platform !== "win32";
      const child = spawn(executable, args, {
        cwd: repositoryRoot,
        detached,
        env: childEnvironment,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
      });
      const output = { stdout: [] as Buffer[], stderr: [] as Buffer[] };
      let bytes = 0;
      let settled = false;
      const terminate = () => {
        if (detached && child.pid) {
          try {
            process.kill(-child.pid, "SIGKILL");
            return;
          } catch {
            // Fall through if the process group has already exited.
          }
        }
        child.kill("SIGKILL");
      };
      const finish = (result?: WorkerBootstrapCommandResult) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (result) resolvePromise(result);
        else reject(new WorkerBootstrapCliError("operation"));
      };
      const capture = (stream: "stdout" | "stderr", chunk: Buffer) => {
        if (settled) return;
        bytes += chunk.byteLength;
        if (bytes > MAX_COMMAND_OUTPUT_BYTES) {
          terminate();
          finish();
        } else {
          output[stream].push(chunk);
        }
      };
      child.stdout.on("data", (chunk: Buffer) => capture("stdout", chunk));
      child.stderr.on("data", (chunk: Buffer) => capture("stderr", chunk));
      child.once("error", () => finish());
      child.once("close", (exitCode) =>
        finish({
          exitCode,
          stdout: Buffer.concat(output.stdout).toString("utf8"),
          stderr: Buffer.concat(output.stderr).toString("utf8"),
        }),
      );
      const timer = setTimeout(
        () => {
          terminate();
          finish();
        },
        Math.min(COMMAND_TIMEOUT_MS, remainingMs),
      );
    });
  };
};

export const withStagingSecretsFile = async <T>(
  operation: (path: string) => Promise<T>,
): Promise<T> => {
  // Validate the shared staging capability secret even though only Netlify consumes it.
  const secrets = Object.fromEntries(STAGING_SECRET_NAMES.map((name) => [name, process.env[name]]));
  const values = Object.values(secrets);
  if (
    values.some((value) => typeof value !== "string" || Buffer.byteLength(value, "utf8") < 32) ||
    new Set(values).size !== values.length
  ) {
    throw new WorkerBootstrapCliError("secrets");
  }
  const directory = await mkdtemp(resolve(tmpdir(), "ephemeral-worker-bootstrap-"));
  const path = resolve(directory, "secrets.json");
  try {
    if (isInsideRepository(directory)) throw new WorkerBootstrapCliError("secrets");
    await chmod(directory, 0o700);
    await writeFile(
      path,
      `${JSON.stringify({ TICKET_HMAC_SECRET: secrets.STAGE_COLLABORATION_TICKET_SECRET, ADMIN_TOKEN: secrets.STAGE_COLLABORATION_SERVICE_TOKEN })}\n`,
      { encoding: "utf8", flag: "wx", mode: 0o600 },
    );
    return await operation(path);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
};

type WorkerBootstrapCliReport = {
  schemaVersion: 1;
  operation: "staging-worker-bootstrap";
  outcome: "complete";
  accountId: string;
  workerName: string;
  versionId: string;
  deploymentId: string;
  inputFingerprint: string;
};

export async function runWorkerBootstrapCli(
  args: readonly string[],
  cwd = process.cwd(),
): Promise<WorkerBootstrapCliReport> {
  const parsed = parseWorkerBootstrapArguments(args, cwd);
  await assertPinnedWranglerVersion();
  return withExclusiveLock(parsed.checkpointPath, async () => {
    const input = await loadInput(parsed.inputPath);
    const dependencies = {
      run: createBoundedWorkerRunner(input),
      store: createAtomicWorkerBootstrapStore(parsed.checkpointPath),
      withSecretsFile: withStagingSecretsFile,
    };
    const result = parsed.recoverVersion
      ? await recoverPendingStagingWorker(input, parsed.recoverVersion, dependencies)
      : await bootstrapStagingWorker(input, dependencies);
    return {
      schemaVersion: 1,
      operation: "staging-worker-bootstrap",
      outcome: "complete",
      ...result,
    };
  });
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (invokedDirectly) {
  try {
    process.stdout.write(`${JSON.stringify(await runWorkerBootstrapCli(process.argv.slice(2)))}\n`);
  } catch (error) {
    const reason =
      error instanceof WorkerBootstrapCliError
        ? error.kind
        : error instanceof WorkerBootstrapError
          ? error.kind
          : "invalid-input";
    process.stdout.write(
      `${JSON.stringify({
        schemaVersion: 1,
        operation: "staging-worker-bootstrap",
        outcome: "blocked",
        reason,
      })}\n`,
    );
    if (error instanceof WorkerBootstrapCliError && error.kind === "invalid-arguments") {
      process.stderr.write(`${workerBootstrapUsage}\n`);
    }
    process.exitCode = 1;
  }
}
