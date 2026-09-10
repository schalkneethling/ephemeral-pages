import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, readdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import { unstable_readConfig } from "wrangler";

import type { CloudflareTarget, ReleaseEnvironment } from "./schema.ts";

export type WorkerArtifactCommandResult = {
  exitCode: number | null;
  stdout: string;
  stderr: string;
};

export type WorkerArtifactCommandRunner = (
  executable: string,
  args: readonly string[],
  env: Readonly<Record<string, string>>,
) => Promise<WorkerArtifactCommandResult>;

export type PrepareWorkerArtifactsInput = {
  artifactDirectory: string;
  environment: ReleaseEnvironment;
  productionWorkerName: string;
  repositoryRoot: string;
  sourceConfigSha256: string;
  target: CloudflareTarget;
};

export type WorkerArtifactFile = {
  bytes: number;
  path: string;
  sha256: string;
};

export type WorkerArtifactPolicy = {
  browser: { binding: "BROWSER" };
  compatibilityDate: string;
  compatibilityFlags: readonly string[];
  durableObjects: {
    bindings: readonly [
      {
        className: "CollaborationRoom";
        name: "COLLABORATION_ROOMS";
      },
    ];
  };
  migrations: readonly [
    {
      newSqliteClasses: readonly ["CollaborationRoom"];
      tag: "v1";
    },
  ];
  observability: unknown;
  requiredSecretNames: readonly ["TICKET_HMAC_SECRET", "ADMIN_TOKEN"];
  workersDev: true;
};

export type WorkerArtifactManifest = {
  schemaVersion: 1;
  wranglerVersion: "4.125.0";
  target: {
    accountId: string;
    environment: ReleaseEnvironment;
    productionWorkerName: string;
    workerName: string;
    wranglerEnvironment: string;
  };
  source: {
    configPath: string;
    configSha256: string;
  };
  uploadConfig: WorkerArtifactFile;
  entrypoint: "bundle/index.js";
  files: readonly WorkerArtifactFile[];
  policy: WorkerArtifactPolicy;
};

export type PreparedWorkerArtifacts = {
  artifactDirectory: string;
  manifest: WorkerArtifactManifest;
  manifestSha256: string;
};

export type WorkerArtifactDependencies = {
  run?: WorkerArtifactCommandRunner;
};

type JsonObject = Record<string, unknown>;

const WRANGLER_VERSION = "4.125.0" as const;
const WRANGLER_EXECUTABLE = "node_modules/.bin/wrangler";
const MANIFEST_PATH = "worker-artifact.json";
const UPLOAD_CONFIG_PATH = "config/wrangler.json";
const ENTRYPOINT_PATH = "bundle/index.js" as const;
const SHA256 = /^[0-9a-f]{64}$/u;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/u;
const MAX_FILE_BYTES = 16 * 1024 * 1024;
const MAX_TOTAL_BYTES = 64 * 1024 * 1024;
const MAX_FILES = 100;
const MAX_OUTPUT_BYTES = 1024 * 1024;
const COMMAND_TIMEOUT_MS = 120_000;
const REQUIRED_SECRETS = ["TICKET_HMAC_SECRET", "ADMIN_TOKEN"] as const;
const VARIABLE_NAMES = [
  "ALLOWED_ORIGINS",
  "PAGE_CONTENT_ORIGIN",
  "PUBLIC_WORKER_ORIGIN",
  "TICKET_AUDIENCE",
] as const;

export class WorkerArtifactError extends Error {
  readonly kind: "artifact" | "configuration" | "invalid-input" | "operation" | "source-drift";

  constructor(kind: WorkerArtifactError["kind"]) {
    const messages = {
      artifact: "Worker artifact verification failed.",
      configuration: "Worker artifact configuration is unsupported.",
      "invalid-input": "Worker artifact input is invalid.",
      operation: "Worker artifact preparation did not complete.",
      "source-drift": "Worker artifact source changed from the reviewed baseline.",
    } as const;
    super(messages[kind]);
    this.name = "WorkerArtifactError";
    this.kind = kind;
  }
}

const isObject = (value: unknown): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const sha256 = (value: Buffer | string): string => createHash("sha256").update(value).digest("hex");

const stableValue = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(stableValue);
  if (isObject(value)) {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, stableValue(item)]),
    );
  }
  return value;
};

const jsonBytes = (value: unknown): Buffer =>
  Buffer.from(`${JSON.stringify(stableValue(value), null, 2)}\n`, "utf8");

const within = (parent: string, child: string): boolean => {
  const path = relative(parent, child);
  return path === "" || (!path.startsWith(`..${sep}`) && path !== "..");
};

const safeRelativePath = (value: string): boolean =>
  value.length > 0 &&
  value.length <= 1_024 &&
  !isAbsolute(value) &&
  !value.includes("\\") &&
  value.split("/").every((part) => part.length > 0 && part !== "." && part !== "..");

const readRegularFile = async (path: string, maxBytes = MAX_FILE_BYTES): Promise<Buffer> => {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile() || metadata.size > maxBytes) throw new WorkerArtifactError("artifact");
    return await handle.readFile();
  } finally {
    await handle.close();
  }
};

const assertDirectory = async (path: string): Promise<void> => {
  const metadata = await lstat(path);
  if (!metadata.isDirectory() || metadata.isSymbolicLink())
    throw new WorkerArtifactError("artifact");
};

const exactStringArray = (value: unknown, expected: readonly string[]): value is string[] =>
  Array.isArray(value) &&
  value.length === expected.length &&
  value.every((item, index) => item === expected[index]);

const isInactive = (value: unknown): boolean => {
  if (value === undefined || value === null || value === false) return true;
  if (Array.isArray(value)) return value.length === 0;
  if (isObject(value)) return Object.values(value).every(isInactive);
  return false;
};

const isHttpsOrigin = (value: string): boolean => {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.origin === value;
  } catch {
    return false;
  }
};

const validateInput = (input: PrepareWorkerArtifactsInput): void => {
  const repositoryRoot = resolve(input.repositoryRoot);
  const configPath = resolve(repositoryRoot, input.target.wranglerConfigPath);
  const artifactDirectory = resolve(input.artifactDirectory);
  const variables = Object.entries(input.target.expectedNonSecretVariables);
  if (
    !isAbsolute(input.repositoryRoot) ||
    !isAbsolute(input.artifactDirectory) ||
    !safeRelativePath(input.target.wranglerConfigPath) ||
    !within(repositoryRoot, configPath) ||
    within(repositoryRoot, artifactDirectory) ||
    configPath === repositoryRoot ||
    artifactDirectory === dirname(artifactDirectory) ||
    !SHA256.test(input.sourceConfigSha256) ||
    !IDENTIFIER.test(input.target.accountId) ||
    !IDENTIFIER.test(input.target.workerName) ||
    !IDENTIFIER.test(input.productionWorkerName) ||
    (input.environment !== "staging" && input.environment !== "production") ||
    input.target.wranglerEnvironment !== input.environment ||
    (input.environment === "production"
      ? input.target.workerName !== input.productionWorkerName
      : input.target.workerName === input.productionWorkerName) ||
    variables.length !== VARIABLE_NAMES.length ||
    !VARIABLE_NAMES.every(
      (name) =>
        typeof input.target.expectedNonSecretVariables[name] === "string" &&
        input.target.expectedNonSecretVariables[name].length > 0 &&
        input.target.expectedNonSecretVariables[name].length <= 2_048,
    ) ||
    input.target.expectedNonSecretVariables.ALLOWED_ORIGINS !==
      input.target.expectedNonSecretVariables.PAGE_CONTENT_ORIGIN ||
    input.target.expectedNonSecretVariables.TICKET_AUDIENCE !== input.target.workerName ||
    !isHttpsOrigin(input.target.expectedNonSecretVariables.ALLOWED_ORIGINS) ||
    !isHttpsOrigin(input.target.expectedNonSecretVariables.PUBLIC_WORKER_ORIGIN) ||
    !new URL(input.target.expectedNonSecretVariables.PUBLIC_WORKER_ORIGIN).hostname.startsWith(
      `${input.target.workerName}.`,
    ) ||
    !exactStringArray(input.target.requiredSecretNames, REQUIRED_SECRETS)
  ) {
    throw new WorkerArtifactError("invalid-input");
  }
};

const parsePolicy = (input: PrepareWorkerArtifactsInput): WorkerArtifactPolicy => {
  try {
    const configPath = resolve(input.repositoryRoot, input.target.wranglerConfigPath);
    const base = unstable_readConfig({ config: configPath }, { hideWarnings: true }) as unknown;
    const production = unstable_readConfig(
      { config: configPath, env: "production" },
      { hideWarnings: true },
    ) as unknown;
    const selected = unstable_readConfig(
      { config: configPath, env: input.target.wranglerEnvironment },
      { hideWarnings: true },
    ) as unknown;
    if (!isObject(base) || !isObject(production) || !isObject(selected)) throw new Error();

    const variables = selected.vars;
    const secrets = selected.secrets;
    const durableObjects = selected.durable_objects;
    const browser = selected.browser;
    const migrations = selected.migrations;
    const binding =
      isObject(durableObjects) && Array.isArray(durableObjects.bindings)
        ? durableObjects.bindings[0]
        : undefined;
    const migration = Array.isArray(migrations) ? migrations[0] : undefined;

    const explicitlyHandled = new Set([
      "account_id",
      "base_dir",
      "browser",
      "build",
      "compatibility_date",
      "compatibility_flags",
      "configPath",
      "definedEnvironments",
      "dev",
      "durable_objects",
      "jsx_factory",
      "jsx_fragment",
      "main",
      "migrations",
      "name",
      "observability",
      "python_modules",
      "secrets",
      "targetEnvironment",
      "topLevelName",
      "userConfigPath",
      "vars",
      "workers_dev",
    ]);
    const unsupportedActive = Object.entries(selected).some(
      ([name, value]) => !explicitlyHandled.has(name) && !isInactive(value),
    );
    if (
      base.name !== input.productionWorkerName ||
      production.name !== input.productionWorkerName ||
      selected.name !== input.target.workerName ||
      (base.account_id !== undefined && base.account_id !== input.target.accountId) ||
      (production.account_id !== undefined && production.account_id !== input.target.accountId) ||
      (selected.account_id !== undefined && selected.account_id !== input.target.accountId) ||
      selected.workers_dev !== true ||
      typeof selected.main !== "string" ||
      !within(resolve(input.repositoryRoot), resolve(selected.main)) ||
      typeof selected.compatibility_date !== "string" ||
      !Array.isArray(selected.compatibility_flags) ||
      !selected.compatibility_flags.every((item) => typeof item === "string") ||
      !isObject(variables) ||
      Object.keys(variables).length !== VARIABLE_NAMES.length ||
      !VARIABLE_NAMES.every(
        (name) => variables[name] === input.target.expectedNonSecretVariables[name],
      ) ||
      !isObject(secrets) ||
      Object.keys(secrets).length !== 1 ||
      !exactStringArray(secrets.required, REQUIRED_SECRETS) ||
      !isObject(durableObjects) ||
      !Array.isArray(durableObjects.bindings) ||
      durableObjects.bindings.length !== 1 ||
      !isObject(binding) ||
      Object.keys(binding).length !== 2 ||
      binding.name !== "COLLABORATION_ROOMS" ||
      binding.class_name !== "CollaborationRoom" ||
      !isObject(browser) ||
      Object.keys(browser).length !== 1 ||
      browser.binding !== "BROWSER" ||
      !Array.isArray(migrations) ||
      migrations.length !== 1 ||
      !isObject(migration) ||
      Object.keys(migration).length !== 2 ||
      migration.tag !== "v1" ||
      !exactStringArray(migration.new_sqlite_classes, ["CollaborationRoom"]) ||
      !isObject(selected.build) ||
      Object.entries(selected.build).some(
        ([key, value]) => key !== "watch_dir" && !isInactive(value),
      ) ||
      selected.build.watch_dir !== "./src" ||
      selected.base_dir !== undefined ||
      selected.jsx_factory !== "React.createElement" ||
      selected.jsx_fragment !== "React.Fragment" ||
      !isObject(selected.python_modules) ||
      !exactStringArray(selected.python_modules.exclude, ["**/*.pyc"]) ||
      unsupportedActive
    ) {
      throw new Error();
    }

    return {
      browser: { binding: "BROWSER" },
      compatibilityDate: selected.compatibility_date,
      compatibilityFlags: [...selected.compatibility_flags],
      durableObjects: {
        bindings: [{ name: "COLLABORATION_ROOMS", className: "CollaborationRoom" }],
      },
      migrations: [{ tag: "v1", newSqliteClasses: ["CollaborationRoom"] }],
      observability: stableValue(selected.observability),
      requiredSecretNames: REQUIRED_SECRETS,
      workersDev: true,
    };
  } catch {
    throw new WorkerArtifactError("configuration");
  }
};

const uploadConfig = (
  input: PrepareWorkerArtifactsInput,
  policy: WorkerArtifactPolicy,
): JsonObject => ({
  name: input.target.workerName,
  main: "../bundle/index.js",
  base_dir: "../bundle",
  compatibility_date: policy.compatibilityDate,
  compatibility_flags: policy.compatibilityFlags,
  workers_dev: true,
  no_bundle: true,
  find_additional_modules: true,
  rules: [{ type: "ESModule", globs: ["**/*.js"], fallthrough: true }],
  vars: input.target.expectedNonSecretVariables,
  secrets: { required: policy.requiredSecretNames },
  durable_objects: {
    bindings: [{ name: "COLLABORATION_ROOMS", class_name: "CollaborationRoom" }],
  },
  migrations: [{ tag: "v1", new_sqlite_classes: ["CollaborationRoom"] }],
  browser: policy.browser,
  observability: policy.observability,
});

const collectFiles = async (
  root: string,
  options: { allowManifest?: boolean } = {},
): Promise<WorkerArtifactFile[]> => {
  const files: WorkerArtifactFile[] = [];
  let totalBytes = 0;
  const visit = async (directory: string): Promise<void> => {
    await assertDirectory(directory);
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const absolutePath = join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new WorkerArtifactError("artifact");
      if (entry.isDirectory()) {
        await visit(absolutePath);
        continue;
      }
      if (!entry.isFile()) throw new WorkerArtifactError("artifact");
      const path = relative(root, absolutePath).split(sep).join("/");
      if (!safeRelativePath(path) || (!options.allowManifest && path === MANIFEST_PATH)) {
        throw new WorkerArtifactError("artifact");
      }
      const bytes = await readRegularFile(absolutePath);
      totalBytes += bytes.length;
      if (files.length >= MAX_FILES || totalBytes > MAX_TOTAL_BYTES) {
        throw new WorkerArtifactError("artifact");
      }
      files.push({ path, bytes: bytes.length, sha256: sha256(bytes) });
    }
  };
  await visit(root);
  return files.sort((left, right) => left.path.localeCompare(right.path));
};

const defaultRunner: WorkerArtifactCommandRunner = async (executable, args, env) =>
  new Promise((resolveResult) => {
    const child = spawn(executable, [...args], {
      cwd: env.WORKER_ARTIFACT_REPOSITORY_ROOT,
      detached: process.platform !== "win32",
      env: Object.fromEntries(
        Object.entries(env).filter(([name]) => name !== "WORKER_ARTIFACT_REPOSITORY_ROOT"),
      ),
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let overflow = false;
    const capture = (current: string, chunk: Buffer): string => {
      if (Buffer.byteLength(current) + chunk.length > MAX_OUTPUT_BYTES) {
        overflow = true;
        return current;
      }
      return current + chunk.toString("utf8");
    };
    child.stdout.on("data", (chunk: Buffer) => {
      stdout = capture(stdout, chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = capture(stderr, chunk);
    });
    const timer = setTimeout(() => {
      if (child.pid !== undefined) {
        try {
          process.kill(process.platform === "win32" ? child.pid : -child.pid);
        } catch {
          // The child can exit between the timeout firing and delivery of the signal.
        }
      }
    }, COMMAND_TIMEOUT_MS);
    child.once("error", () => {
      clearTimeout(timer);
      resolveResult({ exitCode: null, stdout: "", stderr: "" });
    });
    child.once("close", (exitCode) => {
      clearTimeout(timer);
      resolveResult(
        overflow ? { exitCode: null, stdout: "", stderr: "" } : { exitCode, stdout, stderr },
      );
    });
  });

const freezeTree = async (root: string): Promise<void> => {
  const entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      await freezeTree(path);
      await chmod(path, 0o500);
    } else {
      await chmod(path, 0o400);
    }
  }
  await chmod(root, 0o500);
};

const removeOwnedTree = async (root: string): Promise<void> => {
  const makeWritable = async (path: string): Promise<void> => {
    let metadata;
    try {
      metadata = await lstat(path);
    } catch {
      return;
    }
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) return;
    await chmod(path, 0o700).catch(() => undefined);
    const entries = await readdir(path, { withFileTypes: true }).catch(() => []);
    await Promise.all(
      entries
        .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink())
        .map((entry) => makeWritable(join(path, entry.name))),
    );
  };
  await makeWritable(root);
  await rm(root, { recursive: true, force: true });
};

const assertPinnedWrangler = async (repositoryRoot: string): Promise<void> => {
  try {
    const bytes = await readRegularFile(
      join(repositoryRoot, "node_modules/wrangler/package.json"),
      1024 * 1024,
    );
    const parsed = JSON.parse(bytes.toString("utf8")) as unknown;
    if (!isObject(parsed) || parsed.version !== WRANGLER_VERSION) throw new Error();
  } catch {
    throw new WorkerArtifactError("configuration");
  }
};

export const prepareWorkerArtifacts = async (
  input: PrepareWorkerArtifactsInput,
  dependencies: WorkerArtifactDependencies = {},
): Promise<PreparedWorkerArtifacts> => {
  validateInput(input);
  const repositoryRoot = resolve(input.repositoryRoot);
  const artifactDirectory = resolve(input.artifactDirectory);
  const sourceConfigPath = resolve(repositoryRoot, input.target.wranglerConfigPath);
  const configBytes = await readRegularFile(sourceConfigPath, 1024 * 1024).catch(() => {
    throw new WorkerArtifactError("configuration");
  });
  if (sha256(configBytes) !== input.sourceConfigSha256) {
    throw new WorkerArtifactError("source-drift");
  }
  const policy = parsePolicy(input);
  await assertPinnedWrangler(repositoryRoot);
  await mkdir(dirname(artifactDirectory), { recursive: true, mode: 0o700 });
  try {
    await mkdir(artifactDirectory, { mode: 0o700 });
  } catch {
    throw new WorkerArtifactError("invalid-input");
  }

  const operationId = randomUUID();
  const stagingDirectory = join(artifactDirectory, `.preparing-${operationId}`);
  const homeDirectory = join(
    dirname(artifactDirectory),
    `.${artifactDirectory.split(sep).at(-1)}.home-${operationId}`,
  );
  try {
    await mkdir(join(stagingDirectory, "bundle"), { recursive: true, mode: 0o700 });
    await mkdir(join(stagingDirectory, "config"), { recursive: true, mode: 0o700 });
    await mkdir(homeDirectory, { mode: 0o700 });
    const emptyEnvironmentPath = join(homeDirectory, "empty.env");
    await writeFile(emptyEnvironmentPath, "", { flag: "wx", mode: 0o400 });
    const executable = join(repositoryRoot, WRANGLER_EXECUTABLE);
    const args = [
      "deploy",
      "--dry-run",
      "--config",
      sourceConfigPath,
      "--env",
      input.target.wranglerEnvironment,
      "--env-file",
      emptyEnvironmentPath,
      "--outdir",
      join(stagingDirectory, "bundle"),
      "--strict",
    ] as const;
    const env = {
      CI: "1",
      HOME: homeDirectory,
      NO_COLOR: "1",
      PATH: process.env.PATH ?? `${dirname(process.execPath)}:/usr/bin:/bin`,
      TMPDIR: homeDirectory,
      WORKER_ARTIFACT_REPOSITORY_ROOT: repositoryRoot,
      WRANGLER_LOG_SANITIZE: "true",
      WRANGLER_WRITE_LOGS: "false",
    } as const;
    const result = await (dependencies.run ?? defaultRunner)(executable, args, env);
    if (result.exitCode !== 0 || result.stderr.length !== 0) {
      throw new WorkerArtifactError("operation");
    }
    await rm(homeDirectory, { recursive: true, force: true });

    const readmePath = join(stagingDirectory, "bundle/README.md");
    try {
      const readme = await readRegularFile(readmePath, 16 * 1024);
      if (!readme.toString("utf8").startsWith("This folder contains the built output assets")) {
        throw new WorkerArtifactError("artifact");
      }
      await rm(readmePath);
    } catch (error) {
      if (!isObject(error) || error.code !== "ENOENT") throw error;
    }

    const artifactUploadConfig = uploadConfig(input, policy);
    const uploadConfigBytes = jsonBytes(artifactUploadConfig);
    await writeFile(join(stagingDirectory, UPLOAD_CONFIG_PATH), uploadConfigBytes, {
      flag: "wx",
      mode: 0o400,
    });
    unstable_readConfig(
      { config: join(stagingDirectory, UPLOAD_CONFIG_PATH) },
      { hideWarnings: true },
    );

    const files = await collectFiles(stagingDirectory);
    const entrypoint = files.find(({ path }) => path === ENTRYPOINT_PATH);
    const config = files.find(({ path }) => path === UPLOAD_CONFIG_PATH);
    if (
      !entrypoint ||
      !config ||
      !files.every(
        ({ path }) =>
          path.endsWith(".js") || path.endsWith(".js.map") || path === UPLOAD_CONFIG_PATH,
      )
    ) {
      throw new WorkerArtifactError("artifact");
    }
    const sourceConfigRelativePath = input.target.wranglerConfigPath;
    const manifest: WorkerArtifactManifest = {
      schemaVersion: 1,
      wranglerVersion: WRANGLER_VERSION,
      target: {
        accountId: input.target.accountId,
        environment: input.environment,
        productionWorkerName: input.productionWorkerName,
        workerName: input.target.workerName,
        wranglerEnvironment: input.target.wranglerEnvironment,
      },
      source: { configPath: sourceConfigRelativePath, configSha256: input.sourceConfigSha256 },
      uploadConfig: config,
      entrypoint: ENTRYPOINT_PATH,
      files,
      policy,
    };
    const manifestBytes = jsonBytes(manifest);
    await writeFile(join(stagingDirectory, MANIFEST_PATH), manifestBytes, {
      flag: "wx",
      mode: 0o400,
    });
    await rename(join(stagingDirectory, "bundle"), join(artifactDirectory, "bundle"));
    await rename(join(stagingDirectory, "config"), join(artifactDirectory, "config"));
    await rename(join(stagingDirectory, MANIFEST_PATH), join(artifactDirectory, MANIFEST_PATH));
    await rm(stagingDirectory, { recursive: true, force: true });
    await freezeTree(artifactDirectory);
    return { artifactDirectory, manifest, manifestSha256: sha256(manifestBytes) };
  } catch (error) {
    await rm(homeDirectory, { recursive: true, force: true });
    await removeOwnedTree(artifactDirectory);
    if (error instanceof WorkerArtifactError) throw error;
    throw new WorkerArtifactError("operation");
  }
};

export const verifyWorkerArtifacts = async (
  input: PrepareWorkerArtifactsInput,
  prepared: PreparedWorkerArtifacts,
): Promise<WorkerArtifactManifest> => {
  validateInput(input);
  await assertPinnedWrangler(resolve(input.repositoryRoot));
  if (
    resolve(prepared.artifactDirectory) !== resolve(input.artifactDirectory) ||
    !SHA256.test(prepared.manifestSha256)
  ) {
    throw new WorkerArtifactError("artifact");
  }
  const sourceConfigPath = resolve(input.repositoryRoot, input.target.wranglerConfigPath);
  const sourceBytes = await readRegularFile(sourceConfigPath, 1024 * 1024).catch(() => {
    throw new WorkerArtifactError("source-drift");
  });
  if (sha256(sourceBytes) !== input.sourceConfigSha256) {
    throw new WorkerArtifactError("source-drift");
  }
  const policy = parsePolicy(input);
  const manifestBytes = await readRegularFile(join(input.artifactDirectory, MANIFEST_PATH));
  if (sha256(manifestBytes) !== prepared.manifestSha256) {
    throw new WorkerArtifactError("artifact");
  }
  let manifest: unknown;
  try {
    manifest = JSON.parse(manifestBytes.toString("utf8"));
  } catch {
    throw new WorkerArtifactError("artifact");
  }
  if (
    !isObject(manifest) ||
    manifest.schemaVersion !== 1 ||
    manifest.wranglerVersion !== WRANGLER_VERSION ||
    !isObject(manifest.target) ||
    manifest.target.accountId !== input.target.accountId ||
    manifest.target.environment !== input.environment ||
    manifest.target.productionWorkerName !== input.productionWorkerName ||
    manifest.target.workerName !== input.target.workerName ||
    manifest.target.wranglerEnvironment !== input.target.wranglerEnvironment ||
    !isObject(manifest.source) ||
    manifest.source.configPath !== input.target.wranglerConfigPath ||
    manifest.source.configSha256 !== input.sourceConfigSha256 ||
    manifest.entrypoint !== ENTRYPOINT_PATH ||
    JSON.stringify(stableValue(manifest.policy)) !== JSON.stringify(stableValue(policy)) ||
    !Array.isArray(manifest.files) ||
    !isObject(manifest.uploadConfig)
  ) {
    throw new WorkerArtifactError("artifact");
  }

  const expectedFiles = manifest.files as unknown[];
  const parsedFiles: WorkerArtifactFile[] = [];
  for (const file of expectedFiles) {
    if (
      !isObject(file) ||
      typeof file.path !== "string" ||
      !safeRelativePath(file.path) ||
      typeof file.bytes !== "number" ||
      !Number.isSafeInteger(file.bytes) ||
      file.bytes < 0 ||
      file.bytes > MAX_FILE_BYTES ||
      typeof file.sha256 !== "string" ||
      !SHA256.test(file.sha256)
    ) {
      throw new WorkerArtifactError("artifact");
    }
    parsedFiles.push({ path: file.path, bytes: file.bytes, sha256: file.sha256 });
  }
  if (
    parsedFiles.length === 0 ||
    parsedFiles.length > MAX_FILES ||
    new Set(parsedFiles.map(({ path }) => path)).size !== parsedFiles.length ||
    !parsedFiles.some(({ path }) => path === ENTRYPOINT_PATH) ||
    JSON.stringify(stableValue(manifest.uploadConfig)) !==
      JSON.stringify(stableValue(parsedFiles.find(({ path }) => path === UPLOAD_CONFIG_PATH)))
  ) {
    throw new WorkerArtifactError("artifact");
  }
  const actualFiles = await collectFiles(input.artifactDirectory, { allowManifest: true });
  const withoutManifest = actualFiles.filter(({ path }) => path !== MANIFEST_PATH);
  if (JSON.stringify(withoutManifest) !== JSON.stringify(parsedFiles)) {
    throw new WorkerArtifactError("artifact");
  }
  const expectedUploadConfig = jsonBytes(uploadConfig(input, policy));
  const actualUploadConfig = await readRegularFile(
    join(input.artifactDirectory, UPLOAD_CONFIG_PATH),
  );
  if (!actualUploadConfig.equals(expectedUploadConfig)) throw new WorkerArtifactError("artifact");
  return manifest as unknown as WorkerArtifactManifest;
};
