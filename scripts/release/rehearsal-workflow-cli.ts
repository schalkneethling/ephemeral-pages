import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { artifactHash } from "./artifact-contract.ts";
import { readReleaseJson } from "./files.ts";
import {
  createGitHubReleaseApi,
  GitHubReleaseError,
  verifyStagingInvocation,
  type GitHubRuntimeEnvironment,
} from "./github-release.ts";
import { preparedReleaseSchema } from "./prepare.ts";
import { writeReleaseApproval } from "./production-approval.ts";
import { runRehearsalCli } from "./rehearsal-cli.ts";
import { rehearsalPreflightRecordSchema } from "./rehearsal-history.ts";
import { verifyProductionWorkspace } from "./production-workspace.ts";

export function parseRehearsalWorkflowArguments(args: readonly string[], cwd: string) {
  const { values, tokens } = parseArgs({
    args,
    strict: true,
    allowPositionals: false,
    tokens: true,
    options: {
      workspace: { type: "string" },
      "confirm-external-smoke": { type: "boolean" },
      capture: { type: "boolean" },
      "calibration-only": { type: "boolean" },
    },
  });
  const names = tokens.filter((token) => token.kind === "option").map((token) => token.name);
  if (
    !values.workspace ||
    !values["confirm-external-smoke"] ||
    !values.capture ||
    names.length !== new Set(names).size
  )
    throw new Error("Explicit rehearsal and screenshot confirmation is required.");
  return {
    workspace: resolve(cwd, values.workspace),
    calibrationOnly: values["calibration-only"] === true,
  };
}
export async function runRehearsalWorkflow(argv: readonly string[], repositoryRoot: string) {
  const { calibrationOnly, workspace } = parseRehearsalWorkflowArguments(argv, process.cwd());
  const token = process.env.GITHUB_TOKEN ?? "";
  const api = createGitHubReleaseApi({ token });
  const invocation = await verifyStagingInvocation(api, process.env as GitHubRuntimeEnvironment);
  await verifyProductionWorkspace(repositoryRoot, workspace);
  const preflight = await readReleaseJson(
    resolve(workspace, "preflight/rehearsal.json"),
    rehearsalPreflightRecordSchema,
  );
  const artifacts = resolve(workspace, "artifacts"),
    reports = resolve(workspace, "reports"),
    approvalDirectory = resolve(workspace, "approval");
  const prepared = await readReleaseJson(
    resolve(artifacts, "prepared-release.json"),
    preparedReleaseSchema,
  );
  if (
    preflight.runId !== invocation.runId ||
    preflight.workflowCommit !== invocation.headSha ||
    preflight.calibrationOnly !== calibrationOnly ||
    preflight.preparationSha256 !== artifactHash(JSON.stringify(prepared)) ||
    prepared.source.environment !== "staging" ||
    prepared.source.candidate !== invocation.headSha
  ) {
    throw new Error("Rehearsal preflight evidence differs.");
  }
  const baselinePath = resolve(repositoryRoot, "docs/release-evidence/production-baseline.json");
  const rehearsal = await runRehearsalCli(
    ["--artifacts", artifacts, "--output", reports, "--confirm-external-smoke", "--capture"],
    repositoryRoot,
  );
  if (rehearsal.outcome !== "passed") throw new Error("Rehearsal did not pass.");
  await verifyStagingInvocation(api, process.env as GitHubRuntimeEnvironment);
  if (calibrationOnly) {
    return { schemaVersion: 1, operation: "staging-calibration", outcome: "passed" } as const;
  }
  await mkdir(approvalDirectory, { mode: 0o700 });
  await Promise.all([
    writeFile(
      resolve(approvalDirectory, "staging-preparation.json"),
      JSON.stringify(prepared) + "\n",
      { flag: "wx", mode: 0o600 },
    ),
    writeFile(resolve(approvalDirectory, "rehearsal.json"), JSON.stringify(rehearsal) + "\n", {
      flag: "wx",
      mode: 0o600,
    }),
  ]);
  return writeReleaseApproval(repositoryRoot, approvalDirectory, baselinePath);
}

export function rehearsalWorkflowFailureCode(error: unknown): string {
  return error instanceof GitHubReleaseError ? `github-${error.kind}` : "rehearsal-blocked";
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = await runRehearsalWorkflow(
      process.argv.slice(2),
      fileURLToPath(new URL("../..", import.meta.url)),
    );
    process.stdout.write(JSON.stringify(result) + "\n");
  } catch (error) {
    process.stderr.write(
      `Staging rehearsal blocked (${rehearsalWorkflowFailureCode(error)}); inspect sanitized workflow reports.\n`,
    );
    process.exitCode = 1;
  }
}
