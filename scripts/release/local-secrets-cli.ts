import { constants } from "node:fs";
import { open, rename, unlink } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

import { z } from "zod/v4";

import { stagingBootstrapFingerprint } from "./bootstrap.ts";
import { stagingBootstrapFileInputSchema } from "./bootstrap-cli.ts";
import { readBoundedJson as readSafeBoundedJson } from "./bootstrap-safety.ts";
import {
  NETLIFY_LOCAL_SECRET_KEYS,
  provisionNetlifyLocalSecrets,
  STAGING_LOCAL_SECRET_KEYS,
  type LocalSecretsProvisionResult,
  type NetlifyLocalSecretsTarget,
  type StagingLocalSecretValues,
} from "./local-secrets.ts";
import { releaseConfigSchema } from "./schema.ts";

const repositoryRoot = fileURLToPath(new URL("../..", import.meta.url));
const MAX_INPUT_BYTES = 64 * 1024;
const MAX_CHECKPOINT_BYTES = 16 * 1024;

export const localSecretsUsage = `Usage:
  bun scripts/release/local-secrets-cli.ts --input <path> --bootstrap-checkpoint <path> --checkpoint <path>`;

export type LocalSecretsCliArguments = {
  inputPath: string;
  bootstrapCheckpointPath: string;
  checkpointPath: string;
};

type LocalSecretsCheckpointIdentity = {
  schemaVersion: 1;
  operation: "staging-local-secrets";
  accountId: string;
  siteId: string;
  siteName: string;
  productionSiteId: string;
  configurationFingerprint: string;
};

export type LocalSecretsPendingCheckpoint = LocalSecretsCheckpointIdentity & {
  phase: "pending-secret-provision";
  result: null;
};

export type LocalSecretsFinalCheckpoint = LocalSecretsCheckpointIdentity & {
  phase: "complete" | "blocked";
  result: LocalSecretsProvisionResult;
};

type JsonReader = (path: string, maxBytes: number) => Promise<unknown>;

export type LocalSecretsCliDependencies = {
  environment: Record<string, string | undefined>;
  readJson: JsonReader;
  createPendingCheckpoint: (
    path: string,
    checkpoint: LocalSecretsPendingCheckpoint,
  ) => Promise<void>;
  finalizeCheckpoint: (path: string, checkpoint: LocalSecretsFinalCheckpoint) => Promise<void>;
  provision: typeof provisionNetlifyLocalSecrets;
  productionConfigPath: string;
};

export class LocalSecretsCliError extends Error {
  readonly stage: LocalSecretsProvisionResult["stage"];

  constructor(stage: LocalSecretsProvisionResult["stage"]) {
    super("Staging local-secret provisioning could not continue safely.");
    this.name = "LocalSecretsCliError";
    this.stage = stage;
  }
}

const identifierSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/u);
const fingerprintSchema = z.string().regex(/^[0-9a-f]{64}$/u);
const bootstrapCheckpointSchema = z.strictObject({
  schemaVersion: z.literal(1),
  inputFingerprint: fingerprintSchema,
  phase: z.literal("awaiting-operator-secrets"),
  siteId: identifierSchema,
});

export function parseLocalSecretsArguments(
  args: readonly string[],
  cwd: string,
): LocalSecretsCliArguments {
  let parsed;
  try {
    parsed = parseArgs({
      args,
      allowPositionals: false,
      strict: true,
      tokens: true,
      options: {
        input: { type: "string" },
        "bootstrap-checkpoint": { type: "string" },
        checkpoint: { type: "string" },
      },
    });
  } catch {
    throw new LocalSecretsCliError("configuration");
  }

  const input = parsed.values.input;
  const bootstrapCheckpoint = parsed.values["bootstrap-checkpoint"];
  const checkpoint = parsed.values.checkpoint;
  const optionCounts = new Map<string, number>();
  for (const token of parsed.tokens) {
    if (token.kind === "option") {
      optionCounts.set(token.name, (optionCounts.get(token.name) ?? 0) + 1);
    }
  }
  if (
    !input ||
    !bootstrapCheckpoint ||
    !checkpoint ||
    optionCounts.size !== 3 ||
    [...optionCounts.values()].some((count) => count !== 1)
  ) {
    throw new LocalSecretsCliError("configuration");
  }

  return {
    inputPath: resolve(cwd, input),
    bootstrapCheckpointPath: resolve(cwd, bootstrapCheckpoint),
    checkpointPath: resolve(cwd, checkpoint),
  };
}

const readBoundedJson: JsonReader = async (path, maxBytes) => {
  return readSafeBoundedJson(path, maxBytes, () => new LocalSecretsCliError("configuration"));
};

const syncDirectory = async (path: string): Promise<void> => {
  const directory = await open(dirname(path), constants.O_RDONLY);
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
};

export const createPendingLocalSecretsCheckpoint = async (
  path: string,
  checkpoint: LocalSecretsPendingCheckpoint,
): Promise<void> => {
  let handle;
  let created = false;
  try {
    handle = await open(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
    created = true;
    await handle.writeFile(`${JSON.stringify(checkpoint)}\n`, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await syncDirectory(path);
  } catch {
    await handle?.close().catch(() => undefined);
    if (created) await unlink(path).catch(() => undefined);
    throw new LocalSecretsCliError("preflight");
  }
};

export const finalizeLocalSecretsCheckpoint = async (
  path: string,
  checkpoint: LocalSecretsFinalCheckpoint,
): Promise<void> => {
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
    await syncDirectory(path);
  } catch {
    await handle?.close().catch(() => undefined);
    await unlink(temporaryPath).catch(() => undefined);
    throw new LocalSecretsCliError("postflight");
  }
};

const readAndScrubSecrets = (
  environment: Record<string, string | undefined>,
): StagingLocalSecretValues => {
  const copied: Partial<Record<(typeof STAGING_LOCAL_SECRET_KEYS)[number], string>> = {};
  for (const key of STAGING_LOCAL_SECRET_KEYS) {
    const value = environment[key];
    delete environment[key];
    if (value !== undefined) copied[key] = value;
  }
  return copied as StagingLocalSecretValues;
};

const loadTarget = async (
  parsed: LocalSecretsCliArguments,
  dependencies: LocalSecretsCliDependencies,
): Promise<{
  target: NetlifyLocalSecretsTarget;
  configurationFingerprint: string;
}> => {
  let rawInput: unknown;
  let rawBootstrapCheckpoint: unknown;
  let rawProductionConfig: unknown;
  try {
    [rawInput, rawBootstrapCheckpoint, rawProductionConfig] = await Promise.all([
      dependencies.readJson(parsed.inputPath, MAX_INPUT_BYTES),
      dependencies.readJson(parsed.bootstrapCheckpointPath, MAX_CHECKPOINT_BYTES),
      dependencies.readJson(dependencies.productionConfigPath, MAX_INPUT_BYTES),
    ]);
  } catch {
    throw new LocalSecretsCliError("configuration");
  }

  const input = stagingBootstrapFileInputSchema.safeParse(rawInput);
  const bootstrapCheckpoint = bootstrapCheckpointSchema.safeParse(rawBootstrapCheckpoint);
  const config = releaseConfigSchema.safeParse(rawProductionConfig);
  const production = config.success ? config.data.environments.production.netlify : null;
  if (!input.success || !bootstrapCheckpoint.success || !production) {
    throw new LocalSecretsCliError("configuration");
  }
  const completeInput = { ...input.data, productionSiteId: production.siteId };
  const configurationFingerprint = stagingBootstrapFingerprint(completeInput);
  const configuredSecrets = new Set(production.requiredSecretNames);
  if (
    input.data.accountId !== production.accountId ||
    configuredSecrets.size !== NETLIFY_LOCAL_SECRET_KEYS.length ||
    NETLIFY_LOCAL_SECRET_KEYS.some((key) => !configuredSecrets.has(key)) ||
    bootstrapCheckpoint.data.inputFingerprint !== configurationFingerprint ||
    bootstrapCheckpoint.data.siteId === production.siteId
  ) {
    throw new LocalSecretsCliError("target");
  }

  return {
    target: {
      accountId: input.data.accountId,
      productionSiteId: production.siteId,
      siteId: bootstrapCheckpoint.data.siteId,
      siteName: input.data.siteName,
    },
    configurationFingerprint,
  };
};

const defaultDependencies: LocalSecretsCliDependencies = {
  environment: process.env,
  readJson: readBoundedJson,
  createPendingCheckpoint: createPendingLocalSecretsCheckpoint,
  finalizeCheckpoint: finalizeLocalSecretsCheckpoint,
  provision: provisionNetlifyLocalSecrets,
  productionConfigPath: resolve(repositoryRoot, "scripts/release/environments.json"),
};

const provisionStages = new Set<LocalSecretsProvisionResult["stage"]>([
  "configuration",
  "authentication",
  "target",
  "preflight",
  "mutation",
  "postflight",
  "complete",
]);

const sanitizeProvisionResult = (value: unknown): LocalSecretsProvisionResult => {
  if (
    typeof value !== "object" ||
    value === null ||
    !("outcome" in value) ||
    !("stage" in value) ||
    (value.outcome !== "passed" && value.outcome !== "blocked") ||
    typeof value.stage !== "string" ||
    !provisionStages.has(value.stage as LocalSecretsProvisionResult["stage"]) ||
    (value.outcome === "passed" && value.stage !== "complete") ||
    (value.outcome === "blocked" && value.stage === "complete")
  ) {
    return { outcome: "blocked", stage: "mutation" };
  }
  return {
    outcome: value.outcome,
    stage: value.stage as LocalSecretsProvisionResult["stage"],
  };
};

export async function runLocalSecretsCli(
  args: readonly string[],
  cwd = process.cwd(),
  overrides: Partial<LocalSecretsCliDependencies> = {},
): Promise<LocalSecretsProvisionResult> {
  const dependencies = { ...defaultDependencies, ...overrides };
  try {
    const parsed = parseLocalSecretsArguments(args, cwd);
    const { target, configurationFingerprint } = await loadTarget(parsed, dependencies);
    const values = readAndScrubSecrets(dependencies.environment);
    const identity: LocalSecretsCheckpointIdentity = {
      schemaVersion: 1,
      operation: "staging-local-secrets",
      accountId: target.accountId,
      siteId: target.siteId,
      siteName: target.siteName,
      productionSiteId: target.productionSiteId,
      configurationFingerprint,
    };
    try {
      await dependencies.createPendingCheckpoint(parsed.checkpointPath, {
        ...identity,
        phase: "pending-secret-provision",
        result: null,
      });
    } catch {
      return { outcome: "blocked", stage: "preflight" };
    }

    let result: LocalSecretsProvisionResult;
    try {
      result = sanitizeProvisionResult(await dependencies.provision(target, values));
    } catch {
      result = { outcome: "blocked", stage: "mutation" };
    }
    try {
      await dependencies.finalizeCheckpoint(parsed.checkpointPath, {
        ...identity,
        phase: result.outcome === "passed" ? "complete" : "blocked",
        result,
      });
    } catch {
      return { outcome: "blocked", stage: "postflight" };
    }
    return result;
  } catch (error) {
    return {
      outcome: "blocked",
      stage: error instanceof LocalSecretsCliError ? error.stage : "configuration",
    };
  }
}

const writeResultAndExit = async (result: LocalSecretsProvisionResult): Promise<never> => {
  await new Promise<void>((resolveOutput) => {
    process.stdout.write(`${JSON.stringify(result)}\n`, () => resolveOutput());
  });
  process.exit(result.outcome === "passed" ? 0 : 1);
};

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (invokedDirectly) {
  await writeResultAndExit(await runLocalSecretsCli(process.argv.slice(2)));
}
