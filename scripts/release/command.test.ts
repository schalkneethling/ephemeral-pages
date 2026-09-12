import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  createDeadlineProviderCommandRunner,
  createProviderCommandRunner,
  runCommand,
  SafeCommandError,
} from "./command.ts";
import { createGitClient } from "./git.ts";

const SECRET = "raw-provider-secret-must-not-escape";
const DESCENDANT_PROGRAM =
  'const fs = require("node:fs"); const [launched, marker] = process.argv.slice(1); fs.writeFileSync(launched, "launched"); setTimeout(() => fs.writeFileSync(marker, "alive"), 2500);';
const PARENT_PROGRAM =
  'const { spawn } = require("node:child_process"); const [executable, program, launched, marker] = process.argv.slice(1); spawn(executable, ["-e", program, launched, marker], { stdio: "ignore" }); setTimeout(() => {}, 10_000);';

describe("bounded command execution", () => {
  it("can exclude inherited secrets from build subprocesses", async () => {
    const name = "RELEASE_TEST_SENSITIVE_ENV";
    const previous = process.env[name];
    process.env[name] = SECRET;
    try {
      const result = await runCommand(
        process.execPath,
        ["-e", `process.stdout.write(String(${JSON.stringify(name)} in process.env))`],
        {
          cwd: process.cwd(),
          inheritEnv: false,
          env: {},
        },
      );
      expect(result).toEqual({ exitCode: 0, stdout: "false" });
    } finally {
      if (previous === undefined) delete process.env[name];
      else process.env[name] = previous;
    }
  });

  it("times out without forwarding captured stderr", async () => {
    const result = runCommand(
      process.execPath,
      ["-e", `process.stderr.write(${JSON.stringify(SECRET)}); setTimeout(() => {}, 10_000)`],
      { cwd: process.cwd(), timeoutMs: 20 },
    );
    await expect(result).rejects.toThrow("Command timeout.");
    await expect(result).rejects.not.toThrow(SECRET);
  });

  it("redacts command failure output from the provider runner", async () => {
    const run = createProviderCommandRunner({ cwd: process.cwd() });
    const result = run(process.execPath, [
      "-e",
      `process.stderr.write(${JSON.stringify(SECRET)}); process.exit(2)`,
    ]);
    await expect(result).rejects.toThrow("Command failed.");
    await expect(result).rejects.not.toThrow(SECRET);
  });

  it("retains a native spawn cause in memory without serializing it", async () => {
    const executable = join(tmpdir(), `${SECRET}-missing-executable`);
    let observed: unknown;
    try {
      await runCommand(executable, [], { cwd: process.cwd() });
    } catch (error) {
      observed = error;
    }

    expect(observed).toBeInstanceOf(SafeCommandError);
    expect(observed).toMatchObject({ kind: "spawn", message: "Command spawn." });
    expect((observed as Error).cause).toBeInstanceOf(Error);
    expect(((observed as Error).cause as Error).message).toContain(SECRET);
    expect(JSON.stringify(observed)).not.toContain(SECRET);
    expect(JSON.stringify(observed)).not.toContain(executable);
  });

  it("wraps a synchronous native spawn error with the same safe boundary", async () => {
    const executable = `${SECRET}\0`;
    let observed: unknown;
    try {
      await runCommand(executable, [], { cwd: process.cwd() });
    } catch (error) {
      observed = error;
    }

    expect(observed).toBeInstanceOf(SafeCommandError);
    expect(observed).toMatchObject({ kind: "spawn", message: "Command spawn." });
    expect((observed as Error).cause).toBeInstanceOf(Error);
    expect(((observed as Error).cause as Error).message).toContain(SECRET);
    expect(JSON.stringify(observed)).not.toContain(SECRET);
  });

  it("stops capturing and fails safely at the output limit", async () => {
    const result = runCommand(
      process.execPath,
      ["-e", `process.stdout.write(${JSON.stringify(SECRET.repeat(100))})`],
      { cwd: process.cwd(), maxOutputBytes: 32 },
    );
    await expect(result).rejects.toThrow("Command output-limit.");
    await expect(result).rejects.not.toThrow(SECRET);
  });

  it("refuses new provider commands after the shared deadline", async () => {
    const run = createDeadlineProviderCommandRunner({ cwd: process.cwd() }, 500);
    await expect(run(process.execPath, ["-e", ""])).resolves.toBe("");
    await new Promise((resolve) => setTimeout(resolve, 520));
    await expect(run("executable-that-must-not-be-spawned", [])).rejects.toThrow(
      "Command timeout.",
    );
  });

  it.skipIf(process.platform === "win32")(
    "terminates descendants in the command process group",
    async () => {
      const directory = mkdtempSync(join(tmpdir(), "release-command-group-"));
      const launched = join(directory, "descendant-launched");
      const marker = join(directory, "descendant-survived");
      try {
        const result = runCommand(
          process.execPath,
          ["-e", PARENT_PROGRAM, process.execPath, DESCENDANT_PROGRAM, launched, marker],
          {
            cwd: directory,
            timeoutMs: 1_500,
          },
        );
        const completion = expect(result).rejects.toThrow("Command timeout.");
        const launchDeadline = Date.now() + 1_000;
        while (!existsSync(launched) && Date.now() < launchDeadline) {
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        expect(existsSync(launched)).toBe(true);
        await completion;
        await new Promise((resolve) => setTimeout(resolve, 2_600));
        expect(existsSync(marker)).toBe(false);
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    },
    5_000,
  );
});

describe("Git inspection", () => {
  it("disables rename detection so both service paths remain affected", async () => {
    const directory = mkdtempSync(join(tmpdir(), "release-git-"));
    try {
      execFileSync("git", ["init", "-q"], { cwd: directory });
      writeFileSync(join(directory, ".gitignore"), "ignored.txt\n");
      mkdirSync(join(directory, "collaboration-worker"));
      writeFileSync(join(directory, "collaboration-worker/source.ts"), "export {};\n");
      execFileSync("git", ["add", "."], { cwd: directory });
      execFileSync(
        "git",
        [
          "-c",
          "user.name=Test",
          "-c",
          "user.email=test@example.test",
          "-c",
          "commit.gpgSign=false",
          "-c",
          "core.hooksPath=/dev/null",
          "commit",
          "-qm",
          "first",
        ],
        { cwd: directory },
      );
      const first = execFileSync("git", ["rev-parse", "HEAD"], {
        cwd: directory,
        encoding: "utf8",
      }).trim();
      mkdirSync(join(directory, "netlify"));
      renameSync(
        join(directory, "collaboration-worker/source.ts"),
        join(directory, "netlify/source.ts"),
      );
      execFileSync("git", ["add", "."], { cwd: directory });
      execFileSync(
        "git",
        [
          "-c",
          "user.name=Test",
          "-c",
          "user.email=test@example.test",
          "-c",
          "commit.gpgSign=false",
          "-c",
          "core.hooksPath=/dev/null",
          "commit",
          "-qm",
          "second",
        ],
        { cwd: directory },
      );
      const second = execFileSync("git", ["rev-parse", "HEAD"], {
        cwd: directory,
        encoding: "utf8",
      }).trim();
      const git = createGitClient({ cwd: directory });
      expect(await git.changedFiles(first, second)).toEqual([
        "collaboration-worker/source.ts",
        "netlify/source.ts",
      ]);
      writeFileSync(join(directory, "ignored.txt"), "ignored\n");
      expect(await git.isClean()).toBe(true);
      writeFileSync(join(directory, "untracked.txt"), "dirty\n");
      expect(await git.isClean()).toBe(false);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
