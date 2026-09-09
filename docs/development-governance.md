# Development governance

Repository tooling enforces the collaboration program's phase boundaries and security gates. These
checks complement review; they do not replace it.

## CodeQL merge protection

`.github/security-policy.json` is the canonical CodeQL and merge-protection policy. It requires the
extended CodeQL query suite and blocks default-branch updates when CodeQL reports a warning or a
security finding rated medium or higher.

Inspect drift with an authenticated `gh` session or a GitHub token with write access to the
ruleset. GitHub omits bypass actors without that access, so the audit cannot establish protection:

```sh
node scripts/configure-github-security.mjs
```

Apply the exact versioned policy with repository-administration permission:

```sh
node scripts/configure-github-security.mjs --apply
```

The script reads the live configuration back after applying it and fails if the checked settings
differ. It verifies CodeQL settings and thresholds, active branch enforcement, explicit default-branch
coverage, and an empty bypass list. Branch coverage accepts `~DEFAULT_BRANCH`, `~ALL`, or the exact
current default-branch ref, and requires no exclusions. Other glob patterns are reported as unverified,
even if they might cover the default branch. Additional CodeQL languages are allowed.

Apply mode refuses to write if those ruleset protection prerequisites fail. Correct those settings
separately: they affect every rule in the ruleset. The script updates only CodeQL configuration and its
scanner requirement, preserving other scanners and rules. The named repository ruleset must already
exist. Each request has a 30-second timeout; configuration polling makes at most 24 reads with five
seconds between attempts. API errors fail immediately; a failed apply can leave partial changes,
so inspect drift and rerun after correcting the cause.

This audit is manually invoked. It does not audit other repository controls or guarantee that all
possible updates are secure. A successful CodeQL analysis job only means the scanner ran; the ruleset
evaluates its findings.

### Reuse in Project Calavera

`scripts/configure-github-security.mjs` is the repository-specific CLI adapter. It imports the policy
using JSON import attributes (run with Node.js 24), discovers credentials, and renders results.
`GITHUB_REPOSITORY` overrides its repository default; `GITHUB_API_URL` selects the trusted API host.

The portable modules are `scripts/ci/github-security.mjs` and
`scripts/ci/github-security-policy.mjs`. Neither reads environment variables or files, discovers
credentials, prints output, or exits the process. The first exports `createGitHubSecurityClient`,
which accepts repository, token, API URL, and an optional fetch implementation, and
`configureGitHubSecurity`, which accepts policy, client, apply mode, and an optional sleep function.
The second contains the pure comparison and ruleset-update functions.

Calavera can supply its own policy object, credential discovery, and CLI around these modules.
The configuration function returns drift messages and throws on API or prerequisite failures.
Its tests use an injected client and sleep function, so they do not modify GitHub or wait for polling.

## Collaboration program gate

The `Collaboration governance` workflow runs on `pull_request_target`. It checks out and executes the
base revision, never code from the pull request, and reads the proposed files through GitHub's API.
All third-party workflow actions are pinned to verified full commit SHAs.

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
