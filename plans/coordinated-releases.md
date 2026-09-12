# Coordinated releases with Netlify CLI, Wrangler, and stacked PRs

## Summary and decisions

Build one repository-owned release runner that coordinates both platforms. Vendor CLIs perform platform operations; the runner owns validation, sequencing, evidence, and recovery.

Agreed defaults:

- Persistent `stage` branch for release-sensitive work.
- Dedicated Netlify staging site and Cloudflare staging Worker, with separate secrets and storage.
- Production deployment starts through **manual GitHub Actions dispatch**, never merely by merging.
- Failed production verification **stops and reports a recovery plan**; rollback requires a separate operator action.
- Root changelog maintained without Changesets.
- No production publishing changes until the replacement has passed staging rehearsal.

First update [docs/releases.md](/Users/mi-shn001/dev/ephemeral-pages/docs/releases.md) with the CLI architecture, explicit targets, credential handling, artifact verification, and operational limitations. Align [PR.md](/Users/mi-shn001/dev/ephemeral-pages/PR.md) with the implemented checks as each increment lands.

## Implementation stack

Use six dependent PRs, with branch names prefixed `codex/release-`. Each PR description starts with its review question, identifies dependencies, and states validation evidence.

**1. Release contract and branch enforcement**

- Preserve existing work, including untracked documents, in a recoverable snapshot before separating changes.
- Keep the toolbar fix in an independent PR; include the release guidance and historical release evidence in this documentation foundation.
- Establish `stage` from verified current `main`.
- Add CI validation for labeled PRs: direct target `stage`, a verified stack dependency leading to `stage`, or the explicit `stage` → `main` promotion exception.
- Validate PR metadata without executing contributor-controlled code with privileged credentials.
- Run ordinary CI on `stage` pushes as well as PRs and `main`.
- Make routing validation a required check after it has been exercised. The label cannot detect unlabeled risky work; authors and reviewers retain responsibility for classification.

**2. Read-only planner and provider inspection**

- Implement the runner in TypeScript using existing repository tooling and validation libraries.
- Provide planning and status operations with human-readable output and a versioned JSON report.
- Configure environments through checked-in non-secret settings: site/account identifiers, Worker environment, origins, audience, expected gate state, and required secret names.
- Pin Netlify CLI and Wrangler versions. Use explicit site IDs and Worker environments; never rely on whichever project is linked locally.
- Inspect deployment IDs, configuration, source attribution where available, and recovery-target availability. Unknown or inaccessible information produces a blocked result.
- Determine affected services conservatively from changes, including shared code, dependencies, build configuration, and release policy. Documentation-only changes produce a no-deployment plan.
- Compare against the source recorded for each live service, rather than assuming both services share one previous commit.
- Runtime subprocess calls use argument arrays, bounded execution, and sanitized output. Do not export complete environment listings into evidence.

**3. Reusable smoke tests and staging provisioning**

- Move the successful production collaboration smoke into the repository and parameterize its target.
- Cover upload, two-editor synchronization, read-only viewing, reload persistence, actual network-loss recovery, and screenshot download.
- Parameterize the existing API smoke while retaining explicit opt-in for quota-consuming operations.
- Create the dedicated staging pair through a documented bootstrap operation. Record provider-assigned identifiers in environment configuration; obtain secrets through secure operator input.
- Verify real ticket and screenshot operations to establish that matching secrets work across platforms.
- Use short-lived fixtures, bounded attempts, and sanitized failures. Never retain editor capabilities, tickets, page contents, or raw browser traces.

**4. Artifact preparation and staging rehearsal**

- Implement preparation and rehearsal operations using frozen installs for both package boundaries.
- Build separately for each target environment. Retain hashes for static assets, generated headers, function packages, and Worker bundles.
- Verify Netlify’s actual function packaging; `--no-build` alone is insufficient evidence of an unchanged artifact.
- Upload a Netlify draft and inspect it before publishing that deployment to the staging site’s stable origin.
- Prepare and activate the Worker through Wrangler, retaining exact version IDs.
- Verify the compatible pair at stable staging origins, including an old-app/new-Worker transition.
- Treat Durable Object lifecycle migrations as an explicit exceptional deployment path. Block unsupported or destructive transitions rather than silently using ordinary version promotion.

**5. Production promotion and resumable execution**

- Add manually dispatched production orchestration that accepts an approved release record.
- Require a merged promotion PR, successful rehearsal, matching source tree, and successful validation of the exact promotion commit.
- Build and inspect production artifacts before activation; verify configuration again immediately before publishing.
- For compatible combined changes, activate the Worker first and then publish the prepared Netlify deployment. Retain unchanged services.
- Serialize production promotion and recovery through the same GitHub Actions concurrency group; do not cancel an active release to start another.
- Persist stage reports and artifact hashes as workflow artifacts, with a durable sanitized completion record committed through a documentation follow-up PR.
- Resume using a prior run’s evidence and live provider observations. If a timeout leaves an operation ambiguous, reconcile by deployment/version ID or release marker; ambiguity blocks retry rather than risking duplicate deployment.
- Credentialed jobs run trusted code from protected branches. Local tooling supports inspection and rehearsal; production mutation goes through the serialized workflow.

**6. Recovery, cutover, and completion**

- Add an explicit recovery operation that checks the requested prior pair still exists and remains compatible with current storage and secrets.
- Execute the recovery order recorded by the release plan, then rerun verification.
- Test Netlify restore behavior, including function configuration, and Worker rollback limitations on staging.
- Block unavailable rollback targets: provider retention means a historical ID is not a permanent recovery guarantee.
- After successful rehearsal, disable Netlify automatic production publishing while retaining useful preview builds. Keep Cloudflare independent Git deployment disabled.
- Verify that a subsequent Git-triggered build cannot change production, while explicit promotion still works.
- Complete the first coordinated release, retain evidence, and move only verified shipped changelog entries out of `Unreleased`.

## Interfaces and failure semantics

The runner exposes distinct operations for **plan, status, prepare, rehearse, promote, resume, and recover**. Exact command syntax is defined with the parser and tested before documenting executable examples.

Release records contain candidate and promotion commits, configuration fingerprints, artifact hashes, observed deployment pairs, prior recovery targets, and per-stage outcomes. Outcomes distinguish pending, running, passed, failed, blocked, and not applicable.

Use GitHub Actions artifacts for intermediate checkpoints and bundles. Expired or incomplete evidence blocks resumption. Completed release records remain in repository history; raw credentials and sensitive payloads never enter either store.

Routine releases verify configuration without rotating secrets or toggling collaboration. Incompatible migrations require an explicit forward-recovery plan and cannot pass the ordinary compatible-release path.

## Subagent orchestration and GitHub stack management

Use at most **three subagents alongside the coordinator**, each in an isolated worktree. Only the coordinator integrates changes, manages the stack, or performs provider mutations.

- **Coordinator — GPT-6 Astra, high:** owns interfaces, dependency order, integration, and release decisions.
- **Provider adapter agent — GPT-5.6 Sol, high:** Netlify/Wrangler inspection, packaging, deployment, and recovery adapters.
- **Runner and workflow agent — GPT-5.6 Sol, high:** state transitions, routing checks, orchestration, and resume behavior.
- **Browser validation agent — GPT-5.6 Terra, high:** reusable smoke tests, disconnect recovery, and quota-aware testing.
- **Documentation pass — GPT-5.6 Luna, medium:** bounded documentation consistency work once interfaces are stable.
- **Independent reviewer — GPT-6 Astra, high:** credential boundaries, candidate integrity, interrupted operations, and migration/recovery safety.

The browser agent and provider agent can work concurrently once the coordinator fixes shared interfaces. Dependent workflow work starts against accepted adapter contracts. Schedule the documentation and review roles in freed slots rather than exceeding the concurrency limit.

Initialize the implementation stack with the locally verified `gh stack init --base stage` interface. Submit drafts using `gh stack submit --auto`, then replace generated descriptions with reviewed descriptions. Use `gh stack view --json` to verify topology and PR state.

Label every implementation member `need-release-process`; the bottom member targets `stage`, and subsequent members target their dependencies. Review each layer independently, and wait for the automated PR review before proceeding. Merge the complete ready stack into `stage` using GitHub’s atomic stack merge with an explicit merge method and normal repository protections. Open the separate promotion PR from `stage` to `main` afterward.

Any restacking invalidates affected checks; any change to the rehearsed candidate invalidates release approval.

## Acceptance and rollout gates

Before production cutover, demonstrate that all CLI checks are green, including reviews:

- Rejected incorrect PR targets and accepted stack/promotion exceptions.
- Missing credentials, mismatched origins, stale evidence, and changed candidates block safely.
- Documentation-only, single-service, and combined release plans behave correctly.
- Desktop/browser smoke and existing application/Worker suites pass.
- Prepared artifacts match deployed artifacts and reported provider IDs.
- Worker success followed by Netlify failure is reported accurately.
- Interrupted operations resume without duplicate deployment.
- Unavailable or migration-incompatible rollback targets are rejected.
- Git merges cannot publish production independently.
- An operator can rehearse, promote, inspect, and recover using the documented process without reconstructing this conversation.

Documentation edits, branch creation, package installation, and provider changes remain implementation work; none are performed during this planning turn.
