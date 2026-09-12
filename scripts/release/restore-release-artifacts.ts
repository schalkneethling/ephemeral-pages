import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { artifactHash } from "./artifact-contract.ts";
import { readBoundedJson } from "./bootstrap-safety.ts";
import {
  restoreExtractedNetlifyArtifacts,
  type NetlifyArtifactInventory,
} from "./netlify-artifacts.ts";
import { preparedReleaseSchema, type PreparedRelease } from "./prepare.ts";
import { releaseConfigSchema, type ReleaseConfig } from "./schema.ts";
import {
  restoreExtractedWorkerArtifacts,
  workerArtifactManifestSchema,
} from "./worker-artifacts.ts";
import { readReleaseJson } from "./files.ts";

export class ReleaseArtifactRestorationError extends Error {
  readonly kind = "artifact-restoration";

  constructor(cause?: unknown) {
    super(
      "Extracted release artifacts could not be restored.",
      cause instanceof Error ? { cause } : undefined,
    );
    this.name = "ReleaseArtifactRestorationError";
  }
}

export async function restoreExtractedReleaseArtifacts(
  repositoryRoot: string,
  artifactDirectory: string,
  configurationInput: ReleaseConfig,
): Promise<PreparedRelease> {
  try {
    const configuration = releaseConfigSchema.parse(configurationInput);
    const prepared = await readReleaseJson(
      resolve(artifactDirectory, "prepared-release.json"),
      preparedReleaseSchema,
    );
    if (prepared.source.environment !== "production") throw new Error();
    const target = configuration.environments[prepared.source.environment];
    const productionWorker = configuration.environments.production.cloudflare;
    if (!target.netlify || !target.cloudflare || !productionWorker) throw new Error();

    const netlifyDirectory = resolve(artifactDirectory, prepared.artifacts.netlify.directory);
    const inventory = (await readBoundedJson(
      resolve(netlifyDirectory, "inventory.json"),
      1024 * 1024,
      () => new Error("Invalid extracted Netlify inventory."),
    )) as NetlifyArtifactInventory;
    await restoreExtractedNetlifyArtifacts({
      artifactDirectory: netlifyDirectory,
      inventory,
      inventorySha256: prepared.artifacts.netlify.sha256,
    });

    const workerDirectory = resolve(artifactDirectory, prepared.artifacts.worker.directory);
    const manifest = await readReleaseJson(
      resolve(workerDirectory, "worker-artifact.json"),
      workerArtifactManifestSchema,
    );
    await restoreExtractedWorkerArtifacts(
      {
        repositoryRoot,
        artifactDirectory: workerDirectory,
        environment: prepared.source.environment,
        productionWorkerName: productionWorker.workerName,
        target: target.cloudflare,
        sourceConfigSha256: artifactHash(
          await readFile(resolve(repositoryRoot, target.cloudflare.wranglerConfigPath)),
        ),
      },
      {
        artifactDirectory: workerDirectory,
        manifest,
        manifestSha256: prepared.artifacts.worker.sha256,
      },
    );
    return prepared;
  } catch (error) {
    if (error instanceof ReleaseArtifactRestorationError) throw error;
    throw new ReleaseArtifactRestorationError(error);
  }
}
