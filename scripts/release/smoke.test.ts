import { spawnSync } from "node:child_process";
import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  SmokeUsageError,
  parseCollaborationSmokeArguments,
  preflightCollaborationSmoke,
} from "./smoke.ts";

const repositoryRoot = "/repo";
const SECRET = "editor-capability-must-not-escape";
const smokeCli = fileURLToPath(new URL("smoke-cli.ts", import.meta.url));

describe("collaboration smoke arguments", () => {
  it("accepts the bounded external invocation and optional capture", () => {
    expect(
      parseCollaborationSmokeArguments(
        [
          "--environment",
          "production",
          "--origin",
          "https://pages.example",
          "--confirm-external-smoke",
          "--capture",
        ],
        { cwd: repositoryRoot, repositoryRoot },
      ),
    ).toMatchObject({
      environment: "production",
      origin: "https://pages.example",
      capture: true,
      configSource: "default",
    });
  });

  it.each([
    ["missing confirmation", ["--environment", "production", "--origin", "https://pages.example"]],
    [
      "duplicate option",
      [
        "--environment",
        "production",
        "--environment=staging",
        "--origin",
        "https://pages.example",
        "--confirm-external-smoke",
      ],
    ],
    [
      "URL path",
      [
        "--environment",
        "production",
        "--origin",
        "https://pages.example/path",
        "--confirm-external-smoke",
      ],
    ],
    [
      "URL query",
      [
        "--environment",
        "production",
        "--origin",
        "https://pages.example?token=" + SECRET,
        "--confirm-external-smoke",
      ],
    ],
    [
      "URL fragment",
      [
        "--environment",
        "production",
        "--origin",
        "https://pages.example#fragment",
        "--confirm-external-smoke",
      ],
    ],
    [
      "unknown option",
      [
        "--environment",
        "production",
        "--origin",
        "https://pages.example",
        "--confirm-external-smoke",
        "--trace",
      ],
    ],
  ])("rejects %s", (_name, arguments_) => {
    expect(() =>
      parseCollaborationSmokeArguments(arguments_, { cwd: repositoryRoot, repositoryRoot }),
    ).toThrow(SmokeUsageError);
  });

  it("preserves an inline origin value after its first equals sign", () => {
    expect(
      parseCollaborationSmokeArguments(
        [
          "--environment=production",
          "--origin=https://pages.example=bad",
          "--confirm-external-smoke",
        ],
        { cwd: repositoryRoot, repositoryRoot },
      ).origin,
    ).toBe("https://pages.example=bad");
  });
});

describe("collaboration smoke preflight", () => {
  it("blocks an unprovisioned environment without starting an external smoke", async () => {
    const path = await writeConfig({ staging: { netlify: null, cloudflare: null } });
    const preflight = await preflightCollaborationSmoke({
      environment: "staging",
      origin: "https://staging.example",
      capture: false,
      configPath: path,
      configSource: "override",
    });
    expect(preflight).toMatchObject({
      ok: false,
      report: {
        outcome: "blocked",
        checks: [{ id: "target.unprovisioned" }],
        usage: { uploads: 0 },
      },
    });
  });

  it("binds the exact origin to configured PUBLIC_BASE_URL without retaining it", async () => {
    const path = await writeConfig({
      staging: {
        netlify: netlifyTarget("https://staging.example"),
        cloudflare: cloudflareTarget(),
      },
    });
    const preflight = await preflightCollaborationSmoke({
      environment: "staging",
      origin: "https://different.example",
      capture: false,
      configPath: path,
      configSource: "override",
    });
    expect(preflight).toMatchObject({
      ok: false,
      report: { outcome: "blocked", checks: [{ id: "target.origin" }] },
    });
    expect(JSON.stringify(preflight)).not.toContain("different.example");
  });

  it("blocks a Netlify-only environment without starting an external smoke", async () => {
    const path = await writeConfig({
      staging: {
        netlify: netlifyTarget("https://staging.example"),
        cloudflare: null,
      },
    });
    const preflight = await preflightCollaborationSmoke({
      environment: "staging",
      origin: "https://staging.example",
      capture: false,
      configPath: path,
      configSource: "override",
    });
    expect(preflight).toMatchObject({
      ok: false,
      report: { outcome: "blocked", checks: [{ id: "target.unprovisioned" }] },
    });
  });

  it("blocks an unavailable Worker origin before opening the browser transport", async () => {
    const worker = cloudflareTarget();
    const path = await writeConfig({
      staging: {
        netlify: netlifyTarget("https://staging.example"),
        cloudflare: { ...worker, expectedNonSecretVariables: {} },
      },
    });
    const preflight = await preflightCollaborationSmoke({
      environment: "staging",
      origin: "https://staging.example",
      capture: false,
      configPath: path,
      configSource: "override",
    });
    expect(preflight).toMatchObject({
      ok: false,
      report: {
        checks: [{ id: "target.worker-origin", outcome: "blocked" }],
        usage: { uploads: 0 },
      },
    });
  });
});

describe("collaboration smoke output", () => {
  it.each(["DEBUG", "DEBUG_FILE", "PWDEBUG", "PWDEBUGIMPL"])(
    "blocks inherited %s before importing Playwright or uploading",
    async (key) => {
      const configPath = await writeConfig({
        staging: {
          netlify: netlifyTarget("https://staging.example"),
          cloudflare: cloudflareTarget(),
        },
      });
      const directory = await mkdtemp(join(tmpdir(), "collaboration-smoke-diagnostics-"));
      const debugPath = join(directory, `${SECRET}.log`);
      const environment = { ...process.env };
      for (const name of ["DEBUG", "DEBUG_FILE", "PWDEBUG", "PWDEBUGIMPL"])
        delete environment[name];
      environment[key] = key === "DEBUG_FILE" ? debugPath : key === "DEBUG" ? "pw:*" : "1";
      try {
        const result = spawnSync(
          "bun",
          [
            smokeCli,
            "--environment",
            "staging",
            "--origin",
            "https://staging.example",
            "--confirm-external-smoke",
            "--config",
            configPath,
          ],
          {
            cwd: fileURLToPath(new URL("../..", import.meta.url)),
            encoding: "utf8",
            env: environment,
          },
        );
        expect(result.status).toBe(1);
        expect(result.stderr).toBe("");
        expect(JSON.parse(result.stdout)).toMatchObject({
          outcome: "blocked",
          checks: [{ id: "browser.diagnostics", outcome: "blocked" }],
          usage: { uploads: 0, captureRequests: 0 },
        });
        expect(`${result.stdout}${result.stderr}`).not.toContain(SECRET);
        await expect(access(debugPath)).rejects.toThrow();
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
  );

  it("redacts an invalid configuration path from the CLI report", () => {
    const result = spawnSync(
      "bun",
      [
        smokeCli,
        "--environment",
        "production",
        "--origin",
        "https://pages.example",
        "--confirm-external-smoke",
        "--config",
        `missing-${SECRET}.json`,
      ],
      { cwd: fileURLToPath(new URL("../..", import.meta.url)), encoding: "utf8" },
    );
    expect(result.status).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({
      schemaVersion: 1,
      operation: "collaboration-smoke",
      outcome: "blocked",
      checks: [{ id: "config.invalid", outcome: "blocked" }],
      usage: { uploads: 0, captureRequests: 0 },
    });
    expect(`${result.stdout}${result.stderr}`).not.toContain(SECRET);
  });
});

async function writeConfig(overrides: Record<string, unknown>) {
  const directory = await mkdtemp(join(tmpdir(), "collaboration-smoke-"));
  const config = {
    version: 1,
    integrationBranch: "stage",
    environments: {
      staging: { netlify: null, cloudflare: null },
      production: { netlify: null, cloudflare: null },
      ...overrides,
    },
  };
  const path = join(directory, "environments.json");
  await writeFile(path, JSON.stringify(config));
  return path;
}

function netlifyTarget(origin: string) {
  return {
    siteId: "site-1",
    accountId: "account-1",
    expectedNonSecretVariables: { PUBLIC_BASE_URL: origin },
    requiredSecretNames: [],
    requiredVariableScopes: { PUBLIC_BASE_URL: ["functions"] },
  };
}

function cloudflareTarget() {
  return {
    accountId: "account-1",
    workerName: "worker-1",
    wranglerEnvironment: "staging",
    wranglerConfigPath: "collaboration-worker/wrangler.jsonc",
    expectedNonSecretVariables: { PUBLIC_WORKER_ORIGIN: "https://worker.example" },
    requiredSecretNames: [],
  };
}
