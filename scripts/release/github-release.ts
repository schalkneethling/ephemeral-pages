import { createHash } from "node:crypto";
import { mkdir, open, rm } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

import yauzl, { type Entry } from "yauzl";
import { z } from "zod/v4";

import { assertExternalArtifactDirectory } from "./artifact-contract.ts";
import { fullCommitSchema, releaseBaselineSchema, type ReleaseBaseline } from "./schema.ts";

export const GITHUB_RELEASE_REPOSITORY = "schalkneethling/ephemeral-pages";
export const GITHUB_RELEASE_WORKFLOWS = {
  production: ".github/workflows/release-production.yml",
  rehearsal: ".github/workflows/release-rehearsal.yml",
  ci: ".github/workflows/ci.yml",
} as const;
export const GITHUB_RELEASE_PRODUCTION_JOB_NAME = "Production release";
export const GITHUB_RELEASE_ACTIVATION_STEP_NAME = "Activate approved release";
export const GITHUB_RELEASE_RECOVERY_STEP_NAME = "Restore verified prior pair";
export const GITHUB_RELEASE_ADOPTION_STEP_NAME = "Adopt verified Worker baseline";

const GITHUB_API_ORIGIN = "https://api.github.com";
// The promotion verifier requires pull_request.merge_commit_sha. GitHub's
// 2026-03-10 REST version removes that field, so this client stays on the
// schema-compatible version rather than silently weakening merge identity.
const GITHUB_API_VERSION = "2022-11-28";
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_RESPONSE_BYTES = 1024 * 1024;
const DEFAULT_MAX_ARTIFACT_BYTES = 128 * 1024 * 1024;
const MAX_ARCHIVE_ENTRIES = 512;
const MAX_EXPANDED_ARTIFACT_BYTES = 256 * 1024 * 1024;
const MAX_ARCHIVE_PATH_BYTES = 1_024;
const MAX_LIST_ITEMS = 100;
const MAX_PRODUCTION_HISTORY_PAGES = 5;
const MAX_SKIPPED_ACTIVATION_RUNS = 20;
const MAX_REHEARSAL_AGE_MS = 7 * 24 * 60 * 60 * 1000;

const positiveIntegerSchema = z.number().int().positive().safe();
const timestampSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u)
  .refine((value) => Number.isFinite(Date.parse(value)));
const workflowPathSchema = z.string().regex(/^\.github\/workflows\/[A-Za-z0-9_.-]+\.ya?ml$/u);
const completedRecoverySchema = z.object({
  outcome: z.literal("passed"),
  sourceProductionRunId: positiveIntegerSchema,
  recoveryRunIds: z.array(positiveIntegerSchema).min(1).max(MAX_LIST_ITEMS),
});
const completedAdoptionSchema = z.strictObject({
  outcome: z.literal("passed"),
  adoptionRunIds: z.array(positiveIntegerSchema).min(1).max(MAX_LIST_ITEMS),
  promotionCommit: fullCommitSchema,
  configurationSha256: z.string().regex(/^[a-f0-9]{64}$/u),
  preparationSha256: z.string().regex(/^[a-f0-9]{64}$/u),
  workerArtifactSha256: z.string().regex(/^[a-f0-9]{64}$/u),
  workerScriptEtag: z.string().regex(/^[a-f0-9]{32,128}$/u),
  adoptedPair: z.strictObject({
    netlifyDeployId: z.string().min(1).max(256),
    workerDeploymentId: z.string().min(1).max(256),
    workerVersionId: z.string().min(1).max(256),
  }),
  proposedBaseline: releaseBaselineSchema,
});

const repositorySchema = z.object({ full_name: z.string() });
const workflowRunSchema = z.object({
  id: positiveIntegerSchema,
  run_attempt: positiveIntegerSchema,
  event: z.string(),
  status: z.string(),
  conclusion: z.string().nullable(),
  head_branch: z.string().nullable(),
  head_sha: fullCommitSchema,
  path: z.string(),
  workflow_id: positiveIntegerSchema,
  created_at: timestampSchema,
  updated_at: timestampSchema,
  repository: repositorySchema,
});
const workflowSchema = z.object({
  id: positiveIntegerSchema,
  path: workflowPathSchema,
  state: z.string(),
});
const branchSchema = z.object({
  name: z.string(),
  protected: z.boolean(),
  commit: z.object({ sha: fullCommitSchema }),
});
const environmentSchema = z.object({
  name: z.string(),
  deployment_branch_policy: z.object({
    protected_branches: z.boolean(),
    custom_branch_policies: z.boolean(),
  }),
});
const deploymentBranchPoliciesSchema = z.object({
  total_count: z.number().int().nonnegative().safe(),
  branch_policies: z
    .array(
      z.object({
        id: positiveIntegerSchema,
        name: z.string(),
      }),
    )
    .max(MAX_LIST_ITEMS),
});
const pullRequestSchema = z.object({
  number: positiveIntegerSchema,
  state: z.string(),
  merged_at: timestampSchema.nullable(),
  merge_commit_sha: fullCommitSchema.nullable(),
  base: z.object({
    ref: z.string(),
    sha: fullCommitSchema,
    repo: repositorySchema,
  }),
  head: z.object({
    ref: z.string(),
    sha: fullCommitSchema,
    repo: repositorySchema,
  }),
});
const gitCommitSchema = z.object({
  sha: fullCommitSchema,
  tree: z.object({ sha: fullCommitSchema }),
});
const workflowRunsSchema = z.object({
  total_count: z.number().int().nonnegative().safe(),
  workflow_runs: z.array(workflowRunSchema).max(MAX_LIST_ITEMS),
});
const jobsSchema = z.object({
  total_count: z.number().int().nonnegative().safe(),
  jobs: z
    .array(
      z.object({
        id: positiveIntegerSchema,
        name: z.string(),
        head_sha: fullCommitSchema,
        status: z.string(),
        conclusion: z.string().nullable(),
        steps: z
          .array(
            z.object({
              name: z.string(),
              status: z.string(),
              conclusion: z.string().nullable(),
              number: positiveIntegerSchema,
            }),
          )
          .max(MAX_LIST_ITEMS),
      }),
    )
    .max(MAX_LIST_ITEMS),
});
const artifactsSchema = z.object({
  total_count: z.number().int().nonnegative().safe(),
  artifacts: z
    .array(
      z.object({
        id: positiveIntegerSchema,
        name: z.string(),
        size_in_bytes: z.number().int().nonnegative().safe(),
        expired: z.boolean(),
        created_at: timestampSchema,
        updated_at: timestampSchema,
        expires_at: timestampSchema,
        digest: z.string(),
        workflow_run: z.object({
          id: positiveIntegerSchema,
          head_branch: z.string(),
          head_sha: fullCommitSchema,
        }),
      }),
    )
    .max(MAX_LIST_ITEMS),
});

export type GitHubReleaseErrorKind =
  | "configuration"
  | "transport"
  | "response"
  | "runtime"
  | "source"
  | "promotion"
  | "validation"
  | "rehearsal"
  | "resume"
  | "artifact";

export class GitHubReleaseError extends Error {
  readonly kind: GitHubReleaseErrorKind;

  constructor(kind: GitHubReleaseErrorKind) {
    super(`GitHub release ${kind} verification failed.`);
    this.name = "GitHubReleaseError";
    this.kind = kind;
  }
}

export type GitHubApiRequest = {
  path: string;
  query?: Readonly<Record<string, string>>;
};

export type GitHubReleaseApi = {
  get(request: GitHubApiRequest): Promise<unknown>;
};

export type GitHubRuntimeEnvironment = Readonly<
  Record<
    | "GITHUB_ACTIONS"
    | "GITHUB_EVENT_NAME"
    | "GITHUB_REF"
    | "GITHUB_REF_PROTECTED"
    | "GITHUB_REPOSITORY"
    | "GITHUB_RUN_ATTEMPT"
    | "GITHUB_RUN_ID"
    | "GITHUB_SHA"
    | "GITHUB_WORKFLOW_REF"
    | "GITHUB_WORKFLOW_SHA",
    string | undefined
  >
>;

export type VerifiedWorkflowRun = {
  runId: number;
  runAttempt: number;
  workflowId: number;
  workflowPath: string;
  branch: "main" | "stage";
  headSha: string;
  createdAt: string;
  updatedAt: string;
};

export type VerifiedDeploymentEnvironment = {
  name: "production" | "staging";
  branch: "main" | "stage";
  policyId: number;
};

export type VerifiedProductionRun = VerifiedWorkflowRun & {
  branch: "main";
};

export type VerifiedProductionInvocation = VerifiedProductionRun & {
  environment: VerifiedDeploymentEnvironment & { name: "production"; branch: "main" };
};

export type VerifiedStagingInvocation = VerifiedWorkflowRun & {
  branch: "stage";
  environment: VerifiedDeploymentEnvironment & { name: "staging"; branch: "stage" };
};

type VerifiedInvocationForBranch<B extends "main" | "stage"> = VerifiedWorkflowRun & {
  branch: B;
  environment: B extends "main"
    ? VerifiedDeploymentEnvironment & { name: "production"; branch: "main" }
    : VerifiedDeploymentEnvironment & { name: "staging"; branch: "stage" };
};

export type VerifiedPromotion = {
  pullRequestNumber: number;
  candidate: string;
  candidateTree: string;
  promotionCommit: string;
  promotionTree: string;
  mergedAt: string;
};

export type VerifiedCiValidation = {
  runId: number;
  runAttempt: number;
  jobId: number;
  promotionCommit: string;
  completedAt: string;
};

export type VerifiedRehearsalArtifact = {
  artifactId: number;
  name: "release-rehearsal";
  digest: `sha256:${string}`;
  sizeInBytes: number;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
};

export type VerifiedProductionArtifact = Omit<VerifiedRehearsalArtifact, "name"> & {
  name: "release-production";
};

export type VerifiedRecoveryTargetArtifact = {
  run: VerifiedProductionRun;
  artifact: VerifiedProductionArtifact;
  jobId: number;
  activationStepNumber: number;
  adoptionStepNumber?: number;
};

export type VerifiedRehearsalEvidence = {
  run: VerifiedWorkflowRun & { branch: "stage" };
  artifact: VerifiedRehearsalArtifact;
};

export type PreviousProductionRun = {
  previous: VerifiedProductionRun | null;
  previousOperation: "release" | "recovery" | "adoption" | null;
  requiresResume: boolean;
  requiredOperation:
    | "none"
    | "resume-production"
    | "recover-production"
    | "resume-recovery"
    | "resume-adoption";
  artifact?: VerifiedProductionArtifact;
  completedRecovery?: VerifiedCompletedRecovery;
  completedAdoption?: VerifiedCompletedAdoption;
  skippedActivations: ReadonlyArray<{
    runId: number;
    jobId: number;
    stepNumber: number;
  }>;
};

export type VerifiedCompletedRecovery = {
  outcome: "passed";
  sourceProductionRunId: number;
  recoveryRunIds: readonly number[];
};

export type VerifyCompletedRecovery = (input: {
  run: VerifiedProductionRun;
  artifact: VerifiedProductionArtifact;
}) => Promise<VerifiedCompletedRecovery>;

export type VerifiedCompletedAdoption = {
  outcome: "passed";
  adoptionRunIds: readonly number[];
  promotionCommit: string;
  configurationSha256: string;
  preparationSha256: string;
  workerArtifactSha256: string;
  workerScriptEtag: string;
  adoptedPair: {
    netlifyDeployId: string;
    workerDeploymentId: string;
    workerVersionId: string;
  };
  proposedBaseline: ReleaseBaseline;
};

export type VerifyCompletedAdoption = (input: {
  run: VerifiedProductionRun;
  artifact: VerifiedProductionArtifact;
}) => Promise<VerifiedCompletedAdoption>;

export type VerifiedResumeSource = {
  currentRunId: number;
  resumedRunId: number;
  originalRunId: number;
  promotionCommit: string;
  workflowId: number;
  workflowPath: string;
  artifact: VerifiedProductionArtifact;
};

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

const parsePositiveInteger = (value: string | undefined): number | null => {
  if (!value || !/^[1-9][0-9]*$/u.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
};

const validateClientOptions = (timeoutMs: number, maxResponseBytes: number): void => {
  if (
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > 30_000 ||
    !Number.isSafeInteger(maxResponseBytes) ||
    maxResponseBytes < 1 ||
    maxResponseBytes > 4 * 1024 * 1024
  ) {
    throw new GitHubReleaseError("configuration");
  }
};

async function readBoundedResponse(response: Response, maxBytes: number): Promise<unknown> {
  const declaredLength = response.headers.get("content-length");
  if (declaredLength !== null) {
    const length = Number(declaredLength);
    if (!Number.isSafeInteger(length) || length < 0 || length > maxBytes) {
      throw new GitHubReleaseError("response");
    }
  }
  if (!response.body) throw new GitHubReleaseError("response");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  while (true) {
    const item = await reader.read();
    if (item.done) break;
    bytes += item.value.byteLength;
    if (bytes > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new GitHubReleaseError("response");
    }
    chunks.push(item.value);
  }
  const body = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body));
  } catch {
    throw new GitHubReleaseError("response");
  }
}

async function readBoundedBytes(response: Response, maxBytes: number): Promise<Uint8Array> {
  const declaredLength = response.headers.get("content-length");
  if (declaredLength !== null) {
    const length = Number(declaredLength);
    if (!Number.isSafeInteger(length) || length < 0 || length > maxBytes) {
      throw new GitHubReleaseError("artifact");
    }
  }
  if (!response.body) throw new GitHubReleaseError("artifact");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  while (true) {
    const item = await reader.read();
    if (item.done) break;
    bytes += item.value.byteLength;
    if (bytes > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new GitHubReleaseError("artifact");
    }
    chunks.push(item.value);
  }
  const body = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

const githubApiHeaders = (token: string): Record<string, string> => ({
  Accept: "application/vnd.github+json",
  Authorization: `Bearer ${token}`,
  "X-GitHub-Api-Version": GITHUB_API_VERSION,
});

export function createGitHubReleaseApi(options: {
  token: string;
  fetch?: FetchLike;
  timeoutMs?: number;
  maxResponseBytes?: number;
}): GitHubReleaseApi {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxResponseBytes = options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
  validateClientOptions(timeoutMs, maxResponseBytes);
  if (!options.token || options.token.length > 4_096) {
    throw new GitHubReleaseError("configuration");
  }
  const fetchImpl = options.fetch ?? fetch;
  return {
    async get({ path, query = {} }) {
      if (!path.startsWith(`/repos/${GITHUB_RELEASE_REPOSITORY}/`) || path.includes("?")) {
        throw new GitHubReleaseError("configuration");
      }
      const url = new URL(path, GITHUB_API_ORIGIN);
      if (url.origin !== GITHUB_API_ORIGIN || url.pathname !== path || url.hash) {
        throw new GitHubReleaseError("configuration");
      }
      for (const [name, value] of Object.entries(query).sort(([left], [right]) =>
        left.localeCompare(right),
      )) {
        url.searchParams.set(name, value);
      }
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetchImpl(url, {
          method: "GET",
          headers: githubApiHeaders(options.token),
          redirect: "error",
          signal: controller.signal,
        });
        if (!response.ok) throw new GitHubReleaseError("transport");
        return await readBoundedResponse(response, maxResponseBytes);
      } catch (error) {
        if (error instanceof GitHubReleaseError) throw error;
        throw new GitHubReleaseError("transport");
      } finally {
        clearTimeout(timeout);
      }
    },
  };
}

const isTrustedArtifactHost = (hostname: string): boolean =>
  hostname === "results-receiver.actions.githubusercontent.com" ||
  (hostname.endsWith(".blob.core.windows.net") && hostname !== ".blob.core.windows.net");

export async function downloadGitHubArtifact(input: {
  token: string;
  artifactId: number;
  expectedDigest: `sha256:${string}`;
  expectedSizeInBytes: number;
  fetch?: FetchLike;
  timeoutMs?: number;
  maxArtifactBytes?: number;
}): Promise<Uint8Array> {
  const timeoutMs = input.timeoutMs ?? 30_000;
  const maxArtifactBytes = input.maxArtifactBytes ?? DEFAULT_MAX_ARTIFACT_BYTES;
  if (
    !input.token ||
    input.token.length > 4_096 ||
    !positiveIntegerSchema.safeParse(input.artifactId).success ||
    !/^sha256:[a-f0-9]{64}$/u.test(input.expectedDigest) ||
    !Number.isSafeInteger(input.expectedSizeInBytes) ||
    input.expectedSizeInBytes < 1 ||
    input.expectedSizeInBytes > maxArtifactBytes ||
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > 120_000 ||
    !Number.isSafeInteger(maxArtifactBytes) ||
    maxArtifactBytes < 1 ||
    maxArtifactBytes > 512 * 1024 * 1024
  ) {
    throw new GitHubReleaseError("configuration");
  }
  const fetchImpl = input.fetch ?? fetch;
  const deadline = Date.now() + timeoutMs;
  const request = async (url: URL, init: RequestInit): Promise<Response> => {
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) throw new GitHubReleaseError("transport");
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), remainingMs);
    try {
      return await fetchImpl(url, { ...init, signal: controller.signal });
    } catch {
      throw new GitHubReleaseError("transport");
    } finally {
      clearTimeout(timeout);
    }
  };

  const apiUrl = new URL(
    repositoryPath(`actions/artifacts/${input.artifactId}/zip`),
    GITHUB_API_ORIGIN,
  );
  const redirect = await request(apiUrl, {
    method: "GET",
    headers: githubApiHeaders(input.token),
    redirect: "manual",
  });
  if (redirect.status !== 302) throw new GitHubReleaseError("artifact");
  const location = redirect.headers.get("location");
  let downloadUrl: URL;
  try {
    downloadUrl = new URL(location ?? "");
  } catch {
    throw new GitHubReleaseError("artifact");
  }
  if (
    downloadUrl.protocol !== "https:" ||
    downloadUrl.username ||
    downloadUrl.password ||
    (downloadUrl.port && downloadUrl.port !== "443") ||
    !isTrustedArtifactHost(downloadUrl.hostname)
  ) {
    throw new GitHubReleaseError("artifact");
  }
  const response = await request(downloadUrl, { method: "GET", redirect: "error" });
  if (!response.ok) throw new GitHubReleaseError("artifact");
  const archive = await readBoundedBytes(response, maxArtifactBytes);
  const actualDigest = `sha256:${createHash("sha256").update(archive).digest("hex")}`;
  if (archive.byteLength !== input.expectedSizeInBytes || actualDigest !== input.expectedDigest) {
    throw new GitHubReleaseError("artifact");
  }
  return archive;
}

type ArchiveEntry = {
  entry: Entry;
  relativePath: string;
  directory: boolean;
};

const insideDirectory = (directory: string, path: string): boolean => {
  const difference = relative(directory, path);
  return difference !== ".." && !difference.startsWith(`..${sep}`) && !isAbsolute(difference);
};

const archivePath = (entry: Entry): { path: string; directory: boolean; key: string } => {
  if (
    typeof entry.fileName !== "string" ||
    entry.fileName.length === 0 ||
    Buffer.byteLength(entry.fileName, "utf8") > MAX_ARCHIVE_PATH_BYTES ||
    entry.fileName.includes("\0") ||
    entry.fileName.includes("\\")
  ) {
    throw new GitHubReleaseError("artifact");
  }
  const directory = entry.fileName.endsWith("/");
  const path = directory ? entry.fileName.slice(0, -1) : entry.fileName;
  const parts = path.split("/");
  if (
    path.length === 0 ||
    path.startsWith("/") ||
    /^[A-Za-z]:/u.test(path) ||
    parts.some(
      (part) =>
        part.length === 0 || part === "." || part === ".." || Buffer.byteLength(part, "utf8") > 255,
    )
  ) {
    throw new GitHubReleaseError("artifact");
  }
  return { path, directory, key: path.normalize("NFC").toLowerCase() };
};

const verifyEntryKind = (entry: Entry, directory: boolean): void => {
  if (
    !Number.isSafeInteger(entry.uncompressedSize) ||
    entry.uncompressedSize < 0 ||
    (directory && entry.uncompressedSize !== 0) ||
    entry.isEncrypted() ||
    !entry.canDecodeFileData() ||
    (entry.compressionMethod !== 0 && entry.compressionMethod !== 8)
  ) {
    throw new GitHubReleaseError("artifact");
  }
  const hostSystem = (entry.versionMadeBy >>> 8) & 0xff;
  if (hostSystem === 3) {
    const type = (entry.externalFileAttributes >>> 16) & 0o170000;
    const expected = directory ? 0o040000 : 0o100000;
    if (type !== 0 && type !== expected) throw new GitHubReleaseError("artifact");
  } else {
    const dosDirectory = (entry.externalFileAttributes & 0x10) !== 0;
    if (dosDirectory !== directory && dosDirectory) throw new GitHubReleaseError("artifact");
  }
};

export async function extractVerifiedGitHubArtifact(
  archive: Uint8Array,
  destination: string,
  repositoryRoot: string,
): Promise<void> {
  const target = resolve(destination);
  let created = false;
  try {
    if (
      !isAbsolute(destination) ||
      archive.byteLength < 22 ||
      archive.byteLength > DEFAULT_MAX_ARTIFACT_BYTES
    ) {
      throw new GitHubReleaseError("configuration");
    }
    await assertExternalArtifactDirectory(repositoryRoot, target);
    const buffer = Buffer.from(archive.buffer, archive.byteOffset, archive.byteLength);
    const zipfile = await yauzl.fromBufferPromise(buffer, {
      strictFileNames: true,
      validateEntrySizes: true,
    });
    if (
      !Number.isSafeInteger(zipfile.entryCount) ||
      zipfile.entryCount < 1 ||
      zipfile.entryCount > MAX_ARCHIVE_ENTRIES
    ) {
      throw new GitHubReleaseError("artifact");
    }
    const entries: ArchiveEntry[] = [];
    const entriesByKey = new Map<string, ArchiveEntry>();
    let expectedBytes = 0;
    for await (const entry of zipfile.eachEntry()) {
      if (entries.length >= MAX_ARCHIVE_ENTRIES) throw new GitHubReleaseError("artifact");
      const normalized = archivePath(entry);
      verifyEntryKind(entry, normalized.directory);
      expectedBytes += entry.uncompressedSize;
      if (
        !Number.isSafeInteger(expectedBytes) ||
        expectedBytes > MAX_EXPANDED_ARTIFACT_BYTES ||
        entriesByKey.has(normalized.key)
      ) {
        throw new GitHubReleaseError("artifact");
      }
      const item = { entry, relativePath: normalized.path, directory: normalized.directory };
      entries.push(item);
      entriesByKey.set(normalized.key, item);
    }
    if (entries.length !== zipfile.entryCount) throw new GitHubReleaseError("artifact");
    for (const item of entries) {
      const parts = item.relativePath.normalize("NFC").toLowerCase().split("/");
      for (let index = 1; index < parts.length; index += 1) {
        const parent = entriesByKey.get(parts.slice(0, index).join("/"));
        if (parent && !parent.directory) throw new GitHubReleaseError("artifact");
      }
    }

    await mkdir(target, { mode: 0o700 });
    created = true;
    let expandedBytes = 0;
    for (const item of entries) {
      const path = resolve(target, item.relativePath);
      if (!insideDirectory(target, path)) throw new GitHubReleaseError("artifact");
      if (item.directory) {
        await mkdir(path, { mode: 0o700, recursive: true });
        continue;
      }
      await mkdir(resolve(path, ".."), { mode: 0o700, recursive: true });
      const handle = await open(path, "wx", 0o600);
      let entryBytes = 0;
      try {
        const stream = await zipfile.openReadStreamPromise(item.entry);
        for await (const chunk of stream) {
          if (!(chunk instanceof Uint8Array)) throw new GitHubReleaseError("artifact");
          entryBytes += chunk.byteLength;
          expandedBytes += chunk.byteLength;
          if (
            entryBytes > item.entry.uncompressedSize ||
            expandedBytes > MAX_EXPANDED_ARTIFACT_BYTES
          ) {
            throw new GitHubReleaseError("artifact");
          }
          let offset = 0;
          while (offset < chunk.byteLength) {
            const result = await handle.write(chunk, offset, chunk.byteLength - offset);
            if (result.bytesWritten < 1) throw new GitHubReleaseError("artifact");
            offset += result.bytesWritten;
          }
        }
      } finally {
        await handle.close();
      }
      if (entryBytes !== item.entry.uncompressedSize) {
        throw new GitHubReleaseError("artifact");
      }
    }
    if (expandedBytes !== expectedBytes) throw new GitHubReleaseError("artifact");
  } catch {
    if (created) await rm(target, { force: true, recursive: true }).catch(() => undefined);
    throw new GitHubReleaseError("artifact");
  }
}

const repositoryPath = (suffix: string): string => `/repos/${GITHUB_RELEASE_REPOSITORY}/${suffix}`;

const parseResponse = <T>(schema: z.ZodType<T>, value: unknown): T => {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new GitHubReleaseError("response");
  return parsed.data;
};

const workflowRunPath = (runId: number): string => repositoryPath(`actions/runs/${runId}`);
const workflowPath = (path: string): string =>
  repositoryPath(`actions/workflows/${encodeURIComponent(path.split("/").at(-1)!)}`);
const branchPath = (branch: "main" | "stage"): string =>
  repositoryPath(`branches/${encodeURIComponent(branch)}`);

async function readWorkflowRun(api: GitHubReleaseApi, runId: number) {
  if (!positiveIntegerSchema.safeParse(runId).success)
    throw new GitHubReleaseError("configuration");
  return parseResponse(workflowRunSchema, await api.get({ path: workflowRunPath(runId) }));
}

async function readActiveWorkflow(api: GitHubReleaseApi, expectedPath: string) {
  const workflow = parseResponse(
    workflowSchema,
    await api.get({ path: workflowPath(expectedPath) }),
  );
  if (workflow.path !== expectedPath || workflow.state !== "active") {
    throw new GitHubReleaseError("source");
  }
  return workflow;
}

async function requireProtectedBranch(api: GitHubReleaseApi, branch: "main" | "stage") {
  const result = parseResponse(branchSchema, await api.get({ path: branchPath(branch) }));
  if (result.name !== branch || !result.protected) throw new GitHubReleaseError("source");
  return result;
}

export async function verifyDeploymentEnvironment(
  api: GitHubReleaseApi,
  input: { name: "production" | "staging"; branch: "main" | "stage" },
): Promise<VerifiedDeploymentEnvironment> {
  if (
    (input.name === "production" && input.branch !== "main") ||
    (input.name === "staging" && input.branch !== "stage")
  ) {
    throw new GitHubReleaseError("configuration");
  }
  const environmentPath = repositoryPath(`environments/${encodeURIComponent(input.name)}`);
  const [environment, policies] = await Promise.all([
    api.get({ path: environmentPath }).then((value) => parseResponse(environmentSchema, value)),
    api
      .get({
        path: `${environmentPath}/deployment-branch-policies`,
        query: { page: "1", per_page: String(MAX_LIST_ITEMS) },
      })
      .then((value) => parseResponse(deploymentBranchPoliciesSchema, value)),
  ]);
  if (
    environment.name !== input.name ||
    environment.deployment_branch_policy.protected_branches ||
    !environment.deployment_branch_policy.custom_branch_policies ||
    policies.total_count !== policies.branch_policies.length ||
    policies.branch_policies.length !== 1 ||
    policies.branch_policies[0].name !== input.branch
  ) {
    throw new GitHubReleaseError("source");
  }
  return {
    name: input.name,
    branch: input.branch,
    policyId: policies.branch_policies[0].id,
  };
}

function verifyRunSource(
  run: z.infer<typeof workflowRunSchema>,
  workflow: z.infer<typeof workflowSchema>,
  branch: "main" | "stage",
  expectedSha?: string,
): VerifiedWorkflowRun {
  if (
    run.repository.full_name !== GITHUB_RELEASE_REPOSITORY ||
    run.workflow_id !== workflow.id ||
    !workflowRunPathMatches(run.path, workflow.path, branch) ||
    run.event !== "workflow_dispatch" ||
    run.head_branch !== branch ||
    (expectedSha !== undefined && run.head_sha !== expectedSha)
  ) {
    throw new GitHubReleaseError("source");
  }
  return {
    runId: run.id,
    runAttempt: run.run_attempt,
    workflowId: run.workflow_id,
    workflowPath: workflow.path,
    branch,
    headSha: run.head_sha,
    createdAt: run.created_at,
    updatedAt: run.updated_at,
  };
}

// GitHub's workflow-run API currently returns both the documented
// `<workflow path>@<branch>` representation and an unsuffixed workflow path.
// Keep either representation exact; repository, workflow ID, branch, and SHA
// are verified independently by each caller.
function workflowRunPathMatches(
  runPath: string,
  expectedWorkflowPath: string,
  expectedBranch: "main" | "stage",
): boolean {
  return (
    runPath === expectedWorkflowPath || runPath === `${expectedWorkflowPath}@${expectedBranch}`
  );
}

async function verifyInvocation<B extends "main" | "stage">(
  api: GitHubReleaseApi,
  runtime: GitHubRuntimeEnvironment,
  branchName: B,
  expectedWorkflowPath: string,
): Promise<VerifiedInvocationForBranch<B>> {
  const runId = parsePositiveInteger(runtime.GITHUB_RUN_ID);
  const runAttempt = parsePositiveInteger(runtime.GITHUB_RUN_ATTEMPT);
  if (
    runtime.GITHUB_ACTIONS !== "true" ||
    runtime.GITHUB_EVENT_NAME !== "workflow_dispatch" ||
    runtime.GITHUB_REPOSITORY !== GITHUB_RELEASE_REPOSITORY ||
    runtime.GITHUB_REF !== `refs/heads/${branchName}` ||
    runtime.GITHUB_REF_PROTECTED !== "true" ||
    runtime.GITHUB_WORKFLOW_REF !==
      `${GITHUB_RELEASE_REPOSITORY}/${expectedWorkflowPath}@refs/heads/${branchName}` ||
    !fullCommitSchema.safeParse(runtime.GITHUB_SHA).success ||
    runtime.GITHUB_WORKFLOW_SHA !== runtime.GITHUB_SHA ||
    runId === null ||
    runAttempt === null
  ) {
    throw new GitHubReleaseError("runtime");
  }
  const [run, workflow, branch, environment] = await Promise.all([
    readWorkflowRun(api, runId),
    readActiveWorkflow(api, expectedWorkflowPath),
    requireProtectedBranch(api, branchName),
    verifyDeploymentEnvironment(api, {
      name: branchName === "main" ? "production" : "staging",
      branch: branchName,
    }),
  ]);
  const verified = verifyRunSource(run, workflow, branchName, runtime.GITHUB_SHA);
  if (
    verified.runAttempt !== runAttempt ||
    verified.runAttempt !== 1 ||
    branch.commit.sha !== runtime.GITHUB_SHA ||
    run.status !== "in_progress"
  ) {
    throw new GitHubReleaseError("runtime");
  }
  return { ...verified, branch: branchName, environment } as VerifiedInvocationForBranch<B>;
}

export async function verifyProductionInvocation(
  api: GitHubReleaseApi,
  runtime: GitHubRuntimeEnvironment,
): Promise<VerifiedProductionInvocation> {
  return verifyInvocation(api, runtime, "main", GITHUB_RELEASE_WORKFLOWS.production);
}

export async function verifyStagingInvocation(
  api: GitHubReleaseApi,
  runtime: GitHubRuntimeEnvironment,
): Promise<VerifiedStagingInvocation> {
  return verifyInvocation(api, runtime, "stage", GITHUB_RELEASE_WORKFLOWS.rehearsal);
}

export async function verifyPromotionEvidence(
  api: GitHubReleaseApi,
  input: {
    pullRequestNumber: number;
    candidate: string;
    promotionCommit: string;
  },
): Promise<VerifiedPromotion> {
  if (
    !positiveIntegerSchema.safeParse(input.pullRequestNumber).success ||
    !fullCommitSchema.safeParse(input.candidate).success ||
    !fullCommitSchema.safeParse(input.promotionCommit).success
  ) {
    throw new GitHubReleaseError("configuration");
  }
  const [pullRequest, candidateCommit, promotionCommit, main, stage] = await Promise.all([
    api
      .get({ path: repositoryPath(`pulls/${input.pullRequestNumber}`) })
      .then((value) => parseResponse(pullRequestSchema, value)),
    api
      .get({ path: repositoryPath(`git/commits/${input.candidate}`) })
      .then((value) => parseResponse(gitCommitSchema, value)),
    api
      .get({ path: repositoryPath(`git/commits/${input.promotionCommit}`) })
      .then((value) => parseResponse(gitCommitSchema, value)),
    requireProtectedBranch(api, "main"),
    requireProtectedBranch(api, "stage"),
  ]);
  if (
    pullRequest.number !== input.pullRequestNumber ||
    pullRequest.state !== "closed" ||
    pullRequest.merged_at === null ||
    pullRequest.merge_commit_sha !== input.promotionCommit ||
    pullRequest.base.ref !== "main" ||
    pullRequest.base.repo.full_name !== GITHUB_RELEASE_REPOSITORY ||
    pullRequest.head.ref !== "stage" ||
    pullRequest.head.repo.full_name !== GITHUB_RELEASE_REPOSITORY ||
    pullRequest.head.sha !== input.candidate ||
    candidateCommit.sha !== input.candidate ||
    promotionCommit.sha !== input.promotionCommit ||
    candidateCommit.tree.sha !== promotionCommit.tree.sha ||
    main.commit.sha !== input.promotionCommit ||
    stage.commit.sha !== input.candidate
  ) {
    throw new GitHubReleaseError("promotion");
  }
  return {
    pullRequestNumber: pullRequest.number,
    candidate: candidateCommit.sha,
    candidateTree: candidateCommit.tree.sha,
    promotionCommit: promotionCommit.sha,
    promotionTree: promotionCommit.tree.sha,
    mergedAt: pullRequest.merged_at,
  };
}

export async function verifyCiValidation(
  api: GitHubReleaseApi,
  promotionCommit: string,
): Promise<VerifiedCiValidation> {
  if (!fullCommitSchema.safeParse(promotionCommit).success) {
    throw new GitHubReleaseError("configuration");
  }
  const workflow = await readActiveWorkflow(api, GITHUB_RELEASE_WORKFLOWS.ci);
  const runs = parseResponse(
    workflowRunsSchema,
    await api.get({
      path: `${workflowPath(GITHUB_RELEASE_WORKFLOWS.ci)}/runs`,
      query: {
        branch: "main",
        event: "push",
        head_sha: promotionCommit,
        page: "1",
        per_page: String(MAX_LIST_ITEMS),
        status: "completed",
      },
    }),
  );
  if (runs.total_count !== runs.workflow_runs.length || runs.workflow_runs.length !== 1) {
    throw new GitHubReleaseError("validation");
  }
  const [run] = runs.workflow_runs;
  if (
    run.repository.full_name !== GITHUB_RELEASE_REPOSITORY ||
    run.workflow_id !== workflow.id ||
    !workflowRunPathMatches(run.path, workflow.path, "main") ||
    run.event !== "push" ||
    run.head_branch !== "main" ||
    run.head_sha !== promotionCommit ||
    run.status !== "completed" ||
    run.conclusion !== "success"
  ) {
    throw new GitHubReleaseError("validation");
  }
  const jobs = parseResponse(
    jobsSchema,
    await api.get({
      path: repositoryPath(`actions/runs/${run.id}/attempts/${run.run_attempt}/jobs`),
      query: { page: "1", per_page: String(MAX_LIST_ITEMS) },
    }),
  );
  const validateJobs = jobs.jobs.filter((job) => job.name === "validate");
  if (
    jobs.total_count !== jobs.jobs.length ||
    validateJobs.length !== 1 ||
    validateJobs[0].head_sha !== promotionCommit ||
    validateJobs[0].status !== "completed" ||
    validateJobs[0].conclusion !== "success"
  ) {
    throw new GitHubReleaseError("validation");
  }
  return {
    runId: run.id,
    runAttempt: run.run_attempt,
    jobId: validateJobs[0].id,
    promotionCommit,
    completedAt: run.updated_at,
  };
}

export async function verifyRehearsalEvidence(
  api: GitHubReleaseApi,
  input: {
    runId: number;
    candidate: string;
    now?: Date;
    maximumAgeMs?: number;
  },
): Promise<VerifiedRehearsalEvidence> {
  const maximumAgeMs = input.maximumAgeMs ?? MAX_REHEARSAL_AGE_MS;
  if (
    !positiveIntegerSchema.safeParse(input.runId).success ||
    !fullCommitSchema.safeParse(input.candidate).success ||
    !Number.isSafeInteger(maximumAgeMs) ||
    maximumAgeMs < 1 ||
    maximumAgeMs > 30 * 24 * 60 * 60 * 1000
  ) {
    throw new GitHubReleaseError("configuration");
  }
  const now = input.now ?? new Date();
  if (!Number.isFinite(now.getTime())) throw new GitHubReleaseError("configuration");
  const [run, workflow, branch] = await Promise.all([
    readWorkflowRun(api, input.runId),
    readActiveWorkflow(api, GITHUB_RELEASE_WORKFLOWS.rehearsal),
    requireProtectedBranch(api, "stage"),
  ]);
  const verifiedRun = verifyRunSource(run, workflow, "stage", input.candidate);
  const createdAt = Date.parse(run.created_at);
  const updatedAt = Date.parse(run.updated_at);
  if (
    run.status !== "completed" ||
    run.conclusion !== "success" ||
    run.run_attempt !== 1 ||
    branch.commit.sha !== input.candidate ||
    createdAt > now.getTime() ||
    updatedAt < createdAt ||
    now.getTime() - updatedAt > maximumAgeMs
  ) {
    throw new GitHubReleaseError("rehearsal");
  }
  const artifacts = parseResponse(
    artifactsSchema,
    await api.get({
      path: repositoryPath(`actions/runs/${input.runId}/artifacts`),
      query: { page: "1", per_page: String(MAX_LIST_ITEMS) },
    }),
  );
  const matches = artifacts.artifacts.filter((artifact) => artifact.name === "release-rehearsal");
  if (artifacts.total_count !== artifacts.artifacts.length || matches.length !== 1) {
    throw new GitHubReleaseError("rehearsal");
  }
  const [artifact] = matches;
  const digest = z
    .string()
    .regex(/^sha256:[a-f0-9]{64}$/u)
    .safeParse(artifact.digest);
  if (
    !digest.success ||
    artifact.expired ||
    artifact.size_in_bytes < 1 ||
    artifact.workflow_run.id !== input.runId ||
    artifact.workflow_run.head_branch !== "stage" ||
    artifact.workflow_run.head_sha !== input.candidate ||
    Date.parse(artifact.created_at) < createdAt ||
    Date.parse(artifact.updated_at) < Date.parse(artifact.created_at) ||
    Date.parse(artifact.expires_at) <= now.getTime()
  ) {
    throw new GitHubReleaseError("rehearsal");
  }
  return {
    run: { ...verifiedRun, branch: "stage" },
    artifact: {
      artifactId: artifact.id,
      name: "release-rehearsal",
      digest: digest.data as `sha256:${string}`,
      sizeInBytes: artifact.size_in_bytes,
      createdAt: artifact.created_at,
      updatedAt: artifact.updated_at,
      expiresAt: artifact.expires_at,
    },
  };
}

export async function verifyProductionArtifact(
  api: GitHubReleaseApi,
  input: {
    runId: number;
    promotionCommit: string;
    now?: Date;
  },
): Promise<VerifiedProductionArtifact> {
  if (
    !positiveIntegerSchema.safeParse(input.runId).success ||
    !fullCommitSchema.safeParse(input.promotionCommit).success
  ) {
    throw new GitHubReleaseError("configuration");
  }
  const now = input.now ?? new Date();
  if (!Number.isFinite(now.getTime())) throw new GitHubReleaseError("configuration");
  const [run, workflow] = await Promise.all([
    readWorkflowRun(api, input.runId),
    readActiveWorkflow(api, GITHUB_RELEASE_WORKFLOWS.production),
  ]);
  verifyRunSource(run, workflow, "main", input.promotionCommit);
  if (run.run_attempt !== 1 || run.status !== "completed" || run.conclusion === null) {
    throw new GitHubReleaseError("resume");
  }
  const artifacts = parseResponse(
    artifactsSchema,
    await api.get({
      path: repositoryPath(`actions/runs/${input.runId}/artifacts`),
      query: { page: "1", per_page: String(MAX_LIST_ITEMS) },
    }),
  );
  const matches = artifacts.artifacts.filter((artifact) => artifact.name === "release-production");
  if (artifacts.total_count !== artifacts.artifacts.length || matches.length !== 1) {
    throw new GitHubReleaseError("resume");
  }
  const [artifact] = matches;
  const digest = z
    .string()
    .regex(/^sha256:[a-f0-9]{64}$/u)
    .safeParse(artifact.digest);
  if (
    !digest.success ||
    artifact.expired ||
    artifact.size_in_bytes < 1 ||
    artifact.workflow_run.id !== input.runId ||
    artifact.workflow_run.head_branch !== "main" ||
    artifact.workflow_run.head_sha !== input.promotionCommit ||
    Date.parse(artifact.created_at) < Date.parse(run.created_at) ||
    Date.parse(artifact.updated_at) < Date.parse(artifact.created_at) ||
    Date.parse(artifact.expires_at) <= now.getTime()
  ) {
    throw new GitHubReleaseError("resume");
  }
  return {
    artifactId: artifact.id,
    name: "release-production",
    digest: digest.data as `sha256:${string}`,
    sizeInBytes: artifact.size_in_bytes,
    createdAt: artifact.created_at,
    updatedAt: artifact.updated_at,
    expiresAt: artifact.expires_at,
  };
}

export async function verifyRecoveryTargetArtifact(
  api: GitHubReleaseApi,
  input: {
    runId: number;
    promotionCommit: string;
    operation?: "production-adoption";
    now?: Date;
  },
): Promise<VerifiedRecoveryTargetArtifact> {
  if (
    !positiveIntegerSchema.safeParse(input.runId).success ||
    !fullCommitSchema.safeParse(input.promotionCommit).success ||
    (input.now !== undefined && !Number.isFinite(input.now.getTime()))
  ) {
    throw new GitHubReleaseError("configuration");
  }
  const [run, workflow] = await Promise.all([
    readWorkflowRun(api, input.runId),
    readActiveWorkflow(api, GITHUB_RELEASE_WORKFLOWS.production),
  ]);
  const verifiedRun = verifyRunSource(
    run,
    workflow,
    "main",
    input.promotionCommit,
  ) as VerifiedProductionRun;
  if (run.run_attempt !== 1 || run.status !== "completed" || run.conclusion !== "success") {
    throw new GitHubReleaseError("resume");
  }
  const [jobs, artifact] = await Promise.all([
    api
      .get({
        path: repositoryPath(`actions/runs/${run.id}/attempts/${run.run_attempt}/jobs`),
        query: { page: "1", per_page: String(MAX_LIST_ITEMS) },
      })
      .then((value) => parseResponse(jobsSchema, value)),
    verifyProductionArtifact(api, {
      runId: run.id,
      promotionCommit: input.promotionCommit,
      now: input.now,
    }),
  ]);
  if (jobs.total_count !== 1 || jobs.jobs.length !== 1) {
    throw new GitHubReleaseError("resume");
  }
  const [job] = jobs.jobs;
  const activationSteps = job.steps.filter(
    (step) => step.name === GITHUB_RELEASE_ACTIVATION_STEP_NAME,
  );
  const recoverySteps = job.steps.filter((step) => step.name === GITHUB_RELEASE_RECOVERY_STEP_NAME);
  const adoptionSteps = job.steps.filter((step) => step.name === GITHUB_RELEASE_ADOPTION_STEP_NAME);
  const adoption = input.operation === "production-adoption";
  if (
    job.name !== GITHUB_RELEASE_PRODUCTION_JOB_NAME ||
    job.head_sha !== verifiedRun.headSha ||
    job.status !== "completed" ||
    job.conclusion !== "success" ||
    activationSteps.length !== 1 ||
    activationSteps[0].status !== "completed" ||
    activationSteps[0].conclusion !== (adoption ? "skipped" : "success") ||
    recoverySteps.length !== 1 ||
    recoverySteps[0].status !== "completed" ||
    recoverySteps[0].conclusion !== "skipped" ||
    adoptionSteps.length !== 1 ||
    adoptionSteps[0].status !== "completed" ||
    adoptionSteps[0].conclusion !== (adoption ? "success" : "skipped")
  ) {
    throw new GitHubReleaseError("resume");
  }
  return {
    run: verifiedRun,
    artifact,
    jobId: job.id,
    activationStepNumber: activationSteps[0].number,
    ...(adoption ? { adoptionStepNumber: adoptionSteps[0].number } : {}),
  };
}

export async function inspectPreviousProductionRun(
  api: GitHubReleaseApi,
  input: {
    current: VerifiedProductionInvocation;
    resumeRunId?: number;
    recovery?: {
      sourceProductionRunId: number;
      resumeRecoveryRunId?: number;
    };
    adoption?: { resumeAdoptionRunId?: number };
    verifyCompletedAdoption?: VerifyCompletedAdoption;
    verifyCompletedRecovery?: VerifyCompletedRecovery;
    now?: Date;
  },
): Promise<PreviousProductionRun> {
  if (
    (input.resumeRunId !== undefined &&
      !positiveIntegerSchema.safeParse(input.resumeRunId).success) ||
    (input.recovery !== undefined &&
      (!positiveIntegerSchema.safeParse(input.recovery.sourceProductionRunId).success ||
        (input.recovery.resumeRecoveryRunId !== undefined &&
          !positiveIntegerSchema.safeParse(input.recovery.resumeRecoveryRunId).success))) ||
    (input.resumeRunId !== undefined && input.recovery !== undefined) ||
    (input.adoption?.resumeAdoptionRunId !== undefined &&
      !positiveIntegerSchema.safeParse(input.adoption.resumeAdoptionRunId).success) ||
    (input.adoption !== undefined &&
      (input.resumeRunId !== undefined || input.recovery !== undefined)) ||
    (input.resumeRunId !== undefined && input.resumeRunId >= input.current.runId) ||
    (input.recovery !== undefined && input.recovery.sourceProductionRunId >= input.current.runId) ||
    (input.recovery?.resumeRecoveryRunId !== undefined &&
      (input.recovery.resumeRecoveryRunId >= input.current.runId ||
        input.recovery.resumeRecoveryRunId <= input.recovery.sourceProductionRunId)) ||
    (input.recovery !== undefined &&
      input.recovery.sourceProductionRunId === input.recovery.resumeRecoveryRunId) ||
    (input.adoption?.resumeAdoptionRunId !== undefined &&
      input.adoption.resumeAdoptionRunId >= input.current.runId) ||
    (input.now !== undefined && !Number.isFinite(input.now.getTime()))
  ) {
    throw new GitHubReleaseError("configuration");
  }
  const workflow = await readActiveWorkflow(api, GITHUB_RELEASE_WORKFLOWS.production);
  if (
    input.current.workflowId !== workflow.id ||
    input.current.workflowPath !== workflow.path ||
    input.current.branch !== "main"
  ) {
    throw new GitHubReleaseError("source");
  }
  const skippedActivations: Array<{ runId: number; jobId: number; stepNumber: number }> = [];
  let expectedTotal: number | undefined;
  let seen = 0;
  let foundCurrent = false;
  let lastCreatedAt = Number.POSITIVE_INFINITY;
  let lastRunId = Number.POSITIVE_INFINITY;

  for (let page = 1; page <= MAX_PRODUCTION_HISTORY_PAGES; page += 1) {
    const result = parseResponse(
      workflowRunsSchema,
      await api.get({
        path: `${workflowPath(GITHUB_RELEASE_WORKFLOWS.production)}/runs`,
        query: {
          branch: "main",
          event: "workflow_dispatch",
          page: String(page),
          per_page: String(MAX_LIST_ITEMS),
        },
      }),
    );
    if (expectedTotal === undefined) expectedTotal = result.total_count;
    if (
      result.total_count !== expectedTotal ||
      (result.workflow_runs.length === 0 && seen < expectedTotal)
    ) {
      throw new GitHubReleaseError("resume");
    }

    for (const run of result.workflow_runs) {
      seen += 1;
      const createdAt = Date.parse(run.created_at);
      if (
        createdAt > lastCreatedAt ||
        (createdAt === lastCreatedAt && run.id >= lastRunId) ||
        run.repository.full_name !== GITHUB_RELEASE_REPOSITORY ||
        run.workflow_id !== workflow.id ||
        !workflowRunPathMatches(run.path, workflow.path, "main") ||
        run.event !== "workflow_dispatch" ||
        run.head_branch !== "main"
      ) {
        throw new GitHubReleaseError("resume");
      }
      lastCreatedAt = createdAt;
      lastRunId = run.id;

      if (!foundCurrent) {
        if (run.id === input.current.runId && run.run_attempt === input.current.runAttempt) {
          foundCurrent = true;
        }
        continue;
      }
      if (run.id === input.current.runId) {
        throw new GitHubReleaseError("resume");
      }
      const previous = verifyRunSource(run, workflow, "main") as VerifiedProductionRun;
      if (run.run_attempt !== 1) {
        // A debug rerun must not erase an earlier mutation. Only skip the run
        // after every attempt proves that all mutation steps were skipped.
        if (
          run.run_attempt > MAX_SKIPPED_ACTIVATION_RUNS ||
          run.status !== "completed" ||
          run.conclusion === null ||
          run.conclusion === "success"
        )
          throw new GitHubReleaseError("resume");
        let lastSkipped: { runId: number; jobId: number; stepNumber: number } | undefined;
        for (let attempt = 1; attempt <= run.run_attempt; attempt += 1) {
          const jobs = parseResponse(
            jobsSchema,
            await api.get({
              path: repositoryPath(`actions/runs/${run.id}/attempts/${attempt}/jobs`),
              query: { page: "1", per_page: String(MAX_LIST_ITEMS) },
            }),
          );
          const [job] = jobs.jobs;
          if (
            jobs.total_count !== 1 ||
            jobs.jobs.length !== 1 ||
            !job ||
            job.name !== GITHUB_RELEASE_PRODUCTION_JOB_NAME ||
            job.head_sha !== previous.headSha ||
            job.status !== "completed" ||
            job.conclusion === null ||
            job.conclusion === "success"
          ) {
            throw new GitHubReleaseError("resume");
          }
          const activation = job.steps.filter(
            (step) => step.name === GITHUB_RELEASE_ACTIVATION_STEP_NAME,
          );
          const recovery = job.steps.filter(
            (step) => step.name === GITHUB_RELEASE_RECOVERY_STEP_NAME,
          );
          const adoption = job.steps.filter(
            (step) => step.name === GITHUB_RELEASE_ADOPTION_STEP_NAME,
          );
          if (
            activation.length !== 1 ||
            recovery.length !== 1 ||
            adoption.length > 1 ||
            [...activation, ...recovery, ...adoption].some(
              (step) => step.status !== "completed" || step.conclusion !== "skipped",
            )
          ) {
            throw new GitHubReleaseError("resume");
          }
          lastSkipped = { runId: run.id, jobId: job.id, stepNumber: activation[0]!.number };
        }
        if (!lastSkipped) throw new GitHubReleaseError("resume");
        skippedActivations.push(lastSkipped);
        if (skippedActivations.length > MAX_SKIPPED_ACTIVATION_RUNS)
          throw new GitHubReleaseError("resume");
        continue;
      }
      let productionJob: z.infer<typeof jobsSchema>["jobs"][number] | undefined;
      let activationStep: z.infer<typeof jobsSchema>["jobs"][number]["steps"][number] | undefined;
      let recoveryStep: z.infer<typeof jobsSchema>["jobs"][number]["steps"][number] | undefined;
      let adoptionStep: z.infer<typeof jobsSchema>["jobs"][number]["steps"][number] | undefined;
      if (run.status === "completed" && run.conclusion !== null) {
        const jobs = parseResponse(
          jobsSchema,
          await api.get({
            path: repositoryPath(`actions/runs/${run.id}/attempts/${run.run_attempt}/jobs`),
            query: { page: "1", per_page: String(MAX_LIST_ITEMS) },
          }),
        );
        if (jobs.total_count === 1 && jobs.jobs.length === 1) {
          const [job] = jobs.jobs;
          const activationSteps = job.steps.filter(
            (step) => step.name === GITHUB_RELEASE_ACTIVATION_STEP_NAME,
          );
          const recoverySteps = job.steps.filter(
            (step) => step.name === GITHUB_RELEASE_RECOVERY_STEP_NAME,
          );
          const adoptionSteps = job.steps.filter(
            (step) => step.name === GITHUB_RELEASE_ADOPTION_STEP_NAME,
          );
          if (
            job.name === GITHUB_RELEASE_PRODUCTION_JOB_NAME &&
            job.head_sha === previous.headSha &&
            job.status === "completed" &&
            activationSteps.length === 1 &&
            activationSteps[0].status === "completed" &&
            recoverySteps.length === 1 &&
            recoverySteps[0].status === "completed" &&
            adoptionSteps.length <= 1 &&
            adoptionSteps.every((step) => step.status === "completed")
          ) {
            productionJob = job;
            [activationStep] = activationSteps;
            [recoveryStep] = recoverySteps;
            [adoptionStep] = adoptionSteps;
          }
        }
      }
      const completedSuccessfulRelease =
        run.status === "completed" &&
        run.conclusion === "success" &&
        productionJob?.conclusion === "success" &&
        activationStep?.conclusion === "success" &&
        recoveryStep?.conclusion === "skipped" &&
        (adoptionStep === undefined || adoptionStep.conclusion === "skipped");
      const completedRecoveryStep =
        run.status === "completed" &&
        run.conclusion !== null &&
        productionJob !== undefined &&
        productionJob.conclusion !== null &&
        ((run.conclusion === "success" && productionJob.conclusion === "success") ||
          (run.conclusion !== "success" && productionJob.conclusion !== "success")) &&
        activationStep?.conclusion === "skipped" &&
        recoveryStep?.conclusion === "success" &&
        (adoptionStep === undefined || adoptionStep.conclusion === "skipped");
      const completedAdoptionStep =
        run.status === "completed" &&
        run.conclusion === "success" &&
        productionJob?.conclusion === "success" &&
        activationStep?.conclusion === "skipped" &&
        recoveryStep?.conclusion === "skipped" &&
        adoptionStep?.conclusion === "success";

      if (completedSuccessfulRelease) {
        if (
          input.resumeRunId !== undefined ||
          input.recovery?.resumeRecoveryRunId !== undefined ||
          input.adoption !== undefined
        ) {
          throw new GitHubReleaseError("resume");
        }
        if (input.recovery !== undefined) {
          if (input.recovery.sourceProductionRunId !== previous.runId) {
            throw new GitHubReleaseError("resume");
          }
          const artifact = await verifyProductionArtifact(api, {
            runId: previous.runId,
            promotionCommit: previous.headSha,
            now: input.now,
          });
          return {
            previous,
            previousOperation: "release",
            requiresResume: false,
            requiredOperation: "recover-production",
            artifact,
            skippedActivations,
          };
        }
        return {
          previous,
          previousOperation: "release",
          requiresResume: false,
          requiredOperation: "none",
          skippedActivations,
        };
      }

      if (completedAdoptionStep) {
        if (
          input.resumeRunId !== undefined ||
          input.recovery !== undefined ||
          input.adoption !== undefined ||
          input.verifyCompletedAdoption === undefined
        ) {
          throw new GitHubReleaseError("resume");
        }
        const artifact = await verifyProductionArtifact(api, {
          runId: previous.runId,
          promotionCommit: previous.headSha,
          now: input.now,
        });
        let completedAdoptionResult: VerifiedCompletedAdoption;
        try {
          completedAdoptionResult = await input.verifyCompletedAdoption({
            run: previous,
            artifact,
          });
        } catch {
          throw new GitHubReleaseError("resume");
        }
        const parsed = completedAdoptionSchema.safeParse(completedAdoptionResult);
        if (
          !parsed.success ||
          parsed.data.promotionCommit !== previous.headSha ||
          new Set(parsed.data.adoptionRunIds).size !== parsed.data.adoptionRunIds.length ||
          parsed.data.adoptionRunIds.at(-1) !== previous.runId ||
          parsed.data.adoptionRunIds.some(
            (runId, index, runIds) => index > 0 && runId <= runIds[index - 1],
          )
        ) {
          throw new GitHubReleaseError("resume");
        }
        return {
          previous,
          previousOperation: "adoption",
          requiresResume: false,
          requiredOperation: "none",
          artifact,
          completedAdoption: parsed.data,
          skippedActivations,
        };
      }

      if (completedRecoveryStep) {
        if (
          input.resumeRunId !== undefined ||
          input.recovery !== undefined ||
          input.adoption !== undefined ||
          input.verifyCompletedRecovery === undefined
        ) {
          throw new GitHubReleaseError("resume");
        }
        const artifact = await verifyProductionArtifact(api, {
          runId: previous.runId,
          promotionCommit: previous.headSha,
          now: input.now,
        });
        let completedRecoveryResult: VerifiedCompletedRecovery;
        try {
          completedRecoveryResult = await input.verifyCompletedRecovery({
            run: previous,
            artifact,
          });
        } catch {
          throw new GitHubReleaseError("resume");
        }
        const parsedCompletedRecovery = completedRecoverySchema.safeParse(completedRecoveryResult);
        if (!parsedCompletedRecovery.success) throw new GitHubReleaseError("resume");
        const completedRecovery = parsedCompletedRecovery.data;
        const uniqueRecoveryRunIds = new Set(completedRecovery.recoveryRunIds);
        if (
          completedRecovery.sourceProductionRunId === previous.runId ||
          uniqueRecoveryRunIds.size !== completedRecovery.recoveryRunIds.length ||
          completedRecovery.recoveryRunIds.at(-1) !== previous.runId ||
          completedRecovery.recoveryRunIds.includes(completedRecovery.sourceProductionRunId) ||
          completedRecovery.recoveryRunIds.some(
            (runId, index, runIds) =>
              runId <= completedRecovery.sourceProductionRunId ||
              (index > 0 && runId <= runIds[index - 1]),
          )
        ) {
          throw new GitHubReleaseError("resume");
        }
        return {
          previous,
          previousOperation: "recovery",
          requiresResume: false,
          requiredOperation: "none",
          completedRecovery,
          skippedActivations,
        };
      }

      let skippedActivation: { runId: number; jobId: number; stepNumber: number } | undefined;
      if (
        run.status === "completed" &&
        run.conclusion !== null &&
        run.conclusion !== "success" &&
        productionJob !== undefined &&
        productionJob.conclusion !== null &&
        productionJob.conclusion !== "success" &&
        activationStep?.conclusion === "skipped" &&
        recoveryStep?.conclusion === "skipped" &&
        (adoptionStep === undefined || adoptionStep.conclusion === "skipped")
      ) {
        skippedActivation = {
          runId: previous.runId,
          jobId: productionJob.id,
          stepNumber: activationStep.number,
        };
      }
      if (skippedActivation) {
        skippedActivations.push(skippedActivation);
        if (skippedActivations.length > MAX_SKIPPED_ACTIVATION_RUNS) {
          throw new GitHubReleaseError("resume");
        }
        continue;
      }

      const unresolvedRelease =
        run.status === "completed" &&
        run.conclusion !== null &&
        run.conclusion !== "success" &&
        productionJob !== undefined &&
        productionJob.conclusion !== null &&
        productionJob.conclusion !== "success" &&
        recoveryStep?.conclusion === "skipped" &&
        activationStep?.conclusion !== "skipped" &&
        (adoptionStep === undefined || adoptionStep.conclusion === "skipped");
      const unresolvedRecovery =
        run.status === "completed" &&
        run.conclusion !== null &&
        run.conclusion !== "success" &&
        productionJob !== undefined &&
        productionJob.conclusion !== null &&
        productionJob.conclusion !== "success" &&
        activationStep?.conclusion === "skipped" &&
        recoveryStep?.conclusion !== "skipped" &&
        (adoptionStep === undefined || adoptionStep.conclusion === "skipped");
      const unresolvedAdoption =
        run.status === "completed" &&
        run.conclusion !== null &&
        run.conclusion !== "success" &&
        productionJob !== undefined &&
        productionJob.conclusion !== null &&
        productionJob.conclusion !== "success" &&
        activationStep?.conclusion === "skipped" &&
        recoveryStep?.conclusion === "skipped" &&
        adoptionStep !== undefined &&
        adoptionStep.conclusion !== "skipped";
      if (unresolvedRelease) {
        if (input.recovery !== undefined) {
          if (
            input.recovery.sourceProductionRunId !== previous.runId ||
            input.recovery.resumeRecoveryRunId !== undefined
          ) {
            throw new GitHubReleaseError("resume");
          }
          const artifact = await verifyProductionArtifact(api, {
            runId: previous.runId,
            promotionCommit: previous.headSha,
            now: input.now,
          });
          return {
            previous,
            previousOperation: "release",
            requiresResume: false,
            requiredOperation: "recover-production",
            artifact,
            skippedActivations,
          };
        }
        if (input.resumeRunId !== previous.runId) throw new GitHubReleaseError("resume");
        return {
          previous,
          previousOperation: "release",
          requiresResume: true,
          requiredOperation: "resume-production",
          skippedActivations,
        };
      }
      if (unresolvedRecovery) {
        if (input.recovery === undefined || input.recovery.resumeRecoveryRunId !== previous.runId) {
          throw new GitHubReleaseError("resume");
        }
        const artifact = await verifyProductionArtifact(api, {
          runId: previous.runId,
          promotionCommit: previous.headSha,
          now: input.now,
        });
        return {
          previous,
          previousOperation: "recovery",
          requiresResume: false,
          requiredOperation: "resume-recovery",
          artifact,
          skippedActivations,
        };
      }
      if (unresolvedAdoption) {
        if (input.adoption?.resumeAdoptionRunId !== previous.runId) {
          throw new GitHubReleaseError("resume");
        }
        return {
          previous,
          previousOperation: "adoption",
          requiresResume: true,
          requiredOperation: "resume-adoption",
          artifact: await verifyProductionArtifact(api, {
            runId: previous.runId,
            promotionCommit: previous.headSha,
            now: input.now,
          }),
          skippedActivations,
        };
      }
      throw new GitHubReleaseError("resume");
    }

    if (seen >= expectedTotal) {
      if (
        !foundCurrent ||
        input.resumeRunId !== undefined ||
        input.recovery !== undefined ||
        input.adoption?.resumeAdoptionRunId !== undefined
      ) {
        throw new GitHubReleaseError("resume");
      }
      return {
        previous: null,
        previousOperation: null,
        requiresResume: false,
        requiredOperation: "none",
        skippedActivations,
      };
    }
  }
  throw new GitHubReleaseError("resume");
}

export async function verifyResumeSource(
  api: GitHubReleaseApi,
  input: {
    current: VerifiedProductionInvocation;
    resumeRunId: number;
    originalRunId: number;
    promotionCommit: string;
  },
): Promise<VerifiedResumeSource> {
  if (
    !positiveIntegerSchema.safeParse(input.resumeRunId).success ||
    !positiveIntegerSchema.safeParse(input.originalRunId).success ||
    !fullCommitSchema.safeParse(input.promotionCommit).success ||
    input.resumeRunId === input.current.runId ||
    input.originalRunId > input.resumeRunId
  ) {
    throw new GitHubReleaseError("configuration");
  }
  const [resumed, original, workflow, branch, artifact] = await Promise.all([
    readWorkflowRun(api, input.resumeRunId),
    readWorkflowRun(api, input.originalRunId),
    readActiveWorkflow(api, GITHUB_RELEASE_WORKFLOWS.production),
    requireProtectedBranch(api, "main"),
    verifyProductionArtifact(api, {
      runId: input.resumeRunId,
      promotionCommit: input.promotionCommit,
    }),
  ]);
  const verifiedResumed = verifyRunSource(resumed, workflow, "main", input.promotionCommit);
  const verifiedOriginal = verifyRunSource(original, workflow, "main", input.promotionCommit);
  if (
    input.current.workflowId !== verifiedResumed.workflowId ||
    input.current.workflowPath !== verifiedResumed.workflowPath ||
    input.current.headSha !== input.promotionCommit ||
    branch.commit.sha !== input.promotionCommit ||
    verifiedOriginal.runId !== input.originalRunId ||
    input.current.runAttempt !== 1 ||
    verifiedResumed.runAttempt !== 1 ||
    verifiedOriginal.runAttempt !== 1 ||
    resumed.status !== "completed" ||
    resumed.conclusion === "success" ||
    original.status !== "completed" ||
    original.conclusion === null ||
    original.conclusion === "success"
  ) {
    throw new GitHubReleaseError("resume");
  }
  return {
    currentRunId: input.current.runId,
    resumedRunId: verifiedResumed.runId,
    originalRunId: input.originalRunId,
    promotionCommit: input.promotionCommit,
    workflowId: workflow.id,
    workflowPath: workflow.path,
    artifact,
  };
}
