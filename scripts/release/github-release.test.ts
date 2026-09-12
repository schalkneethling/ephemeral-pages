import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { crc32 } from "node:zlib";

import { describe, expect, it } from "vitest";

import {
  createGitHubReleaseApi,
  downloadGitHubArtifact,
  extractVerifiedGitHubArtifact,
  GITHUB_RELEASE_ACTIVATION_STEP_NAME,
  GITHUB_RELEASE_ADOPTION_STEP_NAME,
  GITHUB_RELEASE_PRODUCTION_JOB_NAME,
  GITHUB_RELEASE_RECOVERY_STEP_NAME,
  GITHUB_RELEASE_REPOSITORY,
  GITHUB_RELEASE_WORKFLOWS,
  GitHubReleaseError,
  inspectPreviousProductionRun,
  verifyCiValidation,
  verifyProductionArtifact,
  verifyProductionInvocation,
  verifyRecoveryTargetArtifact,
  verifyPromotionEvidence,
  verifyRehearsalEvidence,
  verifyResumeSource,
  verifyStagingInvocation,
  type GitHubApiRequest,
  type GitHubReleaseApi,
  type GitHubRuntimeEnvironment,
  type VerifiedProductionInvocation,
} from "./github-release.ts";
import { artifactHash } from "./artifact-contract.ts";
import { prepareNetlifyArtifacts, verifyNetlifyArtifacts } from "./netlify-artifacts.ts";
import { preparedReleaseSchema } from "./prepare.ts";
import {
  ReleaseArtifactRestorationError,
  restoreExtractedReleaseArtifacts,
} from "./restore-release-artifacts.ts";
import { releaseConfigSchema } from "./schema.ts";
import { prepareWorkerArtifacts, verifyWorkerArtifacts } from "./worker-artifacts.ts";

const candidate = "a".repeat(40);
const promotion = "b".repeat(40);
const tree = "c".repeat(40);
const digest = `sha256:${"d".repeat(64)}` as `sha256:${string}`;
const now = new Date("2026-09-11T12:00:00.000Z");
const secret = "github-secret-sentinel-must-not-escape";

const workflow = (kind: keyof typeof GITHUB_RELEASE_WORKFLOWS, id: number) => ({
  id,
  path: GITHUB_RELEASE_WORKFLOWS[kind],
  state: "active",
});

const run = (input: {
  id: number;
  attempt?: number;
  workflow: keyof typeof GITHUB_RELEASE_WORKFLOWS;
  workflowId: number;
  branch: "main" | "stage";
  sha: string;
  event?: string;
  status?: string;
  conclusion?: string | null;
  createdAt?: string;
  runPath?: string;
}) => ({
  id: input.id,
  run_attempt: input.attempt ?? 1,
  event: input.event ?? "workflow_dispatch",
  status: input.status ?? "completed",
  conclusion: input.conclusion === undefined ? "success" : input.conclusion,
  head_branch: input.branch,
  head_sha: input.sha,
  path: input.runPath ?? `${GITHUB_RELEASE_WORKFLOWS[input.workflow]}@${input.branch}`,
  workflow_id: input.workflowId,
  created_at: input.createdAt ?? "2026-09-11T10:00:00.000Z",
  updated_at: "2026-09-11T10:30:00.000Z",
  repository: { full_name: GITHUB_RELEASE_REPOSITORY },
});

const branch = (name: "main" | "stage", sha: string, protectedBranch = true) => ({
  name,
  protected: protectedBranch,
  commit: { sha },
});

const deploymentEnvironment = (name: "production" | "staging") => ({
  name,
  deployment_branch_policy: {
    protected_branches: false,
    custom_branch_policies: true,
  },
});

const deploymentBranchPolicies = (name: "main" | "stage") => ({
  total_count: 1,
  branch_policies: [{ id: name === "main" ? 801 : 802, name }],
});

const artifact = (input: {
  id?: number;
  name: "release-rehearsal" | "release-production";
  runId: number;
  branch: "main" | "stage";
  sha: string;
  expired?: boolean;
  expiresAt?: string;
  artifactDigest?: string;
}) => ({
  id: input.id ?? 91,
  name: input.name,
  size_in_bytes: 2048,
  expired: input.expired ?? false,
  created_at: "2026-09-11T10:31:00.000Z",
  updated_at: "2026-09-11T10:32:00.000Z",
  expires_at: input.expiresAt ?? "2026-09-18T10:32:00.000Z",
  digest: input.artifactDigest ?? digest,
  workflow_run: {
    id: input.runId,
    head_branch: input.branch,
    head_sha: input.sha,
  },
});

const productionJob = (
  options: {
    activationConclusion?: string | null;
    activationName?: string;
    conclusion?: string | null;
    headSha?: string;
    name?: string;
    recoveryConclusion?: string | null;
    recoveryName?: string;
    adoptionConclusion?: string | null;
    adoptionName?: string;
  } = {},
) => ({
  id: 701,
  name: options.name ?? GITHUB_RELEASE_PRODUCTION_JOB_NAME,
  head_sha: options.headSha ?? promotion,
  status: "completed",
  conclusion: options.conclusion ?? "failure",
  steps: [
    {
      name: options.activationName ?? GITHUB_RELEASE_ACTIVATION_STEP_NAME,
      status: "completed",
      conclusion: options.activationConclusion ?? "skipped",
      number: 8,
    },
    {
      name: options.recoveryName ?? GITHUB_RELEASE_RECOVERY_STEP_NAME,
      status: "completed",
      conclusion: options.recoveryConclusion ?? "skipped",
      number: 9,
    },
    {
      name: options.adoptionName ?? GITHUB_RELEASE_ADOPTION_STEP_NAME,
      status: "completed",
      conclusion: options.adoptionConclusion ?? "skipped",
      number: 10,
    },
  ],
});

const fakeApi = (handler: (request: GitHubApiRequest) => unknown): GitHubReleaseApi => ({
  get: async (request) => handler(request),
});

const fetchInputUrl = (input: string | URL | Request): string =>
  typeof input === "string" ? input : input instanceof URL ? input.href : input.url;

type ZipEntry = {
  name: string;
  contents?: Uint8Array;
  mode?: number;
  method?: number;
  declaredUncompressedSize?: number;
};

// The offsets mirror yauzl 3.4.0's local-header, central-directory, and EOCD parser.
const storedZip = (entries: readonly ZipEntry[]): Uint8Array => {
  const locals: Buffer[] = [];
  const central: Buffer[] = [];
  let localOffset = 0;
  for (const input of entries) {
    const name = Buffer.from(input.name, "utf8");
    const contents = Buffer.from(input.contents ?? new Uint8Array());
    const method = input.method ?? 0;
    const declaredSize = input.declaredUncompressedSize ?? contents.byteLength;
    const checksum = crc32(contents);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x800, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(contents.byteLength, 18);
    local.writeUInt32LE(declaredSize, 22);
    local.writeUInt16LE(name.byteLength, 26);
    locals.push(local, name, contents);

    const directory = input.name.endsWith("/");
    const mode = input.mode ?? (directory ? 0o040755 : 0o100644);
    const record = Buffer.alloc(46);
    record.writeUInt32LE(0x02014b50, 0);
    record.writeUInt16LE((3 << 8) | 20, 4);
    record.writeUInt16LE(20, 6);
    record.writeUInt16LE(0x800, 8);
    record.writeUInt16LE(method, 10);
    record.writeUInt32LE(checksum, 16);
    record.writeUInt32LE(contents.byteLength, 20);
    record.writeUInt32LE(declaredSize, 24);
    record.writeUInt16LE(name.byteLength, 28);
    record.writeUInt32LE((mode << 16) >>> 0, 38);
    record.writeUInt32LE(localOffset, 42);
    central.push(record, name);
    localOffset += local.byteLength + name.byteLength + contents.byteLength;
  }
  const centralSize = central.reduce((sum, item) => sum + item.byteLength, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(localOffset, 16);
  return Buffer.concat([...locals, ...central, end]);
};

const archiveTree = (root: string, prefix: string): ZipEntry[] => {
  const entries: ZipEntry[] = [];
  const visit = (directory: string, relativeDirectory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const relativePath = `${relativeDirectory}${entry.name}`;
      const absolutePath = join(directory, entry.name);
      if (entry.isDirectory()) {
        entries.push({ name: `${prefix}/${relativePath}/` });
        visit(absolutePath, `${relativePath}/`);
      } else if (entry.isFile()) {
        entries.push({ name: `${prefix}/${relativePath}`, contents: readFileSync(absolutePath) });
      } else {
        throw new Error("Unsupported test artifact entry.");
      }
    }
  };
  visit(root, "");
  return entries;
};

const makeTreeWritable = (root: string): void => {
  if (!existsSync(root)) return;
  chmodSync(root, 0o700);
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (entry.isDirectory()) makeTreeWritable(join(root, entry.name));
  }
};

const runtime = (overrides: Partial<GitHubRuntimeEnvironment> = {}): GitHubRuntimeEnvironment => ({
  GITHUB_ACTIONS: "true",
  GITHUB_EVENT_NAME: "workflow_dispatch",
  GITHUB_REF: "refs/heads/main",
  GITHUB_REF_PROTECTED: "true",
  GITHUB_REPOSITORY: GITHUB_RELEASE_REPOSITORY,
  GITHUB_RUN_ATTEMPT: "1",
  GITHUB_RUN_ID: "101",
  GITHUB_SHA: promotion,
  GITHUB_WORKFLOW_REF: `${GITHUB_RELEASE_REPOSITORY}/${GITHUB_RELEASE_WORKFLOWS.production}@refs/heads/main`,
  GITHUB_WORKFLOW_SHA: promotion,
  ...overrides,
});

const productionInvocation: VerifiedProductionInvocation = {
  runId: 101,
  runAttempt: 1,
  workflowId: 10,
  workflowPath: GITHUB_RELEASE_WORKFLOWS.production,
  branch: "main",
  headSha: promotion,
  createdAt: "2026-09-11T11:00:00.000Z",
  updatedAt: "2026-09-11T11:01:00.000Z",
  environment: { name: "production", branch: "main", policyId: 801 },
};

describe("GitHub release API", () => {
  it("uses only the fixed GitHub origin, bounded GET responses, and pinned headers", async () => {
    let observedUrl: URL | undefined;
    let observedInit: RequestInit | undefined;
    const api = createGitHubReleaseApi({
      token: secret,
      fetch: async (input, init) => {
        observedUrl = new URL(fetchInputUrl(input));
        observedInit = init;
        return new Response('{"ok":true}', {
          status: 200,
          headers: { "content-length": "11", "content-type": "application/json" },
        });
      },
    });

    await expect(
      api.get({
        path: `/repos/${GITHUB_RELEASE_REPOSITORY}/actions/runs/101`,
        query: { per_page: "100", branch: "main" },
      }),
    ).resolves.toEqual({ ok: true });
    expect(observedUrl?.origin).toBe("https://api.github.com");
    expect(observedUrl?.pathname).toBe(`/repos/${GITHUB_RELEASE_REPOSITORY}/actions/runs/101`);
    expect(observedUrl?.search).toBe("?branch=main&per_page=100");
    expect(observedInit?.method).toBe("GET");
    expect(observedInit?.redirect).toBe("error");
    const headers = new Headers(observedInit?.headers);
    expect(headers.get("Authorization")).toBe(`Bearer ${secret}`);
    expect(headers.get("X-GitHub-Api-Version")).toBe("2022-11-28");
  });

  it("rejects other paths, oversized responses, and raw transport errors without leaking details", async () => {
    const api = createGitHubReleaseApi({
      token: secret,
      maxResponseBytes: 10,
      fetch: async () =>
        new Response(JSON.stringify({ value: secret }), {
          status: 200,
          headers: { "content-length": "100" },
        }),
    });
    await expect(api.get({ path: "/user" })).rejects.toMatchObject({ kind: "configuration" });
    await expect(
      api.get({ path: `/repos/${GITHUB_RELEASE_REPOSITORY}/actions/runs/1` }),
    ).rejects.toMatchObject({ kind: "response" });
    const failed = createGitHubReleaseApi({
      token: secret,
      fetch: async () => {
        throw new Error(secret);
      },
    }).get({ path: `/repos/${GITHUB_RELEASE_REPOSITORY}/actions/runs/1` });
    await expect(failed).rejects.toThrow("GitHub release transport verification failed.");
    await expect(failed).rejects.not.toThrow(secret);
  });
});

describe("production invocation trust", () => {
  const invocationApi = (
    options: {
      protected?: boolean;
      headSha?: string;
      attempt?: number;
      environmentName?: string;
      environmentPolicy?: { protected_branches: boolean; custom_branch_policies: boolean };
      environmentBranches?: readonly string[];
    } = {},
  ) =>
    fakeApi(({ path }) => {
      if (path.endsWith("/actions/runs/101")) {
        return run({
          id: 101,
          attempt: options.attempt ?? 1,
          workflow: "production",
          workflowId: 10,
          branch: "main",
          sha: options.headSha ?? promotion,
          status: "in_progress",
          conclusion: null,
        });
      }
      if (path.endsWith("/actions/workflows/release-production.yml")) {
        return workflow("production", 10);
      }
      if (path.endsWith("/branches/main")) {
        return branch("main", promotion, options.protected ?? true);
      }
      if (path.endsWith("/environments/production")) {
        return {
          ...deploymentEnvironment("production"),
          name: options.environmentName ?? "production",
          deployment_branch_policy:
            options.environmentPolicy ??
            deploymentEnvironment("production").deployment_branch_policy,
        };
      }
      if (path.endsWith("/environments/production/deployment-branch-policies")) {
        const names = options.environmentBranches ?? ["main"];
        return {
          total_count: names.length,
          branch_policies: names.map((name, index) => ({ id: 801 + index, name })),
        };
      }
      throw new Error(`unexpected test request: ${path}`);
    });

  it("matches runtime claims to the API run, active workflow, and current protected main", async () => {
    await expect(verifyProductionInvocation(invocationApi(), runtime())).resolves.toEqual({
      runId: 101,
      runAttempt: 1,
      workflowId: 10,
      workflowPath: GITHUB_RELEASE_WORKFLOWS.production,
      branch: "main",
      headSha: promotion,
      createdAt: "2026-09-11T10:00:00.000Z",
      updatedAt: "2026-09-11T10:30:00.000Z",
      environment: { name: "production", branch: "main", policyId: 801 },
    });
  });

  it.each([
    [runtime({ GITHUB_REF_PROTECTED: "false" }), invocationApi(), "runtime"],
    [runtime({ GITHUB_RUN_ATTEMPT: "2" }), invocationApi({ attempt: 2 }), "runtime"],
    [runtime(), invocationApi({ protected: false }), "source"],
    [runtime(), invocationApi({ headSha: candidate }), "source"],
  ] as const)("fails closed for forged or stale invocation evidence", async (env, api, kind) => {
    await expect(verifyProductionInvocation(api, env)).rejects.toMatchObject({ kind });
  });

  it.each([
    invocationApi({ environmentName: "staging" }),
    invocationApi({ environmentBranches: ["main", "release/*"] }),
    invocationApi({ environmentBranches: ["stage"] }),
    invocationApi({
      environmentPolicy: { protected_branches: true, custom_branch_policies: false },
    }),
  ])(
    "requires the production environment's sole custom deployment branch to be main",
    async (api) => {
      await expect(verifyProductionInvocation(api, runtime())).rejects.toMatchObject({
        kind: "source",
      });
    },
  );
});

describe("staging invocation trust", () => {
  const stagingRuntime = (
    overrides: Partial<GitHubRuntimeEnvironment> = {},
  ): GitHubRuntimeEnvironment => ({
    ...runtime(),
    GITHUB_REF: "refs/heads/stage",
    GITHUB_SHA: candidate,
    GITHUB_WORKFLOW_REF: `${GITHUB_RELEASE_REPOSITORY}/${GITHUB_RELEASE_WORKFLOWS.rehearsal}@refs/heads/stage`,
    GITHUB_WORKFLOW_SHA: candidate,
    ...overrides,
  });
  const stagingApi = (attempt = 1) =>
    fakeApi(({ path }) => {
      if (path.endsWith("/actions/runs/101")) {
        return run({
          id: 101,
          attempt,
          workflow: "rehearsal",
          workflowId: 11,
          branch: "stage",
          sha: candidate,
          status: "in_progress",
          conclusion: null,
          runPath: GITHUB_RELEASE_WORKFLOWS.rehearsal,
        });
      }
      if (path.endsWith("/actions/workflows/release-rehearsal.yml")) {
        return workflow("rehearsal", 11);
      }
      if (path.endsWith("/branches/stage")) return branch("stage", candidate);
      if (path.endsWith("/environments/staging")) {
        return deploymentEnvironment("staging");
      }
      if (path.endsWith("/environments/staging/deployment-branch-policies")) {
        return deploymentBranchPolicies("stage");
      }
      throw new Error(`unexpected test request: ${path}`);
    });

  it("matches the staging runtime to a protected stage manual run at its exact head", async () => {
    await expect(verifyStagingInvocation(stagingApi(), stagingRuntime())).resolves.toMatchObject({
      runId: 101,
      runAttempt: 1,
      workflowId: 11,
      workflowPath: GITHUB_RELEASE_WORKFLOWS.rehearsal,
      branch: "stage",
      headSha: candidate,
    });
  });

  it("rejects a same-run rerun attempt", async () => {
    await expect(
      verifyStagingInvocation(stagingApi(2), stagingRuntime({ GITHUB_RUN_ATTEMPT: "2" })),
    ).rejects.toMatchObject({ kind: "runtime" });
  });

  it.each([`${GITHUB_RELEASE_WORKFLOWS.production}@stage`, ".github/workflows/foreign.yml"])(
    "rejects a foreign workflow run path or ref (%s)",
    async (runPath) => {
      const api = fakeApi(({ path }) => {
        if (path.endsWith("/actions/runs/101")) {
          return run({
            id: 101,
            workflow: "rehearsal",
            workflowId: 11,
            branch: "stage",
            sha: candidate,
            status: "in_progress",
            conclusion: null,
            runPath,
          });
        }
        if (path.endsWith("/actions/workflows/release-rehearsal.yml")) {
          return workflow("rehearsal", 11);
        }
        if (path.endsWith("/branches/stage")) return branch("stage", candidate);
        if (path.endsWith("/environments/staging")) return deploymentEnvironment("staging");
        if (path.endsWith("/environments/staging/deployment-branch-policies")) {
          return deploymentBranchPolicies("stage");
        }
        throw new Error(`unexpected test request: ${path}`);
      });
      await expect(verifyStagingInvocation(api, stagingRuntime())).rejects.toMatchObject({
        kind: "source",
      });
    },
  );
});

describe("artifact archive download", () => {
  it("follows one documented-host redirect without forwarding authorization and verifies bytes", async () => {
    const archive = new TextEncoder().encode("verified zip bytes");
    const expectedDigest = `sha256:${createHash("sha256").update(archive).digest("hex")}` as const;
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetch = async (input: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: fetchInputUrl(input), init });
      if (calls.length === 1) {
        return new Response(null, {
          status: 302,
          headers: {
            location:
              "https://example.blob.core.windows.net/actions-results/opaque?sig=signed-value",
          },
        });
      }
      return new Response(archive, {
        status: 200,
        headers: { "content-length": String(archive.byteLength) },
      });
    };

    await expect(
      downloadGitHubArtifact({
        token: secret,
        artifactId: 91,
        expectedDigest,
        expectedSizeInBytes: archive.byteLength,
        fetch,
      }),
    ).resolves.toEqual(archive);
    expect(calls[0].url).toBe(
      `https://api.github.com/repos/${GITHUB_RELEASE_REPOSITORY}/actions/artifacts/91/zip`,
    );
    expect(new Headers(calls[0].init?.headers).get("Authorization")).toBe(`Bearer ${secret}`);
    expect(calls[0].init?.redirect).toBe("manual");
    expect(calls[1].init?.headers).toBeUndefined();
    expect(calls[1].init?.redirect).toBe("error");
  });

  it.each([
    "http://example.blob.core.windows.net/archive?sig=value",
    "https://blob.core.windows.net.evil.example/archive?sig=value",
    "https://user@example.blob.core.windows.net/archive?sig=value",
  ])("rejects an untrusted signed-artifact destination", async (location) => {
    const failed = downloadGitHubArtifact({
      token: secret,
      artifactId: 91,
      expectedDigest: digest,
      expectedSizeInBytes: 1,
      fetch: async () => new Response(null, { status: 302, headers: { location } }),
    });
    await expect(failed).rejects.toMatchObject({ kind: "artifact" });
    await expect(failed).rejects.not.toThrow(location);
  });

  it("rejects mismatched, oversized, or truncated archive bytes", async () => {
    const archive = new TextEncoder().encode("wrong bytes");
    const failed = downloadGitHubArtifact({
      token: secret,
      artifactId: 91,
      expectedDigest: digest,
      expectedSizeInBytes: archive.byteLength,
      fetch: async (_input, init) =>
        init?.redirect === "manual"
          ? new Response(null, {
              status: 302,
              headers: {
                location:
                  "https://results-receiver.actions.githubusercontent.com/archive?sig=value",
              },
            })
          : new Response(archive, { status: 200 }),
    });
    await expect(failed).rejects.toMatchObject({ kind: "artifact" });
  });
});

describe("verified artifact extraction", () => {
  it("extracts regular files and directories into a new external destination", async () => {
    const parent = mkdtempSync(join(tmpdir(), "github-artifact-test-"));
    const destination = join(parent, "extracted");
    try {
      await extractVerifiedGitHubArtifact(
        storedZip([
          { name: "reports/" },
          { name: "reports/rehearsal.json", contents: new TextEncoder().encode('{"ok":true}\n') },
          { name: "bundles/worker.js", contents: new TextEncoder().encode("export default {};\n") },
        ]),
        destination,
        process.cwd(),
      );
      expect(readFileSync(join(destination, "reports/rehearsal.json"), "utf8")).toBe(
        '{"ok":true}\n',
      );
      expect(readFileSync(join(destination, "bundles/worker.js"), "utf8")).toBe(
        "export default {};\n",
      );
      expect(statSync(join(destination, "reports/rehearsal.json")).mode & 0o777).toBe(0o600);
    } finally {
      rmSync(parent, { force: true, recursive: true });
    }
  });

  it("restores extracted release modes only after real artifact contents verify", async () => {
    const parent = mkdtempSync(join(tmpdir(), "github-release-resume-artifacts-"));
    const repositoryRoot = join(parent, "repository");
    const sourceArtifacts = join(parent, "source-artifacts");
    const publishDirectory = join(repositoryRoot, "dist");
    const functionsDirectory = join(repositoryRoot, "netlify/functions");
    const configPath = join(repositoryRoot, "collaboration-worker/wrangler.jsonc");
    const wranglerManifestPath = join(repositoryRoot, "node_modules/wrangler/package.json");
    try {
      mkdirSync(publishDirectory, { recursive: true });
      mkdirSync(functionsDirectory, { recursive: true });
      mkdirSync(join(repositoryRoot, "collaboration-worker"), { recursive: true });
      mkdirSync(join(repositoryRoot, "node_modules/wrangler"), { recursive: true });
      mkdirSync(sourceArtifacts);
      writeFileSync(join(repositoryRoot, "netlify.toml"), '[build]\n  publish = "dist"\n');
      writeFileSync(
        join(publishDirectory, "index.html"),
        "<!doctype html><title>release</title>\n",
      );
      writeFileSync(join(publishDirectory, "_headers"), "/*\n  X-Content-Type-Options: nosniff\n");
      writeFileSync(
        join(functionsDirectory, "hello.ts"),
        "export default () => new Response('ok')\n",
      );
      const workerConfig = readFileSync(
        new URL("../../collaboration-worker/wrangler.jsonc", import.meta.url),
      );
      writeFileSync(configPath, workerConfig);
      writeFileSync(
        wranglerManifestPath,
        readFileSync(new URL("../../node_modules/wrangler/package.json", import.meta.url)),
      );
      const configuration = releaseConfigSchema.parse(
        JSON.parse(
          readFileSync(new URL("../../scripts/release/environments.json", import.meta.url), "utf8"),
        ),
      );
      const target = configuration.environments.production;
      if (!target.cloudflare) throw new Error("Missing production Worker fixture.");
      const netlify = await prepareNetlifyArtifacts({
        artifactDirectory: join(sourceArtifacts, "netlify"),
        repositoryRoot,
        publishDirectory,
        userFunctionsDirectory: functionsDirectory,
      });
      const workerInput = {
        artifactDirectory: join(sourceArtifacts, "worker"),
        environment: "production" as const,
        productionWorkerName: target.cloudflare.workerName,
        repositoryRoot,
        sourceConfigSha256: artifactHash(workerConfig),
        target: target.cloudflare,
      };
      const worker = await prepareWorkerArtifacts(workerInput, {
        run: async (_executable, args) => {
          const outdir = args[args.indexOf("--outdir") + 1];
          if (!outdir) return { exitCode: 1, stdout: "", stderr: "" };
          mkdirSync(outdir, { recursive: true });
          writeFileSync(join(outdir, "README.md"), "This folder contains the built output assets");
          writeFileSync(join(outdir, "index.js"), "export default { fetch() {} };\n");
          writeFileSync(join(outdir, "index.js.map"), "{}\n");
          return { exitCode: 0, stdout: "dry run complete", stderr: "" };
        },
      });
      const prepared = preparedReleaseSchema.parse({
        schemaVersion: 1,
        operation: "prepare",
        outcome: "passed",
        source: {
          candidate: "a".repeat(40),
          tree: "b".repeat(40),
          environment: "production",
          configurationFingerprint: "c".repeat(64),
        },
        toolchain: { bun: "1.3.14" },
        artifacts: {
          netlify: { directory: "netlify", sha256: netlify.inventorySha256 },
          worker: { directory: "worker", sha256: worker.manifestSha256 },
        },
      });
      writeFileSync(
        join(sourceArtifacts, "prepared-release.json"),
        `${JSON.stringify(prepared)}\n`,
      );
      const entries = archiveTree(sourceArtifacts, "artifacts");

      const restored = join(parent, "restored");
      await extractVerifiedGitHubArtifact(storedZip(entries), restored, repositoryRoot);
      const extractedArtifacts = join(restored, "artifacts");
      await expect(
        verifyNetlifyArtifacts({
          ...netlify,
          artifactDirectory: join(extractedArtifacts, "netlify"),
        }),
      ).rejects.toMatchObject({ kind: "state" });
      await expect(
        restoreExtractedReleaseArtifacts(repositoryRoot, extractedArtifacts, configuration),
      ).resolves.toEqual(prepared);
      await expect(
        verifyNetlifyArtifacts({
          ...netlify,
          artifactDirectory: join(extractedArtifacts, "netlify"),
        }),
      ).resolves.toBeUndefined();
      await expect(
        verifyWorkerArtifacts(
          { ...workerInput, artifactDirectory: join(extractedArtifacts, "worker") },
          { ...worker, artifactDirectory: join(extractedArtifacts, "worker") },
        ),
      ).resolves.toEqual(worker.manifest);

      const corrupted = join(parent, "corrupted");
      const corruptedEntries = entries.map((entry) =>
        entry.name === "artifacts/netlify/publish/index.html"
          ? { ...entry, contents: new TextEncoder().encode("tampered\n") }
          : entry,
      );
      await extractVerifiedGitHubArtifact(storedZip(corruptedEntries), corrupted, repositoryRoot);
      await expect(
        restoreExtractedReleaseArtifacts(
          repositoryRoot,
          join(corrupted, "artifacts"),
          configuration,
        ),
      ).rejects.toBeInstanceOf(ReleaseArtifactRestorationError);
      expect(statSync(join(corrupted, "artifacts/netlify/publish/index.html")).mode & 0o777).toBe(
        0o600,
      );
    } finally {
      makeTreeWritable(parent);
      rmSync(parent, { force: true, recursive: true });
    }
  });

  it.each(["../escaped", "/absolute", "C:/absolute", "nested\\escaped"])(
    "rejects unsafe paths without retaining or exposing their names",
    async (name) => {
      const parent = mkdtempSync(join(tmpdir(), "github-artifact-test-"));
      const destination = join(parent, "extracted");
      try {
        const extraction = extractVerifiedGitHubArtifact(
          storedZip([{ name }]),
          destination,
          process.cwd(),
        );
        await expect(extraction).rejects.toThrow("GitHub release artifact verification failed.");
        await expect(extraction).rejects.not.toThrow(name);
        expect(existsSync(destination)).toBe(false);
      } finally {
        rmSync(parent, { force: true, recursive: true });
      }
    },
  );

  it.each([
    ["a symlink", [{ name: "link", mode: 0o120777 }]],
    ["an unsupported special file", [{ name: "pipe", mode: 0o010644 }]],
    ["duplicate entries", [{ name: "same" }, { name: "same" }]],
    ["case-colliding entries", [{ name: "Same" }, { name: "same" }]],
    ["a file used as a parent", [{ name: "parent" }, { name: "parent/child" }]],
    ["unsupported compression", [{ name: "file", method: 99 }]],
  ] as const)("rejects %s", async (_description, entries) => {
    const parent = mkdtempSync(join(tmpdir(), "github-artifact-test-"));
    const destination = join(parent, "extracted");
    try {
      await expect(
        extractVerifiedGitHubArtifact(storedZip(entries), destination, process.cwd()),
      ).rejects.toMatchObject({ kind: "artifact" });
      expect(existsSync(destination)).toBe(false);
    } finally {
      rmSync(parent, { force: true, recursive: true });
    }
  });

  it("rejects excessive entry count and declared expanded bytes before creating output", async () => {
    const parent = mkdtempSync(join(tmpdir(), "github-artifact-test-"));
    try {
      const tooMany = Array.from({ length: 513 }, (_, index) => ({ name: `item-${index}` }));
      await expect(
        extractVerifiedGitHubArtifact(storedZip(tooMany), join(parent, "count"), process.cwd()),
      ).rejects.toMatchObject({ kind: "artifact" });
      await expect(
        extractVerifiedGitHubArtifact(
          storedZip([
            {
              name: "expanded",
              method: 8,
              declaredUncompressedSize: 256 * 1024 * 1024 + 1,
            },
          ]),
          join(parent, "bytes"),
          process.cwd(),
        ),
      ).rejects.toMatchObject({ kind: "artifact" });
      expect(existsSync(join(parent, "count"))).toBe(false);
      expect(existsSync(join(parent, "bytes"))).toBe(false);
    } finally {
      rmSync(parent, { force: true, recursive: true });
    }
  });

  it("rejects an existing or repository-contained destination", async () => {
    const parent = mkdtempSync(join(tmpdir(), "github-artifact-test-"));
    const existing = join(parent, "existing");
    const repositoryDestination = join(parent, ".artifact-extraction-must-not-exist");
    try {
      mkdirSync(existing);
      const archive = storedZip([{ name: "file" }]);
      await expect(
        extractVerifiedGitHubArtifact(archive, existing, process.cwd()),
      ).rejects.toMatchObject({
        kind: "artifact",
      });
      await expect(
        extractVerifiedGitHubArtifact(archive, repositoryDestination, parent),
      ).rejects.toMatchObject({ kind: "artifact" });
      expect(existsSync(repositoryDestination)).toBe(false);
    } finally {
      rmSync(parent, { force: true, recursive: true });
    }
  });
});

describe("promotion and CI evidence", () => {
  const promotionApi = (options: { promotionTree?: string; headRef?: string } = {}) =>
    fakeApi(({ path }) => {
      if (path.endsWith("/pulls/42")) {
        return {
          number: 42,
          state: "closed",
          merged_at: "2026-09-11T09:00:00.000Z",
          merge_commit_sha: promotion,
          base: {
            ref: "main",
            sha: "e".repeat(40),
            repo: { full_name: GITHUB_RELEASE_REPOSITORY },
          },
          head: {
            ref: options.headRef ?? "stage",
            sha: candidate,
            repo: { full_name: GITHUB_RELEASE_REPOSITORY },
          },
        };
      }
      if (path.endsWith(`/git/commits/${candidate}`))
        return { sha: candidate, tree: { sha: tree } };
      if (path.endsWith(`/git/commits/${promotion}`)) {
        return { sha: promotion, tree: { sha: options.promotionTree ?? tree } };
      }
      if (path.endsWith("/branches/main")) return branch("main", promotion);
      if (path.endsWith("/branches/stage")) return branch("stage", candidate);
      throw new Error(`unexpected test request: ${path}`);
    });

  it("proves the merged stage-to-main PR and exact matching candidate tree", async () => {
    await expect(
      verifyPromotionEvidence(promotionApi(), {
        pullRequestNumber: 42,
        candidate,
        promotionCommit: promotion,
      }),
    ).resolves.toEqual({
      pullRequestNumber: 42,
      candidate,
      candidateTree: tree,
      promotionCommit: promotion,
      promotionTree: tree,
      mergedAt: "2026-09-11T09:00:00.000Z",
    });
  });

  it("pins the pull-request schema version and rejects the newer response without merge identity", async () => {
    const versions: string[] = [];
    const versionedFetch =
      (responseVersion?: string) => async (input: string | URL | Request, init?: RequestInit) => {
        const version = new Headers(init?.headers).get("X-GitHub-Api-Version") ?? "";
        versions.push(version);
        const path = new URL(fetchInputUrl(input)).pathname;
        let body: unknown;
        if (path.endsWith("/pulls/42")) {
          body = {
            number: 42,
            state: "closed",
            merged_at: "2026-09-11T09:00:00.000Z",
            ...((responseVersion ?? version) === "2026-03-10"
              ? {}
              : { merge_commit_sha: promotion }),
            base: {
              ref: "main",
              sha: "e".repeat(40),
              repo: { full_name: GITHUB_RELEASE_REPOSITORY },
            },
            head: {
              ref: "stage",
              sha: candidate,
              repo: { full_name: GITHUB_RELEASE_REPOSITORY },
            },
          };
        } else if (path.endsWith(`/git/commits/${candidate}`)) {
          body = { sha: candidate, tree: { sha: tree } };
        } else if (path.endsWith(`/git/commits/${promotion}`)) {
          body = { sha: promotion, tree: { sha: tree } };
        } else if (path.endsWith("/branches/main")) {
          body = branch("main", promotion);
        } else if (path.endsWith("/branches/stage")) {
          body = branch("stage", candidate);
        } else {
          return new Response(null, { status: 404 });
        }
        return Response.json(body);
      };
    const input = { pullRequestNumber: 42, candidate, promotionCommit: promotion };
    await expect(
      verifyPromotionEvidence(
        createGitHubReleaseApi({ token: secret, fetch: versionedFetch() }),
        input,
      ),
    ).resolves.toMatchObject({ promotionCommit: promotion });
    expect(new Set(versions)).toEqual(new Set(["2022-11-28"]));
    await expect(
      verifyPromotionEvidence(
        createGitHubReleaseApi({ token: secret, fetch: versionedFetch("2026-03-10") }),
        input,
      ),
    ).rejects.toMatchObject({ kind: "response" });
  });

  it.each([promotionApi({ promotionTree: "f".repeat(40) }), promotionApi({ headRef: "feature" })])(
    "rejects a promotion with the wrong source or tree",
    async (api) => {
      await expect(
        verifyPromotionEvidence(api, {
          pullRequestNumber: 42,
          candidate,
          promotionCommit: promotion,
        }),
      ).rejects.toMatchObject({ kind: "promotion" });
    },
  );

  it("requires the unique successful CI validate job on the exact promotion attempt", async () => {
    const calls: GitHubApiRequest[] = [];
    const api = fakeApi((request) => {
      calls.push(request);
      if (request.path.endsWith("/actions/workflows/ci.yml")) return workflow("ci", 12);
      if (request.path.endsWith("/actions/workflows/ci.yml/runs")) {
        return {
          total_count: 1,
          workflow_runs: [
            run({
              id: 301,
              attempt: 3,
              workflow: "ci",
              workflowId: 12,
              branch: "main",
              sha: promotion,
              event: "push",
            }),
          ],
        };
      }
      if (request.path.endsWith("/actions/runs/301/attempts/3/jobs")) {
        return {
          total_count: 1,
          jobs: [
            {
              id: 401,
              name: "validate",
              head_sha: promotion,
              status: "completed",
              conclusion: "success",
              steps: [],
            },
          ],
        };
      }
      throw new Error(`unexpected test request: ${request.path}`);
    });

    await expect(verifyCiValidation(api, promotion)).resolves.toEqual({
      runId: 301,
      runAttempt: 3,
      jobId: 401,
      promotionCommit: promotion,
      completedAt: "2026-09-11T10:30:00.000Z",
    });
    expect(calls[1].query).toEqual({
      branch: "main",
      event: "push",
      head_sha: promotion,
      page: "1",
      per_page: "100",
      status: "completed",
    });
    expect(calls[2].path).toContain("/attempts/3/jobs");
  });

  it("rejects incomplete or ambiguous CI evidence", async () => {
    const api = fakeApi(({ path }) => {
      if (path.endsWith("/actions/workflows/ci.yml")) return workflow("ci", 12);
      if (path.endsWith("/actions/workflows/ci.yml/runs")) {
        return {
          total_count: 2,
          workflow_runs: [
            run({
              id: 301,
              workflow: "ci",
              workflowId: 12,
              branch: "main",
              sha: promotion,
              event: "push",
            }),
          ],
        };
      }
      throw new Error(`unexpected test request: ${path}`);
    });
    await expect(verifyCiValidation(api, promotion)).rejects.toMatchObject({ kind: "validation" });
  });
});

describe("rehearsal evidence", () => {
  const rehearsalApi = (
    options: { expired?: boolean; runSha?: string; expiresAt?: string; updatedAt?: string } = {},
  ) =>
    fakeApi(({ path }) => {
      if (path.endsWith("/actions/runs/201")) {
        const value = run({
          id: 201,
          workflow: "rehearsal",
          workflowId: 11,
          branch: "stage",
          sha: options.runSha ?? candidate,
        });
        return { ...value, updated_at: options.updatedAt ?? value.updated_at };
      }
      if (path.endsWith("/actions/workflows/release-rehearsal.yml")) {
        return workflow("rehearsal", 11);
      }
      if (path.endsWith("/branches/stage")) return branch("stage", candidate);
      if (path.endsWith("/actions/runs/201/artifacts")) {
        return {
          total_count: 1,
          artifacts: [
            artifact({
              name: "release-rehearsal",
              runId: 201,
              branch: "stage",
              sha: candidate,
              expired: options.expired,
              expiresAt: options.expiresAt,
            }),
          ],
        };
      }
      throw new Error(`unexpected test request: ${path}`);
    });

  it("returns only verified run and immutable artifact metadata", async () => {
    await expect(
      verifyRehearsalEvidence(rehearsalApi(), { runId: 201, candidate, now }),
    ).resolves.toEqual({
      run: {
        runId: 201,
        runAttempt: 1,
        workflowId: 11,
        workflowPath: GITHUB_RELEASE_WORKFLOWS.rehearsal,
        branch: "stage",
        headSha: candidate,
        createdAt: "2026-09-11T10:00:00.000Z",
        updatedAt: "2026-09-11T10:30:00.000Z",
      },
      artifact: {
        artifactId: 91,
        name: "release-rehearsal",
        digest,
        sizeInBytes: 2048,
        createdAt: "2026-09-11T10:31:00.000Z",
        updatedAt: "2026-09-11T10:32:00.000Z",
        expiresAt: "2026-09-18T10:32:00.000Z",
      },
    });
  });

  it.each([
    rehearsalApi({ expired: true }),
    rehearsalApi({ expiresAt: "2026-09-11T11:59:59.000Z" }),
    rehearsalApi({ runSha: promotion }),
    rehearsalApi({ updatedAt: "2026-09-01T10:30:00.000Z" }),
  ])("rejects stale, expired, or mismatched rehearsal evidence", async (api) => {
    await expect(
      verifyRehearsalEvidence(api, { runId: 201, candidate, now }),
    ).rejects.toBeInstanceOf(GitHubReleaseError);
  });
});

describe("production resumption", () => {
  const previousRun = (conclusion: "success" | "failure") =>
    run({
      id: 99,
      workflow: "production",
      workflowId: 10,
      branch: "main",
      sha: promotion,
      conclusion,
      createdAt: "2026-09-11T09:00:00.000Z",
    });

  const historyApi = (
    conclusion: "success" | "failure",
    job = productionJob(
      conclusion === "success" ? { conclusion: "success", activationConclusion: "success" } : {},
    ),
    artifactOptions: { expired?: boolean } = {},
  ) =>
    fakeApi(({ path }) => {
      if (path.endsWith("/actions/workflows/release-production.yml")) {
        return workflow("production", 10);
      }
      if (path.endsWith("/actions/workflows/release-production.yml/runs")) {
        return {
          total_count: 2,
          workflow_runs: [
            run({
              id: 101,
              workflow: "production",
              workflowId: 10,
              branch: "main",
              sha: promotion,
              status: "in_progress",
              conclusion: null,
              createdAt: "2026-09-11T11:00:00.000Z",
            }),
            previousRun(conclusion),
          ],
        };
      }
      if (path.endsWith("/actions/runs/99/attempts/1/jobs")) {
        return { total_count: 1, jobs: [job] };
      }
      if (path.endsWith("/actions/runs/99")) return previousRun(conclusion);
      if (path.endsWith("/actions/runs/99/artifacts")) {
        return {
          total_count: 1,
          artifacts: [
            artifact({
              name: "release-production",
              runId: 99,
              branch: "main",
              sha: promotion,
              expired: artifactOptions.expired,
            }),
          ],
        };
      }
      throw new Error(`unexpected test request: ${path}`);
    });

  const completedAdoption = () => ({
    outcome: "passed" as const,
    adoptionRunIds: [99],
    promotionCommit: promotion,
    configurationSha256: "a".repeat(64),
    preparationSha256: "b".repeat(64),
    workerArtifactSha256: "c".repeat(64),
    workerScriptEtag: "d".repeat(32),
    adoptedPair: {
      netlifyDeployId: "netlify",
      workerDeploymentId: "worker-deployment",
      workerVersionId: "worker-version",
    },
    proposedBaseline: {
      version: 1 as const,
      environment: "production" as const,
      providers: {
        netlify: {
          siteId: "site",
          sourceCommit: candidate,
          publishedDeployId: "netlify",
          publishLocked: true,
        },
        cloudflare: {
          accountId: "account",
          workerName: "worker",
          sourceCommit: promotion,
          deploymentId: "worker-deployment",
          traffic: [{ versionId: "worker-version", percentage: 100 }],
        },
      },
    },
  });

  it("permits a fresh run after success or a verified skipped activation step", async () => {
    await expect(
      inspectPreviousProductionRun(historyApi("success"), { current: productionInvocation }),
    ).resolves.toMatchObject({
      requiresResume: false,
      previous: { runId: 99 },
      skippedActivations: [],
    });
    await expect(
      inspectPreviousProductionRun(historyApi("failure"), { current: productionInvocation }),
    ).resolves.toMatchObject({
      requiresResume: false,
      previous: null,
      skippedActivations: [{ runId: 99, jobId: 701, stepNumber: 8 }],
    });
    await expect(
      inspectPreviousProductionRun(historyApi("failure"), {
        current: productionInvocation,
        resumeRunId: 99,
      }),
    ).rejects.toMatchObject({ kind: "resume" });
  });

  it("verifies a successful release artifact as a bounded recovery target", async () => {
    await expect(
      verifyRecoveryTargetArtifact(historyApi("success"), {
        runId: 99,
        promotionCommit: promotion,
        now,
      }),
    ).resolves.toMatchObject({
      run: { runId: 99, headSha: promotion },
      artifact: { artifactId: 91, digest },
      jobId: 701,
      activationStepNumber: 8,
    });

    await expect(
      verifyRecoveryTargetArtifact(historyApi("success", undefined, { expired: true }), {
        runId: 99,
        promotionCommit: promotion,
        now,
      }),
    ).rejects.toMatchObject({ kind: "resume" });
    await expect(
      verifyRecoveryTargetArtifact(
        historyApi(
          "success",
          productionJob({
            conclusion: "success",
            activationConclusion: "skipped",
            recoveryConclusion: "success",
          }),
        ),
        { runId: 99, promotionCommit: promotion, now },
      ),
    ).rejects.toMatchObject({ kind: "resume" });
  });

  it("verifies an adoption artifact only through the exact adoption step", async () => {
    const adoptionJob = productionJob({
      conclusion: "success",
      activationConclusion: "skipped",
      recoveryConclusion: "skipped",
      adoptionConclusion: "success",
    });
    await expect(
      verifyRecoveryTargetArtifact(historyApi("success", adoptionJob), {
        runId: 99,
        promotionCommit: promotion,
        operation: "production-adoption",
        now,
      }),
    ).resolves.toMatchObject({
      run: { runId: 99 },
      artifact: { artifactId: 91 },
    });
    await expect(
      verifyRecoveryTargetArtifact(historyApi("success", adoptionJob), {
        runId: 99,
        promotionCommit: promotion,
        now,
      }),
    ).rejects.toMatchObject({ kind: "resume" });
  });

  it("requires verified adoption completion evidence before clearing history", async () => {
    const adoptionJob = productionJob({
      conclusion: "success",
      activationConclusion: "skipped",
      recoveryConclusion: "skipped",
      adoptionConclusion: "success",
    });
    const api = historyApi("success", adoptionJob);
    await expect(
      inspectPreviousProductionRun(api, { current: productionInvocation, now }),
    ).rejects.toMatchObject({ kind: "resume" });
    await expect(
      inspectPreviousProductionRun(api, {
        current: productionInvocation,
        now,
        verifyCompletedAdoption: async () => completedAdoption(),
      }),
    ).resolves.toMatchObject({
      previousOperation: "adoption",
      requiredOperation: "none",
      completedAdoption: { adoptionRunIds: [99], promotionCommit: promotion },
    });
  });

  it.each([
    ["a different promotion commit", { ...completedAdoption(), promotionCommit: candidate }],
    ["duplicate run IDs", { ...completedAdoption(), adoptionRunIds: [99, 99] }],
    [
      "a last run ID different from the workflow run",
      { ...completedAdoption(), adoptionRunIds: [98] },
    ],
    ["non-increasing run IDs", { ...completedAdoption(), adoptionRunIds: [98, 97, 99] }],
  ])("rejects completed adoption evidence with %s", async (_description, evidence) => {
    const adoptionJob = productionJob({
      conclusion: "success",
      activationConclusion: "skipped",
      recoveryConclusion: "skipped",
      adoptionConclusion: "success",
    });
    await expect(
      inspectPreviousProductionRun(historyApi("success", adoptionJob), {
        current: productionInvocation,
        now,
        verifyCompletedAdoption: async () => evidence,
      }),
    ).rejects.toMatchObject({ kind: "resume" });
  });

  it("requires the exact unresolved adoption run for same-plan resume", async () => {
    const api = historyApi(
      "failure",
      productionJob({
        activationConclusion: "skipped",
        recoveryConclusion: "skipped",
        adoptionConclusion: "failure",
      }),
    );
    await expect(
      inspectPreviousProductionRun(api, {
        current: productionInvocation,
        adoption: {},
        now,
      }),
    ).rejects.toMatchObject({ kind: "resume" });
    await expect(
      inspectPreviousProductionRun(api, {
        current: productionInvocation,
        adoption: { resumeAdoptionRunId: 99 },
        now,
      }),
    ).resolves.toMatchObject({
      previousOperation: "adoption",
      requiresResume: true,
      requiredOperation: "resume-adoption",
      artifact: { artifactId: 91 },
    });
  });

  it.each([
    { ...productionJob({ conclusion: "skipped" }), steps: [] },
    productionJob({ conclusion: "success", activationConclusion: "skipped" }),
  ])("does not let workflow-level success hide skipped activation evidence", async (job) => {
    await expect(
      inspectPreviousProductionRun(historyApi("success", job), {
        current: productionInvocation,
      }),
    ).rejects.toMatchObject({ kind: "resume" });
  });

  it("clears a completed recovery only after its exact retained record is verified", async () => {
    const api = historyApi(
      "success",
      productionJob({
        conclusion: "success",
        activationConclusion: "skipped",
        recoveryConclusion: "success",
      }),
    );
    await expect(
      inspectPreviousProductionRun(api, { current: productionInvocation, now }),
    ).rejects.toMatchObject({ kind: "resume" });

    const observed: Array<{ runId: number; artifactId: number }> = [];
    await expect(
      inspectPreviousProductionRun(api, {
        current: productionInvocation,
        now,
        verifyCompletedRecovery: async ({ run, artifact: retained }) => {
          observed.push({ runId: run.runId, artifactId: retained.artifactId });
          return {
            outcome: "passed",
            sourceProductionRunId: 95,
            recoveryRunIds: [99],
          };
        },
      }),
    ).resolves.toMatchObject({
      previous: { runId: 99 },
      previousOperation: "recovery",
      requiredOperation: "none",
      completedRecovery: {
        outcome: "passed",
        sourceProductionRunId: 95,
        recoveryRunIds: [99],
      },
    });
    expect(observed).toEqual([{ runId: 99, artifactId: 91 }]);
  });

  it("clears a verified recovery when only the outer job completion failed", async () => {
    const api = historyApi(
      "failure",
      productionJob({
        conclusion: "failure",
        activationConclusion: "skipped",
        recoveryConclusion: "success",
      }),
    );
    await expect(
      inspectPreviousProductionRun(api, { current: productionInvocation, now }),
    ).rejects.toMatchObject({ kind: "resume" });
    await expect(
      inspectPreviousProductionRun(api, {
        current: productionInvocation,
        now,
        verifyCompletedRecovery: async () => ({
          outcome: "passed",
          sourceProductionRunId: 95,
          recoveryRunIds: [99],
        }),
      }),
    ).resolves.toMatchObject({
      previous: { runId: 99 },
      previousOperation: "recovery",
      requiredOperation: "none",
    });

    await expect(
      inspectPreviousProductionRun(
        historyApi(
          "failure",
          productionJob({
            conclusion: "failure",
            activationConclusion: "skipped",
            recoveryConclusion: "success",
          }),
          { expired: true },
        ),
        {
          current: productionInvocation,
          now,
          verifyCompletedRecovery: async () => ({
            outcome: "passed",
            sourceProductionRunId: 95,
            recoveryRunIds: [99],
          }),
        },
      ),
    ).rejects.toMatchObject({ kind: "resume" });
  });

  it("uses verified completion evidence when recovery succeeded before the outer job failed", async () => {
    const api = historyApi(
      "failure",
      productionJob({
        conclusion: "failure",
        activationConclusion: "skipped",
        recoveryConclusion: "success",
      }),
    );
    await expect(
      inspectPreviousProductionRun(api, { current: productionInvocation, now }),
    ).rejects.toMatchObject({ kind: "resume" });
    await expect(
      inspectPreviousProductionRun(api, {
        current: productionInvocation,
        now,
        verifyCompletedRecovery: async () => ({
          outcome: "passed",
          sourceProductionRunId: 95,
          recoveryRunIds: [99],
        }),
      }),
    ).resolves.toMatchObject({
      previousOperation: "recovery",
      requiredOperation: "none",
      completedRecovery: { sourceProductionRunId: 95, recoveryRunIds: [99] },
    });
  });

  it.each([
    { outcome: "passed" as const, sourceProductionRunId: 95, recoveryRunIds: [98] },
    { outcome: "passed" as const, sourceProductionRunId: 95, recoveryRunIds: [99, 99] },
    { outcome: "passed" as const, sourceProductionRunId: 99, recoveryRunIds: [99] },
  ])("rejects malformed completed recovery lineage", async (completedRecovery) => {
    const api = historyApi(
      "success",
      productionJob({
        conclusion: "success",
        activationConclusion: "skipped",
        recoveryConclusion: "success",
      }),
    );
    await expect(
      inspectPreviousProductionRun(api, {
        current: productionInvocation,
        now,
        verifyCompletedRecovery: async () => completedRecovery,
      }),
    ).rejects.toMatchObject({ kind: "resume" });
  });

  it.each([
    productionJob({ activationConclusion: "failure" }),
    productionJob({ activationName: "Different step" }),
    productionJob({ headSha: candidate }),
    productionJob({ name: "Different job" }),
    {
      ...productionJob(),
      steps: [
        ...productionJob().steps,
        {
          name: GITHUB_RELEASE_ACTIVATION_STEP_NAME,
          status: "completed",
          conclusion: "skipped",
          number: 9,
        },
      ],
    },
  ])("blocks a fresh run unless the exact trusted activation step was skipped", async (job) => {
    const api = fakeApi(({ path }) => {
      if (path.endsWith("/actions/workflows/release-production.yml")) {
        return workflow("production", 10);
      }
      if (path.endsWith("/actions/workflows/release-production.yml/runs")) {
        return {
          total_count: 2,
          workflow_runs: [
            run({
              id: 101,
              workflow: "production",
              workflowId: 10,
              branch: "main",
              sha: promotion,
              status: "in_progress",
              conclusion: null,
              createdAt: "2026-09-11T11:00:00.000Z",
            }),
            previousRun("failure"),
          ],
        };
      }
      if (path.endsWith("/actions/runs/99/attempts/1/jobs")) {
        return { total_count: 1, jobs: [job] };
      }
      throw new Error(`unexpected test request: ${path}`);
    });
    await expect(
      inspectPreviousProductionRun(api, { current: productionInvocation }),
    ).rejects.toMatchObject({ kind: "resume" });
  });

  it("skips failed preflight attempts across bounded pages and preserves the older resume target", async () => {
    const calls: GitHubApiRequest[] = [];
    const api = fakeApi((request) => {
      calls.push(request);
      if (request.path.endsWith("/actions/workflows/release-production.yml")) {
        return workflow("production", 10);
      }
      if (request.path.endsWith("/actions/workflows/release-production.yml/runs")) {
        if (request.query?.page === "1") {
          return {
            total_count: 3,
            workflow_runs: [
              run({
                id: 101,
                workflow: "production",
                workflowId: 10,
                branch: "main",
                sha: promotion,
                status: "in_progress",
                conclusion: null,
                createdAt: "2026-09-11T11:00:00.000Z",
              }),
              previousRun("failure"),
            ],
          };
        }
        return {
          total_count: 3,
          workflow_runs: [
            {
              ...previousRun("failure"),
              id: 95,
              created_at: "2026-09-11T08:00:00.000Z",
            },
          ],
        };
      }
      if (request.path.endsWith("/actions/runs/99/attempts/1/jobs")) {
        return { total_count: 1, jobs: [productionJob()] };
      }
      if (request.path.endsWith("/actions/runs/95/attempts/1/jobs")) {
        return {
          total_count: 1,
          jobs: [productionJob({ activationConclusion: "failure" })],
        };
      }
      throw new Error(`unexpected test request: ${request.path}`);
    });

    await expect(
      inspectPreviousProductionRun(api, {
        current: productionInvocation,
        resumeRunId: 95,
      }),
    ).resolves.toMatchObject({
      requiresResume: true,
      previous: { runId: 95 },
      skippedActivations: [{ runId: 99, jobId: 701, stepNumber: 8 }],
    });
    expect(calls.filter((call) => call.path.endsWith("release-production.yml/runs"))).toHaveLength(
      2,
    );
  });

  it("verifies the failed run, original source, current promotion, and retained artifact", async () => {
    const api = fakeApi(({ path }) => {
      if (path.endsWith("/actions/runs/99") || path.endsWith("/actions/runs/95")) {
        return {
          ...previousRun("failure"),
          id: path.endsWith("/95") ? 95 : 99,
        };
      }
      if (path.endsWith("/actions/workflows/release-production.yml")) {
        return workflow("production", 10);
      }
      if (path.endsWith("/branches/main")) return branch("main", promotion);
      if (path.endsWith("/actions/runs/99/artifacts")) {
        return {
          total_count: 1,
          artifacts: [
            artifact({
              name: "release-production",
              runId: 99,
              branch: "main",
              sha: promotion,
            }),
          ],
        };
      }
      throw new Error(`unexpected test request: ${path}`);
    });

    await expect(
      verifyResumeSource(api, {
        current: productionInvocation,
        resumeRunId: 99,
        originalRunId: 95,
        promotionCommit: promotion,
      }),
    ).resolves.toMatchObject({
      currentRunId: 101,
      resumedRunId: 99,
      originalRunId: 95,
      promotionCommit: promotion,
      artifact: { name: "release-production", digest },
    });
  });

  it("rejects a missing production artifact after a possible mutation", async () => {
    const api = fakeApi(({ path }) => {
      if (path.endsWith("/actions/runs/99")) return previousRun("failure");
      if (path.endsWith("/actions/workflows/release-production.yml")) {
        return workflow("production", 10);
      }
      if (path.endsWith("/actions/runs/99/artifacts")) {
        return { total_count: 0, artifacts: [] };
      }
      throw new Error(`unexpected test request: ${path}`);
    });
    await expect(
      verifyProductionArtifact(api, { runId: 99, promotionCommit: promotion, now }),
    ).rejects.toMatchObject({ kind: "resume" });
  });
});
