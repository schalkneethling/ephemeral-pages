import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { z } from "zod/v4";

import {
  ArtifactContractError,
  artifactBuildEnvironment,
  artifactGitEnvironment,
  artifactHash,
  assertExternalArtifactDirectory,
  rejectLocalBuildInputs,
  sourceContractSchema,
  verifyArtifactSource,
} from "./artifact-contract.ts";
import { runCommand } from "./command.ts";
import { prepareNetlifyArtifacts, verifyNetlifyArtifacts } from "./netlify-artifacts.ts";
import { prepareWorkerArtifacts, verifyWorkerArtifacts } from "./worker-artifacts.ts";
import type { ReleaseEnvironment } from "./schema.ts";

const digest = z.string().regex(/^[a-f0-9]{64}$/u);
export const preparedReleaseSchema = z.strictObject({
  schemaVersion: z.literal(1),
  operation: z.literal("prepare"),
  outcome: z.literal("passed"),
  source: sourceContractSchema,
  toolchain: z.strictObject({ bun: z.literal("1.3.14") }),
  artifacts: z.strictObject({
    netlify: z.strictObject({ directory: z.literal("netlify"), sha256: digest }),
    worker: z.strictObject({ directory: z.literal("worker"), sha256: digest }),
  }),
});
export type PreparedRelease = z.infer<typeof preparedReleaseSchema>;
export type PrepareReleaseInput = {
  repositoryRoot: string;
  artifactDirectory: string;
  candidate: string;
  environment: ReleaseEnvironment;
};
export type PrepareReleaseDependencies = {
  run?: typeof runCommand;
  netlify?: typeof prepareNetlifyArtifacts;
  worker?: typeof prepareWorkerArtifacts;
};

export type CandidateCheckout = {
  repositoryRoot: string;
  remove: () => Promise<void>;
};

// `--no-local` and `--no-hardlinks` are verified with Git 2.55.0. They
// prevent the build input from sharing mutable worktree state or object
// hardlinks with the caller's checkout.
export async function createCandidateCheckout(
  repositoryRoot: string,
  candidate: string,
): Promise<CandidateCheckout> {
  const parent = await mkdtemp(resolve(tmpdir(), "release-candidate-"));
  const checkout = resolve(parent, "checkout");
  const git = async (args: string[], cwd: string): Promise<string> => {
    const result = await runCommand("git", args, {
      cwd,
      env: artifactGitEnvironment(),
      inheritEnv: false,
      timeoutMs: 300_000,
    });
    if (result.exitCode !== 0) throw new ArtifactContractError("candidate");
    return result.stdout.trim();
  };
  try {
    await git(
      ["clone", "--no-local", "--no-hardlinks", "--no-checkout", repositoryRoot, checkout],
      parent,
    );
    await git(["checkout", "--detach", candidate], checkout);
    if ((await git(["rev-parse", "HEAD"], checkout)) !== candidate) {
      throw new ArtifactContractError("candidate");
    }
    return {
      repositoryRoot: checkout,
      remove: async () => await rm(parent, { recursive: true, force: true }),
    };
  } catch (error) {
    await rm(parent, { recursive: true, force: true });
    if (error instanceof ArtifactContractError) throw error;
    throw new ArtifactContractError("candidate");
  }
}

// Provider operations are deliberately absent: preparation produces local artifacts only.
export async function prepareRelease(
  input: PrepareReleaseInput,
  dependencies: PrepareReleaseDependencies = {},
): Promise<PreparedRelease> {
  const repositoryRoot = resolve(input.repositoryRoot);
  const artifactDirectory = resolve(input.artifactDirectory);
  const { source: initialSource } = await verifyArtifactSource(
    repositoryRoot,
    input.candidate,
    input.environment,
  );
  await assertExternalArtifactDirectory(repositoryRoot, artifactDirectory);
  await mkdir(artifactDirectory, { mode: 0o700 });
  await writeFile(
    resolve(artifactDirectory, "preparation-started.json"),
    `${JSON.stringify({ schemaVersion: 1, source: initialSource })}\n`,
    { flag: "wx", mode: 0o600 },
  );
  const checkout = await createCandidateCheckout(repositoryRoot, input.candidate);
  try {
    const { source, configuration } = await verifyArtifactSource(
      checkout.repositoryRoot,
      input.candidate,
      input.environment,
    );
    if (JSON.stringify(source) !== JSON.stringify(initialSource)) {
      throw new ArtifactContractError("candidate");
    }
    await rejectLocalBuildInputs(checkout.repositoryRoot);
    const target = configuration.environments[input.environment];
    const production = configuration.environments.production.cloudflare;
    if (!target.cloudflare || !target.netlify || !production)
      throw new ArtifactContractError("configuration");
    const websocket = target.netlify.expectedNonSecretVariables.COLLABORATION_WEBSOCKET_URL;
    const parsedSocket = new URL(websocket ?? "invalid:");
    if (parsedSocket.protocol !== "wss:" || parsedSocket.origin !== websocket)
      throw new ArtifactContractError("configuration");
    const home = await mkdtemp(resolve(tmpdir(), "release-build-home-"));
    const env = { ...artifactBuildEnvironment(websocket), HOME: home };
    const command = async (args: string[], cwd = checkout.repositoryRoot) => {
      const result = await (dependencies.run ?? runCommand)("bun", args, {
        cwd,
        env,
        inheritEnv: false,
        timeoutMs: 300_000,
      });
      if (result.exitCode !== 0) throw new ArtifactContractError("build");
      return result.stdout.trim();
    };
    try {
      if ((await command(["--version"])) !== "1.3.14") throw new ArtifactContractError("build");
      await command(["install", "--frozen-lockfile", "--ignore-scripts"]);
      await command(
        ["install", "--frozen-lockfile", "--ignore-scripts"],
        resolve(checkout.repositoryRoot, "collaboration-worker"),
      );
      await command(["run", "build"]);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
    const verifiedAfterBuild = await verifyArtifactSource(
      checkout.repositoryRoot,
      input.candidate,
      input.environment,
    );
    if (JSON.stringify(verifiedAfterBuild.source) !== JSON.stringify(source)) {
      throw new ArtifactContractError("candidate");
    }
    const netlify = await (dependencies.netlify ?? prepareNetlifyArtifacts)({
      repositoryRoot: checkout.repositoryRoot,
      artifactDirectory: resolve(artifactDirectory, "netlify"),
      publishDirectory: resolve(checkout.repositoryRoot, "dist"),
      userFunctionsDirectory: resolve(checkout.repositoryRoot, "netlify/functions"),
    });
    const workerInput = {
      repositoryRoot: checkout.repositoryRoot,
      artifactDirectory: resolve(artifactDirectory, "worker"),
      environment: input.environment,
      productionWorkerName: production.workerName,
      target: target.cloudflare,
      sourceConfigSha256: artifactHash(
        await readFile(resolve(checkout.repositoryRoot, target.cloudflare.wranglerConfigPath)),
      ),
    };
    const worker = await (dependencies.worker ?? prepareWorkerArtifacts)(workerInput);
    await verifyNetlifyArtifacts(netlify);
    await verifyWorkerArtifacts(workerInput, worker);
    const after = await verifyArtifactSource(
      checkout.repositoryRoot,
      input.candidate,
      input.environment,
    );
    if (JSON.stringify(after.source) !== JSON.stringify(source))
      throw new ArtifactContractError("candidate");
    const report = preparedReleaseSchema.parse({
      schemaVersion: 1,
      operation: "prepare",
      outcome: "passed",
      source,
      toolchain: { bun: "1.3.14" },
      artifacts: {
        netlify: { directory: "netlify", sha256: netlify.inventorySha256 },
        worker: { directory: "worker", sha256: worker.manifestSha256 },
      },
    });
    const path = resolve(artifactDirectory, "prepared-release.json");
    await writeFile(path, `${JSON.stringify(report, null, 2)}\n`, { flag: "wx", mode: 0o400 });
    await chmod(path, 0o400);
    return report;
  } finally {
    await checkout.remove();
  }
}
