# Coordinated releases — revised delivery plan

Written retrospectively on 12 September 2026. This is an alternative to the
[preserved original plan](coordinated-releases.md), not a claim that this process
was followed. Production was subsequently confirmed working by the operator; this
plan is a historical alternative, not a pending deployment checklist. See the
[retrospective](../docs/coordinated-release-retrospective.md).

## Outcome and limits

Deliver a repeatable, operator-understandable release of the Netlify application
and Cloudflare Worker: explicit destinations, a known source, compatible deployment
order, observable verification, and an actionable response to partial failure.
Keep production mutations manually dispatched and serialized. Preserve secrets,
source integrity, migration restrictions, and native branch protection.

Deliver a narrow working release first, then generalize only demonstrated needs.
The original plan's automatic service selection, generalized resumability, broad
recovery state machine, stack routing enforcement, and comprehensive provenance
framework are not prerequisites for the first release. Where those remain desired,
deliver them in separately budgeted increments after proving the basic path.
This is sequencing, not a claim that a smaller first increment implements every
interface in the original plan.

## 0. Agree on scope and a cost boundary

Write a one-page release contract with the operator:

- Which app change is being shipped, which two services it affects, and who operates it.
- What interruption and fail-forward risk is acceptable for this product.
- What is irreversible, especially storage migrations and secret changes.
- A fixed first-release acceptance checklist and a separate deferred-work list.
- A user-approved effort or spend ceiling. Do not invent dollar estimates from
  subscription usage; use measured usage when available and report uncertainty.

The coordinator owns a scope ledger. New work must identify whether it removes a
demonstrated release blocker, replaces existing work, or belongs in a follow-up.
Approval of a useful idea is not an instruction to put it on the critical path.
At each increment, report outcome, remaining risk, and budget consumed if known.
At half the agreed budget, reassess scope; at the limit, stop and obtain a revised
budget instead of silently extending the project.

Keep toolbar work, generic repository setup utilities, security-script improvements,
and visual documentation as independent deliverables. Secret handling needed for
this release stays in scope; generalizing the secret-management system does not.

## 1. Prove the provider boundary before building a framework

Use the installed, pinned vendor CLIs and inspect their defining help/schema before
writing executable commands. Record explicit site/account IDs and Worker environment.
Perform read-only checks with the actual CI credential types as well as local credentials.

Run a disposable staging experiment that establishes:

- GitHub metadata responses match the API version and schema the tool will use.
- Netlify drafts contain the expected functions, scheduled metadata, assets, and CSP.
- The exact draft can be published to the staging origin and subsequently identified.
- The Worker bundle can be uploaded, activated, identified, and observed at that origin.
- A previous retained version can be restored where the provider and storage permit it.
- Files survive a real Actions upload/download cycle with content intact; filesystem
  permissions are transport properties to normalize, not evidence of content identity.

Record unknowns as unknowns. Test the smallest real integration for each unknown
before adding a validation rule or adapter abstraction. Do not infer provider contracts
from a mock that was written using the same assumptions as the implementation.

Exit: one verified staging deployment pair and a short list of supported operations
and limitations. If provider behavior blocks the proposed design, change the design here.

## 2. Ship one thin release path

Implement one shared execution path parameterized by staging or production; keep
environment-specific values outside it. Production adds protected invocation and
approval checks, not a second independently evolving orchestration implementation.

For the first compatible combined release:

1. Validate source, configuration, credentials, migration policy, and prior live IDs.
2. Build target-specific artifacts once and record content hashes and provider IDs.
3. Prepare a Netlify draft and upload the Worker without claiming either is live.
4. Activate the Worker and verify the old-app/new-Worker transition.
5. Publish the prepared Netlify draft and run the complete application smoke.
6. Record the observed pair and completion status.

Use native branch protection with documented stage-to-main routing. Do not implement
label-dependent routing or privileged PR metadata enforcement. Use at most two or
three cohesive PRs for this increment. Use stacked PR tooling only after verifying
repository support and only if it reduces review work; do not build infrastructure
to accommodate the chosen PR topology.

For the first release, select the compatible service pair explicitly in the reviewed
release record. Defer automatic affected-service detection. Do not deploy an unchanged
service merely to satisfy a framework assumption.

## 3. Make diagnosis and interrupted execution acceptance criteria

Create the diagnostic destination before preflight. Every failure, including missing
credentials, argument validation, and evidence verification, must produce a safe
stage/reason record, a nonzero exit, and an uploaded diagnostic artifact when the
workflow has artifact access. If upload fails, print an explicit safe fallback reason.

Preserve native causes internally. Persist allowlisted provider operation, error class,
exit/timeout status, and a safe reason code. Do not serialize arbitrary exceptions,
environment values, browser traces, tickets, editor capabilities, or response bodies.
Test both that causes remain distinguishable and that sensitive values do not escape.

Exercise the actual workflow and transport boundary:

| Scenario                                    | Required result                                                            |
| ------------------------------------------- | -------------------------------------------------------------------------- |
| Failure before workspace preparation        | Useful diagnostic artifact or explicit upload failure                      |
| Worker activated, Netlify not published     | Accurate mixed pair and no claim of completion                             |
| Timeout after a provider accepts a mutation | Inspect by recorded ID; never blindly repeat mutation                      |
| Artifact downloaded into a fresh job        | Hash and structure verification, permission normalization, successful read |
| Child process leaves handles alive          | Bounded termination after diagnostic persistence                           |
| Missing/expired recovery evidence           | Specific blocked reason, no mutation                                       |
| Runner changes after a failed release       | A rehearsed repair/recovery route without weakening candidate checks       |

Do not write generalized resume until the interrupted-job test proves it is needed.
Initially, an operator-reviewed recovery record plus an explicit serialized recovery
action may suffice. It must reconcile actual live state and validate the requested
target; manual operation is not permission to bypass integrity checks.

If no valid legacy rollback target exists, document the agreed one-time fail-forward
decision. Do not build a legacy restoration subsystem solely to avoid that accepted risk.

Exit: successful normal and interrupted cross-run staging exercises using the same
entry points, artifact transport, and credential boundaries intended for production.

## 4. Freeze the candidate and complete production

Freeze application and release-tool changes after acceptance. Obtain one focused
independent review of the integrated credential, identity, diagnostics, and recovery
boundaries. Address demonstrated blockers; put optional improvements in the backlog.

Rehearse the exact candidate, verify the promotion tree and exact-main checks, then
dispatch production once. Disable independent production publishing only after its
replacement has passed rehearsal; verify preview builds remain useful.

On failure, report stage, safe cause, observed pair, mutation status, and next diagnostic
action. Do not announce another attempt until a hypothesis is supported by evidence.
After a second failure at the same boundary, stop the release loop and reassess that
boundary's design and test coverage. Fix-and-retry is not itself a debugging strategy.

Use a reviewed recovery or forward repair only after its complete path has been
demonstrated against the failed run's evidence. Preserve candidate integrity: a runner
change invalidates approval, but test its historical-evidence compatibility before
paying for another full promotion cycle.

Exit: live application and Worker verified, expected automatic-publishing behavior
confirmed, completion record retained, and only actually shipped changelog entries dated.

## 5. Generalize from successful operation, not anticipated reuse

After the first release, ask a second operator to follow the runbook without chat history.
Fix the steps they cannot perform. Then prioritize automatic service planning, resume,
recovery convenience, and stronger provenance by observed frequency and impact.

Extract reusable subprocess/diagnostic contracts, smoke-test patterns, native protection
configuration, and release-record concepts into Project Calavera only when a second
consumer demonstrates the interface. Keep repository-specific origins, audiences,
branch policy, and storage compatibility in the application.

Retain the existing investment; do not rewrite it wholesale to enact this retrospective.
The remediation proposed at the investigation checkpoint was to reproduce the specific
recovery preflight failure read-only, capture its cause, and prove the corrected
historical-evidence path before continuing. That is historical context, not an instruction
to restart the subsequently completed release. Defer architectural cleanup to a separate task.

Each phase returns a validated handoff containing its source, artifact and deployment
identifiers, verification results, and terminal state. The next phase consumes that output
directly. Do not reconstruct inputs from chat or agent memory. A confirmed completed
release ends the task; optional follow-up work requires a separate scope.

## Agent and review budget

- Coordinator: owns source of truth, scope, integration, release decisions, and concise
  operator updates. Maintain one durable checkpoint with current commit, live pair,
  last failure, evidence locations, and next action across compaction.
- Terra, medium: bounded implementation, test, and documentation tasks with explicit
  input/output contracts. Start with one agent; parallelize only independent useful work.
- Sol, high: a bounded provider integration problem when demonstrated complexity warrants it.
- Astra, high: one focused independent review at the integrated release boundary;
  repeat only for changed risks or new evidence, not every routine documentation update.

Use isolated worktrees and integrate committed changes from a known frozen revision.
Do not copy files while an agent is temporarily reverting them for a regression test.
Keep provider mutations with the coordinator. Give agents a compact evidence packet
instead of repeatedly forwarding the entire conversation. Review is additional scrutiny,
not evidence that an unexecuted recovery path works.

## Expected improvement, not a retrospective guarantee

This sequence should reduce wasted work by testing external contracts first, exercising
cross-job failure paths before cutover, limiting simultaneous scope, and avoiding
repeated approval/rehearsal cycles for discoverable integration defects. It cannot
guarantee zero bugs or a particular token saving. Measure effort per successful increment,
number of release attempts, and time from failure to actionable diagnosis on the next project.
