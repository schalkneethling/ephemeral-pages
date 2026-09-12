import { spawnSync } from "node:child_process";
import { access, mkdtemp, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { copyGitFiles, sanitizeFindings, scanArguments } from "./gitleaks.mjs";

describe("Gitleaks gate", () => {
  it("uses a sanitized in-memory report and scans every ref", () => {
    const args = scanArguments(
      "git",
      "/repo",
      "/repo/.gitleaks.toml",
      "/repo/.gitleaksignore",
      "--all",
    );
    expect(args).toContain("--redact=100");
    expect(args).toContain("--report-format=template");
    expect(args).toContain("/repo/.gitleaks-report.tmpl");
    expect(args).toContain("--report-path=-");
    expect(args).toContain("--all");
    expect(args).toContain("--ignore-gitleaks-allow");
    expect(args.some((argument) => argument.startsWith("--max-target-megabytes"))).toBe(false);
    expect(args.join(" ")).not.toContain("sarif");
  });

  it("removes all secret-bearing report fields", () => {
    const sentinel = ["never", "-print-this-value"].join("");
    const result = sanitizeFindings(
      [
        {
          RuleID: "test-rule",
          File: "/repo/example.ts",
          StartLine: 4,
          Commit: "abc",
          Fingerprint: "abc:example.ts:test-rule:4",
          Secret: sentinel,
          Match: `token=${sentinel}`,
          Line: `token=${sentinel}`,
          Message: sentinel,
          Author: sentinel,
          Email: sentinel,
        },
      ],
      "/repo",
    );
    expect(result).toEqual([
      {
        rule: "test-rule",
        file: "example.ts",
        line: 4,
        commit: "abc",
        fingerprint: "abc:example.ts:test-rule:4",
      },
    ]);
    expect(JSON.stringify(result)).not.toContain(sentinel);
  });

  it("does not configure a file report", () => {
    const args = scanArguments("dir", "/mirror", "/repo/.gitleaks.toml", "/repo/.gitleaksignore");
    expect(args.at(-1)).toBe("/mirror");
    expect(args.filter((argument) => argument.startsWith("--report-path"))).toEqual([
      "--report-path=-",
    ]);
  });

  it("copies tracked and untracked files without ignored, deleted, or linked content", async () => {
    const root = await mkdtemp(join(tmpdir(), "gitleaks-source-"));
    const mirror = await mkdtemp(join(tmpdir(), "gitleaks-mirror-"));
    try {
      expect(spawnSync("git", ["init", "--quiet"], { cwd: root }).status).toBe(0);
      await writeFile(join(root, ".gitignore"), ".env\n");
      await writeFile(join(root, "deleted.txt"), "tracked\n");
      expect(spawnSync("git", ["add", ".gitignore", "deleted.txt"], { cwd: root }).status).toBe(0);
      await unlink(join(root, "deleted.txt"));
      await writeFile(join(root, ".env"), "ignored\n");
      await writeFile(join(root, "visible.txt"), "visible\n");
      await symlink(join(root, ".env"), join(root, "linked.txt"));

      await copyGitFiles(root, mirror);

      await expect(access(join(mirror, ".gitignore"))).resolves.toBeUndefined();
      await expect(access(join(mirror, "visible.txt"))).resolves.toBeUndefined();
      await expect(access(join(mirror, ".env"))).rejects.toThrow();
      await expect(access(join(mirror, "deleted.txt"))).rejects.toThrow();
      await expect(access(join(mirror, "linked.txt"))).rejects.toThrow();
    } finally {
      await Promise.all([
        rm(root, { recursive: true, force: true }),
        rm(mirror, { recursive: true, force: true }),
      ]);
    }
  });
});
