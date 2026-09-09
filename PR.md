# Pull request guidance

Keep each pull request focused on a coherent change that a reviewer can understand and assess
independently. Split unrelated work, but keep closely related changes together when separating them
would make review or validation harder.

When work depends on another change, identify that dependency and explain the intended merge order.
Use issues or a project board to track implementation plans.

For behavior changes, add or update tests that demonstrate the intended behavior. When fixing a bug,
confirm that the regression test fails without the fix where practical. For behavior-neutral changes,
use existing checks to establish that behavior is preserved.

Start the PR description with a review question: the question the PR answers. Make it specific enough
to focus the review on the proposed solution or decision.

Then explain what changed, why, and how you validated it. Include relevant commands,
results, and any limitations. Prefer concise, useful evidence over a prescribed reporting format.

Review the final version after refactoring and rerun the checks relevant to the change.
