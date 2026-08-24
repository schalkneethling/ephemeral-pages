import { readFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";

import { securityPolicyDrift, withCodeScanningRule } from "./ci/github-security-policy.mjs";

const apply = process.argv.includes("--apply");
const repository = process.env.GITHUB_REPOSITORY ?? "schalkneethling/ephemeral-pages";
const token =
  process.env.GITHUB_TOKEN ??
  process.env.GH_TOKEN ??
  execFileSync("gh", ["auth", "token"], { encoding: "utf8" }).trim();
const apiUrl = process.env.GITHUB_API_URL ?? "https://api.github.com";
if (!token) throw new Error("Authenticate gh or set GITHUB_TOKEN/GH_TOKEN");

const policy = JSON.parse(
  await readFile(new URL("../.github/security-policy.json", import.meta.url), "utf8"),
);
const defaultSetup = await githubFetch(`/repos/${repository}/code-scanning/default-setup`);
const rulesets = await githubFetch(
  `/repos/${repository}/rulesets?per_page=100&includes_parents=false`,
);
const summary = rulesets.find(
  ({ name, target, source_type }) =>
    name === policy.ruleset.name && target === "branch" && source_type === "Repository",
);
if (!summary) throw new Error(`Ruleset ${policy.ruleset.name} was not found`);
const ruleset = await githubFetch(`/repos/${repository}/rulesets/${summary.id}`);

if (apply) {
  const update = await githubFetch(`/repos/${repository}/code-scanning/default-setup`, {
    method: "PATCH",
    body: JSON.stringify(policy.codeql),
  });
  if (update?.run_url) console.log(`Waiting for CodeQL configuration run ${update.run_url}`);
  await githubFetch(`/repos/${repository}/rulesets/${summary.id}`, {
    method: "PUT",
    body: JSON.stringify(withCodeScanningRule(policy, ruleset)),
  });
}

const verifiedDefaultSetup = apply ? await waitForDefaultSetup() : defaultSetup;
const verifiedRuleset = apply
  ? await githubFetch(`/repos/${repository}/rulesets/${summary.id}`)
  : ruleset;
const drift = securityPolicyDrift(policy, verifiedDefaultSetup, verifiedRuleset);
if (drift.length > 0) {
  console.error("GitHub security policy drift detected:\n");
  for (const item of drift) console.error(`- ${item}`);
  process.exit(1);
}
console.log("GitHub CodeQL configuration and merge protection match the versioned policy.");

async function waitForDefaultSetup() {
  for (let attempt = 0; attempt < 24; attempt += 1) {
    const current = await githubFetch(`/repos/${repository}/code-scanning/default-setup`);
    if (
      current.state === policy.codeql.state &&
      current.query_suite === policy.codeql.query_suite &&
      current.threat_model === policy.codeql.threat_model &&
      policy.codeql.languages.every((language) => current.languages?.includes(language))
    ) {
      return current;
    }
    await new Promise((resolve) => setTimeout(resolve, 5_000));
  }
  return githubFetch(`/repos/${repository}/code-scanning/default-setup`);
}

async function githubFetch(path, init = {}) {
  const response = await fetch(`${apiUrl}${path}`, {
    ...init,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "X-GitHub-Api-Version": "2026-03-10",
      ...init.headers,
    },
  });
  if (!response.ok) throw new Error(`GitHub API ${path} failed with ${response.status}`);
  return response.status === 204 ? undefined : response.json();
}
