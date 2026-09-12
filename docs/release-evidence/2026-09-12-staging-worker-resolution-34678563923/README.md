# Staging Worker-only recovery — 12 September 2026 UTC

The interrupted calibration [34678563923](https://github.com/schalkneethling/ephemeral-pages/actions/runs/34678563923)
for candidate `93a8c0862efd7d981b690d6d461d6c51dbd7b054` activated the Worker, then stopped during
transition synchronization. Netlify retained its previous deployment; the prepared draft was never
published. Two diagnostic local smokes subsequently passed, but did not establish workflow completion.

The explicit operator recovery restored the Worker version from successful calibration
[34652674501](https://github.com/schalkneethling/ephemeral-pages/actions/runs/34652674501), using the
existing recovery adapters from a clean checkout of the failed candidate. The helper accepted only the
verified failed/current pair and verified target artifact evidence, checkpointed before its one Worker
activation request, persisted the returned deployment ID, and verified the resulting live pair. It
rejected Netlify restore operations. No production operation occurred.

| Service            | Before recovery                        | Verified after recovery                |
| ------------------ | -------------------------------------- | -------------------------------------- |
| Netlify deployment | `6aa47c40f0b74e3ac28b75ea`             | `6aa47c40f0b74e3ac28b75ea` (unchanged) |
| Worker deployment  | `f8e366e9-f76c-4464-850b-dbc0f304b32a` | `f9737b9b-d15e-4ef3-b063-7948f22a2662` |
| Worker version     | `3bd41af3-70a2-42d2-a7e0-f087af16d3a9` | `c12bb05c-bf4e-408f-b96f-e4b65d13a07a` |

The target's historical Worker deployment was `5c3f38ce-eca7-44d5-8591-b3f411f18ee6`; recovery created
a new deployment ID for the same version. A subsequent real browser smoke passed upload, role
enforcement, two-editor synchronization, reload persistence, actual network-loss recovery, and PNG
capture. That smoke consumed one short-lived page and one capture.

The failed workflow consumed one page and no capture. Two pre-recovery local diagnostic runs consumed
one page and one capture each; one has a retained report here, while the other was observed only in
agent output and is not claimed as durable verification. Total incident usage was four pages and
three capture requests, including the post-recovery smoke. Fixtures expire after one hour.

Evidence:

- [Original sanitized operator record](worker-resolution.json), retained byte-for-byte.
- [Verified GitHub artifact inputs](verified-inputs.json), including archive digests and report hashes.
  The temporary extraction paths document where verification ran; they are not reusable inputs.
- [Interrupted rehearsal](failed-rehearsal.json) and [its transition smoke](failed-transition-smoke.json).
- [Retained diagnostic local smoke](diagnostic-local-smoke.json).
- [Reviewed resolution](../rehearsal-resolutions/34678563923.json),
  [recovery projection](../rehearsal-resolutions/34678563923-recovery.json), and
  [post-recovery smoke](../rehearsal-resolutions/34678563923-smoke.json).

The recovery helper SHA-256 was `d237de8059be5e8ad108c594dddb61faab8c14c989b8f2dd068949869729f501`.
Its eight regression tests and independent review passed before execution. Initial 1Password
transactions timed out before provider writes; the successful execution created the sole recovery
record. No ambiguous provider operation was retried.

This record establishes staging recovery, not a successful rehearsal of the changed release runner
or production approval. Integrate the reviewed resolution and history guard into protected `stage`,
then rehearse the exact new candidate. Production adoption, controlled publication cutover, and the
first coordinated production release remain outstanding.
