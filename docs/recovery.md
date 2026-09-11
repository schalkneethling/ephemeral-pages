# Release recovery and cutover

Status: recovery implementation is under validation and review. Production remains disabled in
`production-policy.json`. No production publishing setting has changed. The historical staging
rehearsal is not evidence that this recovery implementation has passed a live drill.

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

## Initial production baseline adoption

The initial Worker launch has no retained artifact proving its source. Ordinary release approval
requires a known production baseline, while ordinary recovery requires a retained successful release.
Those checks deliberately do not infer the missing Worker provenance from the Netlify commit.

A separate, reviewed, one-time adoption operation is proposed; it is not implemented or authorized
for execution by this document. After a protected staging recovery drill passes, it would:

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
An operator must approve that boundary and a concrete manual/forward-recovery plan before execution.
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
installed after verifying their branch restrictions. This confirms credential provisioning, not
provider authorization. A subsequent read-only check confirmed staging's required
`GITHUB_OIDC_AUDIENCE` is still absent. An earlier update returned HTTP 403, and the retry with the new
token timed out during 1Password authorization before reaching Netlify. Setting it to the staging
origin remains a provisioning prerequisite.

## Cutover gates

Complete these gates in order and retain dated sanitized evidence:

1. Finish recovery review and automated checks. Install and verify environment credentials and the
   staging OIDC audience. Establish attributable production source and retained recovery artifacts.
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
