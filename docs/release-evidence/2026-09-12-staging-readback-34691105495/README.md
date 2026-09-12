# Repeated staging readback failure — 12 September 2026 UTC

Approval rehearsal [34691105495](https://github.com/schalkneethling/ephemeral-pages/actions/runs/34691105495)
ran candidate `36f2eb844bb276db549955bbbb8f070224a39359`. History validation and preparation passed.
Both provider writes and all six transition smoke checks passed. The immediate post-publication
inspection failed again. The CLI exited with status 1 and retained diagnostics without cancellation.
No production approval was created.

Diagnostic artifact `10296254400` was downloaded and hash-verified against SHA-256
`cf8679f014253a92055a09c303f07533fa000976f83bc853406e415ed8f387ab` before extraction.
The [failed report](rehearsal.json) records both returned IDs. Subsequent read-only inspection of
the exact provider operations passed; Netlify site and deploy responses both reported ready and
locked, and all configuration checks matched. A fresh six-check smoke passed, followed by
[another provider inspection](inspection.json) confirming the unchanged pair:

- Netlify deployment: `6aa537783dd4928b0555a76c`
- Worker deployment: `310f0d0f-45df-4a88-b222-af90661c9e77`
- Worker version: `4956cf22-d611-4358-8ac5-ddbd59fd36eb`

The code checks only the published deployment ID when publication returns, then immediately
requires stronger readiness and lock agreement across two API responses. Delayed propagation is
a plausible explanation, not a proven cause: the old inspection discarded the underlying error.
The correction must retain specific safe diagnostics and observe the exact pair within a bounded
deadline without repeating publication. Failed attempts must remain visible even if observation
subsequently succeeds.

The [reviewed resolution](../rehearsal-resolutions/34691105495.json) binds the failed archive/report,
[final-pair record](../rehearsal-resolutions/34691105495-recovery.json), and
[passed smoke](../rehearsal-resolutions/34691105495-smoke.json). It clears history only after fresh
provider inspection, never supplies production approval, and required no additional deployment.
The first ordinary production release remains pending a successful fresh approval rehearsal.
