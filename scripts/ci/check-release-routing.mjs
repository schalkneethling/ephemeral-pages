import { checkGitHubReleaseRouting, createGitHubReleaseRoutingClient } from "./release-routing.mjs";

const repository = process.env.GITHUB_REPOSITORY;
const client = createGitHubReleaseRoutingClient({
  repository,
  token: process.env.GITHUB_TOKEN,
  apiUrl: process.env.GITHUB_API_URL,
});
const targetUrl =
  process.env.GITHUB_SERVER_URL && process.env.GITHUB_REPOSITORY && process.env.GITHUB_RUN_ID
    ? `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`
    : undefined;
const decisions = await checkGitHubReleaseRouting({ client, repository, targetUrl });
const failures = decisions.filter(({ allowed }) => !allowed);

for (const decision of decisions) {
  console.log(
    `PR #${decision.pullRequest}: ${decision.allowed ? "pass" : "fail"}: ${JSON.stringify(decision.reason)}`,
  );
}
if (failures.length > 0) {
  console.log(`${failures.length} open pull request route(s) failed validation.`);
}
