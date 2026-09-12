# Production cutover checkpoint — 12 September 2026 UTC

The [staging rehearsal](https://github.com/schalkneethling/ephemeral-pages/actions/runs/34682366013)
passed for candidate `a47ba7c32057b301a340a9f5688ae8bb27917674`. Its archive digest,
source tree, stages and observed pair were verified in [staging-verification.json](staging-verification.json).
Promotion PR #60 preserved that tree in main commit `5ae34ea8773790e7a855b86d387b6e63a7e2a5a1`.

[Netlify publication was locked](netlify-publication-lock.md) through the authenticated dashboard.
The subsequent Git-triggered build completed without replacing the published deployment.
This is UI-observed evidence, not an API lock checkpoint.

[Production adoption run 34683011398](https://github.com/schalkneethling/ephemeral-pages/actions/runs/34683011398)
failed during preflight. GitHub reports the adoption, promotion and recovery mutation steps as skipped;
no release artifact was produced and neither provider was updated by that run.

Read-only diagnosis reproduced a promotion-response schema failure with the runner's pinned
GitHub REST API version `2026-03-10`: its PR response omits `merge_commit_sha`.
The same request with version `2022-11-28` returns the verified merge commit.
GitHub documents the [field removal](https://docs.github.com/en/rest/about-the-rest-api/breaking-changes)
and [at least 24 months of support for the previous version](https://docs.github.com/en/rest/about-the-rest-api/api-versions).
The release client must use the supported version matching its schema; promotion integrity checks remain required.
A changed candidate requires fresh staging rehearsal before another production attempt.

The production baseline and ordinary coordinated release remain outstanding. No historical Worker
rollback guarantee is inferred from this checkpoint; the accepted adoption policy remains fail-forward.
