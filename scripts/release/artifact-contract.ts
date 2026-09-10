import { createHash } from "node:crypto";
import { lstat, realpath, readdir } from "node:fs/promises";
import { devNull } from "node:os";
import { dirname, relative, resolve, sep } from "node:path";
import { z } from "zod/v4";
import { runCommand } from "./command.ts";
import { fullCommitSchema, releaseConfigSchema, type ReleaseEnvironment } from "./schema.ts";
import { readReleaseJson } from "./files.ts";

export class ArtifactContractError extends Error {
  readonly kind: "candidate" | "configuration" | "destination" | "build" | "evidence";
  constructor(kind: ArtifactContractError["kind"]) {
    super("Release artifact contract could not be verified.");
    this.name = "ArtifactContractError";
    this.kind = kind;
  }
}

export const artifactHash = (data: string | Uint8Array): string =>
  createHash("sha256").update(data).digest("hex");

export const sourceContractSchema = z.strictObject({
  candidate: fullCommitSchema,
  tree: fullCommitSchema,
  environment: z.enum(["staging", "production"]),
  configurationFingerprint: z.string().regex(/^[a-f0-9]{64}$/u),
});
export type ArtifactSourceContract = z.infer<typeof sourceContractSchema>;

export async function assertExternalArtifactDirectory(
  repositoryRoot: string,
  directory: string,
): Promise<void> {
  const root = await realpath(repositoryRoot);
  const destination = resolve(directory);
  const parent = await realpath(dirname(destination));
  const path = relative(root, resolve(parent, destination.slice(dirname(destination).length + 1)));
  if (path === "" || (path !== ".." && !path.startsWith(`..${sep}`))) {
    throw new ArtifactContractError("destination");
  }
  try {
    await lstat(destination);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw new ArtifactContractError("destination");
  }
  throw new ArtifactContractError("destination");
}

export async function rejectLocalBuildInputs(repositoryRoot: string): Promise<void> {
  for (const directory of [repositoryRoot, resolve(repositoryRoot, "collaboration-worker")]) {
    const names = await readdir(directory);
    if (
      names.some(
        (name) =>
          name === ".env" ||
          [
            ".env.local",
            ".env.production",
            ".env.production.local",
            ".env.staging",
            ".env.staging.local",
          ].includes(name) ||
          name === ".dev.vars" ||
          name.startsWith(".dev.vars."),
      )
    ) {
      throw new ArtifactContractError("configuration");
    }
  }
}

// Builds have no provider credentials or staging secret values in their environment.
export function artifactBuildEnvironment(websocketUrl: string): Record<string, string> {
  const env: Record<string, string> = {
    COLLABORATION_WEBSOCKET_URL: websocketUrl,
    CI: "true",
  };
  for (const key of ["PATH", "HOME", "TMPDIR", "LANG", "LC_ALL", "SYSTEMROOT"]) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  return env;
}

// Git source verification must not inherit GIT_DIR/GIT_WORK_TREE, aliases, or
// user/system configuration from the caller. Keep only the variables required
// to spawn Git across supported platforms.
export function artifactGitEnvironment(): Record<string, string> {
  const env: Record<string, string> = {
    GIT_CONFIG_GLOBAL: devNull,
    GIT_CONFIG_NOSYSTEM: "1",
    PATH: process.env.PATH ?? "",
  };
  for (const key of [
    "SYSTEMROOT",
    "SystemRoot",
    "COMSPEC",
    "ComSpec",
    "PATHEXT",
    "TMP",
    "TEMP",
    "TMPDIR",
  ]) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  return env;
}

export async function verifyArtifactSource(
  repositoryRoot: string,
  candidate: string,
  environment: ReleaseEnvironment,
): Promise<{ source: ArtifactSourceContract; configuration: z.infer<typeof releaseConfigSchema> }> {
  if (!fullCommitSchema.safeParse(candidate).success) throw new ArtifactContractError("candidate");
  const git = async (args: string[]): Promise<string> => {
    const result = await runCommand("git", args, {
      cwd: repositoryRoot,
      env: artifactGitEnvironment(),
      inheritEnv: false,
    });
    if (result.exitCode !== 0) throw new ArtifactContractError("candidate");
    return result.stdout.trim();
  };
  const [head, tree, dirty] = await Promise.all([
    git(["rev-parse", "HEAD"]),
    git(["rev-parse", `${candidate}^{tree}`]),
    git(["status", "--porcelain=v1", "--untracked-files=all"]),
  ]);
  if (head !== candidate || dirty || !fullCommitSchema.safeParse(tree).success) {
    throw new ArtifactContractError("candidate");
  }
  const configPath = "scripts/release/environments.json";
  const configuration = await readReleaseJson(
    resolve(repositoryRoot, configPath),
    releaseConfigSchema,
  );
  const target = configuration.environments[environment];
  if (!target.netlify || !target.cloudflare) throw new ArtifactContractError("configuration");
  const configSource = await git(["show", `${candidate}:${configPath}`]);
  if (JSON.stringify(JSON.parse(configSource)) !== JSON.stringify(configuration)) {
    throw new ArtifactContractError("configuration");
  }
  const workerConfig = await git(["show", `${candidate}:${target.cloudflare.wranglerConfigPath}`]);
  return {
    source: {
      candidate,
      tree,
      environment,
      configurationFingerprint: artifactHash(JSON.stringify({ target, workerConfig })),
    },
    configuration,
  };
}
