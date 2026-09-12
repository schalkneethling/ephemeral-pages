import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const SECRET = "secret-path-must-not-escape";
const repositoryRoot = fileURLToPath(new URL("../..", import.meta.url));
const cli = fileURLToPath(new URL("cli.ts", import.meta.url));

it("emits a versioned redacted JSON preflight failure", () => {
  const result = spawnSync(
    "bun",
    [
      cli,
      "status",
      "--environment",
      "production",
      "--baseline",
      `missing-${SECRET}.json`,
      "--json",
    ],
    { cwd: repositoryRoot, encoding: "utf8" },
  );
  expect(result.status).toBe(1);
  expect(JSON.parse(result.stdout)).toEqual({
    schemaVersion: 1,
    operation: "preflight",
    outcome: "blocked",
    reason: "invalid-input",
  });
  expect(`${result.stdout}${result.stderr}`).not.toContain(SECRET);
});
