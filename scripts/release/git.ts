import { runCommand, SafeCommandError, type CommandOptions } from "./command.ts";

export type GitClient = {
  changedFiles(from: string, to: string): Promise<readonly string[]>;
  commitExists(commit: string): Promise<boolean>;
  isClean(): Promise<boolean>;
  isReachableFrom(commit: string, branch: string): Promise<boolean>;
  readFileAtCommit(commit: string, path: string): Promise<string>;
};

export function createGitClient(options: CommandOptions): GitClient {
  async function git(args: readonly string[]) {
    return runCommand("git", args, options);
  }
  return {
    async changedFiles(from, to) {
      const result = await git(["diff", "--no-renames", "--name-only", "-z", from, to, "--"]);
      if (result.exitCode !== 0) throw new SafeCommandError("failed");
      return result.stdout.split("\0").filter(Boolean);
    },
    async commitExists(commit) {
      const result = await git(["cat-file", "-e", `${commit}^{commit}`]);
      if (result.exitCode === 0) return true;
      if (result.exitCode === 1 || result.exitCode === 128) return false;
      throw new SafeCommandError("failed");
    },
    async isClean() {
      const result = await git(["status", "--porcelain=v1", "--untracked-files=all"]);
      if (result.exitCode !== 0) throw new SafeCommandError("failed");
      return result.stdout.length === 0;
    },
    async isReachableFrom(commit, branch) {
      const result = await git(["merge-base", "--is-ancestor", commit, `refs/heads/${branch}`]);
      if (result.exitCode === 0) return true;
      if (result.exitCode === 1 || result.exitCode === 128) return false;
      throw new SafeCommandError("failed");
    },
    async readFileAtCommit(commit, path) {
      const result = await git(["show", `${commit}:${path}`]);
      if (result.exitCode !== 0) throw new SafeCommandError("failed");
      return result.stdout;
    },
  };
}
