# Production orchestration

Current rollout checkpoint: the first ordinary release stopped after Worker activation and transition verification, before Netlify publication. Resume exposed a reproduced artifact-permission defect. See the [production resume investigation](release-evidence/2026-09-12-production-resume-investigation/README.md) for verified results and the repair boundary. Earlier status below describes the preceding implementation checkpoint.

Status: production orchestration and resumption are implemented. Protected staging calibration,
recovery, interrupted recovery, and forward deployment passed the
[recorded exercise](release-evidence/2026-09-11-staging-recovery-34652303609/README.md).
Production Worker adoption and the publication lock are verified; the production baseline and
recovery target are recorded. Adoption is disabled and ordinary releases are enabled in policy.
The first coordinated application release still requires a successful approval rehearsal.

Approval rehearsals [34688990620](https://github.com/schalkneethling/ephemeral-pages/actions/runs/34688990620)
and [34691105495](https://github.com/schalkneethling/ephemeral-pages/actions/runs/34691105495)
completed both staging writes but failed during the Netlify readback. Subsequent independent readback
and all six collaboration smoke checks passed against the recorded final pair. Reviewed resolutions
can clear interrupted history for a fresh rehearsal; they do not supply production approval.
The repeated failure requires bounded post-publication observation and retained diagnostic causes;
see the [readback investigation](release-evidence/2026-09-12-staging-readback-34691105495/README.md).

Production inspection failures retain an optional structured diagnostic in `run/production.json`,
including the provider, read operation, and assertion or command failure. Original causes remain
available in memory; arbitrary upstream messages and payloads are not serialized. This diagnostic
change does not add production retries or change deployment sequencing.

The implementation references for this checkpoint are the [production CLI](../scripts/release/production-cli.ts),
[GitHub release verifier](../scripts/release/github-release.ts), [production context](../scripts/release/production-context.ts),
[provider adapters](../scripts/release/production-providers.ts), and [production runner](../scripts/release/production-runner.ts).
The entry points are [Production release](../.github/workflows/release-production.yml) and
[Staging release rehearsal](../.github/workflows/release-rehearsal.yml). Both are manual workflows;
production, adoption, and recovery share the `release-production` concurrency group with active runs
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
boundary. These restrictions and deployment secret names have been provisioned. Staging deployment
authorization and OIDC-backed collaboration smokes passed the protected exercise. Production execution
still requires its own verification.

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
source commit and provider identity for each live service. The verified adoption established that
record, retaining the older Netlify source and recording the newly attributable Worker source.
Do not infer both services' source from `main` or substitute historical launch evidence without
source attribution. An unavailable baseline blocks approval generation.

Both production phases check GitHub provenance and approval again. GitHub artifact downloads must
match the API's size and SHA-256, remain unexpired, and pass bounded ZIP extraction. Missing evidence,
changed candidates, incorrect origins or configuration, and uncertain source attribution block the
operation. Rehearsal evidence is accepted for at most seven days, as configured in the checked-in
production policy. A successful local rehearsal alone is not a trusted workflow approval artifact.

## First Worker adoption

Completed on 12 September 2026 UTC; see the [verified adoption evidence](release-evidence/2026-09-12-production-adoption-34688347172/README.md).
The baseline and recovery target are recorded. The adoption gate is closed and ordinary releases are enabled in policy.
The following describes the one-time procedure and its safeguards.

The one-time adoption establishes source provenance for the Worker while retaining the independently
attributed Netlify deployment. It does not turn the historical Worker into a verified rollback target.
The operator accepted fail-forward recovery for this initial operation; no legacy restore path is added.

The distinct adoption runner uses the same protected production workflow and serialization as routine
releases. Its source is an exact reviewed `stage` to `main` promotion with successful CI and a retained
successful staging calibration for that candidate. Calibration is used here because ordinary approval
requires the production baseline that adoption establishes. A separate adoption policy (now disabled after verified adoption) and
an absent baseline guard prevent it from becoming a routine alternative to release approval.

Before a Worker write, adoption verifies the sealed production artifact, current configuration,
unchanged `v1` lifecycle, required secret bindings, and locked, Git-attributed Netlify deployment.
Its provider adapter exposes only Worker mutations. It checks that the Netlify deployment remains
unchanged throughout and runs the real collaboration and screenshot smoke against the resulting pair.
No secret values are read into evidence or rotated.

The retained `run/adoption.json` is distinct from `run/production.json`. A successful record proposes
a baseline; it does not automatically write one into the repository. Review the actual source commits,
provider IDs, artifact hashes, configuration, and completed smoke before committing the baseline and
recovery target. The first recovery target explicitly identifies its Worker artifact as
`production-adoption`, so the verifier checks the successful adoption workflow step and adoption record.
It cannot substitute an ordinary release record or claim that adoption built the retained Netlify app.

An interrupted adoption must resume its exact source and retained bundle, reconciling recorded Worker
IDs before retrying. Missing or ambiguous evidence blocks. If an activated Worker needs a different
candidate to fix it, stop and prepare an explicitly reviewed forward correction; this operation does
not invent a rollback target or silently start a fresh adoption. After the baseline is reviewed, disable
adoption and use ordinary rehearsal approval, promotion, and recovery.

For the initial cutover:

1. Review the adoption implementation and enable only `adoptionEnabled` in the checked-in production
   policy. Keep `productionEnabled` false. Rehearse that exact `stage` candidate in calibration mode.
2. Verify the current production pair and lock Netlify publication. Merge the reviewed promotion PR
   only after verifying the publication lock. Then verify the subsequent Git-triggered build did not
   replace the published deployment before dispatching adoption.
3. Dispatch **Production release** on `main` with operation `adopt`, the merged `promotion_pr`, and
   the successful calibration `rehearsal_run_id`. Leave unrelated inputs empty. This is the only
   supported production execution route; the local CLI is not a publishing shortcut.
4. If interrupted, inspect the retained `release-production` artifact and dispatch the same operation
   and source with `resume_adoption_run_id` set to the latest interrupted adoption run. Never use
   GitHub's rerun button to retry a possibly completed mutation. Expired bundles block resumption.
5. After successful verification, review and commit the proposed baseline and adoption recovery target,
   disable adoption, and enable ordinary production releases through a separate reviewed change.
   Rehearse the resulting candidate in approval mode, merge its promotion PR, and dispatch the ordinary
   release with its exact approval digest. Record completion and shipped changelog entries only after
   production verification succeeds.

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
Production may retain its Git connection for preview builds; a locked published deployment is required
for every production operation. Staging remains a dedicated site without a Git connection.

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
Staging recovery, resume, and forward deployment have passed. Netlify publication is locked, and a
subsequent Git build was verified not to publish. Production Worker adoption, collaboration and
screenshot verification, baseline recording, and the production policy transition are complete.
Keep independent Cloudflare Git deployment disabled. The remaining release gate is a successful
approval rehearsal for the exact candidate, followed by its reviewed promotion and the first
coordinated production release.

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
