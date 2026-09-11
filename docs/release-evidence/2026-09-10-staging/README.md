# Staging artifact rehearsal — 10 September 2026

This is historical calibration evidence for release tooling in PR #47, not approval to promote a
future candidate. Follow the parameterized [release process](../../releases.md) for every release.
Production was not deployed and its publishing settings were not changed.

## Candidate and outcome

Candidate: `e0508d5fbf1f5cb7ffb8440918e6ac6b7c720355`.
Source tree: `9ba88cec15648a4a785a172408c49540cf0635d0`.

Separate staging and production preparation passed from private detached checkouts, using frozen
installs for both package boundaries. Each produced target-specific static assets/CSP, ten Netlify
function ZIPs and deployment configuration, and the Worker bundle. Production preparation was local
only. The preparation records contain the configuration fingerprints and inventory hashes.

The staging rehearsal passed every recorded stage: configuration inspection, held Netlify upload,
Worker upload and activation, live pair observation, old-app/new-Worker smoke, prepublication
inspection, explicit Netlify publication, and final pair observation and smoke.

Both smokes passed collaborative upload, editor/viewer authorization, two-editor synchronization,
reload persistence, actual network-loss recovery, and PNG screenshot download. Total usage was two
short-lived pages and two screenshot requests. The reports contain no page identifiers, editor
capabilities, tickets, contents, screenshots, or browser traces.

## Provider identities

| Service            | Prior target                           | Verified target                        |
| ------------------ | -------------------------------------- | -------------------------------------- |
| Netlify deployment | `6aa3071fc4ae7b28250acde7`             | `6aa327145fc723d7169c4879`             |
| Worker deployment  | `c7f6d649-0b62-4b1f-82a2-213e2d4b23a9` | `cde14431-97b0-4c07-9469-3e68453c2e62` |
| Worker version     | `b781f975-c8ce-42cf-9e8f-7aa49bafdfc1` | `72189329-0b90-49fb-84ed-eed1c022ff76` |

Netlify site: `9c45026a-d351-40e0-a9ed-2eb9dee63bd3`, at
`https://ephemeral-pages-staging.netlify.app`.
Worker: `ephemeral-pages-collaboration-staging`, at
`https://ephemeral-pages-collaboration-staging.volume4-schalk.workers.dev`.

Netlify retained the candidate deployment ID during explicit publication. The previous deployment
remained live while files and functions uploaded and while the Worker transition was verified.
Cloudflare activated the uploaded version at 100% traffic without a Durable Object migration.

## Verification limits and remaining gates

Netlify omitted the false `draft` field and returned function acknowledgements containing only the
function name. The verifier accepts these schema-valid omissions, checks explicit production context
and the exact name, and rejects any returned hash mismatch. Local hashes bind the exact upload
buffers. Inactive function and Worker bytes cannot be independently downloaded through these APIs;
provider identifiers/metadata and live smoke supplement local integrity checks.

Earlier calibration attempts stopped before Worker activation and were reconciled against the live
pair. Their incomplete Netlify candidates were left unpublished; no automatic retry or rollback
occurred. This successful run exercised the corrected path.

The durable records here retain sanitized outcomes and identities, not executable bundles or full
resumption checkpoints. Missing or expired artifacts must block resumption. Prior IDs do not promise
indefinite provider retention or prove rollback compatibility.

Production promotion, durable workflow checkpoints/resumption, explicit recovery, retention and
rollback drills, and automatic-publishing cutover remain separate implementation gates. The complete
stack must be integrated and its final candidate rehearsed before production approval. Changes after
this candidate invalidate using this run as approval for those changes.
