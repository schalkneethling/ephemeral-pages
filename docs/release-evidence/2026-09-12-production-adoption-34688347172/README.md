# Verified production Worker adoption — 12 September 2026 UTC

[Production run 34688347172](https://github.com/schalkneethling/ephemeral-pages/actions/runs/34688347172)
passed on main commit `7a7b25b9c6cd631e8762cb504c01ad7d5e56f8a0`, after promotion PR #64.
The source tree matched staging candidate `a8622df4bd49230c2d544c71ff8b942489325aa8` and
[successful rehearsal 34687788855](https://github.com/schalkneethling/ephemeral-pages/actions/runs/34687788855).
Exact-main CI and secret scanning passed. A subsequent Netlify Git build completed without replacing
published `main@65aab59`; the dashboard still reported Auto Publishing Locked.

The retained archive was independently downloaded and hash-verified: artifact `10296970037`,
SHA-256 `9b29837b45c4762bd6e2214cbfa02673f0fb9948550b73d2912b438039298ffe`.
[Verification](verification.json) and the [adoption record](adoption.json) bind the
[prepared release](prepared-release.json), source, provider IDs and completed stages.
`validateCompletedAdoption` passed before deriving the baseline; `validateAdoptionRecoveryArtifact`
passed for the generated recovery target.

Verified pair:

- Netlify retained deployment `6aa43cfb4b7bde0008cfc4d9`, source `65aab59bd6ec4a9ae84aa55f8154287b5bbd9e8b`.
- Worker deployment `4cac129b-ed26-45b4-94e3-d0730930daee`, version `8c17bf49-e1f2-465a-8ddb-cb990f2c1cf7`, at 100% traffic.
- Worker source `7a7b25b9c6cd631e8762cb504c01ad7d5e56f8a0`.

The [production smoke](smoke.json) passed upload, editor/viewer enforcement, synchronization,
reload persistence, actual network-loss recovery and screenshot PNG download. It used one upload
and one capture. No editor capability, page contents, tickets or raw browser traces are retained.

This establishes [the production baseline](../production-baseline.json) and
[adoption-backed recovery target](../recovery-target.json). The latter claims only the newly deployed
Worker artifact; it deliberately does not claim a Netlify artifact from adoption. Recovery remains
subject to artifact/provider retention and compatibility checks; the archive expires on 19 September.

The one-time adoption gate is now disabled and ordinary production orchestration enabled in policy.
This policy change still requires protected-stage approval rehearsal and a separate stage-to-main
promotion before ordinary production deployment. The updated application has not yet shipped.
