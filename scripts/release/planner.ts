import { createHash } from "node:crypto";

import { serviceChanged, type Service } from "./changes.ts";
import type { GitClient } from "./git.ts";
import type {
  CloudflareInspection,
  CloudflareInspectionConfig,
  NetlifyInspection,
  NetlifyInspectionConfig,
  ProviderCommandRunner,
} from "./providers.ts";
import {
  releaseConfigSchema,
  type ReleaseBaseline,
  type ReleaseConfig,
  type ReleaseEnvironment,
} from "./schema.ts";

export type CheckOutcome = "passed" | "blocked";
export type ReleaseCheck = {
  id: string;
  outcome: CheckOutcome;
  summary: string;
};

type NetlifyReport = {
  outcome: CheckOutcome;
  affected: boolean | null;
  configurationFingerprint: string | null;
  baseline: {
    siteId: string;
    sourceCommit: string | null;
    publishedDeployId: string;
    publishLocked: boolean;
  } | null;
  observed: {
    siteId: string;
    publishedDeployId: string;
    publishLocked: boolean;
    sourceCommit: string | null;
  } | null;
};

type CloudflareReport = {
  outcome: CheckOutcome;
  affected: boolean | null;
  configurationFingerprint: string | null;
  baseline: {
    accountId: string;
    workerName: string;
    sourceCommit: string | null;
    deploymentId: string;
    traffic: readonly { versionId: string; percentage: number }[];
  } | null;
  observed: {
    accountId: string;
    workerName: string;
    deploymentId: string;
    traffic: readonly { versionId: string; percentage: number }[];
  } | null;
};

export type ReleaseReport = {
  schemaVersion: 1;
  operation: "plan" | "status";
  outcome: CheckOutcome;
  environment: ReleaseEnvironment;
  integrationBranch: string;
  candidate?: string;
  configuration: {
    source: "default" | "override";
    fingerprint: string;
    candidateBound: boolean | null;
  };
  checks: readonly ReleaseCheck[];
  providers: {
    netlify: NetlifyReport;
    cloudflare: CloudflareReport;
  };
  deploymentPlan?: readonly {
    provider: Service;
    action: "deploy" | "retain" | "blocked";
  }[];
};

export type ProviderInspectors = {
  inspectNetlify(
    config: NetlifyInspectionConfig,
    run: ProviderCommandRunner,
  ): Promise<NetlifyInspection>;
  inspectCloudflare(
    config: CloudflareInspectionConfig,
    run: ProviderCommandRunner,
  ): Promise<CloudflareInspection>;
};

export type PlannerDependencies = ProviderInspectors & {
  git: GitClient;
  createProviderRunner(timeoutMs: number): ProviderCommandRunner;
  providerTimeoutMs?: number;
};

type PlannerInput = {
  baseline: ReleaseBaseline;
  config: ReleaseConfig;
  configRepositoryPath: string | null;
  configSource: "default" | "override";
  environment: ReleaseEnvironment;
};

function check(id: string, passed: boolean, known: string, blocked: string): ReleaseCheck {
  return { id, outcome: passed ? "passed" : "blocked", summary: passed ? known : blocked };
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, stableValue(item)]),
    );
  }
  return value;
}

export function configurationFingerprint(value: unknown) {
  return createHash("sha256")
    .update(JSON.stringify(stableValue(value)))
    .digest("hex");
}

async function boundedInspection<T>(operation: () => Promise<T>, timeoutMs: number) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("Provider inspection timed out.")), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function variablesMatch(
  expected: Readonly<Record<string, string>>,
  observed: Readonly<Record<string, { present: boolean; matchesExpected: boolean }>>,
) {
  return Object.keys(expected).every(
    (name) => observed[name]?.present === true && observed[name]?.matchesExpected === true,
  );
}

function secretsPresent(expected: readonly string[], observed: Readonly<Record<string, boolean>>) {
  return expected.every((name) => observed[name] === true);
}

function trafficMatches(
  expected: readonly { versionId: string; percentage: number }[],
  observed: readonly { versionId: string; percentage: number }[],
) {
  const normalize = (traffic: readonly { versionId: string; percentage: number }[]) =>
    [...traffic].sort((left, right) => left.versionId.localeCompare(right.versionId));
  const left = normalize(expected);
  const right = normalize(observed);
  return (
    left.length === right.length &&
    left.every(
      (item, index) =>
        item.versionId === right[index]?.versionId &&
        Math.abs(item.percentage - right[index].percentage) < 0.000_001,
    )
  );
}

async function inspectProviders(
  input: PlannerInput,
  dependencies: PlannerDependencies,
  enabled = true,
): Promise<{
  checks: ReleaseCheck[];
  netlify: NetlifyInspection | null;
  cloudflare: CloudflareInspection | null;
}> {
  const target = input.config.environments[input.environment];
  const checks: ReleaseCheck[] = [];
  const timeoutMs = dependencies.providerTimeoutMs ?? 45_000;

  const inspectNetlifyTarget = async () => {
    if (!target.netlify || !enabled) return null;
    try {
      return await boundedInspection(
        () =>
          dependencies.inspectNetlify(
            target.netlify!,
            dependencies.createProviderRunner(timeoutMs),
          ),
        timeoutMs,
      );
    } catch {
      return null;
    }
  };

  const inspectCloudflareTarget = async () => {
    if (!target.cloudflare || !enabled) return null;
    try {
      return await boundedInspection(
        () =>
          dependencies.inspectCloudflare(
            target.cloudflare!,
            dependencies.createProviderRunner(timeoutMs),
          ),
        timeoutMs,
      );
    } catch {
      return null;
    }
  };

  const [netlify, cloudflare] = await Promise.all([
    inspectNetlifyTarget(),
    inspectCloudflareTarget(),
  ]);
  checks.push(
    check(
      "netlify.target",
      target.netlify !== null,
      "Netlify target is configured.",
      "Netlify target is not provisioned in release configuration.",
    ),
  );
  if (target.netlify) {
    checks.push(
      check(
        "netlify.inspection",
        netlify !== null,
        "Netlify inspection completed.",
        "Netlify inspection is unavailable.",
      ),
    );
  }
  if (netlify) {
    checks.push(
      check(
        "netlify.non-secret-variables",
        variablesMatch(target.netlify!.expectedNonSecretVariables, netlify.nonSecretVariables),
        "Netlify non-secret configuration matches.",
        "Netlify non-secret configuration is missing or different.",
      ),
      check(
        "netlify.required-secrets",
        secretsPresent(target.netlify!.requiredSecretNames, netlify.requiredSecrets),
        "Required Netlify secrets are present.",
        "One or more required Netlify secrets are missing.",
      ),
      check(
        "netlify.variable-scopes",
        netlify.variableScopesMatch,
        "Netlify variable scopes match.",
        "One or more Netlify variable scopes are missing or different.",
      ),
    );
  }
  checks.push(
    check(
      "cloudflare.target",
      target.cloudflare !== null,
      "Cloudflare target is configured.",
      "Cloudflare target is not provisioned in release configuration.",
    ),
  );
  if (target.cloudflare) {
    checks.push(
      check(
        "cloudflare.inspection",
        cloudflare !== null,
        "Cloudflare inspection completed.",
        "Cloudflare inspection is unavailable.",
      ),
    );
  }
  if (cloudflare) {
    checks.push(
      check(
        "cloudflare.non-secret-variables",
        variablesMatch(
          target.cloudflare!.expectedNonSecretVariables,
          cloudflare.nonSecretVariables,
        ),
        "Cloudflare non-secret configuration matches.",
        "Cloudflare non-secret configuration is missing or different.",
      ),
      check(
        "cloudflare.required-secrets",
        secretsPresent(target.cloudflare!.requiredSecretNames, cloudflare.requiredSecrets),
        "Required Cloudflare secrets are present.",
        "One or more required Cloudflare secrets are missing.",
      ),
    );
  }
  return { checks, netlify, cloudflare };
}

function baselineChecks(
  input: PlannerInput,
  netlify: NetlifyInspection | null,
  cloudflare: CloudflareInspection | null,
) {
  const checks: ReleaseCheck[] = [
    check(
      "baseline.environment",
      input.baseline.environment === input.environment,
      "Baseline environment matches the requested environment.",
      "Baseline environment does not match the requested environment.",
    ),
  ];
  const target = input.config.environments[input.environment];
  const netlifyBaseline = input.baseline.providers.netlify;
  checks.push(
    check(
      "netlify.baseline",
      netlifyBaseline !== null,
      "Netlify baseline is recorded.",
      "Netlify baseline is missing.",
    ),
  );
  if (target.netlify && netlifyBaseline) {
    checks.push(
      check(
        "netlify.baseline-target",
        netlifyBaseline.siteId === target.netlify.siteId,
        "Netlify baseline target matches configuration.",
        "Netlify baseline target differs from configuration.",
      ),
    );
  }
  if (netlify && netlifyBaseline) {
    checks.push(
      check(
        "netlify.observed-baseline",
        netlify.siteId === netlifyBaseline.siteId &&
          netlify.publishedDeployId === netlifyBaseline.publishedDeployId &&
          netlify.publishLocked === netlifyBaseline.publishLocked &&
          (netlify.publishedDeploySource.commitRef === null ||
            netlify.publishedDeploySource.commitRef === netlifyBaseline.sourceCommit),
        "Observed Netlify deployment matches the baseline.",
        "Observed Netlify deployment differs from the baseline.",
      ),
    );
  }

  const cloudflareBaseline = input.baseline.providers.cloudflare;
  checks.push(
    check(
      "cloudflare.baseline",
      cloudflareBaseline !== null,
      "Cloudflare baseline is recorded.",
      "Cloudflare baseline is missing.",
    ),
  );
  if (target.cloudflare && cloudflareBaseline) {
    checks.push(
      check(
        "cloudflare.baseline-target",
        cloudflareBaseline.accountId === target.cloudflare.accountId &&
          cloudflareBaseline.workerName === target.cloudflare.workerName,
        "Cloudflare baseline target matches configuration.",
        "Cloudflare baseline target differs from configuration.",
      ),
    );
  }
  if (cloudflare && cloudflareBaseline) {
    checks.push(
      check(
        "cloudflare.observed-baseline",
        cloudflare.accountId === cloudflareBaseline.accountId &&
          cloudflare.workerName === cloudflareBaseline.workerName &&
          cloudflare.deploymentId === cloudflareBaseline.deploymentId &&
          trafficMatches(cloudflareBaseline.traffic, cloudflare.traffic),
        "Observed Cloudflare deployment matches the baseline.",
        "Observed Cloudflare deployment differs from the baseline.",
      ),
    );
  }
  return checks;
}

function buildProviderReports(
  input: PlannerInput,
  checks: readonly ReleaseCheck[],
  affected: { netlify: boolean | null; cloudflare: boolean | null },
  netlify: NetlifyInspection | NetlifyReport["observed"],
  cloudflare: CloudflareReport["observed"],
): ReleaseReport["providers"] {
  const target = input.config.environments[input.environment];
  const providerOutcome = (provider: Service) =>
    checks.some((item) => item.id.startsWith(`${provider}.`) && item.outcome === "blocked")
      ? "blocked"
      : "passed";
  return {
    netlify: {
      outcome: providerOutcome("netlify"),
      affected: affected.netlify,
      configurationFingerprint: target.netlify ? configurationFingerprint(target.netlify) : null,
      baseline: input.baseline.providers.netlify,
      observed: netlify
        ? {
            siteId: netlify.siteId,
            publishedDeployId: netlify.publishedDeployId,
            publishLocked: netlify.publishLocked,
            sourceCommit:
              "publishedDeploySource" in netlify
                ? netlify.publishedDeploySource.commitRef
                : netlify.sourceCommit,
          }
        : null,
    },
    cloudflare: {
      outcome: providerOutcome("cloudflare"),
      affected: affected.cloudflare,
      configurationFingerprint: target.cloudflare
        ? configurationFingerprint(target.cloudflare)
        : null,
      baseline: input.baseline.providers.cloudflare,
      observed: cloudflare
        ? {
            accountId: cloudflare.accountId,
            workerName: cloudflare.workerName,
            deploymentId: cloudflare.deploymentId,
            traffic: cloudflare.traffic.map(({ versionId, percentage }) => ({
              versionId,
              percentage,
            })),
          }
        : null,
    },
  };
}

async function buildReleaseStatus(
  input: PlannerInput,
  dependencies: PlannerDependencies,
  inspectionEnabled: boolean,
): Promise<ReleaseReport> {
  const inspection = await inspectProviders(input, dependencies, inspectionEnabled);
  const checks = [
    ...inspection.checks,
    ...baselineChecks(input, inspection.netlify, inspection.cloudflare),
  ];
  const providers = buildProviderReports(
    input,
    checks,
    { netlify: null, cloudflare: null },
    inspection.netlify,
    inspection.cloudflare,
  );
  return {
    schemaVersion: 1,
    operation: "status",
    outcome: checks.some(({ outcome }) => outcome === "blocked") ? "blocked" : "passed",
    environment: input.environment,
    integrationBranch: input.config.integrationBranch,
    checks,
    configuration: {
      source: input.configSource,
      fingerprint: configurationFingerprint(input.config),
      candidateBound: null,
    },
    providers,
  };
}

export async function releaseStatus(
  input: PlannerInput,
  dependencies: PlannerDependencies,
): Promise<ReleaseReport> {
  return buildReleaseStatus(input, dependencies, true);
}

export async function releasePlan(
  input: PlannerInput & { candidate: string },
  dependencies: PlannerDependencies,
): Promise<ReleaseReport> {
  const preflightChecks: ReleaseCheck[] = [];
  let clean = false;
  let candidateExists = false;
  let reachable = false;
  try {
    clean = await dependencies.git.isClean();
  } catch {
    // A failed Git inspection is a blocked check.
  }
  preflightChecks.push(
    check(
      "git.clean",
      clean,
      "Repository has no tracked or untracked changes.",
      "Repository is dirty or could not be inspected.",
    ),
  );

  try {
    candidateExists = await dependencies.git.commitExists(input.candidate);
  } catch {
    // A failed Git inspection is a blocked check.
  }
  preflightChecks.push(
    check(
      "git.candidate",
      candidateExists,
      "Candidate commit exists.",
      "Candidate commit is unknown.",
    ),
  );
  let candidateBound = false;
  if (candidateExists && input.configRepositoryPath) {
    try {
      const rawCandidateConfig = await dependencies.git.readFileAtCommit(
        input.candidate,
        input.configRepositoryPath,
      );
      const candidateConfig = releaseConfigSchema.safeParse(JSON.parse(rawCandidateConfig));
      candidateBound =
        candidateConfig.success &&
        configurationFingerprint(candidateConfig.data) === configurationFingerprint(input.config);
    } catch {
      // Missing or malformed candidate configuration is a blocked check.
    }
  }
  preflightChecks.push(
    check(
      "config.candidate-bound",
      candidateBound,
      "Release configuration matches the candidate commit.",
      "Release configuration is outside the repository or differs from the candidate commit.",
    ),
  );
  let wranglerCandidateBound = input.config.environments[input.environment].cloudflare === null;
  const wranglerConfigPath =
    input.config.environments[input.environment].cloudflare?.wranglerConfigPath;
  if (candidateExists && wranglerConfigPath) {
    try {
      const [candidateWranglerConfig, checkedOutWranglerConfig] = await Promise.all([
        dependencies.git.readFileAtCommit(input.candidate, wranglerConfigPath),
        dependencies.git.readFileAtCommit("HEAD", wranglerConfigPath),
      ]);
      wranglerCandidateBound = candidateWranglerConfig === checkedOutWranglerConfig;
    } catch {
      // Missing or differing Wrangler configuration is a blocked check.
    }
  }
  preflightChecks.push(
    check(
      "config.wrangler-candidate-bound",
      wranglerCandidateBound,
      "Wrangler configuration matches the candidate commit.",
      "Wrangler configuration is missing or differs from the candidate commit.",
    ),
  );
  if (candidateExists) {
    try {
      reachable = await dependencies.git.isReachableFrom(
        input.candidate,
        input.config.integrationBranch,
      );
    } catch {
      // A failed Git inspection is a blocked check.
    }
  }
  preflightChecks.push(
    check(
      "git.integration-branch",
      reachable,
      "Candidate is reachable from the integration branch.",
      "Candidate is not reachable from the integration branch.",
    ),
  );

  const inspectionEnabled =
    clean &&
    candidateExists &&
    candidateBound &&
    wranglerCandidateBound &&
    reachable &&
    input.baseline.environment === input.environment;
  const status = await buildReleaseStatus(input, dependencies, inspectionEnabled);
  const checks = [...status.checks, ...preflightChecks];

  const affected: { netlify: boolean | null; cloudflare: boolean | null } = {
    netlify: null,
    cloudflare: null,
  };
  for (const provider of ["netlify", "cloudflare"] as const) {
    const sourceCommit = input.baseline.providers[provider]?.sourceCommit;
    let sourceExists = false;
    if (sourceCommit) {
      try {
        sourceExists = await dependencies.git.commitExists(sourceCommit);
      } catch {
        // A failed Git inspection is a blocked check.
      }
    }
    checks.push(
      check(
        `${provider}.baseline-source`,
        sourceExists,
        `${provider === "netlify" ? "Netlify" : "Cloudflare"} baseline source exists.`,
        `${provider === "netlify" ? "Netlify" : "Cloudflare"} baseline source is missing or unknown.`,
      ),
    );
    if (sourceCommit && sourceExists && candidateExists) {
      try {
        const paths = await dependencies.git.changedFiles(sourceCommit, input.candidate);
        affected[provider] = serviceChanged(provider, paths);
      } catch {
        // An unreadable diff remains unknown and blocks planning.
      }
    }
    checks.push(
      check(
        `${provider}.changes`,
        affected[provider] !== null,
        `${provider === "netlify" ? "Netlify" : "Cloudflare"} changes are classified.`,
        `${provider === "netlify" ? "Netlify" : "Cloudflare"} changes could not be classified.`,
      ),
    );
  }

  const providers = buildProviderReports(
    input,
    checks,
    affected,
    status.providers.netlify.observed,
    status.providers.cloudflare.observed,
  );
  const outcome = checks.some(({ outcome }) => outcome === "blocked") ? "blocked" : "passed";
  const deploymentPlan = (["netlify", "cloudflare"] as const).map((provider) => ({
    provider,
    action:
      outcome === "blocked" ||
      providers[provider].outcome === "blocked" ||
      affected[provider] === null
        ? ("blocked" as const)
        : affected[provider]
          ? ("deploy" as const)
          : ("retain" as const),
  }));
  return {
    schemaVersion: 1,
    operation: "plan",
    outcome,
    environment: input.environment,
    integrationBranch: input.config.integrationBranch,
    candidate: input.candidate,
    configuration: {
      ...status.configuration,
      candidateBound,
    },
    checks,
    providers,
    deploymentPlan,
  };
}
