# Production recovery — 12 September 2026 UTC

[Recovery 34700516404](https://github.com/schalkneethling/ephemeral-pages/actions/runs/34700516404)
passed on protected main commit `f37bfb36f159b0bae2b786213f640ff308be406c` after exact-main CI.
It used the latest unresolved release attempt `34694123592`. All five recovery stages
passed. Transition and final-pair browser smokes each passed all six checks, including
network-loss recovery and screenshot download.

The locked Netlify deployment `6aa43cfb4b7bde0008cfc4d9` was retained. Worker version
`8c17bf49-e1f2-465a-8ddb-cb990f2c1cf7` was restored under new deployment
`96462fa9-6f87-4983-aafd-b18fb609d070`. Source attribution remains Netlify `65aab59`
and Worker `7a7b25b`; restoring a version does not change its source commit.

The GitHub artifact was verified against its recorded digest and extracted before
validating completed recovery evidence. The checked-in baseline and recovery target
were derived from that completed record, not inferred from the requested historical
pair. Their Worker deployment ID is the actual restored ID. The target still references
the verified original adoption artifact for the unchanged Worker version.

See [verification.json](verification.json), [recovery.json](recovery.json),
[transition smoke](transition-smoke.json), and [pair smoke](pair-smoke.json).
Artifacts expire according to the verified metadata; retained IDs do not guarantee
permanent provider rollback availability.

This completes recovery, not the new application release. A fresh rehearsal and
production approval are required for the candidate containing the recovered baseline.
