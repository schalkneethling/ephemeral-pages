# Protected staging calibration checkpoint — 11 September 2026

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
