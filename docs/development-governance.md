# Development governance

Repository tooling checks code quality and security configuration. These checks complement review;
they do not replace it. Implementation sequencing belongs in issues or a project board.

## Continuous integration

The CI workflow checks formatting, lint, types, tests, and the production build on pull requests and
pushes to main. Workflow actions are pinned to full commit SHAs, and checkout steps do not retain
credentials. PR authors should explain the change, its purpose, and how it was tested.

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
