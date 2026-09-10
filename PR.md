# Pull request guidance

Keep each pull request focused on a coherent change that a reviewer can understand and assess
independently. Split unrelated work, but keep closely related changes together when separating them
would make review or validation harder.

When work depends on another change, identify that dependency and explain the intended merge order.
Use issues or a project board to track implementation plans.

Apply the `need-release-process` label when a PR introduces a new feature or a change significant
enough that merging directly to `main` is not a safe release. For a stack, apply the label to the
parent PR based on the combined changes in the stack, even if that parent contains only a small
part of the implementation. Identify the covered PRs and their integration target in its description.

Release-sensitive implementation PRs must target the persistent `stage` branch, not `main`.
Intermediate PRs in a stack may target their dependency branches, but the stack's final integration
PR must target `stage`. Keep `stage` limited to work intended for the next coordinated release.
Promote that release through a labeled PR from `stage` to `main`, carrying the rehearsal evidence
and recovery plan. This promotion PR is the exception to the labeled-PR target rule.

For a labeled PR, describe the required deployment order, configuration or migration changes,
compatibility checks, validation, and recovery plan, using [the release contract](docs/releases.md).
Complete the applicable pre-release checks before merging to `main`, and coordinate the merge with
the release plan. Passing CI alone does not establish release readiness. Reassess the label and plan
when the PR or stack changes scope.

GitHub native protections require pull requests and passing CI for `main` and `stage`.
Authors and reviewers remain responsible for classifying and routing release-sensitive work;
native protections do not enforce label-dependent targets or stack topology. The release runner
must verify production prerequisites. See [branch protection guidance](docs/release-routing.md).

For behavior changes, add or update tests that demonstrate the intended behavior. When fixing a bug,
confirm that the regression test fails without the fix where practical. For behavior-neutral changes,
use existing checks to establish that behavior is preserved.

Add a concise entry under `Unreleased` in [CHANGELOG.md](CHANGELOG.md) for user-visible features,
fixes, or breaking changes, including required user action where relevant. Internal-only changes
need no entry. Promotion PRs review and consolidate the entries for their release scope; date and
link the shipped entries only after successful production verification, following the
[changelog process](docs/releases.md#changelog).

Start the PR description with a review question: the question the PR answers. Make it specific enough
to focus the review on the proposed solution or decision.

Then explain what changed, why, and how you validated it. Include relevant commands,
results, and any limitations. Prefer concise, useful evidence over a prescribed reporting format.

For release-system changes, update `docs/release-system-map.html`, `docs/releases.md`, and affected
operator guidance at completed implementation, validation, review, or rollout checkpoints. Keep
verified behavior distinct from planned work and link dated evidence; real-time updates are unnecessary.

Review the final version after refactoring and rerun the checks relevant to the change.

Run `bun run security:secrets` with the pinned Gitleaks binary before pushing changes. CI also scans
history and current files. Investigate findings without copying matched values into PRs, logs, or
review comments. See [secret scanning](docs/secret-scanning.md) for installation and the narrow
historical fixture exception. Passing this check does not replace the release evidence restrictions.
