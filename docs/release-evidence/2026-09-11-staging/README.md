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

This attempt also does not count as rehearsal A or B. Start a fresh calibration after the correction
passes review and protected staging CI.

Read-only verification of the corrected inspection environment passed for both staging providers
using the existing 1Password-backed tokens through Varlock. Expected non-secret variables, required
secret names, and Netlify scope checks matched. No deployment was performed by that check; the
protected workflow must still demonstrate successful deployment and smoke verification.
