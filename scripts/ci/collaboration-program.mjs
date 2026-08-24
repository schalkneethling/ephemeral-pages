const EVIDENCE_PREFIX = ".github/collaboration-evidence/";
const CLOSING_REFERENCE = /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+#(\d+)\b/giu;
const ISSUE_DECLARATION = /^Collaboration-Issue:\s*#(\d+)\s*$/gimu;

export function pathMatches(pattern, filename) {
  return pattern.endsWith("/**") ? filename.startsWith(pattern.slice(0, -2)) : filename === pattern;
}

export function isCollaborationPullRequest(manifest, files) {
  return files.some(({ filename, previous_filename }) =>
    manifest.triggerPaths.some(
      (pattern) =>
        pathMatches(pattern, filename) ||
        (typeof previous_filename === "string" && pathMatches(pattern, previous_filename)),
    ),
  );
}

export function parseCollaborationIssues(body = "") {
  return [...body.matchAll(ISSUE_DECLARATION)].map((match) => Number(match[1]));
}

export function parseClosingIssues(body = "") {
  return [...body.matchAll(CLOSING_REFERENCE)].map((match) => Number(match[1]));
}

export function evidencePath(issue) {
  return `${EVIDENCE_PREFIX}${issue}.json`;
}

export function validateCollaborationPullRequest({
  manifest,
  body,
  files,
  evidence,
  dependencyStates = {},
  pullRequestNumber,
}) {
  if (!isCollaborationPullRequest(manifest, files)) return { applies: false, errors: [] };
  const exception = manifest.grandfatheredPullRequests?.[String(pullRequestNumber)];
  if (exception) return { applies: true, exception, errors: [] };

  const errors = [];
  const declared = parseCollaborationIssues(body);
  if (declared.length !== 1) {
    errors.push("Declare exactly one `Collaboration-Issue: #<number>` in the PR body.");
    return { applies: true, errors };
  }

  const issue = declared[0];
  const definition = manifest.issues[String(issue)];
  if (!definition) {
    errors.push(`Issue #${issue} is not part of collaboration epic #${manifest.epic}.`);
    return { applies: true, issue, errors };
  }

  const closing = [...new Set(parseClosingIssues(body))];
  if (closing.length !== 1 || closing[0] !== issue) {
    errors.push(`The PR must close only its declared collaboration issue (#${issue}).`);
  }

  for (const dependency of definition.dependencies) {
    if (dependencyStates[String(dependency)] !== "closed") {
      errors.push(`Dependency #${dependency} must be closed before issue #${issue} can merge.`);
    }
  }

  if (files.length > manifest.maxChangedFiles) {
    errors.push(
      `The PR changes ${files.length} files; collaboration PRs are limited to ${manifest.maxChangedFiles}.`,
    );
  }
  const changedLines = files
    .filter(
      ({ filename }) => !manifest.generatedPaths.some((pattern) => pathMatches(pattern, filename)),
    )
    .reduce((total, file) => total + file.additions + file.deletions, 0);
  if (changedLines > manifest.maxChangedLines) {
    errors.push(
      `The PR changes ${changedLines} non-generated lines; the limit is ${manifest.maxChangedLines}.`,
    );
  }

  const expectedEvidencePath = evidencePath(issue);
  if (!files.some(({ filename }) => filename === expectedEvidencePath)) {
    errors.push(`Add or update ${expectedEvidencePath} in this PR.`);
  }
  errors.push(...validateEvidence(evidence, definition, issue, files));

  return { applies: true, issue, errors };
}

function validateEvidence(evidence, definition, issue, files) {
  if (!evidence || typeof evidence !== "object" || Array.isArray(evidence)) {
    return ["The collaboration evidence file is missing or invalid JSON."];
  }

  const errors = [];
  if (evidence.issue !== issue) errors.push(`Evidence must identify issue #${issue}.`);
  if (evidence.phase !== definition.phase) {
    errors.push(`Evidence phase must be ${definition.phase} for issue #${issue}.`);
  }

  if (definition.behaviorNeutral) {
    requireText(errors, evidence.baseline?.command, "baseline.command");
    requireText(errors, evidence.baseline?.result, "baseline.result");
  } else {
    requireText(errors, evidence.red?.command, "red.command");
    requireText(errors, evidence.red?.expectedFailure, "red.expectedFailure");
    requireText(errors, evidence.red?.observedFailure, "red.observedFailure");
    const testFiles = evidence.red?.testFiles;
    if (!Array.isArray(testFiles) || testFiles.length === 0) {
      errors.push("Evidence red.testFiles must list at least one focused test file.");
    } else {
      for (const testFile of testFiles) {
        if (typeof testFile !== "string" || !isTestFile(testFile)) {
          errors.push(`Red evidence path is not a recognized test file: ${String(testFile)}.`);
        } else if (!files.some(({ filename }) => filename === testFile)) {
          errors.push(`Focused red test file must change in this PR: ${testFile}.`);
        }
      }
    }
  }

  if (!Array.isArray(evidence.green?.commands) || evidence.green.commands.length === 0) {
    errors.push("Evidence green.commands must contain at least one validation command.");
  } else {
    for (const command of evidence.green.commands) requireText(errors, command, "green.commands[]");
  }
  requireText(errors, evidence.green?.result, "green.result");

  if (!new Set(["completed", "not-needed"]).has(evidence.refactor?.status)) {
    errors.push('Evidence refactor.status must be "completed" or "not-needed".');
  }
  requireText(errors, evidence.refactor?.notes, "refactor.notes");
  requireText(errors, evidence.refactor?.validation, "refactor.validation");
  return errors;
}

function isTestFile(filename) {
  return /(?:^|\/)(?:tests?\/|[^/]+\.(?:test|spec)\.[cm]?[jt]sx?$)/u.test(filename);
}

function requireText(errors, value, path) {
  if (typeof value !== "string" || value.trim().length === 0) {
    errors.push(`Evidence ${path} must be a non-empty string.`);
  }
}
