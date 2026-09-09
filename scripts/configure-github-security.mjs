import { execFileSync } from "node:child_process";

import policy from "../.github/security-policy.json" with { type: "json" };
import { configureGitHubSecurity, createGitHubSecurityClient } from "./ci/github-security.mjs";

const client = createGitHubSecurityClient({
  repository: process.env.GITHUB_REPOSITORY ?? "schalkneethling/ephemeral-pages",
  token:
    process.env.GITHUB_TOKEN ??
    process.env.GH_TOKEN ??
    execFileSync("gh", ["auth", "token"], { encoding: "utf8" }).trim(),
  apiUrl: process.env.GITHUB_API_URL,
});
const drift = await configureGitHubSecurity({
  policy,
  client,
  apply: process.argv.includes("--apply"),
});
if (drift.length > 0) {
  console.error("GitHub security policy drift detected:\n");
  for (const item of drift) console.error(`- ${item}`);
  process.exitCode = 1;
} else {
  console.log(
    "CodeQL settings and the selected ruleset's protection checks match policy; other repository controls are not audited.",
  );
}
