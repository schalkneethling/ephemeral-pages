# Coordinated release retrospective — September 2026

This is a candid retrospective of the collaboration and release-system work that
followed the collaboration feature. It is not a production release record.
At the investigation checkpoint, the attempted first ordinary coordinated application
release had **not** completed.
The application already existed in production, collaboration had been exercised
successfully, and a production baseline adoption succeeded. Those successes are
distinct from completing the later coordinated release.

Prepared by Terra at medium effort, then reviewed and supplemented by the
coordinator against available conversation context and retained evidence. The
[original implementation plan](../plans/coordinated-releases.md) is preserved
unchanged; the [revised plan](../plans/coordinated-releases-revised.md) describes
an alternative sequence, not an implementation performed during this review.

The report is based on the retained repository evidence, current release code, Git
history, pull-request/workflow identifiers recorded in the documentation, and the
conversation context available to this review. Some assistant turns and tool output
were compacted or redacted, so this is not a verbatim transcript or a complete
accounting of time, tokens, or provider-side events. Where that limit matters, this
report says so rather than filling the gap with a confident story.

## Closeout and handoff correction

After this investigation, the operator confirmed that production had been updated and
that they had tested the collaboration flow successfully. The coordinator nevertheless
continued working from an obsolete release checkpoint. That unnecessary continuation
was another failure: it consumed time and tokens after the requested outcome was achieved.
This report preserves the earlier investigation as history, not as current release status
or an instruction to retry its unfinished operations. The operator confirmation is the
source for this closeout; this documentation change does not independently verify a live
deployment or assign new deployment identifiers.

Every phase must produce an explicit, validated output that the next phase consumes.
Source commits, deployment identifiers, verification results, and completion state must
travel in that handoff. Neither the operator nor an agent should have to reconstruct them
from conversation, guess them, or remember which parallel task has the latest state.
When the agreed outcome is confirmed complete, stop. Further improvement belongs in a
separate, explicitly scoped task.

## Scope and evidence

The work began with an application feature: real-time collaboration between a
Netlify-hosted application and a Cloudflare Worker. It then grew to include a
dedicated staging pair, secret provisioning, CSP and WebSocket configuration,
browser smoke testing, manual production controls, staged branching, release
planning, artifact preparation, GitHub Actions orchestration, recovery, evidence
retention, and release documentation.

The most relevant retained evidence is:

- the [release contract](releases.md), plus the verified
  [production orchestration guide](https://github.com/schalkneethling/ephemeral-pages/blob/d1197e6d7dec120e18e0c8f7e86319b4d91d134a/docs/production-orchestration.md)
  and [recovery guide](https://github.com/schalkneethling/ephemeral-pages/blob/d1197e6d7dec120e18e0c8f7e86319b4d91d134a/docs/recovery.md);
- staging recovery and calibration records in the verified
  [`docs/release-evidence`](https://github.com/schalkneethling/ephemeral-pages/tree/d1197e6d7dec120e18e0c8f7e86319b4d91d134a/docs/release-evidence)
  tree;
- the verified [production resume investigation](https://github.com/schalkneethling/ephemeral-pages/blob/d1197e6d7dec120e18e0c8f7e86319b4d91d134a/docs/release-evidence/2026-09-12-production-resume-investigation/README.md);
- release scripts and workflows under `scripts/release/` and `.github/workflows/`;
- the release-related Git history, which records a long sequence of follow-up fixes.

### Terms used below

**Observed fact** means it is supported by retained code, evidence, workflow output,
or the available conversation summary. **Interpretation** is a reasoned conclusion
from those facts. **Unknown** means the available material does not establish it.

The user estimated that this consumed roughly three to four weeks of token budget.
That is an important planning signal, but this report has no verified billing or
token ledger and does not convert that estimate into an API-cost figure.

## What went well

### The application feature was exercised against real infrastructure

**Observed fact:** the collaboration path was configured and tested across Netlify
and Cloudflare. The retained staging records show successful checks for upload,
editor/viewer authorization, two-editor synchronization, reload persistence,
network-loss reconnection, and screenshot download. The UI and screenshot behavior
also received real-browser attention rather than only unit-test coverage.

**Interpretation:** the team did not treat a locally passing implementation as a
complete integration result. That was valuable, especially for WebSockets, CSP,
platform configuration, and rate limits where the failure modes are inherently
cross-service.

### There was meaningful security discipline

**Observed fact:** secrets were kept outside the repository, accessed through
1Password/Varlock for local staging work, and secret scanning was added. The
documentation repeatedly prohibits retaining editor capabilities, tickets, page
content, raw browser traces, and credentials. The release tooling uses explicit
provider targets, does not put credentials in command arguments, and preserves
sanitized evidence.

**Observed fact:** the team rejected `pull_request_target`, moved away from a custom
label-and-stack enforcement mechanism in favour of native branch protection, and
addressed CodeQL feedback rather than dismissing it. A CodeQL finding in a test
that generated a `bun -e` source string was fixed by replacing it with a static
fixture, then verified fixed before the later recovery attempt.

**Interpretation:** the security work was not merely documentary. It improved the
trust boundary around CI and prevented an easy class of accidental secret exposure.
This is reusable across projects.

### The team preserved evidence and avoided unsafe automatic retries

**Observed fact:** the first ordinary production release
[`34693466555`](https://github.com/schalkneethling/ephemeral-pages/actions/runs/34693466555)
recorded that the Worker activated and the transition smoke passed before the
pre-publication check timed out. Netlify was not published. The workflow was
normally cancelled only after the failure record had been persisted so the
diagnostic artifact could upload. Other staging incidents were resolved with
recorded provider IDs, hash-verified artifacts, fresh inspection, and a fresh
smoke rather than a blind deployment retry.

**Interpretation:** this prevented the most serious possible outcome: silently
declaring success or repeatedly mutating a partially known production state. The
release system did protect production from repeated write attempts even as its own
complexity made progress slow.

### Several real defects were found and corrected before wider impact

**Observed fact:** fixes included Netlify pagination timing, omitted ruleset
exclusions, preserving additional CodeQL languages, frozen-lockfile handling,
browser-install integrity, post-publication observation, error-cause preservation
in some release paths, sealed-artifact restoration, path containment, and a static
test fixture that satisfied CodeQL. The artifact-permission problem behind the
first resume failure was reproduced against the actual retained artifact, not
only inferred from a generic test.

**Interpretation:** the work produced a useful collection of provider-integration
lessons and hardening patterns. The issue was not lack of care; it was applying
care reactively across too large a system before the simplest end-to-end path was
settled.

### Documentation and explicit decisions improved operational clarity

**Observed fact:** the repository now has release, recovery, staging-bootstrap,
production-orchestration, branch-routing, and secret-scanning guidance, plus a
release-system map. Important decisions were explicit: a `stage` branch for
release-sensitive work; disabled-by-default collaboration; manual production
dispatch; no automatic rollback; and native branch protections.

**Interpretation:** much of this documentation can be mined for Project Calavera
or other repositories. It captures questions future projects should ask, even
where this implementation went too far.

## What did not go well

### The problem expanded faster than the evidence base

**Observed fact:** a collaboration feature accumulated a multi-service release
platform with planning, preparation, rehearsal, promotion, resume, recovery,
artifact sealing, source attribution, evidence schemas, provider adapters,
workflow lineage, release maps, staged branch policy, and several special paths.
The Git history contains many sequential fixes to that system before an ordinary
application release completed.

**Interpretation:** the system was designed as a general release framework before
the smallest production delivery path had demonstrated that it could complete. The
result was a large state space: every new guard, artifact shape, recovery path,
and workflow branch created combinations that needed real validation.

The original plan was already intentionally broad and authorized; it proposed six
dependent implementation layers, a reusable runner, provider inspection, smoke
tests, recovery, cutover, and a multi-agent PR stack. It would be inaccurate to
describe every later addition as unauthorized drift. The scope-creep problem was
that the plan was not re-baselined when live evidence showed that the release
platform was itself becoming the main product. Later, locally reasonable additions
were allowed to remain on the critical path. Collectively, that changed the
practical task from “ship collaboration safely” into “build a reusable
deployment-control plane before shipping collaboration.”

### The ordinary release was attempted before the recovery path was proven in its production form

**Observed fact:** staging recovery was exercised successfully, but the production
recovery path remained live-unverified. The original production release stopped
after Worker activation. Its resume then failed because GitHub extraction created
writable artifacts while the verifier required sealed ones. A repair was tested
offline and calibrated on staging, but the next production recovery run
[`34698033756`](https://github.com/schalkneethling/ephemeral-pages/actions/runs/34698033756)
failed in preflight in about 3.5 seconds, before production mutation.

**Interpretation:** similar staging and production architectures were treated as
sufficiently equivalent, but the production workflow has unique provenance,
artifact, environment, and recovery-source inputs. That equivalence was not
demonstrated with a realistic production-recovery dry run before it was needed.

### Diagnostics were treated as a requirement, but incompletely implemented

**Observed fact:** the user explicitly required retention of underlying causes for
debugging. The post-publication and production-resume work added cause preservation
and sanitized diagnostics in several places. Yet the current CLI entry points
still use bare catches that replace exceptions with generic messages. The
recovery message directs the operator to inspect retained evidence. The failed
recovery preflight therefore
discarded its actual exception, and no retained artifact was available from that
failure.

**Interpretation:** error transparency was added as a local patch rather than made
an end-to-end, testable contract for every terminal workflow path. This is the
most immediate process failure: a system designed to fail safely must also make a
safe failure diagnosable.

### The GitHub API contract was discovered through a production-adjacent failure

**Observed fact:** the first production adoption attempt
[`34683011398`](https://github.com/schalkneethling/ephemeral-pages/actions/runs/34683011398)
failed in preflight because the pinned GitHub REST API version `2026-03-10` omitted
the `merge_commit_sha` field that the promotion schema expected. Pinning the
supported `2022-11-28` version corrected the immediate incompatibility and the
later adoption succeeded.

**Interpretation:** API version pinning is necessary, but pinning alone is not a
contract test. The implementation assumed a field was present without first
validating the exact endpoint response used by the trusted workflow. A fixture from
the documented or observed provider response should have been tested before a
production-adjacent attempt.

### Review feedback and product decisions were not consistently triaged against the launch boundary

**Observed fact:** review feedback led to valuable corrections, including stricter
evidence and artifact contracts, a production enablement gate, and deployment-specific
CSP generation. Separately, user-directed process decisions added a `stage`-based
release route. The broad request to expand AGENTS architecture
documentation was correctly rejected, as was the later idea of a one-time legacy
restore implementation.

**Interpretation:** the review loop did not consistently separate:

1. a defect in the agreed product;
2. a hard security or correctness requirement; and
3. a plausible enhancement to an increasingly ambitious release platform.

Treating category 3 as in-scope by default accelerated scope growth. Review should
have been triaged against a fixed release charter, with enhancements deferred unless
they blocked the immediate path.

### Too many models and handoffs increased coordination cost

**Observed fact:** the implementation plan intentionally used several agents and a
stack of dependent pull requests. Work was split across provider adapters, runner
and workflow behavior, browser validation, documentation, reviews, release
evidence, and follow-up remediation. The user repeatedly had to supply secrets,
approve access, observe browser behavior, and wait through workflow failures.

**Interpretation:** parallelism helped investigate independent issues, but for a
tightly coupled release state machine it also created integration overhead:
contract drift, repeated context reconstruction, stack management, repeated review
cycles, and more chances for a change to invalidate a rehearsal. A single
accountable release owner with one small supporting reviewer would likely have
been cheaper until the core path was stable.

### The collaboration became too interrupt-driven

**Observed fact:** the work repeatedly pivoted between PR review, CI failures,
platform setup, screenshots, rate limits, documentation, branch policy, secret
access, workflow changes, and production recovery. Many later changes were
responses to the previous failure.

**Interpretation:** there was no durable “stop-the-line” rule after the first few
release-framework failures. The work should have paused, reduced the design, and
re-established a short release objective. Instead, the system accumulated fixes
while still moving toward production.

## Mistakes to own

These are process mistakes, not evidence that any individual contributor acted
carelessly.

1. **We accepted a plan that was too large for the immediate product need.** The
   six-layer release stack was thoughtful, but it bundled first-time platform
   setup, a reusable framework, production controls, recovery, and operational
   documentation into one delivery.
2. **We made production recovery a prerequisite before proving the ordinary release
   path.** Recovery is valuable, but an unproven recovery system became another
   release-critical product.
3. **We did not impose a strict complexity budget.** New branches, artifact types,
   status schemas, and workflows were added without retiring equivalent machinery
   or asking whether the new case was required for the first ordinary coordinated
   application publication.
4. **We trusted offline and staging validation too much.** They were meaningful but
   did not prove the exact production workflow or the artifact lifecycle through
   GitHub Actions.
5. **We did not treat vendor API responses and GitHub artifact transport as first-class
   contracts.** The GitHub REST response shape and extracted artifact permissions
   were each discovered after the corresponding workflow path was already needed.
6. **We did not test terminal error reporting as a whole workflow property.** A
   bare catch remained in the very path needed to explain the latest failure.
7. **We let review-driven improvements and launch blockers share the same queue.**
   This made “address feedback” implicitly authorize architecture expansion.
8. **We kept trying to preserve a highly constrained prior-release lineage.** That
   was defensible from a safety perspective, but it multiplied special-case code
   around legacy artifacts and historical run evidence. The user was right to
   question whether this was proportionate for the product’s current scope.
9. **We did not communicate a sufficiently sharp decision point.** Once the system
   needed a mixed-pair recovery plus a new approval, the team should have stated:
   “pause framework work; choose either a bounded fail-forward manual operation
   with evidence, or invest in a separately tested recovery product.”

## What was under-scoped

- **A minimal delivery definition.** The project needed a written first-launch
  contract with a small number of non-negotiable checks and explicit deferrals.
- **End-to-end workflow fixtures.** Unit and local integration tests did not model
  downloaded GitHub artifacts, their filesystem modes, and the exact workflow
  transitions early enough.
- **Error-observability acceptance criteria.** Each workflow failure should have
  required a retained, sanitized cause code and stage before it could be called
  release-ready.
- **Provider behavior discovery.** Netlify publication/readback timing, Cloudflare
  CLI behavior, and GitHub REST response compatibility were learned from live
  failures. A time-boxed
  provider spike with disposable resources should have preceded framework design.
- **A human operational fallback.** There was no deliberately simple, reviewed,
  one-time manual runbook for restoring a known Worker version or publishing a
  held Netlify deployment if orchestration failed. The user later favored
  fail-forward risk over building a legacy restore product; that decision should
  have been made earlier.
- **Cost and interruption controls.** No token/time budget or escalation threshold
  was visible in the retained material. There should have been a rule to stop
  adding scope after a fixed number of failed live attempts or model-hours.

## What was over-scoped

- A general-purpose release-control plane for a small, early-stage product.
- Multiple overlapping special paths: ordinary promotion, resume, recovery,
  adoption, staging recovery, interrupted recovery, historical resolution, and
  forward calibration.
- High-fidelity artifact contracts and persistence machinery before the first
  routine deployment had succeeded.
- A stacked-PR implementation programme with many dependent layers for behavior
  that had not reached a stable interface.
- Extensive canonical documentation and an interactive system map before the
  release system had settled.
- Branch/process automation that tried to formalize classification and routing
  beyond what native GitHub protections could reliably enforce.

None of these is intrinsically bad. They become bad when they are coupled to the
first shipment, lack an explicit maintenance owner, or displace direct evidence
that the product works in production.

## A better operating model for future projects

### Start from a release charter, not a framework

Before implementation, create a one-page charter that answers:

- What is the user-visible change being shipped?
- What exact production risks make a normal merge unsafe?
- Which controls are mandatory for this release?
- What is deferred until the second successful release?
- What is the manual, reviewed fallback if automation fails?
- What are the budget and stop conditions?

For this project’s first ordinary coordinated application publication, a defensible
charter could have required: dedicated staging credentials, verification of the
intended production gate state, a real staging collaboration smoke, a manual production workflow with
explicit provider targets, provider logs/IDs captured, and a documented rollback
or fail-forward decision. Resume and general recovery could have been deferred.

### Use a thin vertical slice before abstractions

Build and prove this sequence in one disposable staging environment:

1. prepare the application and Worker with the real vendor CLIs;
2. deploy Worker;
3. publish the Netlify deployment;
4. run one bounded smoke;
5. record provider IDs and a sanitized outcome;
6. restore the previous Worker version once, if rollback is in scope.

Only after this has passed twice should it become a generic runner, artifact
contract, or GitHub workflow. Test the exact archive download/extraction path at
that point, including file permissions and missing-artifact behavior.

### Separate launch-critical work from reusable infrastructure

Maintain two queues:

- **Launch path:** only a defect that blocks the agreed launch charter can enter.
- **Platform backlog:** reusable planners, richer recovery, maps, policy
  automation, and nonessential review suggestions go here.

Every new request gets a one-line classification. If it is not a security issue,
data-loss risk, or direct blocker, it waits until after the first successful
production release. That rule would have prevented much of the architectural
accretion seen here.

### Make observability a release gate

Define a stable, small failure envelope for every command and workflow. The exact
schema belongs in code and must be read from its defining schema before examples
are written into documentation. The policy is that an
unexpected failure cannot be acceptable unless it produces a sanitized stage,
classification, stable cause code, and retained evidence or an explicit statement
of why evidence could not be created. Test each terminal catch path by injecting
an error and asserting that contract. Human-friendly output can remain generic;
the retained cause code must not.

### Test the production workflow as deployed

Use an isolated, non-production GitHub environment or a provider sandbox for
workflow-level testing. It should exercise the same artifact upload/download,
permissions, workflow inputs, checkout, environment protection, and error-upload
steps as production. Staging runtime smoke is necessary but insufficient for this
kind of orchestration.

### Freeze candidates and use one integration worktree at the boundary

**Observed fact:** several repairs changed the protected release runner after a
rehearsal or promotion candidate had been established. Correctly, those changes
invalidated the earlier approval and required fresh rehearsal and promotion
lineage. The repair work also encountered a temporary worktree-copy race while an
agent reverted files to prove an unchanged baseline; the discrepancy was caught
before push and the intended patch was restored and revalidated.

**Interpretation:** invalidating stale approval was the correct safety behavior,
but the repeated cycle was expensive because the release system and candidate
changed together. Catching the copy race was a success of review and checks, not
evidence that this coordination method was low risk. Freeze the release runner
before approving an application candidate, isolate framework repairs from an
application promotion, and use one integration worktree for final assembly. Do
not use a temporary revert/copy operation on the path to a protected branch unless
there is a documented snapshot, a final diff review, and complete validation.

### Keep agent roles narrow and serial at the boundary

Use parallel agents for bounded research, code review, or independent test
investigation. Keep one owner for the state machine, workflow YAML, and provider
mutations. Do not create a stack until a single thin implementation has a stable
interface and has passed one end-to-end staging exercise. Require each subagent to
return: exact files changed, tests run, unverified assumptions, and whether it
expanded scope.

### Add explicit cost and frustration circuit breakers

For multi-model work, set these before work starts:

- a token/time budget for the first delivery;
- a maximum number of live attempts before a design reset;
- an escalation trigger for repeated failures in the same subsystem;
- a rule that no new release capability lands during incident recovery unless it
  directly explains or prevents the observed failure;
- a short written decision after each failed live attempt: retry, reduce scope,
  manual fallback, or stop.

These controls turn frustration into a visible engineering signal instead of a
reason to keep investing in the same direction.

## How to reuse the work without repeating the cost

The reusable outcome should be a **small set of patterns**, not a mandate to copy
this release system wholesale.

| Reuse now                                                                                                                                                                                    | Keep as reference only                                                                                                                    | Do not copy without a new need                                                                                        |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Explicit environment configuration, secret references, Gitleaks, CSP/WebSocket setup checks, bounded browser smoke, native branch protection, manual production dispatch, sanitized evidence | Provider inspection adapters, artifact verification helpers, staging smoke scenarios, recovery evidence examples, documentation structure | The full lineage/recovery/adoption framework, all historical-resolution paths, or a large stack of release-system PRs |

For Project Calavera, extract a template that asks projects to choose their own
level of maturity:

1. **Basic:** protected branch, preview deployment, manual release checklist.
2. **Coordinated:** explicit multi-provider targets, staging smoke, manual
   promotion workflow, sanitized evidence.
3. **Resumable:** sealed artifacts, provenance, recovery records, and tested
   workflow-level resume.

Projects should start at Basic or Coordinated. Resumable should be opted into only
after repeated releases justify its operational cost.

## Immediate conclusions for Ephemeral Pages

**Observed fact:** the latest recovery failed before production mutation, its cause
was discarded by a bare catch, and no diagnostic artifact was retained. The
published Netlify application has not been replaced by the attempted ordinary
release. The Worker and application therefore require fresh, read-only inspection
before anyone chooses the next operation.

**Interpretation:** the next action should be read-only reproduction of the failed
preflight against its historical evidence, with the underlying cause captured.
Prove the complete corrected path before another attempt through the existing
protected workflow. This retrospective does not authorize bypassing source checks,
branch protections, or serialized production operations. Broader simplification
belongs after completion, not in another launch-critical rewrite.

The simplest safe next decision record should state the current live pair, the
desired pair, the approved fallback, the evidence required after each mutation,
and the single person or workflow allowed to mutate it. Once production is stable,
freeze release-framework expansion and move reusable lessons into Calavera as
opt-in templates.

## Coordinator review: additional context and corrective commitments

This section supplements the independent draft with details retained in the
coordinator's compacted operational notes and the latest workflow inspection.
It does not recover unavailable conversation turns or redacted values.

### The three recent failures were different

| Run                                                                                        | Established failure                                                                                                                                                      | What remains unknown                                  |
| ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------- |
| [34693466555](https://github.com/schalkneethling/ephemeral-pages/actions/runs/34693466555) | Cloudflare version inspection timed out after Worker activation; the CLI then remained alive after recording failure. Netlify publication did not occur.                 | Why that read timed out.                              |
| [34694123592](https://github.com/schalkneethling/ephemeral-pages/actions/runs/34694123592) | Resume rejected writable files produced by artifact extraction. Actual retained files reproduced the issue; restoring only expected modes made strict verification pass. | This does not explain the earlier Cloudflare timeout. |
| [34698033756](https://github.com/schalkneethling/ephemeral-pages/actions/runs/34698033756) | Recovery preflight exited before mutations. The entry-point catch discarded the exception; downloading diagnostics returned no valid artifacts.                          | The underlying preflight exception.                   |

To the operator these looked like the same failure because the system repeatedly
failed to provide a usable explanation. Distinguishing error causes is essential,
but it does not excuse that recurring experience. The common failure was an
incomplete operational contract across execution, diagnosis, and recovery.

### Test volume was not the missing ingredient

The repair had 119 focused passing tests, then 101 tests on the review follow-up,
strict checks of copies of both real historical bundles, independent review, and
successful staging calibration. These counts are overlapping validation snapshots,
not an additive measure of coverage. None proved the whole recovery preflight with
its historical GitHub inputs in the actual workflow. A known local function-packaging
fixture failure also reproduced on the unchanged base; CI packaging passed. That
distinction must remain visible instead of reporting an undifferentiated “all green.”

Future acceptance should name each untested boundary, not merely enumerate passed
suites. One complete cross-job failure exercise would have been more informative
for this risk than additional tests of already-proven local components.

### We had already demonstrated that simplification works

Earlier in the thread, overly specific collaboration checks were removed in favor
of prose in PR.md. The user rejected unnecessary AGENTS expansion, preferred native
branch protections, declined Changesets as a dependency, and accepted a bounded
one-time fail-forward decision over a legacy restore subsystem. These are examples
of sound product judgment, not resistance to quality. The coordinator should have
applied that same judgment proactively to the release framework as a whole.

The security configuration utility was an explicit candidate for reuse in Project
Calavera. That did not make every later repository-specific release mechanism a
mandatory reusable library. Extract only interfaces demonstrated by another consumer.

### Ownership and communication need to change

The coordinator owns recommending proportionate scope and accurately describing
readiness. User approval does not transfer responsibility for cumulative design
cost to the user. “The tests pass” and “this is the final phase” should never imply
that an unexercised operational path is proven. Repeated assurances that completion
was near were especially costly when each repair created another rehearsal and
promotion cycle.

Use a compact status record: completed outcome, live state, unresolved blocker,
evidence supporting the next action, and remaining untested boundary. Preserve it
across compaction. Distinguish a tool approval delay from an actual provider error.
Set up secure secret references early and batch the genuinely user-dependent setup
steps; do not repeatedly ask for authorization already supplied. Never “solve”
redaction by discarding the diagnostic cause.

### Cost hypotheses must remain hypotheses

Repeated context reconstruction, dependent PR reviews, invalidated candidates,
workflow waiting, and multiple-agent handoffs plausibly contributed substantially
to cost. The available evidence cannot assign token percentages to those causes
or establish that a different model alone would have solved the problem. Model
tiering helps only when task boundaries and acceptance criteria are clear.

For future work, agree on a budget before starting and measure it where tooling
permits. Prefer one coordinator plus a bounded implementation or review agent until
parallel work is demonstrably independent. Count successful operational increments,
not generated code, number of PRs, or tests added. Stop expanding scope when the
budget or repeated-failure threshold is reached.

### Commitments that can be checked on the next project

| Owner                    | Change                                                                                  | Evidence that it happened                                                                                          |
| ------------------------ | --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| Coordinator              | Establish scope, deferrals, risk acceptance, and budget before implementation.          | A short approved charter and scope ledger.                                                                         |
| Implementer              | Prove external contracts and failure-artifact transport before expanding orchestration. | A successful normal workflow and a deliberately interrupted cross-run exercise.                                    |
| Reviewer                 | Review the integrated error boundary as well as individual wrappers.                    | Injected preflight failure retains a safe cause and terminates correctly.                                          |
| Coordinator              | Diagnose before retrying; reassess repeated failures.                                   | Each retry links to a reproduced cause or new discriminating evidence.                                             |
| Coordinator              | Integrate frozen, reviewed revisions from agents.                                       | Known commit and final diff, with no copying from a temporarily reverted worktree.                                 |
| Coordinator and operator | Verify the runbook independently of chat history.                                       | Another operator can identify, release, inspect, and select supported recovery without reconstructing this thread. |

These are proposed collaboration practices, not new automated gates implemented
by this documentation change. The revised plan turns them into delivery checkpoints.

## Limits of this retrospective

This report cannot establish the root cause of the first Cloudflare timeout, the
latest recovery preflight failure, total model-token consumption, vendor charges,
or every decision in compacted conversation turns. It deliberately does not assign
those unknowns a cause. The current code does establish a concrete diagnostic gap:
bare recovery and production CLI catch blocks discard exceptions, and that gap is
consistent with the latest failure being opaque.
