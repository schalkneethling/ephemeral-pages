import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open, readFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";

import {
  verifyWorkerArtifacts,
  type PrepareWorkerArtifactsInput,
  type PreparedWorkerArtifacts,
  type WorkerArtifactManifest,
} from "./worker-artifacts.ts";
import { assertPinnedCliVersions } from "./bootstrap-safety.ts";

type JsonObject = Record<string, unknown>;

export type WorkerMigrationPolicy = {
  artifactTag: "v1";
  change: "none";
  expectedCurrentTag: "v1";
};

export type WorkerReleaseRequest = {
  body?: FormData | string;
  method: "GET" | "POST";
  path: string;
  signal: AbortSignal;
};

export type WorkerReleaseTransport = {
  dispatch(request: WorkerReleaseRequest): Promise<unknown>;
};

export type WorkerReleaseCheckpoint =
  | {
      accountId: string;
      artifactManifestSha256: string;
      baselineDeploymentId: string;
      migrationPolicy: WorkerMigrationPolicy;
      phase: "pending-version-upload";
      workerName: string;
    }
  | {
      accountId: string;
      artifactManifestSha256: string;
      baselineDeploymentId: string;
      migrationPolicy: WorkerMigrationPolicy;
      phase: "pending-activation";
      versionId: string;
      workerName: string;
    };

export type PreparedStagingWorkerRelease = {
  artifactInput: PrepareWorkerArtifactsInput;
  expectedBaselineDeploymentId: string;
  migrationPolicy: WorkerMigrationPolicy;
  prepared: PreparedWorkerArtifacts;
};

export type UploadedStagingWorkerVersion = {
  accountId: string;
  artifactManifestSha256: string;
  baselineDeploymentId: string;
  migrationPolicy: WorkerMigrationPolicy;
  scriptEtag: string;
  status: "uploaded";
  versionId: string;
  workerName: string;
};

export type ActivatedStagingWorkerVersion = {
  accountId: string;
  artifactManifestSha256: string;
  deploymentId: string;
  migrationPolicy: WorkerMigrationPolicy;
  scriptEtag: string;
  status: "activated";
  versionId: string;
  workerName: string;
};

export type ActivatePreparedStagingWorkerInput = PreparedStagingWorkerRelease & {
  upload: UploadedStagingWorkerVersion;
};

export type WorkerReleaseDependencies = {
  checkpoint(checkpoint: WorkerReleaseCheckpoint): Promise<void>;
  timeoutMs?: number;
  transport: WorkerReleaseTransport;
  verifyArtifacts?: typeof verifyWorkerArtifacts;
};

export type CloudflareWorkerFetchTransportOptions = {
  fetch?: typeof fetch;
  resolveAccessToken(): Promise<string>;
};

export type WranglerAccessTokenCommandResult = {
  exitCode: number | null;
  stderr: string;
  stdout: string;
};

export type WranglerAccessTokenCommandRunner = (
  executable: string,
  args: readonly string[],
  environment: Readonly<Record<string, string>>,
) => Promise<WranglerAccessTokenCommandResult>;

export type WranglerAccessTokenResolverOptions = {
  repositoryRoot: string;
  run?: WranglerAccessTokenCommandRunner;
  workingDirectory: string;
};

export class WorkerReleaseError extends Error {
  readonly kind:
    | "ambiguous"
    | "artifact"
    | "authentication"
    | "checkpoint"
    | "invalid-input"
    | "preflight"
    | "verification";

  constructor(kind: WorkerReleaseError["kind"]) {
    const messages = {
      ambiguous: "The Worker mutation outcome is ambiguous; do not retry it blindly.",
      artifact: "The prepared Worker artifact could not be verified.",
      authentication: "Cloudflare authentication could not be established.",
      checkpoint: "The Worker mutation checkpoint could not be persisted.",
      "invalid-input": "The Worker release input is invalid.",
      preflight: "The Worker release preflight did not pass.",
      verification: "The Worker release readback did not verify.",
    } as const;
    super(messages[kind]);
    this.name = "WorkerReleaseError";
    this.kind = kind;
  }
}

const API_ORIGIN = "https://api.cloudflare.com";
const API_PREFIX = "/client/v4";
const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_RESPONSE_BYTES = 1024 * 1024;
const MAX_AUTH_OUTPUT_BYTES = 32 * 1024;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,255}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const SCRIPT_ETAG = /^[0-9a-f]{32,128}$/iu;
const REQUIRED_SECRET_NAMES = ["TICKET_HMAC_SECRET", "ADMIN_TOKEN"] as const;
const EXPECTED_BINDING_NAMES = [
  "ADMIN_TOKEN",
  "ALLOWED_ORIGINS",
  "BROWSER",
  "COLLABORATION_ROOMS",
  "PAGE_CONTENT_ORIGIN",
  "PUBLIC_WORKER_ORIGIN",
  "TICKET_AUDIENCE",
  "TICKET_HMAC_SECRET",
] as const;
const SUPPORTED_ARTIFACT_PATHS = new Set([
  "bundle/index.js",
  "bundle/index.js.map",
  "config/wrangler.json",
]);

const isObject = (value: unknown): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= 4_096;

const containsConfiguredJson = (actual: unknown, expected: unknown): boolean => {
  if (Array.isArray(expected)) {
    return (
      Array.isArray(actual) &&
      actual.length === expected.length &&
      expected.every((item, index) => containsConfiguredJson(actual[index], item))
    );
  }
  if (isObject(expected)) {
    return (
      isObject(actual) &&
      Object.entries(expected).every(([key, item]) => containsConfiguredJson(actual[key], item))
    );
  }
  return Object.is(actual, expected);
};

const normalizeScriptEtag = (value: unknown): string | undefined => {
  if (typeof value !== "string") return undefined;
  const unquoted = value.startsWith('"') && value.endsWith('"') ? value.slice(1, -1) : value;
  return SCRIPT_ETAG.test(unquoted) ? unquoted.toLowerCase() : undefined;
};

const sameMigrationPolicy = (value: unknown): value is WorkerMigrationPolicy =>
  isObject(value) &&
  Object.keys(value).length === 3 &&
  value.artifactTag === "v1" &&
  value.expectedCurrentTag === "v1" &&
  value.change === "none";

const workerPath = (accountId: string, workerName: string, suffix: string): string =>
  `/accounts/${encodeURIComponent(accountId)}/workers/scripts/${encodeURIComponent(workerName)}${suffix}`;

const servicePath = (accountId: string, workerName: string): string =>
  `/accounts/${encodeURIComponent(accountId)}/workers/services/${encodeURIComponent(workerName)}`;

const readBoundedResponse = async (response: Response): Promise<unknown> => {
  const declaredLength = response.headers.get("content-length");
  if (
    declaredLength !== null &&
    (!/^\d+$/u.test(declaredLength) || Number(declaredLength) > MAX_RESPONSE_BYTES)
  ) {
    throw new Error();
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_RESPONSE_BYTES) throw new Error();
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
};

export const createCloudflareWorkerFetchTransport = (
  options: CloudflareWorkerFetchTransportOptions,
): WorkerReleaseTransport => ({
  dispatch: async (request) => {
    if (
      !request.path.startsWith("/accounts/") ||
      request.path.includes("..") ||
      request.path.includes("//") ||
      (request.method === "GET" && request.body !== undefined)
    ) {
      throw new WorkerReleaseError("invalid-input");
    }
    let token: string;
    try {
      token = await options.resolveAccessToken();
    } catch {
      throw new WorkerReleaseError("authentication");
    }
    if (
      typeof token !== "string" ||
      token.length < 20 ||
      token.length > 16_384 ||
      /\s/u.test(token)
    ) {
      throw new WorkerReleaseError("authentication");
    }
    let response: Response;
    try {
      response = await (options.fetch ?? fetch)(`${API_ORIGIN}${API_PREFIX}${request.path}`, {
        body: request.body,
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${token}`,
          ...(typeof request.body === "string" ? { "Content-Type": "application/json" } : {}),
        },
        method: request.method,
        redirect: "error",
        signal: request.signal,
      });
    } catch {
      throw new Error();
    }
    let envelope: unknown;
    try {
      envelope = await readBoundedResponse(response);
    } catch {
      throw new Error();
    }
    if (
      !response.ok ||
      !isObject(envelope) ||
      envelope.success !== true ||
      !("result" in envelope)
    ) {
      throw new Error();
    }
    return envelope.result;
  },
});

const defaultWranglerAuthRunner: WranglerAccessTokenCommandRunner = async (
  executable,
  args,
  environment,
) =>
  new Promise((resolveResult) => {
    const child = spawn(executable, [...args], {
      cwd: environment.WORKER_RELEASE_REPOSITORY_ROOT,
      env: Object.fromEntries(
        Object.entries(environment).filter(([name]) => name !== "WORKER_RELEASE_REPOSITORY_ROOT"),
      ),
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let overflow = false;
    let settled = false;
    const capture = (current: string, chunk: Buffer): string => {
      if (Buffer.byteLength(current, "utf8") + chunk.length > MAX_AUTH_OUTPUT_BYTES) {
        overflow = true;
        return current;
      }
      return current + chunk.toString("utf8");
    };
    const finish = (result: WranglerAccessTokenCommandResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveResult(result);
    };
    child.stdout.on("data", (chunk: Buffer) => {
      stdout = capture(stdout, chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = capture(stderr, chunk);
    });
    child.once("error", () => finish({ exitCode: null, stderr: "", stdout: "" }));
    child.once("close", (exitCode) =>
      finish(overflow ? { exitCode: null, stderr: "", stdout: "" } : { exitCode, stderr, stdout }),
    );
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish({ exitCode: null, stderr: "", stdout: "" });
    }, DEFAULT_TIMEOUT_MS);
  });

const selectedAuthEnvironment = (): Readonly<Record<string, string>> => {
  const allowedNames = [
    "CLOUDFLARE_API_KEY",
    "CLOUDFLARE_API_TOKEN",
    "CLOUDFLARE_EMAIL",
    "HOME",
    "PATH",
    "TMPDIR",
    "XDG_CONFIG_HOME",
  ] as const;
  const environment: Record<string, string> = {};
  for (const name of allowedNames) {
    const value = process.env[name];
    if (value !== undefined) environment[name] = value;
  }
  return {
    ...environment,
    CI: "1",
    NO_COLOR: "1",
    WRANGLER_API_ENVIRONMENT: "production",
    WRANGLER_AUTH_DOMAIN: "dash.cloudflare.com",
    WRANGLER_AUTH_URL: "https://dash.cloudflare.com/oauth2/auth",
    WRANGLER_LOG_SANITIZE: "true",
    WRANGLER_REVOKE_URL: "https://dash.cloudflare.com/oauth2/revoke",
    WRANGLER_TOKEN_URL: "https://dash.cloudflare.com/oauth2/token",
    WRANGLER_WRITE_LOGS: "false",
  };
};

export const createWranglerAccessTokenResolver = (
  options: WranglerAccessTokenResolverOptions,
): (() => Promise<string>) => {
  let resolvedToken: Promise<string> | undefined;
  return async () => {
    if (resolvedToken) return resolvedToken;
    resolvedToken = (async () => {
      if (!isAbsolute(options.repositoryRoot) || !isAbsolute(options.workingDirectory)) {
        throw new WorkerReleaseError("authentication");
      }
      try {
        await assertPinnedCliVersions(
          resolve(options.repositoryRoot),
          ["wrangler"],
          () => new WorkerReleaseError("authentication"),
        );
        const executable = join(resolve(options.repositoryRoot), "node_modules/.bin/wrangler");
        await readFile(executable);
        const result = await (options.run ?? defaultWranglerAuthRunner)(
          executable,
          ["auth", "token", "--json", "--cwd", resolve(options.workingDirectory)],
          {
            ...selectedAuthEnvironment(),
            WORKER_RELEASE_REPOSITORY_ROOT: resolve(options.repositoryRoot),
          },
        );
        if (result.exitCode !== 0 || result.stderr.length !== 0) throw new Error();
        const parsed = JSON.parse(result.stdout) as unknown;
        if (
          !isObject(parsed) ||
          (parsed.type !== "oauth" && parsed.type !== "api_token") ||
          typeof parsed.token !== "string" ||
          parsed.token.length < 20 ||
          parsed.token.length > 16_384 ||
          /\s/u.test(parsed.token)
        ) {
          throw new Error();
        }
        return parsed.token;
      } catch {
        throw new WorkerReleaseError("authentication");
      }
    })();
    return resolvedToken;
  };
};

const validateReleaseInput = (input: PreparedStagingWorkerRelease): void => {
  try {
    if (
      input.artifactInput.environment !== "staging" ||
      input.artifactInput.target.wranglerEnvironment !== "staging" ||
      input.artifactInput.target.workerName === input.artifactInput.productionWorkerName ||
      !SAFE_ID.test(input.artifactInput.target.accountId) ||
      !SAFE_ID.test(input.artifactInput.target.workerName) ||
      !SAFE_ID.test(input.expectedBaselineDeploymentId) ||
      !SHA256.test(input.prepared.manifestSha256) ||
      !sameMigrationPolicy(input.migrationPolicy)
    ) {
      throw new Error();
    }
  } catch {
    throw new WorkerReleaseError("invalid-input");
  }
};

const verifyPrepared = async (
  input: PreparedStagingWorkerRelease,
  dependencies: WorkerReleaseDependencies,
): Promise<WorkerArtifactManifest> => {
  validateReleaseInput(input);
  try {
    const manifest = await (dependencies.verifyArtifacts ?? verifyWorkerArtifacts)(
      input.artifactInput,
      input.prepared,
    );
    if (
      manifest.target.environment !== "staging" ||
      manifest.target.accountId !== input.artifactInput.target.accountId ||
      manifest.target.workerName !== input.artifactInput.target.workerName ||
      manifest.policy.migrations.length !== 1 ||
      manifest.policy.migrations[0].tag !== "v1" ||
      !manifest.files.some(({ path }) => path === "bundle/index.js") ||
      !manifest.files.some(({ path }) => path === "config/wrangler.json") ||
      manifest.files.some(({ path }) => !SUPPORTED_ARTIFACT_PATHS.has(path))
    ) {
      throw new Error();
    }
    return manifest;
  } catch {
    throw new WorkerReleaseError("artifact");
  }
};

const dispatch = async (
  transport: WorkerReleaseTransport,
  request: Omit<WorkerReleaseRequest, "signal">,
  timeoutMs: number,
): Promise<unknown> => {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      transport.dispatch({ ...request, signal: controller.signal }),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new Error());
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
};

const getTimeout = (dependencies: WorkerReleaseDependencies): number => {
  const timeoutMs = dependencies.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) {
    throw new WorkerReleaseError("invalid-input");
  }
  return timeoutMs;
};

const readProvider = async (
  dependencies: WorkerReleaseDependencies,
  path: string,
  failure: "preflight" | "verification",
): Promise<unknown> => {
  try {
    return await dispatch(
      dependencies.transport,
      { method: "GET", path },
      getTimeout(dependencies),
    );
  } catch {
    throw new WorkerReleaseError(failure);
  }
};

const parseCurrentServicePolicy = (value: unknown, manifest: WorkerArtifactManifest): "v1" => {
  if (
    !isObject(value) ||
    !isObject(value.default_environment) ||
    !isObject(value.default_environment.script) ||
    value.default_environment.script.migration_tag !== "v1" ||
    !containsConfiguredJson(
      value.default_environment.script.observability,
      manifest.policy.observability,
    )
  ) {
    throw new Error();
  }
  return "v1";
};

type Deployment = { id: string; versionId: string };

const parseLatestDeployment = (value: unknown): Deployment => {
  if (!isObject(value) || !Array.isArray(value.deployments) || value.deployments.length === 0) {
    throw new Error();
  }
  const deployment = value.deployments[0];
  if (
    !isObject(deployment) ||
    typeof deployment.id !== "string" ||
    !SAFE_ID.test(deployment.id) ||
    !Array.isArray(deployment.versions) ||
    deployment.versions.length !== 1
  ) {
    throw new Error();
  }
  const traffic = deployment.versions[0];
  if (
    !isObject(traffic) ||
    typeof traffic.version_id !== "string" ||
    !SAFE_ID.test(traffic.version_id) ||
    traffic.percentage !== 100
  ) {
    throw new Error();
  }
  return { id: deployment.id, versionId: traffic.version_id };
};

const expectedBinding = (
  binding: JsonObject,
  expectedVariables: Readonly<Record<string, string>>,
): boolean => {
  if (!isNonEmptyString(binding.name) || !isNonEmptyString(binding.type)) return false;
  if (REQUIRED_SECRET_NAMES.includes(binding.name as (typeof REQUIRED_SECRET_NAMES)[number])) {
    return binding.type === "secret_text";
  }
  if (binding.name === "COLLABORATION_ROOMS") {
    return (
      binding.type === "durable_object_namespace" &&
      binding.class_name === "CollaborationRoom" &&
      binding.script_name === undefined &&
      binding.environment === undefined
    );
  }
  if (binding.name === "BROWSER") return binding.type === "browser";
  return (
    Object.hasOwn(expectedVariables, binding.name) &&
    binding.type === "plain_text" &&
    binding.text === expectedVariables[binding.name]
  );
};

const parseVersionAgainstInput = (
  value: unknown,
  versionId: string,
  manifest: WorkerArtifactManifest,
  input: PreparedStagingWorkerRelease,
  expectedAnnotation?: string,
): string => {
  const scriptEtag =
    isObject(value) && isObject(value.resources) && isObject(value.resources.script)
      ? normalizeScriptEtag(value.resources.script.etag)
      : undefined;
  if (
    !isObject(value) ||
    value.id !== versionId ||
    !isObject(value.resources) ||
    !isObject(value.resources.script) ||
    scriptEtag === undefined ||
    !isObject(value.resources.script_runtime) ||
    value.resources.script_runtime.compatibility_date !== manifest.policy.compatibilityDate ||
    !Array.isArray(value.resources.script_runtime.compatibility_flags) ||
    JSON.stringify(value.resources.script_runtime.compatibility_flags) !==
      JSON.stringify(manifest.policy.compatibilityFlags) ||
    !Array.isArray(value.resources.bindings) ||
    value.resources.bindings.length !== EXPECTED_BINDING_NAMES.length ||
    value.resources.bindings.some(
      (binding) =>
        !isObject(binding) ||
        !expectedBinding(binding, input.artifactInput.target.expectedNonSecretVariables),
    )
  ) {
    throw new Error();
  }
  const names = value.resources.bindings.map((binding) => (binding as JsonObject).name);
  if (
    new Set(names).size !== names.length ||
    !EXPECTED_BINDING_NAMES.every((name) => names.includes(name)) ||
    (expectedAnnotation !== undefined &&
      (!isObject(value.annotations) || value.annotations["workers/tag"] !== expectedAnnotation))
  ) {
    throw new Error();
  }
  return scriptEtag;
};

const inspectBaseline = async (
  input: PreparedStagingWorkerRelease,
  manifest: WorkerArtifactManifest,
  dependencies: WorkerReleaseDependencies,
): Promise<void> => {
  const { accountId, workerName } = input.artifactInput.target;
  try {
    parseCurrentServicePolicy(
      await readProvider(dependencies, servicePath(accountId, workerName), "preflight"),
      manifest,
    );
    const deployment = parseLatestDeployment(
      await readProvider(
        dependencies,
        workerPath(accountId, workerName, "/deployments"),
        "preflight",
      ),
    );
    if (deployment.id !== input.expectedBaselineDeploymentId) throw new Error();
    parseVersionAgainstInput(
      await readProvider(
        dependencies,
        workerPath(accountId, workerName, `/versions/${encodeURIComponent(deployment.versionId)}`),
        "preflight",
      ),
      deployment.versionId,
      manifest,
      input,
    );
  } catch {
    throw new WorkerReleaseError("preflight");
  }
};

const readEntrypoint = async (
  input: PreparedStagingWorkerRelease,
  manifest: WorkerArtifactManifest,
): Promise<ArrayBuffer> => {
  const expected = manifest.files.find(({ path }) => path === manifest.entrypoint);
  if (!expected) throw new WorkerReleaseError("artifact");
  let handle;
  try {
    handle = await open(
      join(input.prepared.artifactDirectory, manifest.entrypoint),
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    const metadata = await handle.stat();
    if (!metadata.isFile() || metadata.size !== expected.bytes) throw new Error();
    const bytes = await handle.readFile();
    if (createHash("sha256").update(bytes).digest("hex") !== expected.sha256) throw new Error();
    const copy = new Uint8Array(bytes.length);
    copy.set(bytes);
    return copy.buffer;
  } catch {
    throw new WorkerReleaseError("artifact");
  } finally {
    await handle?.close().catch(() => undefined);
  }
};

const createUploadBody = async (
  input: PreparedStagingWorkerRelease,
  manifest: WorkerArtifactManifest,
): Promise<FormData> => {
  const body = new FormData();
  const bindings: JsonObject[] = [
    ...manifest.policy.requiredSecretNames.map((name) => ({ name, type: "inherit" })),
    ...Object.entries(input.artifactInput.target.expectedNonSecretVariables)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([name, text]) => ({ name, text, type: "plain_text" })),
    {
      class_name: "CollaborationRoom",
      name: "COLLABORATION_ROOMS",
      type: "durable_object_namespace",
    },
    { name: "BROWSER", type: "browser" },
  ];
  const metadata = {
    annotations: { "workers/tag": input.prepared.manifestSha256 },
    bindings,
    compatibility_date: manifest.policy.compatibilityDate,
    compatibility_flags: manifest.policy.compatibilityFlags,
    keep_bindings: ["secret_text", "secret_key"],
    main_module: "index.js",
  };
  body.set("metadata", JSON.stringify(metadata));
  body.set(
    "index.js",
    new File([await readEntrypoint(input, manifest)], "index.js", {
      type: "application/javascript+module",
    }),
  );
  return body;
};

const checkpoint = async (
  dependencies: WorkerReleaseDependencies,
  value: WorkerReleaseCheckpoint,
): Promise<void> => {
  try {
    await dependencies.checkpoint(value);
  } catch {
    throw new WorkerReleaseError("checkpoint");
  }
};

const mutation = async (
  dependencies: WorkerReleaseDependencies,
  request: Omit<WorkerReleaseRequest, "signal">,
): Promise<unknown> => {
  try {
    return await dispatch(dependencies.transport, request, getTimeout(dependencies));
  } catch {
    throw new WorkerReleaseError("ambiguous");
  }
};

export const uploadPreparedStagingWorker = async (
  input: PreparedStagingWorkerRelease,
  dependencies: WorkerReleaseDependencies,
): Promise<UploadedStagingWorkerVersion> => {
  const manifest = await verifyPrepared(input, dependencies);
  await inspectBaseline(input, manifest, dependencies);
  const { accountId, workerName } = input.artifactInput.target;
  const body = await createUploadBody(input, manifest);
  await checkpoint(dependencies, {
    accountId,
    artifactManifestSha256: input.prepared.manifestSha256,
    baselineDeploymentId: input.expectedBaselineDeploymentId,
    migrationPolicy: input.migrationPolicy,
    phase: "pending-version-upload",
    workerName,
  });
  const result = await mutation(dependencies, {
    body,
    method: "POST",
    path: `${workerPath(accountId, workerName, "/versions")}?bindings_inherit=strict`,
  });
  if (!isObject(result) || typeof result.id !== "string" || !SAFE_ID.test(result.id)) {
    throw new WorkerReleaseError("ambiguous");
  }
  const versionId = result.id;
  let scriptEtag: string;
  try {
    scriptEtag = parseVersionAgainstInput(
      await readProvider(
        dependencies,
        workerPath(accountId, workerName, `/versions/${encodeURIComponent(versionId)}`),
        "verification",
      ),
      versionId,
      manifest,
      input,
      input.prepared.manifestSha256,
    );
  } catch {
    throw new WorkerReleaseError("ambiguous");
  }
  return {
    accountId,
    artifactManifestSha256: input.prepared.manifestSha256,
    baselineDeploymentId: input.expectedBaselineDeploymentId,
    migrationPolicy: input.migrationPolicy,
    scriptEtag,
    status: "uploaded",
    versionId,
    workerName,
  };
};

export const activatePreparedStagingWorker = async (
  input: ActivatePreparedStagingWorkerInput,
  dependencies: WorkerReleaseDependencies,
): Promise<ActivatedStagingWorkerVersion> => {
  const manifest = await verifyPrepared(input, dependencies);
  const { accountId, workerName } = input.artifactInput.target;
  if (
    input.upload.status !== "uploaded" ||
    input.upload.accountId !== accountId ||
    input.upload.workerName !== workerName ||
    input.upload.artifactManifestSha256 !== input.prepared.manifestSha256 ||
    input.upload.baselineDeploymentId !== input.expectedBaselineDeploymentId ||
    !sameMigrationPolicy(input.upload.migrationPolicy) ||
    !SAFE_ID.test(input.upload.versionId) ||
    normalizeScriptEtag(input.upload.scriptEtag) !== input.upload.scriptEtag
  ) {
    throw new WorkerReleaseError("invalid-input");
  }
  await inspectBaseline(input, manifest, dependencies);
  try {
    const uploadedEtag = parseVersionAgainstInput(
      await readProvider(
        dependencies,
        workerPath(
          accountId,
          workerName,
          `/versions/${encodeURIComponent(input.upload.versionId)}`,
        ),
        "preflight",
      ),
      input.upload.versionId,
      manifest,
      input,
      input.prepared.manifestSha256,
    );
    if (uploadedEtag !== input.upload.scriptEtag) throw new Error();
    parseCurrentServicePolicy(
      await readProvider(dependencies, servicePath(accountId, workerName), "preflight"),
      manifest,
    );
  } catch {
    throw new WorkerReleaseError("preflight");
  }
  await checkpoint(dependencies, {
    accountId,
    artifactManifestSha256: input.prepared.manifestSha256,
    baselineDeploymentId: input.expectedBaselineDeploymentId,
    migrationPolicy: input.migrationPolicy,
    phase: "pending-activation",
    versionId: input.upload.versionId,
    workerName,
  });
  const result = await mutation(dependencies, {
    body: JSON.stringify({
      annotations: {
        "workers/message": `Activate prepared artifact ${input.prepared.manifestSha256}`,
      },
      strategy: "percentage",
      versions: [{ percentage: 100, version_id: input.upload.versionId }],
    }),
    method: "POST",
    path: workerPath(accountId, workerName, "/deployments"),
  });
  if (!isObject(result) || typeof result.id !== "string" || !SAFE_ID.test(result.id)) {
    throw new WorkerReleaseError("ambiguous");
  }
  const deploymentId = result.id;
  let scriptEtag: string;
  try {
    const deployment = parseLatestDeployment(
      await readProvider(
        dependencies,
        workerPath(accountId, workerName, "/deployments"),
        "verification",
      ),
    );
    if (deployment.id !== deploymentId || deployment.versionId !== input.upload.versionId) {
      throw new Error();
    }
    parseCurrentServicePolicy(
      await readProvider(dependencies, servicePath(accountId, workerName), "verification"),
      manifest,
    );
    scriptEtag = parseVersionAgainstInput(
      await readProvider(
        dependencies,
        workerPath(
          accountId,
          workerName,
          `/versions/${encodeURIComponent(input.upload.versionId)}`,
        ),
        "verification",
      ),
      input.upload.versionId,
      manifest,
      input,
      input.prepared.manifestSha256,
    );
    if (scriptEtag !== input.upload.scriptEtag) throw new Error();
  } catch {
    throw new WorkerReleaseError("ambiguous");
  }
  return {
    accountId,
    artifactManifestSha256: input.prepared.manifestSha256,
    deploymentId,
    migrationPolicy: input.migrationPolicy,
    scriptEtag,
    status: "activated",
    versionId: input.upload.versionId,
    workerName,
  };
};
