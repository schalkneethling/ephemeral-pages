import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { crc32 } from "node:zlib";

import { describe, expect, it } from "vitest";

import {
  createGitHubReleaseApi,
  downloadGitHubArtifact,
  extractVerifiedGitHubArtifact,
  GITHUB_RELEASE_ACTIVATION_STEP_NAME,
  GITHUB_RELEASE_PRODUCTION_JOB_NAME,
  GITHUB_RELEASE_REPOSITORY,
  GITHUB_RELEASE_WORKFLOWS,
  GitHubReleaseError,
  inspectPreviousProductionRun,
  verifyCiValidation,
  verifyProductionArtifact,
  verifyProductionInvocation,
  verifyPromotionEvidence,
  verifyRehearsalEvidence,
  verifyResumeSource,
  verifyStagingInvocation,
  type GitHubApiRequest,
  type GitHubReleaseApi,
  type GitHubRuntimeEnvironment,
  type VerifiedProductionInvocation,
} from "./github-release.ts";

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
}) => ({
  id: input.id,
  run_attempt: input.attempt ?? 1,
  event: input.event ?? "workflow_dispatch",
  status: input.status ?? "completed",
  conclusion: input.conclusion === undefined ? "success" : input.conclusion,
  head_branch: input.branch,
  head_sha: input.sha,
  path: `${GITHUB_RELEASE_WORKFLOWS[input.workflow]}@${input.branch}`,
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
    expect(headers.get("X-GitHub-Api-Version")).toBe("2026-03-10");
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
    options: { protected?: boolean; headSha?: string; attempt?: number } = {},
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
        });
      }
      if (path.endsWith("/actions/workflows/release-rehearsal.yml")) {
        return workflow("rehearsal", 11);
      }
      if (path.endsWith("/branches/stage")) return branch("stage", candidate);
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

  it.each(["../escaped", "/absolute", "C:/absolute", "nested\\escaped"])(
    "rejects unsafe paths without retaining or exposing their names",
    async (name) => {
      const parent = mkdtempSync(join(tmpdir(), "github-artifact-test-"));
      const destination = join(parent, "extracted");
      try {
        const extraction = extractVerifiedGitHubArtifact(storedZip([{ name }]), destination);
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
        extractVerifiedGitHubArtifact(storedZip(entries), destination),
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
        extractVerifiedGitHubArtifact(storedZip(tooMany), join(parent, "count")),
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
    const repositoryDestination = join(process.cwd(), ".artifact-extraction-must-not-exist");
    try {
      mkdirSync(existing);
      const archive = storedZip([{ name: "file" }]);
      await expect(extractVerifiedGitHubArtifact(archive, existing)).rejects.toMatchObject({
        kind: "artifact",
      });
      await expect(
        extractVerifiedGitHubArtifact(archive, repositoryDestination),
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
      throw new Error(`unexpected test request: ${path}`);
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
