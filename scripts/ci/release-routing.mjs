const RELEASE_LABEL = "need-release-process";
const RELEASE_BRANCH = "stage";
const PRODUCTION_BRANCH = "main";

function repositoryName(reference) {
  return reference?.repo?.full_name;
}

function hasReleaseLabel(pullRequest) {
  return pullRequest.labels?.some((label) =>
    typeof label === "string" ? label === RELEASE_LABEL : label?.name === RELEASE_LABEL,
  );
}

function invalid(pullRequest, reason, chain = []) {
  return { allowed: false, pullRequest: pullRequest.number, reason, chain };
}

export function releaseRoutingDecision(pullRequest, openPullRequests, repository) {
  if (!Number.isInteger(pullRequest?.number) || !Array.isArray(pullRequest?.labels)) {
    return invalid(pullRequest ?? {}, "Pull request metadata is incomplete.");
  }
  if (!hasReleaseLabel(pullRequest)) {
    return {
      allowed: true,
      pullRequest: pullRequest.number,
      reason: `PR does not have the ${RELEASE_LABEL} label.`,
      chain: [pullRequest.number],
    };
  }

  const chain = [];
  const visited = new Set();
  let current = pullRequest;
  while (current) {
    if (!Number.isInteger(current.number) || !current.head?.ref || !current.base?.ref) {
      return invalid(pullRequest, "Pull request branch metadata is incomplete.", chain);
    }
    if (repositoryName(current.base) !== repository) {
      return invalid(
        pullRequest,
        `PR #${current.number} targets a branch outside ${repository}.`,
        chain,
      );
    }
    if (visited.has(current.number)) {
      return invalid(pullRequest, `Dependency cycle detected at PR #${current.number}.`, [
        ...chain,
        current.number,
      ]);
    }
    visited.add(current.number);
    chain.push(current.number);

    if (current.base.ref === RELEASE_BRANCH) {
      return {
        allowed: true,
        pullRequest: pullRequest.number,
        reason: `Route reaches ${RELEASE_BRANCH}.`,
        chain,
      };
    }
    if (
      repositoryName(current.head) === repository &&
      current.head.ref === RELEASE_BRANCH &&
      current.base.ref === PRODUCTION_BRANCH
    ) {
      return {
        allowed: true,
        pullRequest: pullRequest.number,
        reason: `PR is the ${RELEASE_BRANCH}-to-${PRODUCTION_BRANCH} promotion.`,
        chain,
      };
    }
    if (current.base.ref === PRODUCTION_BRANCH) {
      return invalid(
        pullRequest,
        `PR #${current.number} targets ${PRODUCTION_BRANCH} without being the ${RELEASE_BRANCH} promotion.`,
        chain,
      );
    }
    if (repositoryName(current.head) !== repository) {
      return invalid(
        pullRequest,
        `PR #${current.number} cannot use a fork branch in a dependency chain.`,
        chain,
      );
    }

    const parents = openPullRequests.filter(
      (candidate) =>
        candidate.state === "open" &&
        repositoryName(candidate.head) === repository &&
        repositoryName(candidate.base) === repository &&
        candidate.head.ref === current.base.ref,
    );
    if (parents.length === 0) {
      return invalid(
        pullRequest,
        `No open same-repository PR has head branch ${current.base.ref}.`,
        chain,
      );
    }
    if (parents.length > 1) {
      return invalid(
        pullRequest,
        `Multiple open same-repository PRs have head branch ${current.base.ref}.`,
        chain,
      );
    }
    current = parents[0];
  }

  return invalid(pullRequest, "The dependency route could not be resolved.", chain);
}

export function checkOpenPullRequestRoutes(openPullRequests, repository) {
  return openPullRequests.map((pullRequest) =>
    releaseRoutingDecision(pullRequest, openPullRequests, repository),
  );
}

export function createGitHubReleaseRoutingClient({
  repository,
  token,
  apiUrl = "https://api.github.com",
  fetchImpl = fetch,
}) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(repository ?? "")) {
    throw new Error("Repository must be owner/repo");
  }
  if (!token) throw new Error("A GitHub token is required");

  const root = `/repos/${repository}`;
  async function request(path, method = "GET", body) {
    const response = await fetchImpl(`${apiUrl}${root}${path}`, {
      method,
      signal: AbortSignal.timeout(30_000),
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "X-GitHub-Api-Version": "2026-03-10",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!response.ok) throw new Error(`GitHub API ${path} failed with ${response.status}`);
    return response.status === 204 ? undefined : response.json();
  }

  return {
    async listOpenPullRequests() {
      const pulls = [];
      for (let page = 1; page <= 10; page += 1) {
        const batch = await request(`/pulls?state=open&per_page=100&page=${page}`);
        pulls.push(...batch);
        if (batch.length < 100) return pulls;
      }
      throw new Error("Pull request pagination exceeded the supported 1,000-item safety limit");
    },
    setCommitStatus(sha, status) {
      if (!/^[0-9a-f]{40}$/u.test(sha ?? "")) throw new Error("Invalid commit SHA");
      return request(`/statuses/${sha}`, "POST", status);
    },
    getCommitStatuses(sha) {
      if (!/^[0-9a-f]{40}$/u.test(sha ?? "")) throw new Error("Invalid commit SHA");
      return request(`/commits/${sha}/statuses?per_page=100`);
    },
  };
}

export async function checkGitHubReleaseRouting({ client, repository, targetUrl }) {
  const pullRequests = await client.listOpenPullRequests();
  const decisions = checkOpenPullRequestRoutes(pullRequests, repository);
  const statuses = new Map();
  for (const [index, decision] of decisions.entries()) {
    const pullRequest = pullRequests[index];
    const previous = statuses.get(pullRequest.head.sha);
    statuses.set(pullRequest.head.sha, previous === false ? false : decision.allowed);
  }
  const errors = [];
  for (const [sha, allowed] of statuses) {
    const desiredState = allowed ? "success" : "failure";
    let currentState;
    try {
      const existingStatuses = await client.getCommitStatuses(sha);
      currentState = existingStatuses.find(
        ({ context }) => context?.toLowerCase() === "release-routing",
      )?.state;
    } catch {
      // A status read is only a write de-duplication optimization. Publish the desired state.
    }
    if (currentState === desiredState) {
      continue;
    }
    try {
      await client.setCommitStatus(sha, {
        state: desiredState,
        context: "release-routing",
        description: allowed
          ? "Release routing is valid."
          : "Release routing is invalid; inspect the workflow run.",
        ...(targetUrl ? { target_url: targetUrl } : {}),
      });
    } catch (error) {
      errors.push(new Error(`Could not publish release routing for ${sha}.`, { cause: error }));
    }
  }
  if (errors.length > 0) {
    throw new AggregateError(
      errors,
      `Could not publish ${errors.length} release routing status(es).`,
    );
  }
  return decisions;
}
