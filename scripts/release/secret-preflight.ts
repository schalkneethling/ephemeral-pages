const names = [
  "STAGE_COLLABORATION_CAPABILITY_CURRENT_SECRET",
  "STAGE_COLLABORATION_TICKET_SECRET",
  "STAGE_COLLABORATION_SERVICE_TOKEN",
] as const;
const values = names.map((name) => process.env[name]);
const valid =
  values.every((value) => typeof value === "string" && value.length >= 32) &&
  new Set(values).size === names.length;
process.stdout.write(
  `${JSON.stringify({ schemaVersion: 1, operation: "staging-secret-preflight", outcome: valid ? "passed" : "blocked" })}\n`,
);
if (!valid) process.exitCode = 1;
