# Production orchestration

Status: production orchestration and resumption are implemented and under PR review.
Live workflow verification remains a rollout gate. The production policy remains disabled.
The staging rehearsal from 10 September is historical calibration, not approval for this increment.
No production publishing setting has changed.

The implementation references for this checkpoint are the [production CLI](../scripts/release/production-cli.ts),
[GitHub release verifier](../scripts/release/github-release.ts), [production context](../scripts/release/production-context.ts),
[provider adapters](../scripts/release/production-providers.ts), and [production runner](../scripts/release/production-runner.ts).
The entry points are [Production release](../.github/workflows/release-production.yml) and
[Staging release rehearsal](../.github/workflows/release-rehearsal.yml). Both are manual workflows;
production and recovery share the `release-production` concurrency group with active runs
never cancelled by a later dispatch.

## Trust and approval

The production entry point is a manually dispatched workflow running the protected `main` commit.
The runner verifies the GitHub run, workflow path, first attempt, protected branch, merged `stage` to
`main` promotion PR, equal candidate and promotion trees, and successful CI for the exact promotion
commit. Ordinary pull-request code does not receive deployment credentials.

Before adding workflow credentials, restrict the GitHub `production` environment to deployments
from `main` and the `staging` environment to deployments from `stage`. Store separate
`NETLIFY_AUTH_TOKEN` and `CLOUDFLARE_API_TOKEN` values in those environments. Do not use repository-wide
deployment secrets: a workflow edited on another branch must not be able to retrieve them. Job-level
ref checks provide an additional guard; native environment restrictions establish the credential
boundary. These restrictions and deployment secret names have been provisioned. Provider authorization,
deployment authorization and live workflow verification remain rollout gates. Staging OIDC configuration
has been provisioned and passed read-only verification.

Set Netlify `GITHUB_OIDC_AUDIENCE` to the exact site origin in each environment, with function scope.
The workflow smoke uses GitHub OIDC for upload identity; the checked-in environment configuration
verifies this value before attempting uploads. `id-token: write` serves that smoke authentication.
This uses the existing public [repository upload identity](api.md#github-actions-oidc), which supports
other GitHub repositories at the documented quota. It does not authorize deployments; the release
runner separately pins its repository, workflow, branch and approved source.

A successful protected `stage` rehearsal produces the `release-rehearsal` artifact. Its canonical
`approval.json` names the candidate and tree, checked-in configuration fingerprint, per-service
production baseline, affected services, migration policy and recovery order. It hashes the associated
preparation and rehearsal records. The operator supplies that approval file's SHA-256 when promoting.
Approval stays outside the candidate's source tree, avoiding a self-referential commit/hash.

The producer requires a reviewed `docs/release-evidence/production-baseline.json` with the actual
source commit and provider identity for each live service. That known-source bootstrap record has
not yet been established. Do not infer both services' source from `main`, or substitute the 9/10
historical launch evidence that lacks the required source attribution. An unavailable baseline blocks
approval generation.

Both production phases check GitHub provenance and approval again. GitHub artifact downloads must
match the API's size and SHA-256, remain unexpired, and pass bounded ZIP extraction. Missing evidence,
changed candidates, incorrect origins or configuration, and uncertain source attribution block the
operation. Rehearsal evidence is accepted for at most seven days, as configured in the checked-in
production policy. A successful local rehearsal alone is not a trusted workflow approval artifact.

## Preparation and execution

The parser is defined in `scripts/release/production-args.ts`. Its operations are `promote` and
`resume`; both require a promotion PR number, rehearsal run ID, approval SHA-256 and external
workspace. Resume additionally requires the latest interrupted production run ID. The CLI has
separate `preflight` and `execute` phases. These are workflow interfaces, not a local production
publishing shortcut.

Preflight builds production-specific artifacts without provider credentials. On resume it retrieves
the prior sealed bundles instead of rebuilding. Execute accepts the retained workspace, checks its
run identity and preparation digest, validates the artifacts and live configuration, and only then
creates the production provider adapters. Targets come from checked-in configuration; there is no
site, Worker, source, configuration or policy override on the command line.

For a compatible combined release, the runner holds the Netlify candidate, uploads and activates the
Worker, verifies old-app/new-Worker behavior, reinspects the pair, publishes the held Netlify ID and
verifies the final pair. Unchanged services retain their IDs. Documentation-only releases make no
provider deployment. The ordinary path accepts only the existing `v1` Durable Object lifecycle with
no migration change.

Netlify production must already use controlled publication. The production adapter requires its
current published deployment to be locked; it does not silently change publishing settings to make
a release pass. A publication that cannot retain the required protection blocks completion. The
cutover and restore drills must establish the supported provider behavior before enabling this path.

## Interrupted execution

`run/production.json` records stage outcomes, returned provider IDs, the prior pair, observed pair,
artifact bindings and original/current run lineage. Checkpoints precede writes, and returned IDs are
persisted before subsequent inspection. Provider error payloads and credentials are excluded.

A new manual resume dispatch retrieves the previous workflow artifact, retains its sealed bundles
and state, and re-verifies previously completed provider artifacts. Incomplete writes are reconciled
by exact retained IDs or a unique release marker. Missing, multiple or unverifiable matches block;
the runner does not repeat a possibly completed upload or activation. Re-running the same GitHub
workflow attempt is rejected. A fresh release cannot bypass an unresolved activation. GitHub job evidence may prove that an earlier
failed attempt skipped activation entirely. Such attempts are ignored when finding the latest
potentially mutating run; they cannot hide an older partial release. Missing or ambiguous job evidence
still blocks. A transient execute-phase remote verification failure is retained as a failed inspection
stage before provider adapters are initialized.

Production verification failure reports the observed pair and stops. It does not automatically
roll back. Recovery is a separate operator action implemented in the same serialized workflow; a historical target ID
alone does not establish that restoration is possible or compatible with current storage/secrets.

## Remaining rollout gates

See [recovery and cutover](recovery.md) for implementation details and the current setup checkpoint.
Finish PR review, then rehearse the integrated candidate and
prove Layer 6 recovery drills on staging. Establish the attributable production baseline and verify
provider authorization using the provisioned environment credentials. Verify Netlify controlled publishing and restoration, disable its independent
automatic production publication, and confirm that Git-triggered builds cannot publish. Keep
independent Cloudflare Git deployment disabled. Only then enable the reviewed production policy and
perform the first coordinated production release.

Dispatch `Staging release rehearsal` from `stage` in `approval` mode. Its successful `release-rehearsal` artifact contains
only the approval bundle; `release-rehearsal-diagnostics` retains prepared artifacts and reports even
on failure. Dispatch `Production release` from `main` with `operation`, `promotion_pr`,
`rehearsal_run_id`, `approval_sha256`, and `resume_run_id` only when resuming. Keep the workflow job
name `Production release` and activation step name `Activate approved release` aligned with the
GitHub verifier: they participate in the proof that a failed attempt never activated a release.

Retain intermediate sanitized records and bundles as workflow artifacts for seven days. After successful production
verification, commit a sanitized completion record through a documentation follow-up PR and move
only verified shipped changelog entries out of `Unreleased`. Artifact expiration blocks later
resumption; repository completion records do not preserve provider rollback targets indefinitely.

Recovery uses the same workflow with `operation` set to `recover`, `recovery_source_run_id`, and an
optional `resume_recovery_run_id`. Leave promotion inputs empty. Its credentialed mutation step is
**Restore verified prior pair**; see [the recovery guide](recovery.md) for evidence and resume rules.

Before the initial production baseline exists, use rehearsal `calibration` mode and the separate
**Staging recovery** workflow to prove restoration with retained A/B staging evidence. Calibration
does not issue a production approval. See [the staging drill procedure](recovery.md#protected-staging-calibration-and-recovery).
