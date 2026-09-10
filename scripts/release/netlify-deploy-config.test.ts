import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  NetlifyDeployConfigError,
  prepareNetlifyDeployConfiguration,
} from "./netlify-deploy-config.ts";

const fixture = async (toml: string) => {
  const root = await mkdtemp(join(tmpdir(), "netlify-deploy-config-"));
  const publishDirectory = join(root, "dist");
  await mkdir(publishDirectory);
  await Promise.all([
    writeFile(join(root, "netlify.toml"), toml),
    writeFile(join(publishDirectory, "_headers"), "/*\n  X-Frame-Options: DENY\n"),
  ]);
  return { root, publishDirectory };
};

describe("Netlify deploy configuration", () => {
  it("uses the pinned parsers and serializer for portable redirects and headers", async () => {
    const { root, publishDirectory } = await fixture(`
[build]
  publish = "dist"

[[redirects]]
  from = "/api/*"
  to = "/.netlify/functions/pages/:splat"
  status = 200
  force = true
`);
    try {
      const prepared = await prepareNetlifyDeployConfiguration({
        repositoryRoot: root,
        publishDirectory,
      });
      const contents = prepared.artifact.contents.toString("utf8");
      expect(prepared.artifact).toMatchObject({
        relativePath: "deploy/netlify.toml",
        sha1: expect.stringMatching(/^[a-f0-9]{40}$/u),
      });
      expect(prepared.artifact.bytes).toBe(prepared.artifact.contents.byteLength);
      expect(contents).toContain('from = "/api/*"');
      expect(contents).toContain('to = "/.netlify/functions/pages/:splat"');
      expect(contents).toContain("X-Frame-Options");
      expect(contents).not.toContain(root);
      expect(contents).not.toContain("publish =");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects resolved build environment values instead of freezing them", async () => {
    const { root, publishDirectory } = await fixture(`
[build]
  publish = "dist"

[build.environment]
  DEPLOY_SECRET = "must-not-be-an-artifact"
`);
    try {
      await expect(
        prepareNetlifyDeployConfiguration({ repositoryRoot: root, publishDirectory }),
      ).rejects.toBeInstanceOf(NetlifyDeployConfigError);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects parser diagnostics instead of silently omitting generated policies", async () => {
    const { root, publishDirectory } = await fixture(`
[build]
  publish = "dist"
`);
    try {
      await Promise.all([
        writeFile(join(publishDirectory, "_headers"), "/*\n  X-Frame-Options:\n"),
        writeFile(join(publishDirectory, "_redirects"), "/missing-destination\n"),
      ]);
      await expect(
        prepareNetlifyDeployConfiguration({ repositoryRoot: root, publishDirectory }),
      ).rejects.toMatchObject({ kind: "invalid-input" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("normalizes explicit function settings only for the local ZISI packing step", async () => {
    const { root, publishDirectory } = await fixture(`
[build]
  publish = "dist"

[functions]
  included_files = ["templates/**"]
`);
    try {
      const prepared = await prepareNetlifyDeployConfiguration({
        repositoryRoot: root,
        publishDirectory,
      });
      expect(prepared.functionConfig).toMatchObject({
        "*": {
          includedFiles: ["templates/**"],
          processDynamicNodeImports: true,
          zipGo: true,
        },
      });
      expect(prepared.artifact.contents.toString("utf8")).not.toContain("included_files");
      expect(prepared.artifact.contents.toString("utf8")).not.toContain(root);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
