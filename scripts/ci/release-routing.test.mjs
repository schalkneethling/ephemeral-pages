import { describe, expect, it } from "vitest";

import {
  checkGitHubReleaseRouting,
  createGitHubReleaseRoutingClient,
  releaseRoutingDecision,
} from "./release-routing.mjs";

const repository = "example/project";
function pullRequest({
  number,
  head,
  base,
  label = false,
  state = "open",
  headRepository = repository,
  baseRepository = repository,
}) {
  return {
    number,
    state,
    labels: label ? [{ name: "need-release-process" }] : [],
    head: { ref: head, sha: String(number).padStart(40, "0"), repo: { full_name: headRepository } },
    base: { ref: base, repo: { full_name: baseRepository } },
  };
}

describe("release routing policy", () => {
  it("accepts unlabeled PRs, direct stage PRs, and the stage promotion", () => {
    const unlabeled = pullRequest({ number: 1, head: "docs", base: "main" });
    const staged = pullRequest({ number: 2, head: "feature", base: "stage", label: true });
    const promotion = pullRequest({ number: 3, head: "stage", base: "main", label: true });
    expect(releaseRoutingDecision(unlabeled, [unlabeled], repository).allowed).toBe(true);
    expect(releaseRoutingDecision(staged, [staged], repository)).toMatchObject({
      allowed: true,
      chain: [2],
    });
    expect(releaseRoutingDecision(promotion, [promotion], repository)).toMatchObject({
      allowed: true,
      chain: [3],
    });
  });

  it("accepts a unique open dependency chain that reaches stage", () => {
    const child = pullRequest({ number: 1, head: "feature-ui", base: "feature-api", label: true });
    const parent = pullRequest({ number: 2, head: "feature-api", base: "stage" });
    expect(releaseRoutingDecision(child, [child, parent], repository)).toMatchObject({
      allowed: true,
      chain: [1, 2],
    });
  });

  it("rejects a labeled PR targeting main and a chain whose unlabeled parent targets main", () => {
    const direct = pullRequest({ number: 1, head: "feature", base: "main", label: true });
    const child = pullRequest({ number: 2, head: "feature-ui", base: "feature-api", label: true });
    const parent = pullRequest({ number: 3, head: "feature-api", base: "main" });
    expect(releaseRoutingDecision(direct, [direct], repository)).toMatchObject({ allowed: false });
    expect(releaseRoutingDecision(child, [child, parent], repository)).toMatchObject({
      allowed: false,
      chain: [2, 3],
    });
  });

  it("fails closed for missing, closed, or ambiguous dependencies", () => {
    const child = pullRequest({ number: 1, head: "feature-ui", base: "feature-api", label: true });
    const closed = pullRequest({
      number: 2,
      head: "feature-api",
      base: "stage",
      state: "closed",
    });
    const duplicate = pullRequest({ number: 3, head: "feature-api", base: "stage" });
    expect(releaseRoutingDecision(child, [child], repository).allowed).toBe(false);
    expect(releaseRoutingDecision(child, [child, closed], repository).allowed).toBe(false);
    expect(
      releaseRoutingDecision(child, [child, { ...closed, state: "open" }, duplicate], repository),
    ).toMatchObject({ allowed: false, reason: expect.stringContaining("Multiple") });
  });

  it("fails closed for cycles and foreign branch references", () => {
    const first = pullRequest({ number: 1, head: "feature-a", base: "feature-b", label: true });
    const second = pullRequest({ number: 2, head: "feature-b", base: "feature-a" });
    const foreign = pullRequest({
      number: 3,
      head: "fork-feature",
      base: "stage",
      label: true,
      headRepository: "someone/fork",
    });
    expect(releaseRoutingDecision(first, [first, second], repository)).toMatchObject({
      allowed: false,
      reason: expect.stringContaining("cycle"),
    });
    expect(releaseRoutingDecision(foreign, [foreign], repository)).toMatchObject({
      allowed: false,
      reason: expect.stringContaining("outside"),
    });
  });
});

describe("GitHub release routing check", () => {
  it("refreshes statuses for every same-repository open PR", async () => {
    const child = pullRequest({ number: 1, head: "feature-ui", base: "missing", label: true });
    const ordinary = pullRequest({ number: 2, head: "docs", base: "main" });
    const statuses = [];
    const decisions = await checkGitHubReleaseRouting({
      repository,
      targetUrl: "https://example.test/run",
      client: {
        listOpenPullRequests: async () => [child, ordinary],
        getCommitStatuses: async () => [],
        setCommitStatus: async (sha, status) => statuses.push({ sha, ...status }),
      },
    });
    expect(decisions.map(({ allowed }) => allowed)).toEqual([false, true]);
    expect(statuses).toEqual([
      expect.objectContaining({
        sha: child.head.sha,
        state: "failure",
        context: "release-routing",
      }),
      expect.objectContaining({
        sha: ordinary.head.sha,
        state: "success",
        context: "release-routing",
      }),
    ]);
  });

  it("publishes one failing status when the same commit belongs to valid and invalid PRs", async () => {
    const invalid = pullRequest({ number: 1, head: "feature", base: "main", label: true });
    const ordinary = {
      ...pullRequest({ number: 2, head: "feature", base: "main" }),
      head: {
        ...pullRequest({ number: 2, head: "feature", base: "main" }).head,
        sha: invalid.head.sha,
      },
    };
    const statuses = [];
    await checkGitHubReleaseRouting({
      repository,
      client: {
        listOpenPullRequests: async () => [invalid, ordinary],
        getCommitStatuses: async () => [],
        setCommitStatus: async (sha, status) => statuses.push({ sha, ...status }),
      },
    });
    expect(statuses).toEqual([
      expect.objectContaining({ sha: invalid.head.sha, state: "failure" }),
    ]);
  });

  it("turns a child status into a failure after its parent closes", async () => {
    const child = pullRequest({ number: 1, head: "feature-ui", base: "feature-api", label: true });
    const parent = pullRequest({ number: 2, head: "feature-api", base: "stage" });
    const states = [];
    const client = {
      listOpenPullRequests: async () => [child, parent],
      getCommitStatuses: async () => [],
      setCommitStatus: async (sha, { state }) => states.push({ sha, state }),
    };
    await checkGitHubReleaseRouting({ client, repository });
    client.listOpenPullRequests = async () => [child];
    await checkGitHubReleaseRouting({ client, repository });
    expect(states.filter(({ sha }) => sha === child.head.sha)).toEqual([
      { sha: child.head.sha, state: "success" },
      { sha: child.head.sha, state: "failure" },
    ]);
  });

  it("does not duplicate an unchanged routing status", async () => {
    const ordinary = pullRequest({ number: 1, head: "docs", base: "main" });
    let writes = 0;
    await checkGitHubReleaseRouting({
      repository,
      client: {
        listOpenPullRequests: async () => [ordinary],
        getCommitStatuses: async () => [{ context: "Release-Routing", state: "success" }],
        setCommitStatus: async () => {
          writes += 1;
        },
      },
    });
    expect(writes).toBe(0);
  });

  it("paginates API reads and sends authenticated status writes", async () => {
    const requests = [];
    let page = 0;
    const client = createGitHubReleaseRoutingClient({
      repository,
      token: "token",
      fetchImpl: async (url, init) => {
        requests.push({ url, init });
        if (init.method === "POST") {
          return { ok: true, status: 201, json: async () => ({}) };
        }
        if (url.includes("/commits/")) {
          return { ok: true, status: 200, json: async () => [] };
        }
        page += 1;
        return {
          ok: true,
          status: 200,
          json: async () => (page === 1 ? Array.from({ length: 100 }, () => ({})) : []),
        };
      },
    });
    expect(await client.listOpenPullRequests()).toHaveLength(100);
    expect(await client.getCommitStatuses("a".repeat(40))).toEqual([]);
    await client.setCommitStatus("a".repeat(40), { state: "success" });
    expect(requests).toHaveLength(4);
    expect(requests[3]).toMatchObject({
      url: "https://api.github.com/repos/example/project/statuses/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      init: { method: "POST" },
    });
    expect(requests[3].init.headers.Authorization).toBe("Bearer token");
  });
});
