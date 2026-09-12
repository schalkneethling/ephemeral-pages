# Release recovery and cutover

Status: protected staging calibrations A/B and explicit B-to-A recovery passed. The recovery
resumed from its retained checkpoint, preserved the completed Netlify restore, and passed both
transition and final-pair browser smokes. A subsequent forward calibration passed and left staging
on the latest exercised candidate. See [the verified checkpoint](release-evidence/2026-09-11-staging-recovery-34652303609/README.md).
Ordinary production releases remain disabled in `production-policy.json`; the separate one-time
adoption gate is enabled for the initial cutover candidate. Production publishing cutover, the
attributable initial baseline, and the first coordinated production release remain outstanding.

## Recovery operation

The manually dispatched **Production release** workflow accepts `recover` separately from
`promote` and `resume`. It runs protected `main` code in the `production` environment and shares the
same `release-production` concurrency group. Only **Restore verified prior pair** receives provider
credentials for recovery; it cannot run alongside **Activate approved release** in the same job.

For a fresh recovery, supply `recovery_source_run_id`, identifying the latest potentially mutating
production release. For an interrupted recovery, supply that original source ID and
`resume_recovery_run_id`, identifying the latest interrupted recovery. Leave promotion-specific
inputs empty. The parser rejects overlapping inputs and invalid lineage. See the
[workflow](../.github/workflows/release-production.yml) and
[parser](../scripts/release/recovery-args.ts) for the executable interface.

Preflight verifies the protected workflow, native environment restriction and selected run history.
Fresh recovery requires unexpired source and target GitHub artifacts with matching sizes and digests.
Resume requires the latest unexpired recovery artifact, containing the previously sealed source and
target bundles; their original artifacts need not remain available. It retains the source release and
recovery target bundles outside the checkout. Execution repeats provenance checks and persists its
initial state before creating provider clients. It reconciles uncertain source writes read-only.
Missing or ambiguous evidence blocks recovery.

A reviewed `docs/release-evidence/recovery-target.json` must identify the exact prior pair and its
source/artifact evidence. The [schema](../scripts/release/recovery-target.ts) requires the configuration
fingerprint, Netlify and Worker source commits, a successful production artifact run for the target
Worker, the Worker artifact digest and script ETag. API-created Netlify deployments require their
release artifact digest when no provider source commit is available. The retained artifact must
substantiate that digest. The current ordinary path requires the two target artifacts to be
substantiated by that same successful run when this Netlify digest is used; other histories block.

This file has deliberately not been populated from the initial production launch log. That log has
no retained runner artifact proving the original Worker source, bundle digest and deployment marker.
A verified baseline adoption procedure is required before the first coordinated release; an old
version ID or a manually invented digest does not satisfy this prerequisite.

## Protected staging calibration and recovery

The **Staging release rehearsal** workflow accepts `mode` values `approval` and `calibration`.
Calibration prepares and rehearses an exact protected `stage` commit and retains
`release-rehearsal-diagnostics`; it never creates a production approval or requires a fabricated
production baseline. The normal approval mode retains its production-baseline requirements.
See [the rehearsal workflow](../.github/workflows/release-rehearsal.yml) and
[its parser](../scripts/release/rehearsal-workflow-cli.ts).

To exercise real restoration, obtain two successful protected staging calibrations, A then B, from
distinct reviewed commits with the same deployment configuration. B's recorded prior pair must be
A's observed pair, and both services must have distinct deployment/version IDs. Retain both runs'
complete diagnostics artifacts, including prepared bundles and provider checkpoints.

Dispatch **Staging recovery** from `stage` with `source_rehearsal_run_id` set to B and
`target_rehearsal_run_id` set to A. For an interrupted recovery, retain those IDs and add
`resume_recovery_run_id` for the latest interrupted recovery. The workflow shares the
`release-rehearsal` concurrency group with calibration. Its preflight verifies protected runs and
artifact digests without provider tokens; execution repeats those checks and records its state before
provider operations. Staging source and record schemas are separate from production records, and
production targets are explicitly rejected.

The runner restores Netlify, verifies the transition, restores the Worker, then verifies the final
pair using real collaboration and screenshot smoke. It retains `release-staging-recovery` evidence
for seven days. Resume reuses sealed A/B evidence in that retained artifact and reconciles uncertain
writes before retrying. After the drill, use the normal forward rehearsal path to establish the
intended final staging candidate and retain its newly observed IDs.

These operations are implemented and locally tested. The registration-only bootstrap was merged
through reviewed CI-only PR #50; the full implementations are now merged into protected `stage`.
[Protected calibrations A and B](release-evidence/2026-09-11-staging/README.md) passed.
The [protected recovery and resume drill](release-evidence/2026-09-11-staging-recovery-34652303609/README.md) also passed.
It verified the retained Netlify restore, portable inspection evidence, restored Worker version,
and both live browser smokes. Production recovery remains unverified.
See [the staging recovery workflow](../.github/workflows/release-staging-recovery.yml),
[CLI](../scripts/release/staging-recovery-cli.ts),
[source contract](../scripts/release/staging-recovery-source.ts), and
[runner](../scripts/release/staging-recovery-runner.ts).

## Initial production baseline adoption

The initial Worker launch has no retained artifact proving its source. Ordinary release approval
requires a known production baseline, while ordinary recovery requires a retained successful release.
Those checks deliberately do not infer the missing Worker provenance from the Netlify commit.

A read-only comparison on 11 September found that the active Worker module matches a retained
local artifact whose manifest names `eaec58c43192e7d78859da87799a2b683a6ddf5b`. The active deployment,
version and script ETag remained stable before and after retrieval. This establishes a byte match
with that artifact, but does not independently verify its declared source. Two clean builds through the historical preparation pipeline produced identical output to each
other, but different bytes from the live module. Source attribution therefore remains unverified. The ordinary recovery path still requires its normal
tag and trusted release artifact, so this comparison cannot populate `recovery-target.json` or
authorize production cutover.

The operator accepted a one-time fail-forward adoption on 11 September, given the current product
usage and the cost of a temporary legacy restore subsystem. No legacy restore path will be built.
The separate adoption operation is described in [production orchestration](production-orchestration.md#first-worker-adoption).
Its live verification remains outstanding; the accepted failure policy does not bypass staging,
artifact, configuration, or source checks. The protected staging
recovery drill has passed. The adoption operation must:

1. Require an absent baseline and an exact reviewed production candidate with retained staging evidence.
2. Verify and seal its production Worker artifact, current configuration, `v1` migration compatibility,
   current provider pair, and Netlify publication lock.
3. Preserve the attributable Netlify deployment when compatible, activate a new tagged Worker version,
   and run the real collaboration and screenshot smoke against the observed pair.
4. Retain a distinct adoption record and artifact bundle, including source, configuration, hashes,
   returned provider IDs and per-stage checkpoints. Review that evidence before adopting the new pair
   as the baseline. Ordinary recovery must explicitly validate adoption evidence before accepting it.

This establishes new provenance; it does not make the historical Worker a verified rollback target.
The first activation is therefore a forward-only bootstrap if it fails after changing the Worker.
The accepted boundary permits diagnosing and deploying a correction if this first activation fails.
Keep the adoption limited to the Worker, preserve Netlify, and introduce no storage migration or
secret rotation. Record the exact candidate and forward-recovery procedure before execution.
Interrupted adoption must reconcile its recorded IDs and must never silently emit a successful baseline.
A separate adoption record avoids representing this exceptional operation as an ordinary production
release whose normal prerequisites passed.

## Restore order and interruption

The runner verifies target availability and configuration before writes, restores Netlify first,
verifies the old-app/current-Worker transition, restores the Worker, then runs the collaboration
smoke and inspects the final pair. The same adapters support the isolated staging targets for drills.
An already-restored service is retained without another mutation.

Each mutation is recorded before dispatch. Returned IDs are recorded before readback. Interrupted
writes are reconciled using exact IDs or the bound recovery marker, never blindly repeated. The
recovery record retains the original target evidence, lineage and sanitized stage outcomes. Resume
rejects reordered stages, changed plans, missing results and already-completed recoveries.

Inspection fingerprints bind semantic targets, configuration and artifact hashes, excluding local
checkout and extraction paths. New evidence records inspection version 2. For the existing staging
checkpoint only, legacy evidence can be rebound after exact semantic comparison and fresh read-only
inspection of the current mixed pair and retained targets. This is allowed only before any Worker
restore checkpoint or result exists, and the replacement evidence is persisted before further
mutation. Legacy production evidence and ambiguous legacy Worker writes remain blocked. The original
archived record is retained for audit.

Worker rollback creates a new deployment ID while restoring the target version. Completion records
must retain that new ID; subsequent baselines must use the actually recovered pair. A successful
recovery clears the workflow history guard only after its retained completion evidence is verified.
Missing or expired completion artifacts block that automatic clearance.

Netlify restores the selected deployment and its functions. Current environment-variable metadata
is not proof of the historical function environment. The staging drill must test real ticket and
screenshot operations after restoration. A restore that does not retain publication locking fails
verification. [Netlify function environment behavior](https://docs.netlify.com/build/functions/environment-variables/)

Worker rollback does not rewind Durable Object data or lifecycle migrations. The ordinary path
accepts only the existing `v1` lifecycle and retained runtime/binding policy. Secret values are
not observable through metadata; evidence explicitly says so. The adapter omits `force`, preserving
Cloudflare's refusal when changed secrets make a rollback unsafe. Storage-incompatible changes
need an explicit forward-recovery plan. [Cloudflare deployment API](https://developers.cloudflare.com/api/resources/workers/subresources/scripts/subresources/deployments/methods/create/)

## Credentials and verified setup checkpoint

On 11 September 2026, the repository's GitHub environments were created and read back with exactly
these deployment branch policies:

| Environment  | Allowed branch | Allowed tags |
| ------------ | -------------- | ------------ |
| `staging`    | `stage`        | None         |
| `production` | `main`         | None         |

The workflow verifier checks those native restrictions. The four provider tokens are stored in the
same 1Password `dev / ephemeral-pages` item and referenced by
[the local deployment schema](../scripts/release/local/deployment/.env.schema):

- `STAGE_NETLIFY_AUTH_TOKEN`
- `STAGE_CLOUDFLARE_API_TOKEN`
- `PRODUCTION_NETLIFY_AUTH_TOKEN`
- `PRODUCTION_CLOUDFLARE_API_TOKEN`

Each GitHub environment receives its corresponding values as `NETLIFY_AUTH_TOKEN` and
`CLOUDFLARE_API_TOKEN`. Never add these deployment tokens to Worker runtime secrets or repository-wide
GitHub secrets. Varlock resolves values locally without caching; send values to credential tools
through standard input, never command arguments or evidence files.

Separate tokens support independent rotation and revocation. They do not establish per-site or
per-Worker authorization: the configured Cloudflare Workers Scripts permission covers its account,
and Netlify personal access tokens inherit their user's access. Checked targets and protected
workflow code provide additional controls, not narrower provider token permissions.

At this checkpoint, all four provider references resolved successfully through Varlock without
exposing their values. Both GitHub environments contain the corresponding deployment secret names,
installed after verifying their branch restrictions. Staging `GITHUB_OIDC_AUDIENCE` was subsequently
created with the exact staging origin and read back successfully. The Free-plan request uses all
scopes, matching the installed Netlify CLI default; a selected-scope request was rejected with HTTP 403. The release check requires the Functions scope to be included and accepts this all-scopes value.

Read-only staging and production inspection with the new deployment tokens passed both platforms' non-secret
configuration, required secret-name and scope checks. This proves read access and configuration
presence, not successful deployment or cross-platform secret equality. Protected staging calibration
and recovery subsequently passed their real ticket and screenshot smokes. Production verification
remains required before declaring the cutover complete.

## Cutover gates

Complete these gates in order and retain dated sanitized evidence:

1. Finish recovery review and automated checks. Verify deployment authorization using the provisioned
   credentials and staging OIDC configuration. Establish attributable production source and retained recovery artifacts.
2. Rehearse the integrated candidate on staging. Exercise a partial deployment, explicit restoration,
   interrupted restoration, Netlify function configuration after restore, Worker secret/migration
   limits, missing provider targets, and final collaboration/screenshot verification.
3. Verify that locked Netlify publication still permits explicit promotion. Disable automatic
   production publication only after the replacement path and recovery have passed staging.
4. Prove a subsequent Git-triggered build cannot change the published production ID, while an explicit
   authorized promotion can. Keep independent Cloudflare Git deployment disabled.
5. Enable production policy through review, merge the promotion PR, dispatch the exact approved
   release, and retain a sanitized completion record. Move only verified shipped changelog entries
   out of `Unreleased`.

Until these gates pass, the release process is not cut over. Deployment IDs and evidence artifacts
can expire; inspect availability before every recovery instead of assuming historical retention.
