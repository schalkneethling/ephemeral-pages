import { resolve } from "node:path";
import { parseArgs } from "node:util";

import { environmentSchema, fullCommitSchema, type ReleaseEnvironment } from "./schema.ts";

export const releaseUsage = `Usage:
  bun run release:plan --environment <staging|production> --candidate <full-sha> --baseline <path> [--config <path>] [--json]
  bun run release:status --environment <staging|production> --baseline <path> [--config <path>] [--json]`;

type CommonArguments = {
  baselinePath: string;
  configPath: string;
  configSource: "default" | "override";
  environment: ReleaseEnvironment;
  json: boolean;
};

export type ReleaseArguments =
  | (CommonArguments & { operation: "plan"; candidate: string })
  | (CommonArguments & { operation: "status" });

export class ReleaseUsageError extends Error {
  constructor() {
    super("Invalid release command arguments.");
    this.name = "ReleaseUsageError";
  }
}

export function parseReleaseArguments(
  args: readonly string[],
  { cwd, repositoryRoot }: { cwd: string; repositoryRoot: string },
): ReleaseArguments {
  let parsed;
  try {
    parsed = parseArgs({
      args,
      allowPositionals: true,
      strict: true,
      options: {
        environment: { type: "string" },
        candidate: { type: "string" },
        baseline: { type: "string" },
        config: {
          type: "string",
          default: resolve(repositoryRoot, "scripts/release/environments.json"),
        },
        json: { type: "boolean", default: false },
      },
    });
  } catch {
    throw new ReleaseUsageError();
  }

  const [operation, ...extraPositionals] = parsed.positionals;
  const environment = environmentSchema.safeParse(parsed.values.environment);
  if (
    (operation !== "plan" && operation !== "status") ||
    extraPositionals.length > 0 ||
    !environment.success ||
    !parsed.values.baseline ||
    !parsed.values.config
  ) {
    throw new ReleaseUsageError();
  }
  const defaultConfigPath = resolve(repositoryRoot, "scripts/release/environments.json");
  const configPath = resolve(cwd, parsed.values.config);
  const common = {
    environment: environment.data,
    baselinePath: resolve(cwd, parsed.values.baseline),
    configPath,
    configSource: configPath === defaultConfigPath ? ("default" as const) : ("override" as const),
    json: parsed.values.json,
  };
  if (operation === "plan") {
    const candidate = fullCommitSchema.safeParse(parsed.values.candidate);
    if (!candidate.success) throw new ReleaseUsageError();
    return { operation, candidate: candidate.data, ...common };
  }
  if (parsed.values.candidate !== undefined) throw new ReleaseUsageError();
  return { operation, ...common };
}
