import type { PreparedRelease } from "./prepare.ts";
import type { ReleaseConfig } from "./schema.ts";
import type { Service } from "./changes.ts";

export type ProductionProviderTarget = {
  accountId: string;
  siteId?: string;
  workerName?: string;
};

// A process-local capability handed to adapters only after the production CLI
// verifies GitHub provenance, approval, source, artifacts and rollout policy.
// It is not serializable evidence or a replacement for scoped provider credentials.
export type ProductionProviderAuthorization = {
  assertArtifact(provider: Service, target: ProductionProviderTarget, artifactSha256: string): void;
};

export function bindProductionProviderAuthorization(
  prepared: PreparedRelease,
  config: ReleaseConfig,
): ProductionProviderAuthorization {
  if (prepared.source.environment !== "production")
    throw new Error("Production artifacts required.");
  const app = config.environments.production.netlify;
  const worker = config.environments.production.cloudflare;
  if (!app || !worker) throw new Error("Explicit production targets required.");
  return {
    assertArtifact(provider, target, artifactSha256) {
      const valid =
        provider === "netlify"
          ? target.accountId === app.accountId &&
            target.siteId === app.siteId &&
            target.workerName === undefined &&
            artifactSha256 === prepared.artifacts.netlify.sha256
          : target.accountId === worker.accountId &&
            target.workerName === worker.workerName &&
            target.siteId === undefined &&
            artifactSha256 === prepared.artifacts.worker.sha256;
      if (!valid) throw new Error("Production artifact or target differs from approval.");
    },
  };
}
