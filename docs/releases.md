# Repeatable releases

Status: proposed release contract. The coordinated release automation described below is not yet
implemented. Existing CI and the production API smoke workflow provide part of the validation.

This design applies the principles in
[The release process is part of the product](https://schalkneethling.com/posts/the-release-process-is-part-of-the-product/)
to the Netlify application and Cloudflare collaboration Worker.

## Independent of any work set

The release process must work for future changes without being rewritten for each feature, branch,
pull request, or milestone. A candidate commit, target environment, affected deployment surfaces,
and compatibility requirements are release inputs, not hard-coded assumptions in the runner.
Environment configuration supplies origins and provider identifiers; individual release records
hold deployment IDs, test results, and recovery targets. Historical rollout logs are evidence, not
configuration or prerequisites for the next release.

Keep the stage sequence and evidence requirements reusable. Maintain product smoke checks alongside
the capabilities they verify, and select applicable checks through explicit, versioned release
policy. Record why any check or deployment is not applicable; do not silently skip it based on a PR
label or branch name. New capabilities extend that policy without introducing a separate release
process.

An application-only, Worker-only, documentation-only, or combined change must all produce a valid
plan. Unchanged services retain their observed deployment IDs and still participate in compatibility
verification; a documentation-only release may require no service deployment. The recorded pair
must describe what is actually running, even when the two services originate from different commits.

## Integration and promotion branches

Use a persistent `stage` branch for the next coordinated release. Implementation PRs labeled
`need-release-process` target `stage`, never `main` directly. Intermediate PRs in a stack may target
their dependency branches; the final integration PR targets `stage`. Assess the combined stack's
scope when labeling its parent. See [PR guidance](../PR.md).

Only integrate work intended to ship together in the next release. Rehearse an exact commit on
`stage`, not its moving branch tip, and open a labeled promotion PR from `stage` to `main` with the
release evidence, included scope, deployment order, and recovery plan. That promotion PR is the
explicit exception to the labeled-PR target rule. Changes to the candidate commit or build invalidate
the existing approval and require fresh validation and rehearsal.

Before final rehearsal, integrate any intervening `main` changes into `stage`. If `main` changes
again before promotion, refresh the candidate and its evidence. Record both the rehearsed commit
and the resulting `main` commit: a merge may create a different commit identity. Before deploying,
verify the resulting commit's source tree matches the approved candidate and run the required
checks against that exact commit. A source-tree mismatch requires a new rehearsal and approval.
Build production artifacts from the verified promotion commit with explicit production configuration.
After promotion, synchronize `stage` with `main` before integrating the next release's work.

CI must enforce this routing, including allowed stack dependencies and the promotion exception;
the label alone is not enforcement. The branch and checks are implementation requirements, not
automation already established by this document. Branch routing also does not coordinate providers:
replace automatic production publishing on merge with the controlled release workflow before
treating promotion as separate from deployment.

## Bootstrap once, verify on every release

Account setup, deployment credentials, exact origins, initial secrets, and the first Durable Object
migration are environment provisioning. Routine releases should verify that configuration remains
correct; they should not recreate secrets or ask the operator to repeat setup.

Secret rotation, migration changes, and enabling a new feature are explicit operations with their
own compatibility and recovery plans. Ordinary compatible releases leave collaboration enabled.
Disabling the gate on every release would interrupt ticket renewal and new collaboration sessions.

## Release identity and evidence

Each release identifies one immutable candidate Git commit and the resulting Netlify deployment and
Worker version, including retained deployments for unchanged services. A source commit alone is
insufficient: deployed configuration also affects behavior, including generated CSP.

The release record must contain:

- Full rehearsed candidate and promotion commits, source-tree verification, validation run,
  runtime/tool versions, and both lockfile hashes.
- Target environment, exact application and Worker origins, audience, and intended feature-gate state.
- Build artifact hashes and the non-secret configuration used for those builds.
- Netlify deploy ID and Cloudflare Worker version ID, plus the previous verified pair.
- Storage migration history and the compatibility conditions for deployment and rollback.
- Per-stage status, timestamps, smoke-test results, and actionable failure details.

Never store secrets, editor links, tickets, page contents, or raw browser traces in release evidence.
Secret names or provider metadata establish presence, not equality; a successful ticket connection
and authorized screenshot exercise the cross-platform secret relationships.

## Changelog

Maintain a root [CHANGELOG.md](../CHANGELOG.md) without adding Changesets or another dependency.
Keep an `Unreleased` section for concise, user-facing descriptions of new capabilities, fixes, and
breaking changes. Describe the observable effect and any required user action. Internal refactoring
or documentation maintenance needs no entry unless it changes something users need to know.

Contributing PRs add relevant entries to `Unreleased`. The promotion PR reviews and consolidates
the entries for its exact release scope. Entries remain unreleased until production verification
succeeds; a merge, failed deployment, or partial rollout is not evidence that they shipped.

After successful verification, move only the shipped entries into a section identified by the
release's UTC date and a link to its release record. If multiple releases occur on the same date,
include the release record's identifier to distinguish them. Keep `Unreleased` for remaining and
future work. Record operational checks, deployment IDs, and recovery details in the release record
rather than duplicating them in the changelog.

Finalize the changelog and evidence in a documentation follow-up PR, then synchronize `stage`.
That follow-up records the already verified deployment; it does not change its recorded source
commit or require another product release. The controlled publishing workflow must support this
documentation-only path. Do not mark completion in advance to fit the promotion PR's timing.

## The release sequence

1. **Plan.** Resolve an exact candidate commit on `stage`, require a clean checkout, identify affected deployment surfaces,
   compare intended non-secret configuration with observed configuration, and capture the previous
   deployment pair. Missing access or unverifiable configuration is a blocked check, not success.
   Show the deployment order, expected effects, and recovery plan before changing either service.
2. **Validate and build.** Install both lockfiles frozen. Run the existing application, Worker, and
   browser checks. Build for the explicit target environment, inspect generated headers and function
   packaging, and retain artifacts and their hashes. A production Worker dry run must explicitly use
   the production environment; the existing unqualified dry run only covers the default configuration.
3. **Rehearse.** Deploy the candidate to an isolated staging application and Worker, with separate
   secrets and storage. Verify the deployed CSP, ordinary upload, two-editor synchronization,
   read-only viewing, reload persistence, network-loss recovery, and frozen screenshot download.
   Rehearse rollback for deployment or migration changes. Record observable results, not only exit codes.
4. **Approve promotion.** Present the exact candidate, successful rehearsal, production configuration
   differences, and rollback targets. Approval applies to that candidate; a changed commit or build
   invalidates it. Promote through the `stage`-to-`main` PR and verify the resulting commit as described
   above before deploying. Only one production release may run at a time.
5. **Deploy the compatible pair.** For a backward-compatible Worker change, deploy and verify the
   Worker first, then publish the Netlify deployment. The new Worker must support the currently live
   app during this interval, including existing browser sessions. Incompatible changes require a
   staged protocol/schema transition; deployment order alone cannot make them safe.
6. **Verify production.** Confirm the intended deployment IDs are live, check response headers, run
   bounded collaboration smoke tests, and run the existing production API smoke workflow. Live tests
   create short-lived test pages and consume upload/screenshot quota; record this cost and honor
   retry timing. A healthy Worker endpoint alone does not prove the product works.
7. **Complete.** Persist the verified deployment pair and evidence, and finalize the shipped changelog
   entries as described above. Report the live URL and any
   outstanding operator action. A partial deployment or failed smoke test is not a completed release.

Builds are environment-specific because origins affect CSP and configuration. Rehearsal and
production should use the same source and locked dependencies, but must not claim identical
artifacts when those inputs differ. Within an environment, deploy the artifact that was inspected;
do not silently rebuild from a moving branch during promotion.

## Failure and retry behavior

Persist a stage's provider operation/deployment ID as soon as it is available. Before retrying after
a timeout, query the provider to establish whether the operation completed. Skip only stages whose
recorded inputs and observed outputs still match. Never treat an inaccessible API as an absent deploy.

If the Worker succeeds and Netlify fails, report that mixed state. Keep the Worker only if its
compatibility with the old app was established; otherwise follow the recorded recovery plan.
Production smoke failures halt completion and report whether rollback is safe. Do not repeatedly
deploy or consume screenshot quota to hide a failed check.

Rollback restores a verified compatible deployment pair, not simply the previous Git commit.
Netlify deployment recovery must account for the configuration associated with that deployment.
Worker rollback must preserve required secrets and storage compatibility. Reverting code does not
undo Durable Object data or migrations; destructive schema changes need a forward-recovery plan.

The collaboration gate is an operational mitigation, not a universal rollback mechanism. Changing
it requires a Netlify redeploy and does not revoke existing sockets or restore stored state.

## Implementation boundaries

Use pinned Netlify CLI and Wrangler versions as the provider adapters. Always pass an explicit
Netlify site ID, deploy context, and Wrangler environment. Local project linking and the current
branch are conveniences, not release target selection. The runner defines release policy; vendor
CLIs perform the platform operations. Verify supported flags and response shapes against the pinned
versions before changing commands.

Use Netlify CLI for configuration inspection, builds, draft deployments, and deployment metadata;
use its API interface for operations without a dedicated command. Verify publication and restore
behavior in staging before enabling production orchestration. A CLI alias is not a branch deploy.
Skipping an application build does not establish that function packages are unchanged: inspect and
hash the complete deployment artifact, including functions and generated headers.

Keep authentication and secret provisioning separate from routine release evidence. Supply CI
credentials through protected environment secrets, never command arguments or recorded output.
Read only allowlisted non-secret settings for reports. Confirm secret presence through metadata
where available and matching behavior through smoke tests, without exporting secret values.

Use a dedicated staging Netlify site and Worker with separate secrets and storage. Production
promotion and recovery are manually dispatched GitHub Actions operations sharing one concurrency
group. Failed production verification stops with the observed deployment pair and a recovery plan;
it never automatically rolls back. Recovery requires an explicit operator action.

Use a small repository-owned release runner for planning, verification, stage state, and evidence.
Keep provider calls behind Netlify and Cloudflare adapters so release policy can be tested without
deploying. GitHub Actions should invoke the same runner, supply deployment credentials, serialize
releases, and retain evidence. Do not build a general-purpose deployment framework first.

The runner should expose distinct planning, rehearsal, promotion, status, and recovery operations.
Their command syntax and record schema will be defined and tested during implementation; there
are no new release commands to run yet.

Before production promotion can be authoritative, replace the current automatic production publish
on merge with a controlled publish path. Otherwise a merge can bypass the release checks. Provider
capabilities, deployment packaging, authentication, and account-plan constraints must be verified
before selecting that path or changing the live site's settings.

Staging must not depend on a historical pull request's preview origin. Use a stable staging
environment, or explicitly provision an isolated pair for each candidate. A shared staging
Worker must not be overwritten by simultaneous candidates.

## Small implementation increments

1. Establish `stage` and CI enforcement of PR routing, then add a read-only release planner and configuration checks, with machine-readable evidence and
   tests for mismatched origins, missing evidence, and partial provider failures.
2. Move the successful live collaboration smoke into the repository, parameterize its target,
   add network-loss recovery, and make errors safe to retain. Establish the staging deployment pair.
3. Add controlled deployment and promotion, exact artifact/deployment verification, serialization,
   and resumable stage records. Rehearse before changing production publishing settings.
4. Add recovery operations and prove them against staging, including partial deployment and
   migration incompatibility. Then use the process for the next production release.

The implementation is ready when an operator can identify what is live, preview a release's effects,
resume after a provider timeout without duplicate deployment, and recover using recorded evidence
without reconstructing this conversation.
