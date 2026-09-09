import { describe, expect, it } from "vitest";
import policy from "../../.github/security-policy.json" with { type: "json" };
import { configureGitHubSecurity, createGitHubSecurityClient } from "./github-security.mjs";
import { withCodeScanningRule, securityPolicyDrift } from "./github-security-policy.mjs";

const base = {
  name: "main",
  target: "branch",
  enforcement: "active",
  bypass_actors: [],
  conditions: { ref_name: { include: ["~DEFAULT_BRANCH"], exclude: [] } },
  rules: [{ type: "deletion" }],
};
function harness({
  ruleset = withCodeScanningRule(policy, base),
  setup = policy.codeql,
  converge = true,
} = {}) {
  const writes = [];
  let current = setup;
  return {
    writes,
    client: {
      getRepository: async () => ({ default_branch: "main" }),
      getDefaultSetup: async () => current,
      findRuleset: async () => ({ id: 7 }),
      getRuleset: async () => ruleset,
      updateDefaultSetup: async (value) => {
        writes.push("setup");
        if (converge) current = value;
      },
      updateRuleset: async (_id, value) => {
        writes.push("ruleset");
        ruleset = value;
      },
    },
  };
}
describe("reusable GitHub security configuration", () => {
  it("audits without writing", async () => {
    const { client, writes } = harness();
    expect(await configureGitHubSecurity({ policy, client })).toEqual([]);
    expect(writes).toEqual([]);
  });
  it("applies and verifies the returned state", async () => {
    const { client, writes } = harness({
      ruleset: base,
      setup: { ...policy.codeql, query_suite: "default" },
    });
    expect(await configureGitHubSecurity({ policy, client, apply: true })).toEqual([]);
    expect(writes).toEqual(["setup", "ruleset"]);
  });
  it("applies when the API omits exclusions", async () => {
    const { client, writes } = harness({
      ruleset: { ...base, conditions: { ref_name: { include: ["~DEFAULT_BRANCH"] } } },
    });
    expect(await configureGitHubSecurity({ policy, client, apply: true })).toEqual([]);
    expect(writes).toEqual(["setup", "ruleset"]);
  });
  it("preserves configured languages and adds missing required languages", async () => {
    const setup = { ...policy.codeql, languages: ["python", "actions"] };
    const { client } = harness({ setup });
    expect(await configureGitHubSecurity({ policy, client, apply: true })).toEqual([]);
    const configured = await client.getDefaultSetup();
    expect([...configured.languages].sort()).toEqual([
      "actions",
      "javascript-typescript",
      "python",
    ]);
    expect(setup.languages).toEqual(["python", "actions"]);
    expect(policy.codeql.languages).toEqual(["actions", "javascript-typescript"]);
  });
  it("reports when readback loses a previously configured language", async () => {
    const { client } = harness({ setup: { ...policy.codeql, languages: ["python"] } });
    client.updateDefaultSetup = async () => {
      client.getDefaultSetup = async () => policy.codeql;
    };
    const drift = await configureGitHubSecurity({
      policy,
      client,
      apply: true,
      sleep: async () => {},
    });
    expect(drift).toContain(
      "CodeQL languages are actions, javascript-typescript; expected at least actions, javascript-typescript, python.",
    );
  });
  it("reports non-convergence after bounded polling", async () => {
    const { client } = harness({
      setup: { ...policy.codeql, query_suite: "default" },
      converge: false,
    });
    let waits = 0;
    const drift = await configureGitHubSecurity({
      policy,
      client,
      apply: true,
      sleep: async () => {
        waits += 1;
      },
    });
    expect(waits).toBe(23);
    expect(drift).toContain("CodeQL query_suite is default; expected extended.");
  });
  it("refuses writes when bypass information is unavailable", async () => {
    const { client, writes } = harness({ ruleset: { ...base, bypass_actors: undefined } });
    await expect(configureGitHubSecurity({ policy, client, apply: true })).rejects.toThrow(
      "Cannot verify bypass actors",
    );
    expect(writes).toEqual([]);
  });
  it("detects inactive enforcement, wrong scope, and bypass actors", () => {
    const ruleset = withCodeScanningRule(policy, {
      ...base,
      enforcement: "evaluate",
      conditions: { ref_name: { include: ["refs/heads/develop"], exclude: [] } },
      bypass_actors: [{ actor_id: 234, actor_type: "Team", bypass_mode: "always" }],
    });
    expect(securityPolicyDrift(policy, policy.codeql, ruleset, "main")).toHaveLength(3);
  });
  it("accepts an explicit default branch but rejects exclusions", () => {
    const ruleset = withCodeScanningRule(policy, {
      ...base,
      conditions: { ref_name: { include: ["refs/heads/trunk"], exclude: [] } },
    });
    expect(securityPolicyDrift(policy, policy.codeql, ruleset, "trunk")).toEqual([]);
    ruleset.conditions.ref_name.exclude.push("refs/heads/trunk");
    expect(securityPolicyDrift(policy, policy.codeql, ruleset, "trunk")).toHaveLength(1);
  });
  it("preserves other scanners and remains idempotent", () => {
    const other = {
      tool: "OtherScanner",
      alerts_threshold: "all",
      security_alerts_threshold: "all",
    };
    const ruleset = {
      ...base,
      rules: [
        ...base.rules,
        { type: "code_scanning", parameters: { code_scanning_tools: [other] } },
      ],
    };
    const result = withCodeScanningRule(policy, ruleset);
    expect(result.rules[1].parameters.code_scanning_tools).toContainEqual(other);
    expect(withCodeScanningRule(policy, result)).toEqual(result);
    expect(ruleset.rules[1].parameters.code_scanning_tools).toEqual([other]);
  });
  it("uses the supplied repository and bounds authenticated requests", async () => {
    const requests = [];
    const client = createGitHubSecurityClient({
      repository: "example/calavera",
      token: "test-token",
      fetchImpl: async (url, init) => {
        requests.push({ url, init });
        return { ok: true, status: 200, json: async () => ({ state: "configured" }) };
      },
    });
    expect(await client.getDefaultSetup()).toEqual({ state: "configured" });
    expect(requests[0].url).toBe(
      "https://api.github.com/repos/example/calavera/code-scanning/default-setup",
    );
    expect(requests[0].init.signal).toBeInstanceOf(AbortSignal);
    expect(requests[0].init.headers.Authorization).toBe("Bearer test-token");
  });
  it("finds a ruleset beyond the first page", async () => {
    let count = 0;
    const client = createGitHubSecurityClient({
      repository: "example/calavera",
      token: "test-token",
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        json: async () =>
          ++count === 1
            ? Array.from({ length: 100 }, () => ({ name: "unrelated" }))
            : [{ id: 7, name: "main", target: "branch", source_type: "Repository" }],
      }),
    });
    expect(await client.findRuleset("main")).toEqual({
      id: 7,
      name: "main",
      target: "branch",
      source_type: "Repository",
    });
    expect(count).toBe(2);
  });
});
