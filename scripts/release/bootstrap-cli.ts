import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

import { z } from "zod/v4";

import {
  bootstrapNetlifyStaging,
  recoverPendingNetlifySite,
  recoverPendingNetlifyVariables,
  StagingBootstrapError,
  type NetlifyStagingBootstrapInput,
  type NetlifyStagingBootstrapStore,
} from "./bootstrap.ts";
import { createDeadlineProviderCommandRunner } from "./command.ts";
import { releaseConfigSchema } from "./schema.ts";
import {
  assertPinnedCliVersions,
  createAtomicJsonStore,
  readBoundedJson,
  withExclusiveFileLock,
} from "./bootstrap-safety.ts";

const repositoryRoot = fileURLToPath(new URL("../..", import.meta.url));
const MAX_INPUT_BYTES = 64 * 1024;
const MAX_CHECKPOINT_BYTES = 16 * 1024;

export const stagingBootstrapUsage = `Usage:
  bun scripts/release/bootstrap-cli.ts --input <path> --checkpoint <path>
  bun scripts/release/bootstrap-cli.ts --input <path> --checkpoint <path> --recover-site <site-id>
  bun scripts/release/bootstrap-cli.ts --input <path> --checkpoint <path> --recover-variables`;

const identifierSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/u);
const siteNameSchema = z.string().regex(/^[A-Za-z0-9-]{1,63}$/u);
const valueSchema = z.string().min(1).max(2_048);
export const stagingBootstrapFileInputSchema = z.strictObject({
  accountId: identifierSchema,
  accountSlug: siteNameSchema,
  siteName: siteNameSchema,
  nonSecretVariables: z.strictObject({
    PUBLIC_BASE_URL: valueSchema,
    COLLABORATION_SERVICE_URL: valueSchema,
    COLLABORATION_WEBSOCKET_URL: valueSchema,
    COLLABORATION_TICKET_AUDIENCE: valueSchema,
    COLLABORATION_CAPABILITY_CURRENT_VERSION: valueSchema,
    COLLABORATION_ENABLED: valueSchema,
    GITHUB_OIDC_AUDIENCE: valueSchema,
  }),
});

export type StagingBootstrapFileInput = z.infer<typeof stagingBootstrapFileInputSchema>;

export type StagingBootstrapCliArguments = {
  inputPath: string;
  checkpointPath: string;
  recovery: { kind: "site"; siteId: string } | { kind: "variables" } | null;
};

export class StagingBootstrapCliError extends Error {
  readonly kind: "invalid-arguments" | "invalid-input" | "locked" | "version";

  constructor(kind: StagingBootstrapCliError["kind"]) {
    super("Staging bootstrap could not start safely.");
    this.name = "StagingBootstrapCliError";
    this.kind = kind;
  }
}

export function parseStagingBootstrapArguments(
  args: readonly string[],
  cwd: string,
): StagingBootstrapCliArguments {
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
        "recover-site": { type: "string" },
        "recover-variables": { type: "boolean", default: false },
      },
    });
  } catch {
    throw new StagingBootstrapCliError("invalid-arguments");
  }
  const { input, checkpoint } = parsed.values;
  const recoverSite = parsed.values["recover-site"];
  const recoverVariables = parsed.values["recover-variables"];
  const optionCounts = new Map<string, number>();
  for (const token of parsed.tokens) {
    if (token.kind === "option") {
      optionCounts.set(token.name, (optionCounts.get(token.name) ?? 0) + 1);
    }
  }
  if (
    !input ||
    !checkpoint ||
    [...optionCounts.values()].some((count) => count !== 1) ||
    (recoverSite !== undefined && recoverVariables) ||
    (recoverSite !== undefined && !identifierSchema.safeParse(recoverSite).success)
  ) {
    throw new StagingBootstrapCliError("invalid-arguments");
  }
  return {
    inputPath: resolve(cwd, input),
    checkpointPath: resolve(cwd, checkpoint),
    recovery:
      recoverSite !== undefined
        ? { kind: "site", siteId: recoverSite }
        : recoverVariables
          ? { kind: "variables" }
          : null,
  };
}

export async function assertPinnedBootstrapToolVersions(root: string): Promise<void> {
  await assertPinnedCliVersions(
    root,
    ["netlify-cli", "wrangler"],
    () => new StagingBootstrapCliError("version"),
  );
}

export function createAtomicBootstrapStore(path: string): NetlifyStagingBootstrapStore {
  return createAtomicJsonStore(
    path,
    MAX_CHECKPOINT_BYTES,
    () => new StagingBootstrapCliError("invalid-input"),
  );
}

export async function withExclusiveBootstrapLock<T>(
  checkpointPath: string,
  operation: () => Promise<T>,
): Promise<T> {
  return withExclusiveFileLock(
    checkpointPath,
    operation,
    (kind) => new StagingBootstrapCliError(kind),
  );
}

type BootstrapCliReport =
  | {
      schemaVersion: 1;
      operation: "staging-bootstrap";
      outcome: "checkpoint";
      status: "awaiting-operator-secrets";
      accountId: string;
      siteId: string;
      siteName: string;
      inputFingerprint: string;
    }
  | {
      schemaVersion: 1;
      operation: "staging-bootstrap";
      outcome: "recovered";
      phase: "site-created" | "awaiting-operator-secrets";
    };

const loadBootstrapInput = async (inputPath: string): Promise<NetlifyStagingBootstrapInput> => {
  const [rawInput, rawConfig] = await Promise.all([
    readBoundedJson(
      inputPath,
      MAX_INPUT_BYTES,
      () => new StagingBootstrapCliError("invalid-input"),
    ),
    readBoundedJson(
      resolve(repositoryRoot, "scripts/release/environments.json"),
      MAX_INPUT_BYTES,
      () => new StagingBootstrapCliError("invalid-input"),
    ),
  ]);
  const input = stagingBootstrapFileInputSchema.safeParse(rawInput);
  const config = releaseConfigSchema.safeParse(rawConfig);
  const production = config.success ? config.data.environments.production.netlify : null;
  if (!input.success || !production || input.data.accountId !== production.accountId) {
    throw new StagingBootstrapCliError("invalid-input");
  }
  return { ...input.data, productionSiteId: production.siteId };
};

export async function runStagingBootstrapCli(
  args: readonly string[],
  cwd = process.cwd(),
): Promise<BootstrapCliReport> {
  const parsed = parseStagingBootstrapArguments(args, cwd);
  await assertPinnedBootstrapToolVersions(repositoryRoot);
  return withExclusiveBootstrapLock(parsed.checkpointPath, async () => {
    const input = await loadBootstrapInput(parsed.inputPath);
    const dependencies = {
      run: createDeadlineProviderCommandRunner(
        { cwd: repositoryRoot, maxOutputBytes: 1024 * 1024, timeoutMs: 30_000 },
        120_000,
      ),
      store: createAtomicBootstrapStore(parsed.checkpointPath),
    };
    if (parsed.recovery?.kind === "site") {
      await recoverPendingNetlifySite(input, parsed.recovery.siteId, dependencies);
      return {
        schemaVersion: 1,
        operation: "staging-bootstrap",
        outcome: "recovered",
        phase: "site-created",
      };
    }
    if (parsed.recovery?.kind === "variables") {
      const phase = await recoverPendingNetlifyVariables(input, dependencies);
      return {
        schemaVersion: 1,
        operation: "staging-bootstrap",
        outcome: "recovered",
        phase,
      };
    }
    return {
      schemaVersion: 1,
      operation: "staging-bootstrap",
      outcome: "checkpoint",
      ...(await bootstrapNetlifyStaging(input, dependencies)),
    };
  });
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (invokedDirectly) {
  try {
    process.stdout.write(
      `${JSON.stringify(await runStagingBootstrapCli(process.argv.slice(2)))}\n`,
    );
  } catch (error) {
    const reason =
      error instanceof StagingBootstrapCliError
        ? error.kind
        : error instanceof StagingBootstrapError
          ? error.kind
          : "invalid-input";
    process.stdout.write(
      `${JSON.stringify({
        schemaVersion: 1,
        operation: "staging-bootstrap",
        outcome: "blocked",
        reason,
      })}\n`,
    );
    if (error instanceof StagingBootstrapCliError && error.kind === "invalid-arguments") {
      process.stderr.write(`${stagingBootstrapUsage}\n`);
    }
    process.exitCode = 1;
  }
}
