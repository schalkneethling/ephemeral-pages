import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";

import {
  evidencePath,
  isCollaborationPullRequest,
  parseCollaborationIssues,
  validateCollaborationPullRequest,
} from "./collaboration-program.mjs";

const prArgumentIndex = process.argv.indexOf("--pr");
const repositoryArgumentIndex = process.argv.indexOf("--repo");
const requestedPullRequest =
  prArgumentIndex === -1
    ? Number(process.env.GOVERNANCE_PR_NUMBER)
    : Number(process.argv[prArgumentIndex + 1]);
const token =
  process.env.GITHUB_TOKEN ??
  process.env.GH_TOKEN ??
  execFileSync("gh", ["auth", "token"], { encoding: "utf8" }).trim();
const apiUrl = process.env.GITHUB_API_URL ?? "https://api.github.com";

if (!token) throw new Error("Authenticate gh or set GITHUB_TOKEN/GH_TOKEN");

const repository =
  repositoryArgumentIndex === -1
    ? (process.env.GITHUB_REPOSITORY ?? "schalkneethling/ephemeral-pages")
    : process.argv[repositoryArgumentIndex + 1];
if (
  !Number.isSafeInteger(requestedPullRequest) ||
  requestedPullRequest <= 0 ||
  typeof repository !== "string" ||
  !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(repository)
) {
  throw new Error("Run for pull_request_target or pass --pr <number> [--repo <owner/repo>]");
}
const pullRequest = await githubFetch(`/repos/${repository}/pulls/${requestedPullRequest}`);

const manifest = JSON.parse(
  await readFile(new URL("../../.github/collaboration-program.json", import.meta.url), "utf8"),
);
const files = await listPullRequestFiles(repository, pullRequest.number);
if (!isCollaborationPullRequest(manifest, files)) {
  console.log("Collaboration governance does not apply to this PR.");
  process.exit(0);
}

const declared = parseCollaborationIssues(pullRequest.body ?? "");
const issue = declared.length === 1 ? declared[0] : undefined;
const definition = issue === undefined ? undefined : manifest.issues[String(issue)];
const dependencyStates = {};
if (definition) {
  const issues = await listIssues(repository);
  for (const dependency of definition.dependencies) {
    dependencyStates[String(dependency)] = issues.get(dependency);
  }
}

let evidence;
if (issue !== undefined) {
  evidence = await readHeadJson(pullRequest, evidencePath(issue));
}

const result = validateCollaborationPullRequest({
  manifest,
  body: pullRequest.body ?? "",
  files,
  evidence,
  dependencyStates,
  pullRequestNumber: pullRequest.number,
});
if (result.errors.length > 0) {
  console.error("Collaboration program gate failed:\n");
  for (const error of result.errors) console.error(`- ${error}`);
  process.exit(1);
}

console.log(
  result.exception
    ? `PR #${pullRequest.number} is explicitly grandfathered: ${result.exception}`
    : `Collaboration issue #${result.issue} satisfies the program gate.`,
);

async function listPullRequestFiles(repo, number) {
  const files = [];
  for (let page = 1; page <= 10; page += 1) {
    const batch = await githubFetch(
      `/repos/${repo}/pulls/${number}/files?per_page=100&page=${page}`,
    );
    files.push(
      ...batch.map(({ filename, previous_filename, additions, deletions }) => ({
        filename,
        previous_filename,
        additions,
        deletions,
      })),
    );
    if (batch.length < 100) return files;
  }
  throw new Error("PR file pagination exceeded the supported 1,000-file safety limit");
}

async function listIssues(repo) {
  const issues = new Map();
  for (let page = 1; page <= 10; page += 1) {
    const batch = await githubFetch(`/repos/${repo}/issues?state=all&per_page=100&page=${page}`);
    for (const issue of batch) issues.set(issue.number, issue.state);
    if (batch.length < 100) return issues;
  }
  throw new Error("Issue pagination exceeded the supported 1,000-item safety limit");
}

async function readHeadJson(pr, path) {
  if (
    typeof pr.head?.repo?.full_name !== "string" ||
    !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(pr.head.repo.full_name) ||
    typeof pr.head?.sha !== "string" ||
    !/^[a-f0-9]{40}$/u.test(pr.head.sha)
  ) {
    return undefined;
  }
  const encodedPath = path.split("/").map(encodeURIComponent).join("/");
  const response = await githubFetch(
    `/repos/${pr.head.repo.full_name}/contents/${encodedPath}?ref=${encodeURIComponent(pr.head.sha)}`,
    true,
  );
  if (!response) return undefined;
  if (response.type !== "file" || typeof response.content !== "string") return undefined;
  try {
    return JSON.parse(Buffer.from(response.content, "base64").toString("utf8"));
  } catch {
    return undefined;
  }
}

async function githubFetch(path, allowNotFound = false) {
  const response = await fetch(`${apiUrl}${path}`, {
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": "2026-03-10",
    },
  });
  if (allowNotFound && response.status === 404) return undefined;
  if (!response.ok) throw new Error(`GitHub API ${path} failed with ${response.status}`);
  return response.json();
}
