import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { readReleaseJson } from "./files.ts";
import {
  downloadGitHubArtifact,
  extractVerifiedGitHubArtifact,
  type VerifiedCompletedAdoption,
  type VerifyCompletedAdoption,
} from "./github-release.ts";
import { preparedReleaseSchema } from "./prepare.ts";
import {
  productionAdoptionRecordSchema,
  validateCompletedAdoption,
} from "./production-adoption-record.ts";

export function completedAdoptionVerifier(
  repositoryRoot: string,
  token: string,
): VerifyCompletedAdoption {
  return async ({ run, artifact }): Promise<VerifiedCompletedAdoption> => {
    const parent = await mkdtemp(resolve(tmpdir(), "production-adoption-inspection-"));
    try {
      const directory = resolve(parent, "evidence");
      const bytes = await downloadGitHubArtifact({
        token,
        artifactId: artifact.artifactId,
        expectedDigest: artifact.digest,
        expectedSizeInBytes: artifact.sizeInBytes,
      });
      await extractVerifiedGitHubArtifact(bytes, directory, repositoryRoot);
      const [record, prepared] = await Promise.all([
        readReleaseJson(resolve(directory, "run/adoption.json"), productionAdoptionRecordSchema),
        readReleaseJson(
          resolve(directory, "artifacts/prepared-release.json"),
          preparedReleaseSchema,
        ),
      ]);
      const completed = validateCompletedAdoption(record, prepared);
      if (
        completed.runIds.at(-1) !== run.runId ||
        completed.source.promotionCommit !== run.headSha
      ) {
        throw new Error("Production adoption completion evidence differs.");
      }
      return {
        outcome: "passed",
        adoptionRunIds: completed.runIds,
        promotionCommit: completed.source.promotionCommit,
        configurationSha256: completed.source.configurationSha256,
        preparationSha256: completed.preparationSha256,
        workerArtifactSha256: prepared.artifacts.worker.sha256,
        workerScriptEtag: completed.results.uploadedWorker!.scriptEtag,
        adoptedPair: completed.adoptedPair!,
        proposedBaseline: completed.proposedBaseline!,
      };
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  };
}
