# Protected staging calibration checkpoint — 11 September 2026

This is the historical attempt log. See [the 11 September UTC recovery checkpoint](../2026-09-11-staging-recovery-34652303609/README.md)
for the completed protected restore and resume.

The release stack and toolbar fix are merged into `stage`. Required CI and secret scanning passed
for candidate `afbab10286fb89cecdd80a07d9e12eb14e213c11`.

[Calibration run 34635706500](https://github.com/schalkneethling/ephemeral-pages/actions/runs/34635706500)
installed dependencies and Chromium, then stopped before artifact preparation or provider deployment.
The runner expected a workflow path ending in `@stage`; GitHub returned the repository-relative path
`.github/workflows/release-rehearsal.yml`, with branch and commit in separate fields. The diagnostics
upload step completed but found no artifact files because execution had not reached preparation.

This failed attempt does not count as rehearsal A or B and does not authorize recovery or production.
Correct the metadata contract while retaining independent branch, commit, workflow identity, and
protected-environment verification, then start a fresh calibration on the reviewed corrected candidate.

The operator accepted a one-time fail-forward production adoption. No legacy restore subsystem will
be added. Production adoption, live staging recovery, and publication cutover remain unverified.

## Second attempt

[Run 34637502589](https://github.com/schalkneethling/ephemeral-pages/actions/runs/34637502589)
on corrected candidate `d69d85af6631053b910abd4be6f68c675e4b0876` passed GitHub verification and
artifact preparation. See [the preparation record](preparation-34637502589.json) and
[the rehearsal record](rehearsal-34637502589.json). Provider inspection blocked before any deployment
stage or provider write checkpoint. The isolated inspection command environment omitted the provider
tokens available to the parent workflow. The correction must forward only the intended provider's
token to its own CLI; build environments and retained evidence remain credential-free.

This attempt also does not count as rehearsal A or B. Start a fresh calibration only after the
correction passes review, is merged into `stage`, and that exact staging commit passes protected CI.

Read-only verification of the corrected inspection environment passed for both staging providers
using the existing 1Password-backed tokens through Varlock. Expected non-secret variables, required
secret names, and Netlify scope checks matched. No deployment was performed by that check; the
protected workflow must still demonstrate successful deployment and smoke verification.

## Third attempt

[Run 34639972407](https://github.com/schalkneethling/ephemeral-pages/actions/runs/34639972407)
on candidate `967bafae7e040958488bf34a76e0701659092d27` passed preparation, provider inspection,
held Netlify upload, Worker upload, activation, and live Worker observation. The old-app/new-Worker
smoke then stopped because the existing app returned HTTP 500 during authenticated upload. See
[preparation](preparation-34639972407.json), [rehearsal](rehearsal-34639972407.json), and
[transition smoke](transition-smoke-34639972407.json).

A deliberately invalid bearer token with an empty request body confirmed that the deployed app
reports missing GitHub OIDC configuration before token validation or page creation. The site-level
`GITHUB_OIDC_AUDIENCE` setting exists, but the published deployment predates that setting.

The old Netlify deployment `6aa327145fc723d7169c4879` remains published. The prepared candidate
`6aa4591d5a330dbc6ee4bd01` remains unpublished. Worker deployment
`5692b4ef-bcb1-4635-9e91-62411c9ee82c`, version `a8bd1a52-3e0a-4e3f-a791-ec6d3e668cd9`,
is active. There was no automatic rollback, no final-pair smoke, and no production mutation.
This failed attempt does not count as rehearsal A or B.

## Old-app runtime configuration refresh

A separate local staging bootstrap operation redeployed the exact retained Netlify artifact from
candidate `e0508d5fbf1f5cb7ffb8440918e6ac6b7c720355`, with inventory SHA-256
`89d58b657f0396a3573b66bb0b35c9513d766bce37c0878a4debfdac688fb4c4`.
The artifact and historical preparation/rehearsal binding were verified before provider mutation.
The existing upload/hold and publish adapters created and published deployment
`6aa45e304f4fd676a16c545e`, applying the current site environment to the unchanged app bytes.

Before publication, the atomic deployment URL returned the expected HTTP 401 invalid-token response
for a deliberately invalid bearer token and empty body. The stable staging origin returned the same
response after publication. The Worker deployment/version remained `5692b4ef-bcb1-4635-9e91-62411c9ee82c`
and `a8bd1a52-3e0a-4e3f-a791-ec6d3e668cd9`. No page was created by these probes.
See [the sanitized refresh record](netlify-runtime-refresh.json).

This repaired runtime configuration, not candidate compatibility. The new app from the failed
calibration remains unpublished. A fresh protected calibration must still pass both full browser smokes.

## Successful protected calibration A

[Run 34642239601](https://github.com/schalkneethling/ephemeral-pages/actions/runs/34642239601)
on the same reviewed candidate `967bafae7e040958488bf34a76e0701659092d27` passed after the
runtime refresh. All ten rehearsal stages passed. Both browser smokes verified collaborative upload,
editor/viewer roles, two-editor synchronization, reload persistence, actual network-loss recovery,
and PNG screenshot download. Total usage was two short-lived uploads and two screenshot requests.

See [preparation](preparation-a.json), [rehearsal A](rehearsal-a.json),
[transition smoke](transition-smoke-a.json), and [final-pair smoke](pair-smoke-a.json).
The verified pair is:

- Netlify deployment: `6aa45f0f2b404d22d09d9b75`.
- Worker deployment: `3e1252c7-2f45-4b00-a582-c940e01e1e79`.
- Worker version: `57437e24-e988-44bd-b9f1-b65180c0c0e5`.

The workflow retained the complete `release-rehearsal-diagnostics` artifact for seven days. These
repository records are sanitized summaries, not a replacement for its bundles and checkpoints.
Calibration mode issued no production approval. Next, merge the reviewed evidence update into
`stage`, validate its exact commit, and obtain calibration B with unchanged deployment configuration
and A as its prior pair. Then exercise explicit B-to-A staging recovery with both retained run IDs.

## Successful protected calibration B

[Run 34643899329](https://github.com/schalkneethling/ephemeral-pages/actions/runs/34643899329)
on reviewed candidate `8b0a0e306cdaeebc2ec3b706c563350b974761f2` passed all ten rehearsal stages
and both full browser smokes. This candidate includes the reviewed documentation checkpoint in
PR #53; its deployment configuration fingerprint is identical to A. B's prior pair exactly matches
A's observed pair, and each resulting deployment/version ID is distinct.

See [preparation](preparation-b.json), [rehearsal B](rehearsal-b.json),
[transition smoke](transition-smoke-b.json), and [final-pair smoke](pair-smoke-b.json).
B's verified pair is:

- Netlify deployment: `6aa46366dace99455126237f`.
- Worker deployment: `4bb572cc-8991-4127-8fbe-1bd76f219a37`.
- Worker version: `6e4ee754-a886-40cd-82aa-6966123385fa`.

Usage was two short-lived uploads and two screenshot requests. The complete diagnostics artifact is
retained for seven days. Calibration issued no production approval.

## Recovery preflight correction

[Recovery run 34644336012](https://github.com/schalkneethling/ephemeral-pages/actions/runs/34644336012)
stopped during GitHub evidence preflight. The credentialed restore step was skipped, so B remains
live. No recovery workspace artifact was created. The verifier constructed the workflow lookup URL
using the full repository path; the GitHub API requires a workflow ID or filename in that URL.
The full-path request returned HTTP 404, while the filename request returned the active workflow.
The same correction is required for the workflow run-history URL.

After the focused correction passes review, is merged into `stage`, and that exact commit passes CI,
dispatch a fresh recovery with B run `34643899329` and A run `34642239601`. This preflight-only
failure does not require a resume ID because the provider mutation step never ran. Retained A/B
artifacts and live targets must still pass the normal verification gates.

Read-only validation of the corrected verifier accepted the real diagnostics metadata for both A
and B, including their successful run identities, artifact digests, sizes, and expiry. Four regression
cases failed against the previous endpoint construction and passed with the correction. This validates
the lookup fix; only a fresh protected recovery run can verify the complete restore operation.

## Recovery checkpoint compatibility correction

[Run 34646374702](https://github.com/schalkneethling/ephemeral-pages/actions/runs/34646374702)
on reviewed candidate `44e04d300bb424cf1459c9ef562b205c3675befe` passed the corrected GitHub
lookups and downloaded both A/B diagnostic archives. It then blocked while reading the provider
evidence. The recovery reader expected a legacy Netlify publish checkpoint without a `phase` field;
the actual deployment adapter emits `phase: "pending-mutation"` before publication and a separate
response checkpoint afterward. The strict legacy schema therefore found no matching pending publish.

The credentialed restore step was skipped again, leaving B live. The failed run retained both sealed
A/B directories in its `release-staging-recovery` artifact, but no completed recovery preflight or
provider-write record. Align the reader with the adapter's emitted checkpoint and retain strict
uniqueness and deployment/hash binding. Validate the complete real A/B evidence through the corrected
reader before a fresh protected recovery attempt; this preflight-only failure does not require resume.

The corrected strict reader now accepts both complete retained A/B directories with their real
GitHub artifact metadata. The combined recovery source schema and current configuration-lineage
validation also pass. Seven focused cases fail with the previous checkpoint schema; the corrected
suite passes and rejects missing, duplicate, or unexpected pending evidence while retaining response
records. This read-only check performed no provider mutation and does not replace the live drill.

## Interrupted live restore and portable resume correction

[Run 34648240950](https://github.com/schalkneethling/ephemeral-pages/actions/runs/34648240950)
on reviewed candidate `061556107604f96bb39a084a7527fb398a1f42f9` passed complete A/B preflight,
verified both recovery targets, and restored Netlify A. Readback confirmed Netlify A with Worker B.
The transition smoke created one short-lived page, then blocked at editor/viewer role verification.
No screenshot was requested and no Worker mutation began. See [the interrupted record](recovery-interrupted.json)
and [the blocked smoke](recovery-transition-blocked.json).

A separate local diagnostic on the same mixed pair observed successful ticket requests and the
expected roles for the proxied editor, direct editor, and viewer. A full local smoke then passed
viewer controls, synchronization, reload persistence, actual network-loss recovery, and PNG capture.
These checks used two short-lived uploads and one screenshot. The original role failure was not
reproduced; the local result did not substitute for protected workflow verification.

[Explicit resume 34648899133](https://github.com/schalkneethling/ephemeral-pages/actions/runs/34648899133)
accepted the retained recovery artifact and preserved the completed Netlify result, then blocked in
inspection before smoke or further mutation. See [the resume record](recovery-resume-blocked.json).
The provider inspection fingerprint included absolute artifact and checkout paths, so moving the
verified bundle into a new workflow workspace changed the expected fingerprint.

The correction binds inspection to deployment identities, configuration, and artifact hashes rather
than temporary paths. The existing checkpoint requires explicit read-only reinspection before its
fingerprint can be updated, and only while no Worker restore has started. The prior archived evidence
remains intact. A fresh protected resume must still demonstrate completion.

Cloudflare restores a version through a new deployment ID. Completed-history verification must bind
that new ID to the recorded result and observed pair while requiring the requested Netlify deployment
and Worker version; it must not require the original target's Worker deployment ID.

The corrected adapter passed read-only reinspection against the real retained resume record and
current providers, producing version-2 evidence for Netlify A / Worker B. Local artifact verification,
provider configuration, target retention and exact mixed-pair checks passed without mutation. This
validates the portable evidence correction; only the next protected resume can complete the drill.
