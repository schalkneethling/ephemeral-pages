# Protected release branches

GitHub's native ruleset protects `main` and `stage`. The checked-in configuration is
[protected-release-branches.json](../.github/protected-release-branches.json).
It requires a pull request, resolved review conversations, and the GitHub Actions `validate`
check against the latest target branch. It prevents branch deletion and force pushes, with no
bypass actors. Approving reviews are not mandatory because the repository has a solo maintainer.
The existing, separate default-branch CodeQL ruleset remains in place.

The `need-release-process` label records release-sensitive work. Authors and reviewers route that
work to `stage`, or through dependency branches that integrate into `stage`. A promotion PR goes
from `stage` to `main`. Native protections do not enforce label-dependent targets or stack topology.
There is no custom routing status or privileged PR-metadata workflow.

Branch protections do not coordinate deployments. The coordinated release runner must enforce
promotion source integrity, successful rehearsal, configuration and artifact verification before
production activation. Until that implementation and cutover are verified, existing automatic
Netlify publication is still a separate concern.

## Apply or inspect the configuration

Inspect the existing ruleset before updating it; retain unrelated rulesets. For this repository,
update ruleset `22802231` in place rather than deleting it first:

```sh
gh api repos/schalkneethling/ephemeral-pages/rulesets/22802231
gh api --method PUT repos/schalkneethling/ephemeral-pages/rulesets/22802231 \
  --input .github/protected-release-branches.json
gh api repos/schalkneethling/ephemeral-pages/rulesets/22802231
```

For another repository, discover its ruleset and GitHub Actions integration identifiers first.
Require additional checks only after they exist and have been exercised on the protected branches.
See the [GitHub ruleset API](https://docs.github.com/en/rest/repos/rules).
