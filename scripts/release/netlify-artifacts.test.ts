import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  NetlifyArtifactError,
  prepareNetlifyArtifacts,
  toNetlifyDeployFunctionConfig,
  verifyNetlifyArtifacts,
} from "./netlify-artifacts.ts";

const repositoryRoot = fileURLToPath(new URL("../..", import.meta.url));

const removeFixture = (root: string): void => {
  const makeWritable = (path: string): void => {
    if (!existsSync(path)) return;
    const metadata = lstatSync(path);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) return;
    chmodSync(path, 0o700);
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      if (entry.isDirectory()) makeWritable(join(path, entry.name));
    }
  };
  makeWritable(root);
  rmSync(root, { force: true, recursive: true });
};

const fixture = () => {
  const root = mkdtempSync(join(tmpdir(), "netlify-artifacts-"));
  const publishDirectory = join(root, "publish");
  const functionsDirectory = join(root, "functions");
  mkdirSync(publishDirectory);
  mkdirSync(functionsDirectory);
  writeFileSync(
    join(root, "netlify.toml"),
    `[[redirects]]\n  from = "/hello"\n  to = "/.netlify/functions/hello"\n  status = 200\n`,
  );
  writeFileSync(join(publishDirectory, "index.html"), "<!doctype html><title>artifact</title>\n");
  writeFileSync(join(publishDirectory, "_headers"), "/*\n  X-Content-Type-Options: nosniff\n");
  writeFileSync(join(functionsDirectory, "hello.ts"), "export default () => new Response('ok')\n");
  return { root, publishDirectory, functionsDirectory };
};

describe("Netlify artifact preparation", () => {
  it("uses the pinned CLI snake_case function-config payload", () => {
    const config = toNetlifyDeployFunctionConfig({
      name: "hello",
      path: "/tmp/hello.zip",
      mainFile: "/tmp/hello.ts",
      runtime: "js",
      size: 1,
      entryFilename: "hello.js",
      config: {},
      buildData: { bootstrapVersion: "1", runtimeAPIVersion: 2 },
      trafficRules: {
        action: {
          type: "rate_limit",
          config: {
            rateLimitConfig: {
              algorithm: "sliding_window",
              windowSize: 60,
              windowLimit: 10,
            },
            aggregate: { keys: [{ type: "ip" }] },
          },
        },
      },
    });
    expect(config).toEqual({
      display_name: undefined,
      excluded_routes: undefined,
      generator: undefined,
      memory: undefined,
      region: undefined,
      routes: undefined,
      build_data: { bootstrapVersion: "1", runtimeAPIVersion: 2 },
      priority: undefined,
      traffic_rules: {
        action: {
          type: "rate_limit",
          config: {
            rate_limit_config: {
              algorithm: "sliding_window",
              window_size: 60,
              window_limit: 10,
            },
            aggregate: { keys: [{ type: "ip" }] },
            to: undefined,
          },
        },
      },
      vcpu: undefined,
    });
  });

  it("freezes and verifies static files, generated headers, function zips, and metadata", async () => {
    const { root, publishDirectory, functionsDirectory } = fixture();
    const artifactDirectory = join(root, "artifact");
    try {
      const prepared = await prepareNetlifyArtifacts({
        artifactDirectory,
        repositoryRoot: root,
        publishDirectory,
        userFunctionsDirectory: functionsDirectory,
      });
      expect(prepared.inventory.headers.relativePath).toBe("publish/_headers");
      expect(prepared.inventory.deployConfiguration).toEqual({
        file: expect.objectContaining({
          relativePath: "deploy/netlify.toml",
          sha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
        }),
        sha1: expect.stringMatching(/^[a-f0-9]{40}$/u),
      });
      expect(readFileSync(join(artifactDirectory, "deploy/netlify.toml"), "utf8")).toContain(
        'from = "/hello"',
      );
      expect(prepared.inventory.staticFiles.map(({ relativePath }) => relativePath)).toEqual([
        "publish/_headers",
        "publish/index.html",
      ]);
      expect(prepared.inventory.functions).toEqual([
        expect.objectContaining({
          name: "hello",
          runtime: "js",
          relativePath: "functions/hello.zip",
        }),
      ]);
      expect(prepared.inventorySha256).toMatch(/^[0-9a-f]{64}$/u);
      expect(
        JSON.parse(
          readFileSync(
            join(artifactDirectory, prepared.inventory.functionsManifest.relativePath),
            "utf8",
          ),
        ),
      ).toEqual(
        expect.objectContaining({
          version: 1,
          functions: [expect.objectContaining({ name: "hello", runtime: "js" })],
        }),
      );
      expect(
        readFileSync(
          join(artifactDirectory, prepared.inventory.functionsManifest.relativePath),
          "utf8",
        ),
      ).not.toContain(root);
      await expect(verifyNetlifyArtifacts(prepared)).resolves.toBeUndefined();

      const frozenFile = join(artifactDirectory, "publish/index.html");
      chmodSync(frozenFile, 0o600);
      writeFileSync(frozenFile, "changed\n");
      await expect(verifyNetlifyArtifacts(prepared)).rejects.toMatchObject({ kind: "state" });
    } finally {
      removeFixture(root);
    }
  });

  it("rejects symlinks, nested output paths, and configured bounds", async () => {
    const symlinkFixture = fixture();
    try {
      symlinkSync(
        join(symlinkFixture.publishDirectory, "index.html"),
        join(symlinkFixture.publishDirectory, "linked.html"),
      );
      await expect(
        prepareNetlifyArtifacts({
          artifactDirectory: join(symlinkFixture.root, "artifact"),
          repositoryRoot: symlinkFixture.root,
          publishDirectory: symlinkFixture.publishDirectory,
          userFunctionsDirectory: symlinkFixture.functionsDirectory,
        }),
      ).rejects.toMatchObject({ kind: "invalid-input" });
      expect(existsSync(join(symlinkFixture.root, "artifact"))).toBe(false);
    } finally {
      removeFixture(symlinkFixture.root);
    }

    const nestedFixture = fixture();
    try {
      const occupiedArtifact = join(nestedFixture.root, "occupied-artifact");
      mkdirSync(occupiedArtifact);
      writeFileSync(join(occupiedArtifact, "keep"), "preserve\n");
      await expect(
        prepareNetlifyArtifacts({
          artifactDirectory: occupiedArtifact,
          repositoryRoot: nestedFixture.root,
          publishDirectory: nestedFixture.publishDirectory,
          userFunctionsDirectory: nestedFixture.functionsDirectory,
        }),
      ).rejects.toBeInstanceOf(NetlifyArtifactError);
      expect(readFileSync(join(occupiedArtifact, "keep"), "utf8")).toBe("preserve\n");
      await expect(
        prepareNetlifyArtifacts({
          artifactDirectory: join(nestedFixture.publishDirectory, "artifact"),
          repositoryRoot: nestedFixture.root,
          publishDirectory: nestedFixture.publishDirectory,
          userFunctionsDirectory: nestedFixture.functionsDirectory,
        }),
      ).rejects.toBeInstanceOf(NetlifyArtifactError);
      await expect(
        prepareNetlifyArtifacts({
          artifactDirectory: join(nestedFixture.root, "bounded-artifact"),
          repositoryRoot: nestedFixture.root,
          publishDirectory: nestedFixture.publishDirectory,
          userFunctionsDirectory: nestedFixture.functionsDirectory,
          limits: { maxFileBytes: 4 },
        }),
      ).rejects.toMatchObject({ kind: "bounds" });
    } finally {
      removeFixture(nestedFixture.root);
    }
  });

  it("packages the repository's ten real functions and retains scheduled-function metadata", async () => {
    const root = mkdtempSync(join(tmpdir(), "netlify-real-artifacts-"));
    const publishDirectory = join(root, "publish");
    const artifactDirectory = join(root, "artifact");
    mkdirSync(publishDirectory);
    writeFileSync(join(publishDirectory, "index.html"), "<!doctype html><title>real</title>\n");
    writeFileSync(join(publishDirectory, "_headers"), "/*\n  X-Content-Type-Options: nosniff\n");
    try {
      const prepared = await prepareNetlifyArtifacts({
        artifactDirectory,
        repositoryRoot,
        publishDirectory,
        userFunctionsDirectory: resolve(repositoryRoot, "netlify/functions"),
      });
      expect(prepared.inventory.functions.map(({ name }) => name)).toEqual([
        "cleanup",
        "collaboration-auth",
        "collaboration-service",
        "github-oidc",
        "html-validation",
        "mcp",
        "pages",
        "screenshot-capture",
        "security",
        "storage",
      ]);
      const manifest = JSON.parse(
        readFileSync(join(artifactDirectory, "functions/manifest.json"), "utf8"),
      ) as { functions: Array<{ name: string; schedule?: string; buildData?: unknown }> };
      expect(manifest.functions.find(({ name }) => name === "cleanup")).toEqual(
        expect.objectContaining({
          name: "cleanup",
          schedule: "0 * * * *",
          buildData: expect.any(Object),
        }),
      );
      expect(prepared.inventory.functionSchedules).toContainEqual({
        name: "cleanup",
        cron: "0 * * * *",
      });
      expect(prepared.inventory.functionsConfig.cleanup).toEqual(
        expect.objectContaining({ build_data: expect.any(Object) }),
      );
      expect(JSON.stringify(prepared.inventory)).not.toContain(repositoryRoot);
      expect(JSON.stringify(manifest)).not.toContain(repositoryRoot);
      await expect(verifyNetlifyArtifacts(prepared)).resolves.toBeUndefined();
    } finally {
      removeFixture(root);
    }
  }, 30_000);
});
