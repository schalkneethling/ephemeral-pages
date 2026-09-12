# Protected staging recovery checkpoint — 11 September 2026 UTC

[Recovery run 34652303609](https://github.com/schalkneethling/ephemeral-pages/actions/runs/34652303609)
on reviewed staging commit `293f5edbac5a9a29bbb3507a4910f677c6a66597` passed every recovery stage.
It resumed run `34648899133`, preserving the lineage back to the original live attempt
`34648240950`. Calibration B was run `34643899329`; target A was run `34642239601`.
See [the earlier attempts and A/B evidence](../2026-09-11-staging/README.md).

The run revalidated the retained staging checkpoint through read-only inspection and persisted
portable version-2 inspection evidence before further mutation. The Netlify restore journal is
unchanged from the original attempt: resumption did not repeat the completed Netlify mutation.
Both protected smokes passed upload, editor/viewer enforcement, synchronization, reload persistence,
actual network-loss recovery, and PNG screenshot download. Usage was two short-lived uploads and
two screenshots.

The recovered pair was:

- Netlify deployment: `6aa45f0f2b404d22d09d9b75` (A).
- Worker deployment: `97a5c130-4bb5-4758-827b-c5177319a2c9` (new rollback deployment).
- Worker version: `57437e24-e988-44bd-b9f1-b65180c0c0e5` (A).

The observed pair, recovered pair and provider results agree. Cloudflare restored A's version
through a new deployment, rather than reusing A's original deployment ID. See [the recovery record](recovery.json),
[transition smoke](recovery-transition-smoke.json), and [final-pair smoke](recovery-pair-smoke.json).

The complete `release-staging-recovery` artifact is retained by GitHub for seven days. These
sanitized repository records preserve the outcome but do not replace its sealed bundles or
checkpoints for resumption. The earlier role failure was not reproduced; it was not hidden by an
automatic retry or counted as passing. The explicit resume ran the protected checks again.

A normal forward calibration on the same reviewed staging commit also passed, as recorded below.
Staging calibration and recovery issue no production approval. Production publishing settings and runtime
were unchanged by this drill. The accepted one-time fail-forward Worker adoption, publication
cutover, and first coordinated production release remain outstanding.

## Forward calibration and final staging state

[Run 34652674501](https://github.com/schalkneethling/ephemeral-pages/actions/runs/34652674501)
prepared and deployed candidate `293f5edbac5a9a29bbb3507a4910f677c6a66597` after recovery. All ten
rehearsal stages and both full browser smokes passed. The prior pair exactly matches the recovered
pair above, including Cloudflare's new rollback deployment ID. The deployment configuration
fingerprint remains identical to A and B. Usage was two short-lived uploads and two screenshots.

The final observed staging pair is:

- Netlify deployment: `6aa47c40f0b74e3ac28b75ea`.
- Worker deployment: `5c3f38ce-eca7-44d5-8591-b3f411f18ee6`.
- Worker version: `c12bb05c-bf4e-408f-b96f-e4b65d13a07a`.

See [preparation](forward-preparation.json), [forward rehearsal](forward-rehearsal.json),
[transition smoke](forward-transition-smoke.json), and [final-pair smoke](forward-pair-smoke.json).
The workflow retained `release-rehearsal-diagnostics` for seven days and skipped production approval.

This completes the staging calibration, restore, resume and forward-deployment exercise. The
documentation-only follow-up records the exercised candidate; it does not claim that later source
changes are rehearsed or that production approval exists. A production candidate still needs its
applicable exact-source approval and release prerequisites.
