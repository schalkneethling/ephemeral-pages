import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { artifactHash, assertExternalArtifactDirectory } from "./artifact-contract.ts";
import { createAtomicJsonStore } from "./bootstrap-safety.ts";
import { readReleaseJson } from "./files.ts";
import {
  createGitHubReleaseApi,
  GitHubReleaseError,
  verifyStagingInvocation,
  type GitHubRuntimeEnvironment,
} from "./github-release.ts";
import { prepareRelease } from "./prepare.ts";
import { inspectStagingDeploymentPair } from "./rehearsal-cli.ts";
import {
  defaultRehearsalHistoryDependencies,
  verifyRehearsalHistory,
  type RehearsalPreflightRecord,
} from "./rehearsal-history.ts";
import { releaseBaselineSchema } from "./schema.ts";

export function parseRehearsalPreflightArguments(args: readonly string[], cwd: string) {
  const { values, tokens } = parseArgs({
    args,
    strict: true,
    allowPositionals: false,
    tokens: true,
    options: {
      workspace: { type: "string" },
      "calibration-only": { type: "boolean" },
    },
  });
  const names = tokens.filter((token) => token.kind === "option").map((token) => token.name);
  if (
    !values.workspace ||
    names.filter((name) => name === "workspace").length !== 1 ||
    new Set(names).size !== names.length
  ) {
    throw new Error("An exclusive rehearsal workspace is required.");
  }
  return {
    workspace: resolve(cwd, values.workspace),
    calibrationOnly: values["calibration-only"] === true,
  };
}

export async function runRehearsalPreflight(argv: readonly string[], repositoryRoot: string) {
  const { calibrationOnly, workspace } = parseRehearsalPreflightArguments(argv, process.cwd());
  await assertExternalArtifactDirectory(repositoryRoot, workspace);
  const token = process.env.GITHUB_TOKEN ?? "";
  const api = createGitHubReleaseApi({ token });
  const invocation = await verifyStagingInvocation(api, process.env as GitHubRuntimeEnvironment);
  if (!calibrationOnly) {
    const baseline = await readReleaseJson(
      resolve(repositoryRoot, "docs/release-evidence/production-baseline.json"),
      releaseBaselineSchema,
    );
    if (
      baseline.environment !== "production" ||
      !baseline.providers.netlify?.sourceCommit ||
      !baseline.providers.cloudflare?.sourceCommit ||
      baseline.providers.cloudflare.traffic.length !== 1 ||
      baseline.providers.cloudflare.traffic[0].percentage !== 100
    ) {
      throw new Error("A known-source production baseline is required.");
    }
  }
  await verifyRehearsalHistory(
    api,
    { current: invocation, token, repositoryRoot },
    defaultRehearsalHistoryDependencies(() => inspectStagingDeploymentPair(repositoryRoot)),
  );
  const directory = resolve(workspace, "preflight");
  await mkdir(workspace, { mode: 0o700 });
  const prepared = await prepareRelease({
    repositoryRoot,
    artifactDirectory: resolve(workspace, "artifacts"),
    candidate: invocation.headSha,
    environment: "staging",
  });
  await mkdir(directory, { mode: 0o700 });
  const record: RehearsalPreflightRecord = {
    schemaVersion: 1,
    operation: "staging-rehearsal-preflight",
    runId: invocation.runId,
    workflowCommit: invocation.headSha,
    calibrationOnly,
    preparationSha256: artifactHash(JSON.stringify(prepared)),
    outcome: "passed",
  };
  await createAtomicJsonStore<RehearsalPreflightRecord>(
    resolve(directory, "rehearsal.json"),
    1024 * 1024,
    () => new Error("Cannot persist rehearsal preflight evidence."),
  ).save(record);
  return record;
}

const failureCode = (error: unknown): string =>
  error instanceof GitHubReleaseError ? `github-${error.kind}` : "rehearsal-preflight-blocked";

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = await runRehearsalPreflight(
      process.argv.slice(2),
      fileURLToPath(new URL("../..", import.meta.url)),
    );
    process.stdout.write(JSON.stringify(result) + "\n");
  } catch (error) {
    process.stderr.write(`Staging rehearsal preflight blocked (${failureCode(error)}).\n`);
    process.exitCode = 1;
  }
}
