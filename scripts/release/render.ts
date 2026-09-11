import type { ReleaseReport } from "./planner.ts";

export function renderReleaseReport(report: ReleaseReport) {
  const lines = [
    `Release ${report.operation}: ${report.outcome.toUpperCase()}`,
    `Environment: ${report.environment}`,
    `Integration branch: ${report.integrationBranch}`,
    `Configuration: ${report.configuration.source} ${report.configuration.fingerprint}`,
  ];
  if (report.candidate) lines.push(`Candidate: ${report.candidate}`);
  if (report.configuration.candidateBound !== null) {
    lines.push(
      `Candidate configuration: ${report.configuration.candidateBound ? "matched" : "blocked"}`,
    );
  }
  lines.push("Checks:");
  for (const item of report.checks) {
    lines.push(`- [${item.outcome}] ${item.summary}`);
  }
  if (report.deploymentPlan) {
    lines.push("Deployment plan:");
    for (const item of report.deploymentPlan) {
      lines.push(`- ${item.provider}: ${item.action}`);
    }
  }
  return `${lines.join("\n")}\n`;
}
