import { describe, expect, it } from "vitest";

import { securityPolicyDrift, withCodeScanningRule } from "./github-security-policy.mjs";

const policy = {
  codeql: {
    state: "configured",
    languages: ["actions", "javascript-typescript"],
    query_suite: "extended",
    threat_model: "remote",
  },
  ruleset: {
    name: "main",
    tool: "CodeQL",
    alerts_threshold: "errors_and_warnings",
    security_alerts_threshold: "medium_or_higher",
  },
};
const baseRuleset = {
  name: "main",
  target: "branch",
  enforcement: "active",
  bypass_actors: [],
  conditions: { ref_name: { include: ["~DEFAULT_BRANCH"], exclude: [] } },
  rules: [{ type: "deletion" }, { type: "non_fast_forward" }],
};

describe("GitHub security policy", () => {
  it("adds a blocking CodeQL rule while preserving existing rules", () => {
    const configured = withCodeScanningRule(policy, baseRuleset);
    expect(configured.rules).toEqual([
      { type: "deletion" },
      { type: "non_fast_forward" },
      {
        type: "code_scanning",
        parameters: {
          code_scanning_tools: [
            {
              tool: "CodeQL",
              alerts_threshold: "errors_and_warnings",
              security_alerts_threshold: "medium_or_higher",
            },
          ],
        },
      },
    ]);
  });

  it("reports default-setup and merge-protection drift", () => {
    const drift = securityPolicyDrift(
      policy,
      {
        state: "configured",
        languages: ["javascript-typescript"],
        query_suite: "default",
        threat_model: "remote",
      },
      baseRuleset,
    );
    expect(drift).toEqual([
      "CodeQL query_suite is default; expected extended.",
      "CodeQL languages are javascript-typescript; expected at least actions, javascript-typescript.",
      "Ruleset main does not require CodeQL code scanning.",
    ]);
  });

  it("accepts the exact declared policy", () => {
    const configured = withCodeScanningRule(policy, baseRuleset);
    expect(
      securityPolicyDrift(
        policy,
        { ...policy.codeql, languages: [...policy.codeql.languages, "javascript", "typescript"] },
        configured,
      ),
    ).toEqual([]);
  });
});
