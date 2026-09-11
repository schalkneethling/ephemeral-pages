import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { assertExternalArtifactDirectory } from "./artifact-contract.ts";
import { readReleaseJson } from "./files.ts";
import {
  createGitHubReleaseApi,
  verifyStagingInvocation,
  type GitHubRuntimeEnvironment,
} from "./github-release.ts";
import { prepareRelease } from "./prepare.ts";
import { writeReleaseApproval } from "./production-approval.ts";
import { runRehearsalCli } from "./rehearsal-cli.ts";
import { releaseBaselineSchema } from "./schema.ts";

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
  return { workspace: resolve(cwd, values.workspace) };
}
export async function runRehearsalWorkflow(argv: readonly string[], repositoryRoot: string) {
  const { workspace } = parseRehearsalWorkflowArguments(argv, process.cwd());
  await assertExternalArtifactDirectory(repositoryRoot, workspace);
  const api = createGitHubReleaseApi({ token: process.env.GITHUB_TOKEN ?? "" });
  const invocation = await verifyStagingInvocation(api, process.env as GitHubRuntimeEnvironment);
  // This reviewed baseline is intentionally not synthesized from whichever
  // commit happens to be checked out. Missing provenance blocks before quotas.
  const baselinePath = resolve(repositoryRoot, "docs/release-evidence/production-baseline.json");
  const baseline = await readReleaseJson(baselinePath, releaseBaselineSchema);
  if (
    baseline.environment !== "production" ||
    !baseline.providers.netlify?.sourceCommit ||
    !baseline.providers.cloudflare?.sourceCommit ||
    baseline.providers.cloudflare.traffic.length !== 1 ||
    baseline.providers.cloudflare.traffic[0].percentage !== 100
  )
    throw new Error("A known-source production baseline is required.");
  await mkdir(workspace, { mode: 0o700 });
  const artifacts = resolve(workspace, "artifacts"),
    reports = resolve(workspace, "reports"),
    approvalDirectory = resolve(workspace, "approval");
  const prepared = await prepareRelease({
    repositoryRoot,
    artifactDirectory: artifacts,
    candidate: invocation.headSha,
    environment: "staging",
  });
  const rehearsal = await runRehearsalCli(
    ["--artifacts", artifacts, "--output", reports, "--confirm-external-smoke", "--capture"],
    repositoryRoot,
  );
  if (rehearsal.outcome !== "passed") throw new Error("Rehearsal did not pass.");
  await verifyStagingInvocation(api, process.env as GitHubRuntimeEnvironment);
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
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = await runRehearsalWorkflow(
      process.argv.slice(2),
      fileURLToPath(new URL("../..", import.meta.url)),
    );
    process.stdout.write(JSON.stringify(result) + "\n");
  } catch {
    process.stderr.write("Rehearsal approval blocked; inspect sanitized workflow reports.\n");
    process.exitCode = 1;
  }
}
