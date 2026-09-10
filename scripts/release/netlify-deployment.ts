import { preparedReleaseSchema, type PreparedRelease } from "./prepare.ts";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Readable } from "node:stream";
import { resolve } from "node:path";
import { NetlifyAPI } from "netlify-cli/dist/index.js";
import { getToken, USER_AGENT } from "netlify-cli/dist/utils/command-helpers.js";
import { createSingleDispatchAgent } from "./local-secrets.ts";
import { assertPinnedCliVersions } from "./bootstrap-safety.ts";
import { verifyNetlifyArtifacts, type PreparedNetlifyArtifacts } from "./netlify-artifacts.ts";

export type NetlifyDeploymentOperation =
  | "getSite"
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
export type NetlifyDeploymentCheckpoint = {
  operation: Exclude<NetlifyDeploymentOperation, "getSite" | "getSiteDeploy">;
  deployId?: string;
  artifactSha256: string;
};
export type NetlifyDeploymentDependencies = {
  client: NetlifyDeploymentClient;
  checkpoint: (value: NetlifyDeploymentCheckpoint) => Promise<void>;
  wait?: () => Promise<void>;
};
export type NetlifyDeploymentInput = {
  environment: "staging";
  siteId: string;
  accountId: string;
  origin: string;
  productionSiteId: string;
  baselineDeployId: string;
  candidate: string;
  preparation: PreparedRelease;
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
  acknowledgedUploads: number;
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
const validateTarget = (input: NetlifyDeploymentInput) => {
  const parsed = preparedReleaseSchema.safeParse(input.preparation);
  if (
    !parsed.success ||
    parsed.data.source.environment !== "staging" ||
    parsed.data.source.candidate !== input.candidate
  )
    throw new NetlifyDeploymentError("preflight");
  if (
    input.environment !== "staging" ||
    !identifier(input.siteId) ||
    !identifier(input.accountId) ||
    !identifier(input.productionSiteId) ||
    !identifier(input.baselineDeployId) ||
    input.siteId === input.productionSiteId ||
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
      operation === "getSite" || operation === "getSiteDeploy" ? "verification" : "ambiguous",
    );
  }
};
const mutate = async (
  dependencies: NetlifyDeploymentDependencies,
  operation: NetlifyDeploymentCheckpoint["operation"],
  parameters: Record<string, unknown>,
  checkpoint: Omit<NetlifyDeploymentCheckpoint, "operation">,
) => {
  try {
    await dependencies.checkpoint({ operation, ...checkpoint });
  } catch {
    throw new NetlifyDeploymentError("checkpoint");
  }
  return call(dependencies, operation, parameters);
};
const site = async (
  input: NetlifyDeploymentInput,
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
    settings.repo_url ||
    settings.repo_path ||
    published.id !== deployId ||
    (locked !== null && published.locked !== locked)
  )
    throw new NetlifyDeploymentError("verification");
  return published;
};
const candidate = async (
  input: NetlifyDeploymentInput,
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
    value.draft !== false ||
    value.state === "error"
  )
    throw new NetlifyDeploymentError("verification");
  return value;
};
const poll = async (
  input: NetlifyDeploymentInput,
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

export async function uploadHeldNetlifyDeployment(
  input: NetlifyDeploymentInput,
  artifacts: PreparedNetlifyArtifacts,
  metadata: NetlifyDeployMetadata,
  dependencies: NetlifyDeploymentDependencies,
): Promise<HeldNetlifyDeployment> {
  validateTarget(input);
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
    await mutate(
      dependencies,
      "lockDeploy",
      { deployId: input.baselineDeployId },
      { ...checkpoint, deployId: input.baselineDeployId },
    );
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
    const required = diff[field];
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
          response.sha !== digest ||
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

export async function publishHeldNetlifyDeployment(
  input: NetlifyDeploymentInput,
  held: HeldNetlifyDeployment,
  dependencies: NetlifyDeploymentDependencies,
): Promise<{ publishedDeployId: string }> {
  validateTarget(input);
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
  await site(input, dependencies, held.candidateDeployId, null);
  return { publishedDeployId: held.candidateDeployId };
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
