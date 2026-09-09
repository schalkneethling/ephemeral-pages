import { setTimeout as delay } from "node:timers/promises";

import {
  codeqlPolicyDrift,
  rulesetProtectionDrift,
  securityPolicyDrift,
  withCodeScanningRule,
} from "./github-security-policy.mjs";

// No environment, filesystem, authentication discovery, or console side effects.
export function createGitHubSecurityClient({
  repository,
  token,
  apiUrl = "https://api.github.com",
  fetchImpl = fetch,
}) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(repository ?? "")) {
    throw new Error("Repository must be owner/repo");
  }
  if (!token) throw new Error("A GitHub token is required");
  const root = `/repos/${repository}`;
  async function request(path, method = "GET", body) {
    const response = await fetchImpl(`${apiUrl}${root}${path}`, {
      method,
      signal: AbortSignal.timeout(30_000),
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "X-GitHub-Api-Version": "2026-03-10",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!response.ok) throw new Error(`GitHub API ${path} failed with ${response.status}`);
    return response.status === 204 ? undefined : response.json();
  }
  return {
    getRepository: () => request(""),
    getDefaultSetup: () => request("/code-scanning/default-setup"),
    updateDefaultSetup: (configuration) =>
      request("/code-scanning/default-setup", "PATCH", configuration),
    getRuleset: (id) => request(`/rulesets/${id}`),
    updateRuleset: (id, ruleset) => request(`/rulesets/${id}`, "PUT", ruleset),
    async findRuleset(name) {
      for (let page = 1; page <= 10; page += 1) {
        const batch = await request(`/rulesets?per_page=100&includes_parents=false&page=${page}`);
        const match = batch.find(
          (item) =>
            item.name === name && item.target === "branch" && item.source_type === "Repository",
        );
        if (match) return match;
        if (batch.length < 100) throw new Error(`Ruleset ${name} was not found`);
      }
      throw new Error("Ruleset pagination exceeded the supported 1,000-item safety limit");
    },
  };
}

export async function configureGitHubSecurity({ policy, client, apply = false, sleep = delay }) {
  const repository = await client.getRepository();
  const defaultSetup = await client.getDefaultSetup();
  const summary = await client.findRuleset(policy.ruleset.name);
  const ruleset = await client.getRuleset(summary.id);
  if (!apply) return securityPolicyDrift(policy, defaultSetup, ruleset, repository.default_branch);

  // These settings affect every rule, so require a separate deliberate configuration change.
  const protectionDrift = rulesetProtectionDrift(ruleset, repository.default_branch);
  if (protectionDrift.length > 0)
    throw new Error(
      `Fix ruleset protection before applying CodeQL policy:\n${protectionDrift.join("\n")}`,
    );
  await client.updateDefaultSetup(policy.codeql);
  await client.updateRuleset(summary.id, withCodeScanningRule(policy, ruleset));
  let verifiedDefaultSetup;
  for (let attempt = 0; attempt < 24; attempt += 1) {
    verifiedDefaultSetup = await client.getDefaultSetup();
    if (codeqlPolicyDrift(policy, verifiedDefaultSetup).length === 0) break;
    if (attempt < 23) await sleep(5_000);
  }
  const verifiedRuleset = await client.getRuleset(summary.id);
  return securityPolicyDrift(
    policy,
    verifiedDefaultSetup,
    verifiedRuleset,
    repository.default_branch,
  );
}
