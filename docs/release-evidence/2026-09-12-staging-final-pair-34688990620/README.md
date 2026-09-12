# Staging final-pair verification — 12 September 2026 UTC

Approval rehearsal [34688990620](https://github.com/schalkneethling/ephemeral-pages/actions/runs/34688990620)
ran candidate `f48a842bb8e95f20a83db7cf775136234675bbc5`. Both provider writes completed;
Netlify readback failed. The CLI reported failure but retained an active runtime handle, so the
operator cancelled the workflow normally to allow its diagnostic artifact upload to finish.
This run did not issue production approval.

The retained diagnostic artifact is `10296292454`, with SHA-256
`a83de171e16c18bb7610f67a5f03171f31420007a4dca8c628570a9748778772`.
Its downloaded bytes were verified before extracting the [failed report](rehearsal.json).

A subsequent read-only inspection matched the returned provider IDs. A fresh full staging smoke
passed upload, editor/viewer authorization, synchronization, reload persistence, network-loss
recovery, and PNG download, consuming one upload and one capture. A second
[read-only inspection](inspection.json) after that smoke confirmed the pair remained unchanged:

- Netlify deployment: `6aa52bfbf919906bd91a0136`
- Worker deployment: `e8c972e6-b74b-47ab-8440-232138e31fe9`
- Worker version: `07ec6ca7-4864-4c87-aff7-104ffee987ae`

No rollback or further provider write was performed to obtain this verification. The reviewed
[resolution](../rehearsal-resolutions/34688990620.json) binds the failed archive and report,
[final-pair record](../rehearsal-resolutions/34688990620-recovery.json), and
[passed smoke](../rehearsal-resolutions/34688990620-smoke.json). The history guard must inspect
providers again before permitting a fresh rehearsal. This resolution clears interrupted history;
it does not change the failed outcome or approve any candidate for production.
