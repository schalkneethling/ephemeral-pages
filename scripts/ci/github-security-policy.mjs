export function codeqlPolicyDrift(policy, defaultSetup) {
  const drift = [];
  const desiredLanguages = [...policy.codeql.languages].sort((left, right) =>
    left.localeCompare(right),
  );
  const actualLanguages = [...(defaultSetup.languages ?? [])].sort((left, right) =>
    left.localeCompare(right),
  );
  for (const key of ["state", "query_suite", "threat_model"]) {
    if (defaultSetup[key] !== policy.codeql[key]) {
      drift.push(`CodeQL ${key} is ${String(defaultSetup[key])}; expected ${policy.codeql[key]}.`);
    }
  }
  if (!desiredLanguages.every((language) => actualLanguages.includes(language))) {
    drift.push(
      `CodeQL languages are ${actualLanguages.join(", ")}; expected at least ${desiredLanguages.join(", ")}.`,
    );
  }

  return drift;
}

export function rulesetProtectionDrift(ruleset, defaultBranch) {
  const drift = [];
  if (ruleset.target !== "branch" || ruleset.enforcement !== "active") {
    drift.push("The ruleset must actively enforce branch rules.");
  }
  const refs = ruleset.conditions?.ref_name;
  const accepted = ["~DEFAULT_BRANCH", "~ALL"];
  if (defaultBranch) accepted.push(`refs/heads/${defaultBranch}`);
  if (!refs?.include?.some((ref) => accepted.includes(ref)) || refs?.exclude?.length !== 0) {
    drift.push(
      "The ruleset must explicitly include the default branch and have no exclusions; other patterns are not verified.",
    );
  }
  if (!Array.isArray(ruleset.bypass_actors)) {
    drift.push("Cannot verify bypass actors; use credentials with write access to the ruleset.");
  } else if (ruleset.bypass_actors.length > 0) {
    drift.push("The ruleset must have no bypass actors.");
  }
  return drift;
}

export function securityPolicyDrift(policy, defaultSetup, ruleset, defaultBranch) {
  const drift = [
    ...codeqlPolicyDrift(policy, defaultSetup),
    ...rulesetProtectionDrift(ruleset, defaultBranch),
  ];
  const codeScanning = ruleset.rules?.find(({ type }) => type === "code_scanning");
  const tool = codeScanning?.parameters?.code_scanning_tools?.find(
    (candidate) => candidate.tool === policy.ruleset.tool,
  );
  if (!tool) {
    drift.push(`Ruleset ${ruleset.name} does not require ${policy.ruleset.tool} code scanning.`);
  } else {
    for (const key of ["alerts_threshold", "security_alerts_threshold"]) {
      if (tool[key] !== policy.ruleset[key]) {
        drift.push(
          `${policy.ruleset.tool} ${key} is ${String(tool[key])}; expected ${policy.ruleset[key]}.`,
        );
      }
    }
  }
  return drift;
}

export function withCodeScanningRule(policy, ruleset) {
  const rule = {
    type: "code_scanning",
    parameters: {
      code_scanning_tools: [
        ...(ruleset.rules ?? [])
          .filter(({ type }) => type === "code_scanning")
          .flatMap((existing) => existing.parameters?.code_scanning_tools ?? [])
          .filter(({ tool }) => tool !== policy.ruleset.tool),
        {
          tool: policy.ruleset.tool,
          alerts_threshold: policy.ruleset.alerts_threshold,
          security_alerts_threshold: policy.ruleset.security_alerts_threshold,
        },
      ],
    },
  };
  return {
    name: ruleset.name,
    target: ruleset.target,
    enforcement: ruleset.enforcement,
    bypass_actors: ruleset.bypass_actors,
    conditions: ruleset.conditions,
    rules: [...(ruleset.rules ?? []).filter(({ type }) => type !== "code_scanning"), rule],
  };
}
