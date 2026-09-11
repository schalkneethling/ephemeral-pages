# Repeatable releases

Status: Native branch protections, read-only planning, local artifact preparation, staging rehearsal,
and the production provider/runner implementation are present. The first full [staging calibration](release-evidence/2026-09-10-staging/README.md)
passed, including both transition and final-pair browser smokes. Manual production orchestration and resumption are implemented;
live verification remains pending. Recovery and the toolbar improvements are merged into protected `stage`, and deployment credentials
are provisioned in branch-restricted GitHub environments. Read-only provider inspection passed, and
the staging workflows are registered on the default branch. The first protected calibration attempt
stopped at GitHub source validation before deployment; see [the checkpoint](release-evidence/2026-09-11-staging/README.md). Live deployment authorization, recovery drills,
publishing cutover, the attributable baseline, and the first production release remain gates. Production publishing
settings have not been changed by this increment.

This design applies the principles in
[The release process is part of the product](https://schalkneethling.com/posts/the-release-process-is-part-of-the-product/)
to the Netlify application and Cloudflare collaboration Worker.

## Documentation checkpoints

Update the [release system map](release-system-map.html), this guide, and affected setup, recovery,
and PR guidance at meaningful checkpoints: completion of an implementation layer, validation or
rehearsal, review changes that alter the design, and a release or recovery outcome. Continuous or
real-time updates are not required.

Before closing a checkpoint, reconcile implemented, verified, planned and assumed behavior against
current code and retained evidence. Update source links, remaining gates and the map checkpoint date.
Keep canonical instructions reusable; put candidate-specific IDs and results in dated evidence records.
A documentation update does not approve a changed candidate or imply that production has shipped.

## Prepare artifacts and rehearse on staging

Use a clean checkout of the exact candidate commit, with Bun 1.3.14 and the pinned dependencies
installed. Preparation reads only checked-in environment settings; it accepts no configuration
override. Choose new output directories outside the checkout, with existing parent directories:

```sh
candidate_sha=$(git rev-parse HEAD)
bun run release:prepare --environment staging --candidate "$candidate_sha" \
  --output /absolute/path/to/new-artifacts --json
bun run release:rehearse --artifacts /absolute/path/to/new-artifacts \
  --output /absolute/path/to/new-rehearsal --confirm-external-smoke --capture --json
```

Preparation creates a private detached copy of the exact candidate. Git verification ignores caller
Git environment overrides and global configuration. Installs, builds, and packaging run exclusively
in that copy, which is removed afterward. The preparation operation runs frozen installs for both package boundaries with lifecycle scripts
disabled, builds the target-specific app and CSP, packages Netlify functions with the pinned ZISI,
and dry-runs Wrangler into a separate bundle. Candidate dotenv overrides are rejected; caller-local files never enter the copy. Temporary build
caches are removed. `prepared-release.json` binds the candidate commit, tree, configuration, toolchain,
and both artifact inventories. The inventories hash static assets, generated headers, portable
Netlify deploy configuration, function ZIPs and metadata, and the Worker bundle/configuration.
Preparation supports production builds but performs no provider mutation.

Rehearsal supports the dedicated staging pair only. It verifies artifact hashes and current
configuration, holds Netlify's stable deployment with a publish lock, and uploads a non-draft
production-context candidate. This is deliberate: a deploy-preview-context draft would use different
runtime environment values. Netlify's stable published ID must remain unchanged throughout upload.
The runner uploads and activates the Worker, runs the old-app/new-Worker smoke, explicitly publishes
the held Netlify deployment, then runs the final pair smoke. Each smoke creates at most one short-lived
page and requests at most one screenshot. The explicit flags authorize these quota-consuming checks.

Netlify authentication uses its pinned CLI's normal token resolution. Cloudflare authentication uses
Wrangler's `auth token --json` command with bounded in-memory capture. Credentials never enter command
arguments or release records. Upload and activation requests do not retry automatically. A checkpoint
is persisted before each mutation, with separate records for returned provider identifiers. Mutation results are retained before the
subsequent read-back check, so a failed observation does not erase a successful activation. The runner
rechecks the expected pair immediately before publishing Netlify. Failures
stop with recovery guidance; no automatic rollback occurs. Keep the complete artifact and report
directories. Existing report directories cannot be reused to retry an interrupted operation.

A local lock serializes rehearsals across worktrees sharing the Git repository. A persistent guard
blocks new runs after an unresolved operation, including runs using a different output directory.
A completed failure confined to read-only inspection permits a fresh attempt. Incomplete guard
evidence blocks execution. Inspect the referenced checkpoints and live provider IDs before explicitly resolving that guard. Coordinate operators
on separate machines; this is not a distributed staging lock. Production serialization will be owned
by the protected GitHub Actions workflow. Do not unlock the held staging deployment merely because
an upload failed; inspect recorded IDs before a separate recovery action.

The ordinary Worker path supports the reviewed `v1` SQLite Durable Object lifecycle with no migration
change. Different migration state blocks this path. Netlify upload acknowledgements and Cloudflare
version metadata supplement local byte hashes. Netlify function acknowledgements may contain only
the function name; a returned hash must match, but an omitted hash is not independent byte verification.
Neither API supplies downloadable inactive
function/Worker bytes for independent byte-for-byte retrieval. Staging calibration and runtime smoke
are required; a ready deployment alone is insufficient proof. A Netlify restore that returns a new
unmapped deployment ID also blocks further execution.

## Read-only tooling

The repository owns the `release:plan` and `release:status` scripts. They use pinned Netlify CLI
27.5.0 and Wrangler 4.125.0 installations, with explicit provider targets from
[`scripts/release/environments.json`](../scripts/release/environments.json). The staging targets
remain `null` until dedicated resources have been provisioned and their assigned identifiers
recorded and the first cross-platform smoke has passed. Missing targets block inspection; the runner
does not substitute production targets.

The root `bunfig.toml` selects Bun's isolated dependency layout. This keeps Netlify's function
packager on its supported TypeScript dependency while preserving the application's TypeScript 7
compiler. Use the checked lockfile and install both the root and Worker package boundaries; do not
replace the layout with a hoisted installation or downgrade the application compiler to work around
provider tooling.

Both operations require an environment and a versioned baseline file. Planning also requires a full
candidate commit. The argument parser in
[`scripts/release/args.ts`](../scripts/release/args.ts) defines the command interface, and
[`scripts/release/schema.ts`](../scripts/release/schema.ts) defines configuration and baseline shapes.
The baseline records each service's own source commit and observed provider deployment identifiers.
Unknown source attribution must remain unknown; do not assign the current `main` commit merely
because it is convenient. Status can inspect a deployment pair whose source attribution is still
unknown; planning blocks on that gap. Missing targets or inconsistent deployment evidence block
both operations.

Set `RELEASE_BASELINE` to the absolute path of the baseline JSON outside the checkout and
`RELEASE_CANDIDATE` to the full candidate commit, then run:

```sh
bun run release:status --environment staging --baseline "$RELEASE_BASELINE" --json
bun run release:plan --environment staging --candidate "$RELEASE_CANDIDATE" --baseline "$RELEASE_BASELINE" --json
```

Use a clean checkout. Planning verifies the candidate's membership in `stage` and binds the
configuration to the candidate. An explicit `--config` path is reported as an override and must
still satisfy the candidate checks. Replace `staging` with `production` for read-only production
inspection; neither command publishes anything.

Use `--json` for a versioned, sanitized report. Keep credentials in the vendor CLI's supported
authentication mechanism or environment variables, never command arguments or baseline files.
Inspection compares only the configured non-secret values and required secret metadata; it does not
export environment listings. Netlify scope requirements are explicit for each variable: runtime
configuration needs the Functions scope, and the WebSocket origin also needs the Builds scope for
CSP generation. These are minimum requirements; additional scopes are permitted.
Secret presence does not prove that the two platforms share matching
values, so ticket and screenshot smoke checks remain necessary during rehearsal.

A successful read-only plan is not release approval. It does not build, publish, rotate secrets,
prove artifact identity, or establish storage compatibility. The remaining gates below still apply.
Blocked results exit nonzero. Invalid arguments or input files produce a sanitized preflight
failure; `--json` preserves a versioned JSON shape for those failures as well.

## Collaboration smoke and local secrets

The collaboration smoke uses the selected environment's configured application origin:

```sh
bun run release:smoke --environment staging --origin https://ephemeral-pages-staging.netlify.app --confirm-external-smoke --capture
```

Both provider targets must be configured first. During bootstrap, `--config` can select an inspected
configuration file containing the newly assigned provider identifiers. The command creates one
one-hour collaborative page, verifies two-editor synchronization, read-only viewing, reload
persistence, and reconnection after browser network loss. A private loopback CONNECT proxy drops
only the first editor's Worker TCP connections and requires a fresh connection afterward. It allows
only the configured app and Worker authorities, does not decrypt TLS, and closes after the run.
Playwright diagnostic environment settings are rejected before any upload because they can expose
capability URLs outside the sanitized report. `--capture` separately opts into one
screenshot request and validates the downloaded PNG in memory. Without that flag, the report records
that capture was not requested. Raw browser traces, page content, capabilities, and image files are
not retained. Rate limiting blocks the run with a validated retry delay; it does not retry uploads
or captures.

Local staging provisioning resolves the four authorized staging secrets through Varlock and the
1Password desktop app. References are versioned in
[the staging secret schema](../scripts/release/local/staging/.env.schema); values are not stored in
Git. This entry point is separate from the application's development schema and does not resolve
production or unrelated development secrets.

```sh
bun run release:secrets:check
```

This command returns only a validation outcome. It uses pinned compatible Varlock and plugin
versions, skips caching, and injects individual variables without a serialized environment graph.
1Password may require a desktop unlock. Routine releases inspect existing provider configuration;
they do not reprovision or rotate secrets. See [staging bootstrap](staging-bootstrap.md) for the
one-time setup and recovery checkpoints.

## API smoke

Run the API smoke only with an explicit HTTPS origin and both opt-ins:

```sh
bun run smoke:production --origin https://your-staging-site.netlify.app --confirm-external-smoke --confirm-quota-exhaustion
```

The existing script name is retained, but the origin selects the target; there is no production
default. The test creates two one-hour pages, verifies compressed uploads and idempotency, and
intentionally exhausts one upload quota bucket (at most 17 upload requests). Avoid running it
immediately before collaboration smoke from the same anonymous client. It stops at the expected
quota response and records a validated retry delay when available. Failure does not trigger retries.
The manually dispatched production API smoke workflow supplies the production origin explicitly
and runs trusted `main` code with GitHub OIDC.

Reports contain fixed check outcomes and request counts, never page links, page contents, or raw
errors. A blocked result exits nonzero. Missing either opt-in or an invalid origin causes no network
requests.

## Production orchestration checkpoint

The production implementation is split between GitHub provenance/artifact verification, a provider
boundary, and a resumable runner. The protected workflow must establish the exact promotion commit,
successful CI, a recent `release-rehearsal` artifact, the reviewed production baseline, and the
approval hash before provider credentials are made available. Production policy remains disabled
until the integrated workflow and prerequisites have been verified.

The production CLI has separate `preflight` and `execute` phases. Its reviewed parser accepts only
the `promote` or `resume` operation plus promotion/rehearsal identifiers, an approval digest, and an
external workspace; resume also names the interrupted production run. Production targets and policy
come from checked-in configuration. Preflight seals production artifacts and evidence; execution
revalidates provenance, approval, preparation and configuration before creating provider adapters.
The workflow is the interface for these phases; this guide intentionally does not prescribe a
standalone production command line.

The runner persists sanitized stage outcomes, provider identifiers, the prior and observed pairs,
artifact bindings, checkpoints and run lineage. It holds the Netlify deployment, uploads and
activates the Worker, verifies the old-app/new-Worker transition, publishes the held Netlify ID,
and verifies the final pair. Resume reconciles incomplete writes against retained IDs or a unique
release marker and blocks ambiguity; it does not repeat a possibly completed mutation. Failed
verification stops with evidence and requires an explicit recovery action.

See [production orchestration](production-orchestration.md) for the reusable operator model and its
remaining rollout gates. The 10 September staging rehearsal remains historical calibration; it is
not approval for this 11 September documentation checkpoint or for a production release.

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

GitHub's [native branch protections](release-routing.md) require pull requests, resolved review
conversations, and passing CI against the latest target branch on `main` and `stage`. They also
prevent deletion and force pushes. Authors and reviewers classify release-sensitive work and
check its target and stack dependencies; no custom routing workflow or status enforces those rules.
Production source integrity, rehearsal evidence, and deployment prerequisites belong in the release
runner. The original CI bootstrap in PR #41 was superseded by native protections.

Branch routing does not coordinate providers: replace automatic production publishing on merge with
the controlled release workflow before treating promotion as separate from deployment.

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
Run `bun run security:secrets` before submitting release changes. [Gitleaks](secret-scanning.md)
checks history and pending files, but cannot prove arbitrary sensitive content is safe to publish.
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

The runner currently exposes planning and status under [Read-only tooling](#read-only-tooling),
and preparation and staging rehearsal under [artifact preparation](#prepare-artifacts-and-rehearse-on-staging).
Production promotion and resumption use the manual workflows and tested interfaces described in
[production orchestration](production-orchestration.md). The checked-in production gate stays off
until rollout prerequisites pass. Explicit recovery is implemented in the final layer and remains under validation; live drills and publishing cutover are outstanding. See [recovery and cutover](recovery.md).

Before production promotion can be authoritative, replace the current automatic production publish
on merge with a controlled publish path. Otherwise a merge can bypass the release checks. Provider
capabilities, deployment packaging, authentication, and account-plan constraints must be verified
before selecting that path or changing the live site's settings.

Staging must not depend on a historical pull request's preview origin. Use a stable staging
environment, or explicitly provision an isolated pair for each candidate. A shared staging
Worker must not be overwritten by simultaneous candidates.

## Small implementation increments

1. Establish `stage`, native branch protections, and documented PR routing, then add a read-only release planner and configuration checks, with machine-readable evidence and
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
