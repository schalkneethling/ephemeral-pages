import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { rehearsePreparedRelease, type RehearsalDependencies } from "./rehearsal.ts";
import { verifyArtifactSource } from "./artifact-contract.ts";

vi.mock("./artifact-contract.ts", async (original) => ({
  ...(await original<object>()),
  verifyArtifactSource: vi.fn(),
}));
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});
async function fixture() {
  const parent = await mkdtemp(join(tmpdir(), "rehearsal-order-"));
  roots.push(parent);
  const repositoryRoot = join(parent, "repo");
  const artifactDirectory = join(parent, "artifacts");
  const reportDirectory = join(parent, "report");
  await mkdir(repositoryRoot);
  await mkdir(artifactDirectory);
  const source = {
    candidate: "a".repeat(40),
    tree: "b".repeat(40),
    environment: "staging" as const,
    configurationFingerprint: "c".repeat(64),
  };
  vi.mocked(verifyArtifactSource).mockResolvedValue({ source, configuration: {} as never });
  await writeFile(
    join(artifactDirectory, "prepared-release.json"),
    JSON.stringify({
      schemaVersion: 1,
      operation: "prepare",
      outcome: "passed",
      source,
      toolchain: { bun: "1.3.14" },
      artifacts: {
        netlify: { directory: "netlify", sha256: "d".repeat(64) },
        worker: { directory: "worker", sha256: "e".repeat(64) },
      },
    }),
  );
  const calls: string[] = [];
  let worker = "old-worker";
  let app = "old-app";
  const dependencies: RehearsalDependencies = {
    inspect: async () => ({
      netlifyDeployId: app,
      workerDeploymentId: worker,
      workerVersionId: worker,
    }),
    holdNetlify: async () => {
      calls.push("hold");
    },
    uploadWorker: async () => {
      calls.push("upload");
    },
    activateWorker: async () => {
      calls.push("activate");
      worker = "new-worker";
    },
    verifyTransition: async () => {
      calls.push("transition");
      expect(app).toBe("old-app");
      expect(worker).toBe("new-worker");
      return true;
    },
    publishNetlify: async () => {
      calls.push("publish");
      app = "new-app";
    },
    verifyPair: async () => {
      calls.push("pair");
      return true;
    },
  };
  return { input: { repositoryRoot, artifactDirectory, reportDirectory }, dependencies, calls };
}
it("verifies the transition before publishing the app and records the final pair", async () => {
  const { input, dependencies, calls } = await fixture();
  const report = await rehearsePreparedRelease(input, dependencies);
  expect(calls).toEqual(["hold", "upload", "activate", "transition", "publish", "pair"]);
  expect(report.outcome).toBe("passed");
  expect(report.observedPair?.netlifyDeployId).toBe("new-app");
  expect(JSON.parse(await readFile(join(input.reportDirectory, "rehearsal.json"), "utf8"))).toEqual(
    report,
  );
});
it("reports a changed Worker accurately when Netlify publishing fails and never rolls back automatically", async () => {
  const { input, dependencies, calls } = await fixture();
  dependencies.publishNetlify = async () => {
    calls.push("publish-failed");
    throw new Error("sensitive failure");
  };
  const report = await rehearsePreparedRelease(input, dependencies);
  expect(report.outcome).toBe("blocked");
  expect(report.recovery).toBe("inspect-recorded-targets-before-recovery");
  expect(report.observedPair).toMatchObject({
    netlifyDeployId: "old-app",
    workerVersionId: "new-worker",
  });
  expect(report.stages["activate-worker"]).toBe("passed");
  expect(report.stages["publish-netlify"]).toBe("blocked");
  expect(calls).not.toContain("pair");
  expect(JSON.stringify(report)).not.toContain("sensitive");
  await expect(rehearsePreparedRelease(input, dependencies)).rejects.toThrow();
  expect(calls.filter((call) => call === "activate")).toHaveLength(1);
});
it("does not publish after failed old-app/new-Worker compatibility", async () => {
  const { input, dependencies, calls } = await fixture();
  dependencies.verifyTransition = async () => false;
  const result = await rehearsePreparedRelease(input, dependencies);
  expect(result.outcome).toBe("blocked");
  expect(calls).not.toContain("publish");
});
