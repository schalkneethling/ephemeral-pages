import { fileURLToPath } from "node:url";

import {
  SmokeUsageError,
  parseCollaborationSmokeArguments,
  preflightCollaborationSmoke,
  runCollaborationSmoke,
} from "./smoke.ts";

const repositoryRoot = fileURLToPath(new URL("../..", import.meta.url));

async function main() {
  const arguments_ = parseCollaborationSmokeArguments(process.argv.slice(2), {
    cwd: process.cwd(),
    repositoryRoot,
  });
  const preflight = await preflightCollaborationSmoke(arguments_);
  const report = preflight.ok
    ? await runCollaborationSmoke(arguments_, preflight.config)
    : preflight.report;
  process.stdout.write(`${JSON.stringify(report)}\n`);
  if (report.outcome === "blocked") process.exitCode = 1;
}

try {
  await main();
} catch (error) {
  const reason = error instanceof SmokeUsageError ? "invalid-arguments" : "invalid-input";
  process.stdout.write(
    `${JSON.stringify({
      schemaVersion: 1,
      operation: "collaboration-smoke",
      outcome: "blocked",
      reason,
    })}\n`,
  );
  process.exitCode = 1;
}
