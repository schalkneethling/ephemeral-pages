# Development governance

Repository tooling enforces the collaboration program's phase boundaries and security gates. These
checks complement review; they do not replace it.

## CodeQL merge protection

`.github/security-policy.json` is the canonical CodeQL and merge-protection policy. It requires the
extended CodeQL query suite and blocks default-branch updates when CodeQL reports a warning or a
security finding rated medium or higher.

Inspect drift with an authenticated `gh` session or a GitHub token that can read repository
administration settings:

```sh
node scripts/configure-github-security.mjs
```

Apply the exact versioned policy with repository-administration permission:

```sh
node scripts/configure-github-security.mjs --apply
```

The script reads the live configuration back after applying it and fails if any setting differs.
A successful CodeQL analysis job only means the scanner ran; the ruleset evaluates its findings.

## Collaboration program gate

The `Collaboration governance` workflow runs on `pull_request_target`. It checks out and executes the
base revision, never code from the pull request, and reads the proposed files through GitHub's API.

Any PR touching a path in `.github/collaboration-program.json` must:

1. Declare exactly one `Collaboration-Issue: #<number>` in its body and close only that issue.
2. Wait until every dependency declared for that issue is closed.
3. Stay within the versioned file and non-generated line limits.
4. Add `.github/collaboration-evidence/<issue>.json`.
5. Change every focused test listed by the evidence.

Behavior changes use this evidence shape:

```json
{
  "issue": 24,
  "phase": 2,
  "red": {
    "testFiles": ["collaboration-worker/test/reducer.test.ts"],
    "command": "vp test reducer",
    "expectedFailure": "unsafe paths are rejected",
    "observedFailure": "expected InvalidOperationPathError"
  },
  "green": { "commands": ["vp test reducer"], "result": "passed" },
  "refactor": {
    "status": "completed",
    "notes": "centralized path validation",
    "validation": "vp test reducer passed"
  }
}
```

Behavior-neutral issues replace `red` with non-empty `baseline.command` and `baseline.result` fields.
The gate deliberately uses the manifest from the target branch, so a feature PR cannot weaken its
own limits, dependency graph, or evidence requirements.

PR #33 is the sole versioned exception because its implementation predates the gate. This exception
applies only to phase/evidence enforcement; CodeQL merge protection remains mandatory. Adding or
changing an exception requires a separate governance change against the trusted base branch.

Run the same audit locally against an existing PR:

```sh
node scripts/ci/check-collaboration-pr.mjs --pr 33
```
