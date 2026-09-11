import { createHash } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  PrepareWorkerArtifactsInput,
  PreparedWorkerArtifacts,
  WorkerArtifactManifest,
} from "./worker-artifacts.ts";
import {
  activatePreparedStagingWorker,
  createCloudflareWorkerFetchTransport,
  createWranglerAccessTokenResolver,
  uploadPreparedStagingWorker,
  WorkerReleaseError,
  type PreparedStagingWorkerRelease,
  type UploadedStagingWorkerVersion,
  type WorkerReleaseCheckpoint,
  type WorkerReleaseRequest,
  type WorkerReleaseTransport,
} from "./worker-release.ts";

const temporaryDirectories: string[] = [];
const digest = (value: Uint8Array | string): string =>
  createHash("sha256").update(value).digest("hex");

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })));
});

const createFixture = async (): Promise<{
  input: PreparedStagingWorkerRelease;
  manifest: WorkerArtifactManifest;
}> => {
  const root = await mkdtemp(join(tmpdir(), "worker-release-test-"));
  temporaryDirectories.push(root);
  const artifactDirectory = join(root, "artifact");
  await mkdir(join(artifactDirectory, "bundle"), { recursive: true });
  await mkdir(join(artifactDirectory, "config"), { recursive: true });
  const source = "export default { fetch() { return new Response('ok') } };\n";
  const config = "{}\n";
  await writeFile(join(artifactDirectory, "bundle/index.js"), source);
  await writeFile(join(artifactDirectory, "config/wrangler.json"), config);
  const variables = {
    ALLOWED_ORIGINS: "https://stage.example.test",
    PAGE_CONTENT_ORIGIN: "https://stage.example.test",
    PUBLIC_WORKER_ORIGIN: "https://stage-worker.example.workers.dev",
    TICKET_AUDIENCE: "stage-worker",
  } as const;
  const artifactInput: PrepareWorkerArtifactsInput = {
    artifactDirectory,
    environment: "staging",
    productionWorkerName: "production-worker",
    repositoryRoot: root,
    sourceConfigSha256: "a".repeat(64),
    target: {
      accountId: "account-id",
      expectedNonSecretVariables: variables,
      requiredSecretNames: ["TICKET_HMAC_SECRET", "ADMIN_TOKEN"],
      workerName: "stage-worker",
      wranglerConfigPath: "collaboration-worker/wrangler.jsonc",
      wranglerEnvironment: "staging",
    },
  };
  const entrypointBytes = Buffer.from(source);
  const manifest: WorkerArtifactManifest = {
    entrypoint: "bundle/index.js",
    files: [
      {
        bytes: entrypointBytes.length,
        path: "bundle/index.js",
        sha256: digest(entrypointBytes),
      },
      {
        bytes: Buffer.byteLength(config),
        path: "config/wrangler.json",
        sha256: digest(config),
      },
    ],
    policy: {
      browser: { binding: "BROWSER" },
      compatibilityDate: "2026-08-16",
      compatibilityFlags: ["nodejs_compat"],
      durableObjects: {
        bindings: [{ className: "CollaborationRoom", name: "COLLABORATION_ROOMS" }],
      },
      migrations: [{ newSqliteClasses: ["CollaborationRoom"], tag: "v1" }],
      observability: {
        enabled: true,
        logs: { enabled: true, head_sampling_rate: 0.1 },
        traces: { enabled: true, head_sampling_rate: 0.01 },
      },
      requiredSecretNames: ["TICKET_HMAC_SECRET", "ADMIN_TOKEN"],
      workersDev: true,
    },
    schemaVersion: 1,
    source: {
      configPath: "collaboration-worker/wrangler.jsonc",
      configSha256: "a".repeat(64),
    },
    target: {
      accountId: "account-id",
      environment: "staging",
      productionWorkerName: "production-worker",
      workerName: "stage-worker",
      wranglerEnvironment: "staging",
    },
    uploadConfig: {
      bytes: Buffer.byteLength(config),
      path: "config/wrangler.json",
      sha256: digest(config),
    },
    wranglerVersion: "4.125.0",
  };
  const prepared: PreparedWorkerArtifacts = {
    artifactDirectory,
    manifest,
    manifestSha256: "c".repeat(64),
  };
  return {
    input: {
      artifactInput,
      expectedBaselineDeploymentId: "baseline-deployment",
      migrationPolicy: { artifactTag: "v1", change: "none", expectedCurrentTag: "v1" },
      prepared,
    },
    manifest,
  };
};

const bindings = (input: PreparedStagingWorkerRelease): readonly Record<string, unknown>[] => [
  { name: "TICKET_HMAC_SECRET", type: "secret_text" },
  { name: "ADMIN_TOKEN", type: "secret_text" },
  ...Object.entries(input.artifactInput.target.expectedNonSecretVariables).map(([name, text]) => ({
    name,
    text,
    type: "plain_text",
  })),
  {
    class_name: "CollaborationRoom",
    name: "COLLABORATION_ROOMS",
    type: "durable_object_namespace",
  },
  { name: "BROWSER", type: "browser" },
];

const version = (
  input: PreparedStagingWorkerRelease,
  id: string,
  annotation?: string,
  quotedEtag = false,
): unknown => ({
  ...(annotation ? { annotations: { "workers/tag": annotation } } : {}),
  id,
  resources: {
    bindings: bindings(input),
    script: { etag: quotedEtag ? `"${digest(id)}"` : digest(id) },
    script_runtime: {
      compatibility_date: "2026-08-16",
      compatibility_flags: ["nodejs_compat"],
    },
  },
});

const service = {
  default_environment: {
    script: {
      migration_tag: "v1",
      observability: {
        enabled: true,
        head_sampling_rate: 1,
        logs: {
          enabled: true,
          head_sampling_rate: 0.1,
          invocation_logs: true,
          persist: true,
        },
        redact_query_string: false,
        traces: { enabled: true, head_sampling_rate: 0.01, persist: true },
      },
    },
  },
};
const deployments = (id: string, versionId: string): unknown => ({
  deployments: [{ id, versions: [{ percentage: 100, version_id: versionId }] }],
});

class ScriptedTransport implements WorkerReleaseTransport {
  readonly requests: WorkerReleaseRequest[] = [];
  readonly #responses: unknown[];

  constructor(responses: unknown[]) {
    this.#responses = responses;
  }

  async dispatch(request: WorkerReleaseRequest): Promise<unknown> {
    this.requests.push(request);
    const response = this.#responses.shift();
    if (response instanceof Error) throw response;
    return response;
  }
}

const recordingTransport = (responses: unknown[], events: string[]): WorkerReleaseTransport => ({
  dispatch: async (request) => {
    events.push(`dispatch:${request.method}:${request.path}`);
    const response = responses.shift();
    if (response instanceof Error) throw response;
    return response;
  },
});

describe("uploadPreparedStagingWorker", () => {
  it("rejects an additional executable module before provider inspection or mutation", async () => {
    const { input, manifest } = await createFixture();
    const unsupportedManifest: WorkerArtifactManifest = {
      ...manifest,
      files: [...manifest.files, { bytes: 1, path: "bundle/chunk.js", sha256: "d".repeat(64) }],
    };
    const checkpoint = vi.fn(async () => undefined);
    const transport = new ScriptedTransport([]);

    await expect(
      uploadPreparedStagingWorker(input, {
        checkpoint,
        transport,
        verifyArtifacts: async () => unsupportedManifest,
      }),
    ).rejects.toMatchObject({ kind: "artifact" });
    expect(transport.requests).toHaveLength(0);
    expect(checkpoint).not.toHaveBeenCalled();
  });

  it("checks the baseline, checkpoints, and sends one exact multipart mutation", async () => {
    const { input, manifest } = await createFixture();
    const transport = new ScriptedTransport([
      service,
      deployments("baseline-deployment", "baseline-version"),
      version(input, "baseline-version"),
      { id: "uploaded-version" },
      version(input, "uploaded-version", input.prepared.manifestSha256, true),
    ]);
    const checkpoints: WorkerReleaseCheckpoint[] = [];

    const result = await uploadPreparedStagingWorker(input, {
      checkpoint: async (value) => {
        checkpoints.push(value);
      },
      transport,
      verifyArtifacts: async () => manifest,
    });

    expect(result).toMatchObject({
      artifactManifestSha256: input.prepared.manifestSha256,
      baselineDeploymentId: "baseline-deployment",
      scriptEtag: digest("uploaded-version"),
      status: "uploaded",
      versionId: "uploaded-version",
    });
    expect(checkpoints).toEqual([
      expect.objectContaining({ phase: "pending-version-upload", workerName: "stage-worker" }),
      expect.objectContaining({
        phase: "version-upload-response-received",
        versionId: "uploaded-version",
      }),
    ]);
    const mutations = transport.requests.filter(({ method }) => method === "POST");
    expect(mutations).toHaveLength(1);
    expect(mutations[0].path).toBe(
      "/accounts/account-id/workers/scripts/stage-worker/versions?bindings_inherit=strict",
    );
    const body = mutations[0].body;
    expect(body).toBeInstanceOf(FormData);
    const metadataPart = (body as FormData).get("metadata");
    expect(typeof metadataPart).toBe("string");
    if (typeof metadataPart !== "string") throw new Error("missing metadata fixture");
    const metadata = JSON.parse(metadataPart) as Record<string, unknown>;
    expect(metadata).not.toHaveProperty("migrations");
    expect(metadata).toMatchObject({
      annotations: { "workers/tag": input.prepared.manifestSha256 },
      compatibility_date: "2026-08-16",
      compatibility_flags: ["nodejs_compat"],
      keep_bindings: ["secret_text", "secret_key"],
      main_module: "index.js",
    });
    expect(metadata.bindings).toEqual(
      expect.arrayContaining([
        { name: "TICKET_HMAC_SECRET", type: "inherit" },
        { name: "ADMIN_TOKEN", type: "inherit" },
      ]),
    );
    const module = (body as FormData).get("index.js");
    expect(module).toBeInstanceOf(File);
    expect((module as File).type).toBe("application/javascript+module");
  });

  it("does not dispatch a mutation if checkpoint persistence fails", async () => {
    const { input, manifest } = await createFixture();
    const transport = new ScriptedTransport([
      service,
      deployments("baseline-deployment", "baseline-version"),
      version(input, "baseline-version"),
    ]);

    await expect(
      uploadPreparedStagingWorker(input, {
        checkpoint: async () => {
          throw new Error("sensitive checkpoint error");
        },
        transport,
        verifyArtifacts: async () => manifest,
      }),
    ).rejects.toMatchObject({
      kind: "checkpoint",
      message: "The Worker mutation checkpoint could not be persisted.",
    });
    expect(transport.requests.filter(({ method }) => method === "POST")).toHaveLength(0);
  });

  it("blocks when the existing non-versioned observability policy differs", async () => {
    const { input, manifest } = await createFixture();
    const checkpoint = vi.fn(async () => undefined);
    const transport = new ScriptedTransport([
      {
        default_environment: {
          script: { migration_tag: "v1", observability: { enabled: false } },
        },
      },
    ]);

    await expect(
      uploadPreparedStagingWorker(input, {
        checkpoint,
        transport,
        verifyArtifacts: async () => manifest,
      }),
    ).rejects.toMatchObject({ kind: "preflight" });
    expect(transport.requests.filter(({ method }) => method === "POST")).toHaveLength(0);
    expect(checkpoint).not.toHaveBeenCalled();
  });

  it("classifies a dispatched upload failure as ambiguous and never retries", async () => {
    const { input, manifest } = await createFixture();
    const transport = new ScriptedTransport([
      service,
      deployments("baseline-deployment", "baseline-version"),
      version(input, "baseline-version"),
      new Error("raw provider secret"),
    ]);

    await expect(
      uploadPreparedStagingWorker(input, {
        checkpoint: async () => undefined,
        transport,
        verifyArtifacts: async () => manifest,
      }),
    ).rejects.toEqual(new WorkerReleaseError("ambiguous"));
    expect(transport.requests.filter(({ method }) => method === "POST")).toHaveLength(1);
  });

  it("classifies a mutation timeout as ambiguous after one dispatch", async () => {
    const { input, manifest } = await createFixture();
    const requests: WorkerReleaseRequest[] = [];
    const responses = [
      service,
      deployments("baseline-deployment", "baseline-version"),
      version(input, "baseline-version"),
    ];
    const transport: WorkerReleaseTransport = {
      dispatch: async (request) => {
        requests.push(request);
        if (request.method === "POST") return new Promise(() => undefined);
        return responses.shift();
      },
    };

    await expect(
      uploadPreparedStagingWorker(input, {
        checkpoint: async () => undefined,
        timeoutMs: 1,
        transport,
        verifyArtifacts: async () => manifest,
      }),
    ).rejects.toEqual(new WorkerReleaseError("ambiguous"));
    expect(requests.filter(({ method }) => method === "POST")).toHaveLength(1);
  });

  it("checkpoints the returned version ID before a failing readback", async () => {
    const { input, manifest } = await createFixture();
    const events: string[] = [];
    const checkpoints: WorkerReleaseCheckpoint[] = [];
    const transport = recordingTransport(
      [
        service,
        deployments("baseline-deployment", "baseline-version"),
        version(input, "baseline-version"),
        { id: "returned-version" },
        new Error("unverified readback failure"),
      ],
      events,
    );

    await expect(
      uploadPreparedStagingWorker(input, {
        checkpoint: async (value) => {
          checkpoints.push(value);
          events.push(`checkpoint:${value.phase}`);
        },
        transport,
        verifyArtifacts: async () => manifest,
      }),
    ).rejects.toMatchObject({ kind: "ambiguous" });
    expect(checkpoints.at(-1)).toMatchObject({
      phase: "version-upload-response-received",
      versionId: "returned-version",
    });
    const returnedIndex = events.indexOf("checkpoint:version-upload-response-received");
    expect(events[returnedIndex + 1]).toBe(
      "dispatch:GET:/accounts/account-id/workers/scripts/stage-worker/versions/returned-version",
    );
  });

  it("does not read back when the returned version ID checkpoint cannot persist", async () => {
    const { input, manifest } = await createFixture();
    const events: string[] = [];
    const transport = recordingTransport(
      [
        service,
        deployments("baseline-deployment", "baseline-version"),
        version(input, "baseline-version"),
        { id: "returned-version" },
      ],
      events,
    );

    await expect(
      uploadPreparedStagingWorker(input, {
        checkpoint: async (value) => {
          events.push(`checkpoint:${value.phase}`);
          if (value.phase === "version-upload-response-received") throw new Error();
        },
        transport,
        verifyArtifacts: async () => manifest,
      }),
    ).rejects.toMatchObject({ kind: "ambiguous" });
    expect(events.at(-1)).toBe("checkpoint:version-upload-response-received");
    expect(events).not.toContain(
      "dispatch:GET:/accounts/account-id/workers/scripts/stage-worker/versions/returned-version",
    );
  });
});

describe("activatePreparedStagingWorker", () => {
  const uploaded = (input: PreparedStagingWorkerRelease): UploadedStagingWorkerVersion => ({
    accountId: "account-id",
    artifactManifestSha256: input.prepared.manifestSha256,
    baselineDeploymentId: "baseline-deployment",
    migrationPolicy: input.migrationPolicy,
    scriptEtag: digest("uploaded-version"),
    status: "uploaded",
    versionId: "uploaded-version",
    workerName: "stage-worker",
  });

  it("rechecks the baseline and upload, checkpoints, activates, and verifies readback", async () => {
    const { input, manifest } = await createFixture();
    const transport = new ScriptedTransport([
      service,
      deployments("baseline-deployment", "baseline-version"),
      version(input, "baseline-version"),
      version(input, "uploaded-version", input.prepared.manifestSha256),
      service,
      { id: "new-deployment" },
      deployments("new-deployment", "uploaded-version"),
      service,
      version(input, "uploaded-version", input.prepared.manifestSha256),
    ]);
    const checkpoints: WorkerReleaseCheckpoint[] = [];

    const result = await activatePreparedStagingWorker(
      { ...input, upload: uploaded(input) },
      {
        checkpoint: async (value) => {
          checkpoints.push(value);
        },
        transport,
        verifyArtifacts: async () => manifest,
      },
    );

    expect(result).toMatchObject({
      deploymentId: "new-deployment",
      scriptEtag: digest("uploaded-version"),
      status: "activated",
      versionId: "uploaded-version",
    });
    expect(checkpoints).toEqual([
      expect.objectContaining({ phase: "pending-activation", versionId: "uploaded-version" }),
      expect.objectContaining({
        deploymentId: "new-deployment",
        phase: "activation-response-received",
        versionId: "uploaded-version",
      }),
    ]);
    const mutations = transport.requests.filter(({ method }) => method === "POST");
    expect(mutations).toHaveLength(1);
    const activationBody = mutations[0].body;
    expect(typeof activationBody).toBe("string");
    if (typeof activationBody !== "string") throw new Error("missing activation fixture");
    expect(JSON.parse(activationBody)).toEqual({
      annotations: {
        "workers/message": `Activate prepared artifact ${input.prepared.manifestSha256}`,
      },
      strategy: "percentage",
      versions: [{ percentage: 100, version_id: "uploaded-version" }],
    });
  });

  it("blocks activation before checkpoint when the current deployment drifted", async () => {
    const { input, manifest } = await createFixture();
    const checkpoint = vi.fn(async () => undefined);
    const transport = new ScriptedTransport([
      service,
      deployments("different-deployment", "baseline-version"),
    ]);

    await expect(
      activatePreparedStagingWorker(
        { ...input, upload: uploaded(input) },
        { checkpoint, transport, verifyArtifacts: async () => manifest },
      ),
    ).rejects.toMatchObject({ kind: "preflight" });
    expect(checkpoint).not.toHaveBeenCalled();
    expect(transport.requests.filter(({ method }) => method === "POST")).toHaveLength(0);
  });

  it("checkpoints the returned deployment ID before a failing activation readback", async () => {
    const { input, manifest } = await createFixture();
    const events: string[] = [];
    const checkpoints: WorkerReleaseCheckpoint[] = [];
    const transport = recordingTransport(
      [
        service,
        deployments("baseline-deployment", "baseline-version"),
        version(input, "baseline-version"),
        version(input, "uploaded-version", input.prepared.manifestSha256),
        service,
        { id: "returned-deployment" },
        new Error("unverified activation readback failure"),
      ],
      events,
    );

    await expect(
      activatePreparedStagingWorker(
        { ...input, upload: uploaded(input) },
        {
          checkpoint: async (value) => {
            checkpoints.push(value);
            events.push(`checkpoint:${value.phase}`);
          },
          transport,
          verifyArtifacts: async () => manifest,
        },
      ),
    ).rejects.toMatchObject({ kind: "ambiguous" });
    expect(checkpoints.at(-1)).toMatchObject({
      deploymentId: "returned-deployment",
      phase: "activation-response-received",
      versionId: "uploaded-version",
    });
    const returnedIndex = events.indexOf("checkpoint:activation-response-received");
    expect(events[returnedIndex + 1]).toBe(
      "dispatch:GET:/accounts/account-id/workers/scripts/stage-worker/deployments",
    );
  });

  it("does not read back when the returned deployment ID checkpoint cannot persist", async () => {
    const { input, manifest } = await createFixture();
    const events: string[] = [];
    const transport = recordingTransport(
      [
        service,
        deployments("baseline-deployment", "baseline-version"),
        version(input, "baseline-version"),
        version(input, "uploaded-version", input.prepared.manifestSha256),
        service,
        { id: "returned-deployment" },
      ],
      events,
    );

    await expect(
      activatePreparedStagingWorker(
        { ...input, upload: uploaded(input) },
        {
          checkpoint: async (value) => {
            events.push(`checkpoint:${value.phase}`);
            if (value.phase === "activation-response-received") throw new Error();
          },
          transport,
          verifyArtifacts: async () => manifest,
        },
      ),
    ).rejects.toMatchObject({ kind: "ambiguous" });
    expect(events.at(-1)).toBe("checkpoint:activation-response-received");
    expect(events.filter((event) => event.endsWith("/deployments"))).toHaveLength(2);
  });
});

describe("createCloudflareWorkerFetchTransport", () => {
  it("uses only the fixed API origin, bearer auth, redirect errors, and an unwrapped result", async () => {
    const fetchMock = vi.fn<typeof fetch>(
      async () =>
        new Response(JSON.stringify({ result: { id: "ok" }, success: true }), {
          headers: { "Content-Type": "application/json" },
          status: 200,
        }),
    );
    const transport = createCloudflareWorkerFetchTransport({
      fetch: fetchMock,
      resolveAccessToken: async () => "token-value-that-is-long-enough",
    });

    await expect(
      transport.dispatch({
        method: "GET",
        path: "/accounts/account/workers/scripts/worker/deployments",
        signal: new AbortController().signal,
      }),
    ).resolves.toEqual({ id: "ok" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe(
      "https://api.cloudflare.com/client/v4/accounts/account/workers/scripts/worker/deployments",
    );
    expect(fetchMock.mock.calls[0][1]).toMatchObject({
      headers: {
        Accept: "application/json",
        Authorization: "Bearer token-value-that-is-long-enough",
      },
      redirect: "error",
    });
  });

  it("does not expose a rejected provider response", async () => {
    const transport = createCloudflareWorkerFetchTransport({
      fetch: async () =>
        new Response(
          JSON.stringify({ errors: [{ message: "raw-sensitive-provider-value" }], success: false }),
          {
            status: 403,
          },
        ),
      resolveAccessToken: async () => "token-value-that-is-long-enough",
    });

    await expect(
      transport.dispatch({
        method: "GET",
        path: "/accounts/account/workers/scripts/worker/deployments",
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow("");
    await transport
      .dispatch({
        method: "GET",
        path: "/accounts/account/workers/scripts/worker/deployments",
        signal: new AbortController().signal,
      })
      .catch((error: unknown) => {
        expect(String(error)).not.toContain("raw-sensitive-provider-value");
      });
  });

  it("cancels oversized provider response streams", async () => {
    const streamedCancel = vi.fn();
    const streamedBody = new ReadableStream<Uint8Array>({
      cancel: streamedCancel,
      start(controller) {
        controller.enqueue(new Uint8Array(1024 * 1024 + 1));
      },
    });
    const declaredCancel = vi.fn();
    const declaredBody = new ReadableStream<Uint8Array>({
      cancel: declaredCancel,
    });
    const responses = [
      new Response(streamedBody, { status: 200 }),
      new Response(declaredBody, { headers: { "Content-Length": "1048577" }, status: 200 }),
    ];
    const transport = createCloudflareWorkerFetchTransport({
      fetch: async () => responses.shift() as Response,
      resolveAccessToken: async () => "token-value-that-is-long-enough",
    });
    const request = {
      method: "GET" as const,
      path: "/accounts/account/workers/scripts/worker/deployments",
      signal: new AbortController().signal,
    };

    await expect(transport.dispatch(request)).rejects.toThrow();
    await expect(transport.dispatch(request)).rejects.toThrow();
    expect(streamedCancel).toHaveBeenCalledTimes(1);
    expect(declaredCancel).toHaveBeenCalledTimes(1);
  });
});

describe("createWranglerAccessTokenResolver", () => {
  it("uses the pinned auth token JSON command and caches the token in memory", async () => {
    const repositoryRoot = resolve(".");
    const sentinel = "oauth-token-that-stays-out-of-argv";
    const run = vi.fn(
      async (
        _executable: string,
        args: readonly string[],
        environment: Readonly<Record<string, string>>,
      ) => {
        expect(args).toEqual(["auth", "token", "--json", "--cwd", repositoryRoot]);
        expect(args.join(" ")).not.toContain(sentinel);
        expect(Object.values(environment)).not.toContain(sentinel);
        return {
          exitCode: 0,
          stderr: "",
          stdout: JSON.stringify({ token: sentinel, type: "oauth" }),
        };
      },
    );
    const resolveAccessToken = createWranglerAccessTokenResolver({
      repositoryRoot,
      run,
      workingDirectory: repositoryRoot,
    });

    await expect(resolveAccessToken()).resolves.toBe(sentinel);
    await expect(resolveAccessToken()).resolves.toBe(sentinel);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("returns a static authentication error for unsupported global-key output", async () => {
    const repositoryRoot = resolve(".");
    const resolveAccessToken = createWranglerAccessTokenResolver({
      repositoryRoot,
      run: async () => ({
        exitCode: 0,
        stderr: "",
        stdout: JSON.stringify({
          email: "private@example.test",
          key: "private-key",
          type: "api_key",
        }),
      }),
      workingDirectory: repositoryRoot,
    });

    await expect(resolveAccessToken()).rejects.toEqual(new WorkerReleaseError("authentication"));
  });
});
