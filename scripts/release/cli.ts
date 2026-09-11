import { relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { parseReleaseArguments, releaseUsage, ReleaseUsageError } from "./args.ts";
import { runRehearsalCli } from "./rehearsal-cli.ts";
import { parsePrepareArguments } from "./prepare-args.ts";
import { prepareRelease } from "./prepare.ts";
import { createDeadlineProviderCommandRunner } from "./command.ts";
import { readReleaseJson } from "./files.ts";
import { createGitClient } from "./git.ts";
import { releasePlan, releaseStatus } from "./planner.ts";
import { inspectCloudflare, inspectNetlify } from "./providers.ts";
import { renderReleaseReport } from "./render.ts";
import { releaseBaselineSchema, releaseConfigSchema } from "./schema.ts";

const repositoryRoot = fileURLToPath(new URL("../..", import.meta.url));

function repositoryPath(path: string) {
  const candidate = relative(repositoryRoot, path);
  if (!candidate || candidate === ".." || candidate.startsWith(`..${sep}`)) return null;
  return candidate.split(sep).join("/");
}

function absoluteRepositoryPath(path: string) {
  const absolute = resolve(repositoryRoot, path);
  if (repositoryPath(absolute) === null) throw new Error("Invalid repository path.");
  return absolute;
}

async function main() {
  if (process.argv[2] === "rehearse") {
    const report = await runRehearsalCli(process.argv.slice(3), repositoryRoot);
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    if (report.outcome !== "passed") process.exitCode = 1;
    return;
  }
  if (process.argv[2] === "prepare") {
    const input = parsePrepareArguments(process.argv.slice(3), repositoryRoot, process.cwd());
    const report = await prepareRelease(input);
    process.stdout.write(
      process.argv.includes("--json")
        ? `${JSON.stringify(report, null, 2)}\n`
        : `Prepared ${report.source.environment} artifacts for ${report.source.candidate}.\nRecord: ${resolve(input.artifactDirectory, "prepared-release.json")}\n`,
    );
    return;
  }
  const args = parseReleaseArguments(process.argv.slice(2), {
    cwd: process.cwd(),
    repositoryRoot,
  });
  const [config, baseline] = await Promise.all([
    readReleaseJson(args.configPath, releaseConfigSchema),
    readReleaseJson(args.baselinePath, releaseBaselineSchema),
  ]);
  const commandOptions = { cwd: resolve(repositoryRoot), timeoutMs: 30_000 };
  const dependencies = {
    git: createGitClient(commandOptions),
    inspectCloudflare: (
      config: Parameters<typeof inspectCloudflare>[0],
      run: Parameters<typeof inspectCloudflare>[1],
    ) =>
      inspectCloudflare(
        { ...config, wranglerConfigPath: absoluteRepositoryPath(config.wranglerConfigPath) },
        run,
      ),
    inspectNetlify,
    createProviderRunner: (timeoutMs: number) =>
      createDeadlineProviderCommandRunner(commandOptions, timeoutMs),
  };
  const input = {
    baseline,
    config,
    configRepositoryPath: repositoryPath(args.configPath),
    configSource: args.configSource,
    environment: args.environment,
  };
  const report =
    args.operation === "plan"
      ? await releasePlan({ ...input, candidate: args.candidate }, dependencies)
      : await releaseStatus(input, dependencies);
  process.stdout.write(
    args.json ? `${JSON.stringify(report, null, 2)}\n` : renderReleaseReport(report),
  );
  if (report.outcome === "blocked") process.exitCode = 1;
}

const jsonRequested = process.argv.slice(2).includes("--json");
try {
  await main();
} catch (error) {
  if (jsonRequested) {
    process.stdout.write(
      `${JSON.stringify({
        schemaVersion: 1,
        operation: "preflight",
        outcome: "blocked",
        reason: error instanceof ReleaseUsageError ? "invalid-arguments" : "invalid-input",
      })}\n`,
    );
  } else {
    process.stderr.write(
      error instanceof ReleaseUsageError
        ? `${error.message}\n${releaseUsage}\n`
        : "Release inspection failed before a safe report could be produced.\n",
    );
  }
  process.exitCode = 1;
}
