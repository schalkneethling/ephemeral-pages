import { preparedReleaseSchema, type PreparedRelease } from "./prepare.ts";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Readable } from "node:stream";
import { resolve } from "node:path";
import { NetlifyAPI } from "netlify-cli/dist/index.js";
import { getToken, USER_AGENT } from "netlify-cli/dist/utils/command-helpers.js";
import { createSingleDispatchAgent } from "./local-secrets.ts";
import { assertPinnedCliVersions } from "./bootstrap-safety.ts";
import type { ProductionProviderAuthorization } from "./production-authorization.ts";
import { verifyNetlifyArtifacts, type PreparedNetlifyArtifacts } from "./netlify-artifacts.ts";

export type NetlifyDeploymentOperation =
  | "getSite"
  | "listSiteDeploys"
  | "lockDeploy"
  | "createSiteDeploy"
  | "updateSiteDeploy"
  | "getSiteDeploy"
  | "uploadDeployFile"
  | "uploadDeployFunction"
  | "restoreSiteDeploy";
export type NetlifyDeploymentClient = (
  operation: NetlifyDeploymentOperation,
  parameters: Record<string, unknown>,
  signal: AbortSignal,
) => Promise<unknown>;
type NetlifyMutationOperation = Exclude<
  NetlifyDeploymentOperation,
  "getSite" | "getSiteDeploy" | "listSiteDeploys"
>;
export type NetlifyDeploymentCheckpoint =
  | {
      operation: NetlifyMutationOperation;
      phase: "pending-mutation";
      deployId?: string;
      artifactSha256: string;
    }
  | {
      operation: "lockDeploy" | "createSiteDeploy";
      phase: "mutation-response-received";
      deployId: string;
      artifactSha256: string;
    }
  | {
      operation: "restoreSiteDeploy";
      phase: "mutation-response-received";
      deployId: string;
      artifactSha256: string;
      publishedDeployId: string;
    };
export type NetlifyDeploymentDependencies = {
  client: NetlifyDeploymentClient;
  checkpoint: (value: NetlifyDeploymentCheckpoint) => Promise<void>;
  wait?: () => Promise<void>;
};
type NetlifyDeploymentBaseInput = {
  siteId: string;
  accountId: string;
  origin: string;
  productionSiteId: string;
  baselineDeployId: string;
  candidate: string;
  preparation: PreparedRelease;
};
export type NetlifyDeploymentInput = NetlifyDeploymentBaseInput & {
  environment: "staging";
};
export type ProductionNetlifyDeploymentInput = NetlifyDeploymentBaseInput & {
  authorization: ProductionProviderAuthorization;
  environment: "production";
};
export type NetlifyDeployMetadata = {
  functionSchedules: readonly { name: string; cron: string }[];
  functionsConfig: Record<string, unknown>;
  functions: Readonly<
    Record<string, { runtime: string; invocationMode?: string; timeout?: number }>
  >;
};
export type HeldNetlifyDeployment = {
  siteId: string;
  baselineDeployId: string;
  candidateDeployId: string;
  candidate: string;
  artifactSha256: string;
  context: "production";
  state: "ready";
  acknowledgedUploads: number | null;
};
export class NetlifyDeploymentError extends Error {
  readonly kind: "preflight" | "checkpoint" | "ambiguous" | "verification";
  constructor(kind: NetlifyDeploymentError["kind"]) {
    super(
      "Netlify deployment stopped; inspect the recorded deployment before taking another action.",
    );
    this.kind = kind;
    this.name = "NetlifyDeploymentError";
  }
}
const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new NetlifyDeploymentError("verification");
  return value as Record<string, unknown>;
};
const identifier = (value: unknown): value is string =>
  typeof value === "string" && /^[a-zA-Z0-9-]{1,128}$/u.test(value);
const sha = (algorithm: "sha1" | "sha256", bytes: Buffer) =>
  createHash(algorithm).update(bytes).digest("hex");
type NetlifyDeploymentCoreInput = NetlifyDeploymentInput | ProductionNetlifyDeploymentInput;

const validateTarget = (
  input: NetlifyDeploymentCoreInput,
  environment: "staging" | "production",
) => {
  const parsed = preparedReleaseSchema.safeParse(input.preparation);
  if (
    !parsed.success ||
    parsed.data.source.environment !== environment ||
    parsed.data.source.candidate !== input.candidate
  )
    throw new NetlifyDeploymentError("preflight");
  if (
    input.environment !== environment ||
    !identifier(input.siteId) ||
    !identifier(input.accountId) ||
    !identifier(input.productionSiteId) ||
    !identifier(input.baselineDeployId) ||
    (environment === "staging"
      ? input.siteId === input.productionSiteId
      : input.siteId !== input.productionSiteId) ||
    !/^[a-f0-9]{40}$/u.test(input.candidate)
  )
    throw new NetlifyDeploymentError("preflight");
  const url = new URL(input.origin);
  if (url.origin !== input.origin || url.protocol !== "https:")
    throw new NetlifyDeploymentError("preflight");
};
const call = async (
  dependencies: NetlifyDeploymentDependencies,
  operation: NetlifyDeploymentOperation,
  parameters: Record<string, unknown>,
): Promise<Record<string, unknown>> => {
  try {
    return object(await dependencies.client(operation, parameters, AbortSignal.timeout(30_000)));
  } catch {
    throw new NetlifyDeploymentError(
      operation === "getSite" || operation === "getSiteDeploy" || operation === "listSiteDeploys"
        ? "verification"
        : "ambiguous",
    );
  }
};
const mutate = async (
  dependencies: NetlifyDeploymentDependencies,
  operation: NetlifyMutationOperation,
  parameters: Record<string, unknown>,
  checkpoint: { artifactSha256: string; deployId?: string },
) => {
  try {
    await dependencies.checkpoint({ operation, phase: "pending-mutation", ...checkpoint });
  } catch {
    throw new NetlifyDeploymentError("checkpoint");
  }
  return call(dependencies, operation, parameters);
};
const checkpointMutationResponse = async (
  dependencies: NetlifyDeploymentDependencies,
  value: Extract<NetlifyDeploymentCheckpoint, { phase: "mutation-response-received" }>,
) => {
  try {
    await dependencies.checkpoint(value);
  } catch {
    throw new NetlifyDeploymentError("ambiguous");
  }
};
const site = async (
  input: NetlifyDeploymentCoreInput,
  dependencies: NetlifyDeploymentDependencies,
  deployId: string,
  locked: boolean | null,
) => {
  const current = await call(dependencies, "getSite", { siteId: input.siteId });
  const published = object(current.published_deploy);
  const settings = object(current.build_settings ?? {});
  if (
    current.id !== input.siteId ||
    current.account_id !== input.accountId ||
    current.ssl_url !== input.origin ||
    (input.environment === "staging" && (settings.repo_url || settings.repo_path)) ||
    published.id !== deployId ||
    (locked !== null && published.locked !== locked)
  )
    throw new NetlifyDeploymentError("verification");
  return published;
};
const candidate = async (
  input: NetlifyDeploymentCoreInput,
  dependencies: NetlifyDeploymentDependencies,
  deployId: string,
) => {
  const value = await call(dependencies, "getSiteDeploy", { siteId: input.siteId, deployId });
  if (value.title !== `release-${input.candidate}-${input.preparation.artifacts.netlify.sha256}`)
    throw new NetlifyDeploymentError("verification");
  if (
    value.id !== deployId ||
    value.site_id !== input.siteId ||
    value.context !== "production" ||
    (value.draft !== undefined && value.draft !== false) ||
    value.state === "error"
  )
    throw new NetlifyDeploymentError("verification");
  return value;
};
const poll = async (
  input: NetlifyDeploymentCoreInput,
  dependencies: NetlifyDeploymentDependencies,
  deployId: string,
  ready: boolean,
) => {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const value = await candidate(input, dependencies, deployId);
    await site(input, dependencies, input.baselineDeployId, true);
    if (
      ready
        ? value.state === "ready"
        : ["prepared", "uploading", "uploaded", "ready"].includes(String(value.state))
    )
      return value;
    await (dependencies.wait ?? (() => new Promise<void>((done) => setTimeout(done, 2_000))))();
  }
  throw new NetlifyDeploymentError("ambiguous");
};

async function uploadHeldNetlifyDeploymentCore(
  input: NetlifyDeploymentCoreInput,
  artifacts: PreparedNetlifyArtifacts,
  metadata: NetlifyDeployMetadata,
  dependencies: NetlifyDeploymentDependencies,
  environment: "staging" | "production",
): Promise<HeldNetlifyDeployment> {
  validateTarget(input, environment);
  if (artifacts.inventorySha256 !== input.preparation.artifacts.netlify.sha256)
    throw new NetlifyDeploymentError("preflight");
  await verifyNetlifyArtifacts(artifacts);
  const files: Record<string, string> = {};
  const functions: Record<string, string> = {};
  const uploads = new Map<string, Array<{ name: string; bytes: Buffer; function: boolean }>>();
  // Hold the exact buffers whose digests are sent; uploads never reopen mutable source paths.
  for (const entry of [
    ...artifacts.inventory.staticFiles,
    artifacts.inventory.deployConfiguration.file,
    ...artifacts.inventory.functions,
  ]) {
    const bytes = await readFile(resolve(artifacts.artifactDirectory, entry.relativePath));
    if (bytes.length !== entry.bytes || sha("sha256", bytes) !== entry.sha256)
      throw new NetlifyDeploymentError("preflight");
    const isFunction = "name" in entry;
    const name = isFunction
      ? entry.name
      : entry.relativePath === "deploy/netlify.toml"
        ? "netlify.toml"
        : entry.relativePath.replace(/^publish\//u, "");
    if (typeof name !== "string" || !name || name.includes("?") || name.includes("#"))
      throw new NetlifyDeploymentError("preflight");
    const digest = sha(isFunction ? "sha256" : "sha1", bytes);
    (isFunction ? functions : files)[name] = digest;
    const key = `${isFunction ? "fn" : "file"}:${digest}`;
    uploads.set(key, [...(uploads.get(key) ?? []), { name, bytes, function: isFunction }]);
  }
  if (
    !files["netlify.toml"] ||
    Object.keys(metadata.functions).sort().join() !== Object.keys(functions).sort().join()
  )
    throw new NetlifyDeploymentError("preflight");
  const before = await site(input, dependencies, input.baselineDeployId, null);
  const checkpoint = { artifactSha256: artifacts.inventorySha256 };
  if (before.locked !== true) {
    if (environment === "production") throw new NetlifyDeploymentError("preflight");
    const locked = await mutate(
      dependencies,
      "lockDeploy",
      { deployId: input.baselineDeployId },
      { ...checkpoint, deployId: input.baselineDeployId },
    );
    if (locked.id !== input.baselineDeployId) throw new NetlifyDeploymentError("ambiguous");
    await checkpointMutationResponse(dependencies, {
      ...checkpoint,
      deployId: input.baselineDeployId,
      operation: "lockDeploy",
      phase: "mutation-response-received",
    });
  }
  await site(input, dependencies, input.baselineDeployId, true);
  const created = await mutate(
    dependencies,
    "createSiteDeploy",
    {
      siteId: input.siteId,
      title: `release-${input.candidate}-${artifacts.inventorySha256}`,
      body: { draft: false, deploy_source: "cli" },
    },
    checkpoint,
  );
  if (!identifier(created.id) || created.id === input.baselineDeployId)
    throw new NetlifyDeploymentError("ambiguous");
  const deployId = created.id;
  await checkpointMutationResponse(dependencies, {
    ...checkpoint,
    deployId,
    operation: "createSiteDeploy",
    phase: "mutation-response-received",
  });
  await site(input, dependencies, input.baselineDeployId, true);
  await candidate(input, dependencies, deployId);
  await mutate(
    dependencies,
    "updateSiteDeploy",
    {
      siteId: input.siteId,
      deployId,
      body: {
        files,
        functions,
        function_schedules: metadata.functionSchedules,
        functions_config: metadata.functionsConfig,
        async: true,
      },
    },
    { ...checkpoint, deployId },
  );
  const diff = await poll(input, dependencies, deployId, false);
  let acknowledgedUploads = 0;
  for (const [field, prefix] of [
    ["required", "file"],
    ["required_functions", "fn"],
  ] as const) {
    const required = diff[field] === undefined ? [] : diff[field];
    if (
      !Array.isArray(required) ||
      required.some((value) => typeof value !== "string" || !uploads.has(`${prefix}:${value}`)) ||
      new Set(required).size !== required.length
    )
      throw new NetlifyDeploymentError("verification");
    for (const digest of required as string[]) {
      for (const entry of uploads.get(`${prefix}:${digest}`)!) {
        const meta = metadata.functions[entry.name];
        const response = await mutate(
          dependencies,
          entry.function ? "uploadDeployFunction" : "uploadDeployFile",
          entry.function
            ? {
                deployId,
                name: encodeURI(entry.name),
                ...meta,
                body: () => Readable.from([entry.bytes]),
              }
            : { deployId, path: encodeURI(entry.name), body: () => Readable.from([entry.bytes]) },
          { ...checkpoint, deployId },
        );
        if (
          (entry.function
            ? response.sha !== undefined && response.sha !== digest
            : response.sha !== digest) ||
          (entry.function
            ? response.name !== entry.name
            : response.path !== `/${entry.name}` && response.path !== entry.name) ||
          (!entry.function && response.size !== entry.bytes.length)
        )
          throw new NetlifyDeploymentError("verification");
        acknowledgedUploads += 1;
        await site(input, dependencies, input.baselineDeployId, true);
      }
    }
  }
  await poll(input, dependencies, deployId, true);
  return {
    siteId: input.siteId,
    baselineDeployId: input.baselineDeployId,
    candidateDeployId: deployId,
    candidate: input.candidate,
    artifactSha256: artifacts.inventorySha256,
    context: "production",
    state: "ready",
    acknowledgedUploads,
  };
}

export async function uploadHeldNetlifyDeployment(
  input: NetlifyDeploymentInput,
  artifacts: PreparedNetlifyArtifacts,
  metadata: NetlifyDeployMetadata,
  dependencies: NetlifyDeploymentDependencies,
): Promise<HeldNetlifyDeployment> {
  return uploadHeldNetlifyDeploymentCore(input, artifacts, metadata, dependencies, "staging");
}

const authorizeProductionNetlify = (
  input: ProductionNetlifyDeploymentInput,
  artifactSha256: string,
): void => {
  try {
    input.authorization.assertArtifact(
      "netlify",
      { accountId: input.accountId, siteId: input.siteId },
      artifactSha256,
    );
  } catch {
    throw new NetlifyDeploymentError("preflight");
  }
};

export async function uploadHeldProductionNetlifyDeployment(
  input: ProductionNetlifyDeploymentInput,
  artifacts: PreparedNetlifyArtifacts,
  metadata: NetlifyDeployMetadata,
  dependencies: NetlifyDeploymentDependencies,
): Promise<HeldNetlifyDeployment> {
  authorizeProductionNetlify(input, artifacts.inventorySha256);
  return uploadHeldNetlifyDeploymentCore(input, artifacts, metadata, dependencies, "production");
}

async function publishHeldNetlifyDeploymentCore(
  input: NetlifyDeploymentCoreInput,
  held: HeldNetlifyDeployment,
  dependencies: NetlifyDeploymentDependencies,
  environment: "staging" | "production",
): Promise<{ publishedDeployId: string }> {
  validateTarget(input, environment);
  if (
    held.candidate !== input.candidate ||
    held.artifactSha256 !== input.preparation.artifacts.netlify.sha256 ||
    held.siteId !== input.siteId ||
    held.baselineDeployId !== input.baselineDeployId ||
    !identifier(held.candidateDeployId) ||
    !/^[a-f0-9]{64}$/u.test(held.artifactSha256)
  )
    throw new NetlifyDeploymentError("preflight");
  await site(input, dependencies, input.baselineDeployId, true);
  const ready = await candidate(input, dependencies, held.candidateDeployId);
  if (ready.state !== "ready") throw new NetlifyDeploymentError("preflight");
  const result = await mutate(
    dependencies,
    "restoreSiteDeploy",
    { siteId: input.siteId, deployId: held.candidateDeployId },
    { deployId: held.candidateDeployId, artifactSha256: held.artifactSha256 },
  );
  // A new restore ID needs an independently verified content mapping; fail closed until calibrated.
  if (result.id !== held.candidateDeployId) throw new NetlifyDeploymentError("ambiguous");
  await checkpointMutationResponse(dependencies, {
    artifactSha256: held.artifactSha256,
    deployId: held.candidateDeployId,
    operation: "restoreSiteDeploy",
    phase: "mutation-response-received",
    publishedDeployId: held.candidateDeployId,
  });
  try {
    await site(
      input,
      dependencies,
      held.candidateDeployId,
      environment === "production" ? true : null,
    );
  } catch {
    throw new NetlifyDeploymentError("ambiguous");
  }
  return { publishedDeployId: held.candidateDeployId };
}

export async function publishHeldNetlifyDeployment(
  input: NetlifyDeploymentInput,
  held: HeldNetlifyDeployment,
  dependencies: NetlifyDeploymentDependencies,
): Promise<{ publishedDeployId: string }> {
  return publishHeldNetlifyDeploymentCore(input, held, dependencies, "staging");
}

export async function publishHeldProductionNetlifyDeployment(
  input: ProductionNetlifyDeploymentInput,
  held: HeldNetlifyDeployment,
  dependencies: NetlifyDeploymentDependencies,
): Promise<{ publishedDeployId: string }> {
  authorizeProductionNetlify(input, held.artifactSha256);
  return publishHeldNetlifyDeploymentCore(input, held, dependencies, "production");
}

export type NetlifyDeploymentReconciliation =
  | { phase: "candidate-create-pending" }
  | { deployId: string; phase: "candidate-create-response-received" }
  | { held: HeldNetlifyDeployment; phase: "publish-pending" }
  | {
      held: HeldNetlifyDeployment;
      phase: "publish-response-received";
      publishedDeployId: string;
    };

const listCandidateDeploys = async (
  input: ProductionNetlifyDeploymentInput,
  dependencies: NetlifyDeploymentDependencies,
): Promise<string> => {
  const title = `release-${input.candidate}-${input.preparation.artifacts.netlify.sha256}`;
  const matching: unknown[] = [];
  // Each request gets up to 30 seconds within a two-minute discovery budget.
  const deadline = performance.now() + 120_000;
  for (let page = 1; page <= 100; page += 1) {
    const remaining = Math.floor(deadline - performance.now());
    if (remaining <= 0) throw new NetlifyDeploymentError("verification");
    const signal = AbortSignal.timeout(Math.min(30_000, remaining));
    let value: unknown;
    try {
      value = await dependencies.client(
        "listSiteDeploys",
        { page, per_page: 100, production: true, siteId: input.siteId },
        signal,
      );
    } catch {
      throw new NetlifyDeploymentError("verification");
    }
    if (performance.now() >= deadline || !Array.isArray(value))
      throw new NetlifyDeploymentError("verification");
    matching.push(
      ...value.filter(
        (entry) =>
          entry !== null &&
          typeof entry === "object" &&
          !Array.isArray(entry) &&
          (entry as Record<string, unknown>).title === title,
      ),
    );
    if (matching.length > 1) throw new NetlifyDeploymentError("ambiguous");
    if (value.length < 100) break;
    if (page === 100) throw new NetlifyDeploymentError("ambiguous");
  }
  if (matching.length !== 1) throw new NetlifyDeploymentError("ambiguous");
  const deployId = (matching[0] as Record<string, unknown>).id;
  if (!identifier(deployId) || deployId === input.baselineDeployId)
    throw new NetlifyDeploymentError("verification");
  return deployId;
};

const validateHeld = (
  input: ProductionNetlifyDeploymentInput,
  held: HeldNetlifyDeployment,
): void => {
  if (
    held.candidate !== input.candidate ||
    held.artifactSha256 !== input.preparation.artifacts.netlify.sha256 ||
    held.siteId !== input.siteId ||
    held.baselineDeployId !== input.baselineDeployId ||
    !identifier(held.candidateDeployId) ||
    held.context !== "production" ||
    held.state !== "ready"
  ) {
    throw new NetlifyDeploymentError("preflight");
  }
};

export async function reconcileNetlifyDeployment(
  input: ProductionNetlifyDeploymentInput,
  reconciliation: NetlifyDeploymentReconciliation,
  dependencies: NetlifyDeploymentDependencies,
): Promise<HeldNetlifyDeployment | { publishedDeployId: string }> {
  authorizeProductionNetlify(input, input.preparation.artifacts.netlify.sha256);
  validateTarget(input, "production");
  if (
    reconciliation.phase === "candidate-create-pending" ||
    reconciliation.phase === "candidate-create-response-received"
  ) {
    await site(input, dependencies, input.baselineDeployId, true);
    const deployId =
      reconciliation.phase === "candidate-create-pending"
        ? await listCandidateDeploys(input, dependencies)
        : reconciliation.deployId;
    if (!identifier(deployId)) throw new NetlifyDeploymentError("verification");
    const deploy = await candidate(input, dependencies, deployId);
    if (deploy.state !== "ready") throw new NetlifyDeploymentError("ambiguous");
    await site(input, dependencies, input.baselineDeployId, true);
    return {
      acknowledgedUploads: null,
      artifactSha256: input.preparation.artifacts.netlify.sha256,
      baselineDeployId: input.baselineDeployId,
      candidate: input.candidate,
      candidateDeployId: deployId,
      context: "production",
      siteId: input.siteId,
      state: "ready",
    };
  }
  validateHeld(input, reconciliation.held);
  if (
    reconciliation.phase === "publish-response-received" &&
    reconciliation.publishedDeployId !== reconciliation.held.candidateDeployId
  ) {
    throw new NetlifyDeploymentError("verification");
  }
  const deploy = await candidate(input, dependencies, reconciliation.held.candidateDeployId);
  if (deploy.state !== "ready") throw new NetlifyDeploymentError("ambiguous");
  try {
    await site(input, dependencies, reconciliation.held.candidateDeployId, true);
  } catch {
    throw new NetlifyDeploymentError("ambiguous");
  }
  return { publishedDeployId: reconciliation.held.candidateDeployId };
}

export async function verifyRetainedNetlifyDeployment(
  input: ProductionNetlifyDeploymentInput,
  held: HeldNetlifyDeployment,
  expectedPublishedDeployId: string,
  dependencies: NetlifyDeploymentDependencies,
): Promise<void> {
  authorizeProductionNetlify(input, held.artifactSha256);
  validateTarget(input, "production");
  validateHeld(input, held);
  if (
    !identifier(expectedPublishedDeployId) ||
    (expectedPublishedDeployId !== input.baselineDeployId &&
      expectedPublishedDeployId !== held.candidateDeployId)
  ) {
    throw new NetlifyDeploymentError("preflight");
  }
  const discoveredDeployId = await listCandidateDeploys(input, dependencies);
  if (discoveredDeployId !== held.candidateDeployId) {
    throw new NetlifyDeploymentError("verification");
  }
  const deploy = await candidate(input, dependencies, held.candidateDeployId);
  if (deploy.state !== "ready") throw new NetlifyDeploymentError("verification");
  await site(input, dependencies, expectedPublishedDeployId, true);
}

export async function createAuthenticatedNetlifyDeploymentClient(
  repositoryRoot: string,
): Promise<NetlifyDeploymentClient> {
  await assertPinnedCliVersions(
    repositoryRoot,
    ["netlify-cli"],
    () => new NetlifyDeploymentError("preflight"),
  );
  const [token] = await getToken();
  if (!token) throw new NetlifyDeploymentError("preflight");
  return async (operation, parameters, signal) => {
    const api = new NetlifyAPI(token, {
      host: "api.netlify.com",
      scheme: "https",
      pathPrefix: "/api/v1",
      userAgent: USER_AGENT,
      agent: createSingleDispatchAgent(undefined) as unknown as string,
    });
    const method = api[operation] as unknown as (
      parameters: Record<string, unknown>,
      options: { signal: AbortSignal; redirect: "error" },
    ) => Promise<unknown>;
    return method.call(api, parameters, { signal, redirect: "error" });
  };
}
