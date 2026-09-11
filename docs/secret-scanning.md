# Secret scanning

CI runs Gitleaks over every reachable Git ref and over the current tracked and
untracked, non-ignored files. The second scan uses `git ls-files -co
--exclude-standard`, so local ignored `.env` files and private tool state are
never copied into the scan. A fixed report template emits only rule, path,
line, commit, and fingerprint metadata. Raw findings and SARIF are not
persisted or uploaded.

The gate pins Gitleaks 8.30.0. Version 8.30.1 is intentionally excluded because
[the upstream project has a closed report](https://github.com/gitleaks/gitleaks/issues/2170) that its release binary can return a
successful result while missing canonical credentials. The wrapper checks the
exact version and runs a synthetic detection and redaction canary before each
scan.

For a local scan, download the `gitleaks_8.30.0` archive for your platform from
the [official release](https://github.com/gitleaks/gitleaks/releases/tag/v8.30.0)
and verify the checksum from the release's
`gitleaks_8.30.0_checksums.txt` asset. Then run:

```sh
GITLEAKS_BIN=/absolute/path/to/gitleaks node scripts/ci/gitleaks.mjs
```

With the pinned binary on `PATH`, use `bun run security:secrets`. The command scans
history and pending files; inline `gitleaks:allow` comments do not bypass it.

Gitleaks detects recognizable credential patterns, including the staging collaboration
secret assignments. It cannot establish that arbitrary page contents, personal data, or every
capability URL are safe to publish. The release evidence restrictions and sanitized runtime
reports still apply.

The repository has one exact fingerprint exception for a demonstrably
synthetic historical unit-test fixture. Do not add file, directory, rule, or
regular-expression allowlists. Investigate a new finding without copying its
matched content into an issue or CI log, revoke any real credential, remove it
from the current tree, and decide separately whether history must be rewritten.
