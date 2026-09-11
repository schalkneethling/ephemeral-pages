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
