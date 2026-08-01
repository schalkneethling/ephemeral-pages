# CI Report Publishing API and GitHub Action

## Summary

Formalize and harden the existing `POST /api/pages` endpoint for automated CI clients, then publish a separate GitHub Action that uploads a self-contained HTML report and maintains a single comment on a same-repository pull request.

Deliver this through two GitHub issues and two pull requests:

1. `ephemeral-pages`: public API hardening and CI authentication support.
2. `ephemeral-pages-action`: standalone JavaScript Action for upload and PR commenting.

The API PR must be deployed before the Action is released.

## Issue 1: Harden the public page-creation API for CI

**Repository:** `schalkneethling/ephemeral-pages`  
**Suggested title:** `Harden the page creation API for CI report publishing`

### Goal

Turn the existing browser-facing `POST /api/pages` handler into a documented, stable public API suitable for unattended CI use without disrupting the current upload UI.

### Public API contract

Keep the existing route:

```http
POST /api/pages
Content-Type: application/json
```

Support two backward-compatible request forms:

```ts
interface PlainCreatePageRequest {
  html: string;
  expirationHours?: 1 | 3 | 5 | 7 | 12 | 24 | 72 | 120 | 168;
  encoding?: "identity";
}

interface BrotliCreatePageRequest {
  // Base64-encoded Brotli bytes.
  html: string;
  expirationHours?: 1 | 3 | 5 | 7 | 12 | 24 | 72 | 120 | 168;
  encoding: "br+base64";
}
```

Plain HTML remains the default for browser and curl clients. The Action uses `br+base64`, allowing highly compressible reports larger than Netlify’s 6 MB buffered-request limit to reach the handler while retaining the existing 20 MB decompressed and 2 MB compressed policy. [Netlify documents the 6 MB buffered payload limit here.](https://docs.netlify.com/build/functions/configuration/)

Return:

```ts
interface CreatePageResponse {
  id: string;
  createdAt: string;
  expiresAt: string;
  url: string; // Absolute https://ephemeral.schalkneethling.com/p/:id URL
}
```

Update the browser client to resolve `url` with `new URL(response.url, window.location.origin)` so it remains compatible with both older relative responses and the new absolute response.

### Authentication and actor identity

Authentication is optional:

- No `Authorization` header: process as an anonymous upload.
- `Authorization: Bearer <GitHub OIDC JWT>`: verify as a GitHub Actions upload.
- A supplied but invalid, expired, or incorrectly scoped bearer token returns `401`; it must never silently fall back to anonymous access.

Verify GitHub tokens using GitHub’s OIDC issuer and JWKS:

- Issuer: `https://token.actions.githubusercontent.com`
- Audience: `https://ephemeral.schalkneethling.com`
- Require valid signature, `exp`, `nbf`, issuer, and audience.
- Require non-empty `repository_id`, `repository`, `run_id`, and `run_attempt` claims.
- Use stable `repository_id`, not the mutable repository name, as the verified quota identity.
- Do not log JWTs or full claim payloads.

Add required configuration:

```env
GITHUB_OIDC_AUDIENCE=https://ephemeral.schalkneethling.com
```

Use a maintained JWT/JWKS library such as `jose`, with remote JWKS caching. GitHub Actions only needs `id-token: write` to obtain a short-lived token; no user-managed OIDC secret is introduced. [GitHub’s OIDC documentation describes the permission and claims.](https://docs.github.com/en/actions/reference/security/oidc)

### Rate limiting and abuse safeguards

Retain the selected application quota of ten uploads per ten-minute window:

- Anonymous uploads: 10 per 10 minutes per client IP.
- Verified GitHub uploads: 10 per 10 minutes per `repository_id`.
- Continue applying Netlify’s existing coarse limit of 120 requests per minute per IP and domain across `/api/*`.

Change anonymous actor derivation from `IP + User-Agent` to IP only. User-Agent is attacker-controlled and currently allows trivial quota evasion.

Continue HMAC-hashing rate-limit subjects before storage. Never store raw IP addresses or OIDC identities in Blob keys.

Make counters concurrency-safe:

- Extend the store adapter to return the record ETag.
- Use `onlyIfNew` for a new counter and `onlyIfMatch` for updates.
- Retry a bounded number of compare-and-set conflicts.
- Fail closed with `503` if a counter cannot be safely updated.
- Preserve cleanup of expired or malformed counter records.

Netlify supports conditional Blob writes through `onlyIfNew` and `onlyIfMatch`. [Netlify Blobs API documentation](https://docs.netlify.com/build/data-and-storage/netlify-blobs/)

Return these headers on application-limited responses:

```http
Retry-After: <seconds>
X-RateLimit-Limit: 10
X-RateLimit-Remaining: 0
X-RateLimit-Reset: <unix-seconds>
```

Include remaining/reset headers on successful uploads where practical.

No global daily quota is added in this iteration. Function and Blob usage must be monitored after release so a separate global cost ceiling can be introduced if real usage warrants it.

### Compressed request validation

For `encoding: "br+base64"`:

1. Reject malformed or non-canonical base64.
2. Reject compressed data over 2 MB before decompression.
3. Brotli-decompress with a hard 20 MB output limit.
4. Decode as UTF-8 and reject invalid data.
5. Run the same parse5 document validation used by plain uploads.
6. Store the decompressed HTML exactly as the page content.

Return:

- `400` for malformed JSON, invalid base64/Brotli, invalid HTML, or unsupported TTL.
- `401` for an invalid supplied OIDC token.
- `413` for compressed or decompressed size violations.
- `415` for unsupported content type or encoding.
- `429` for quota exhaustion.
- `500` for unexpected internal failures.
- `503` when safe rate-limit enforcement cannot be completed.

### Idempotent CI retries

Support an optional request header:

```http
Idempotency-Key: <1–200 printable ASCII characters>
```

Behavior:

- Scope the key to the derived anonymous IP identity or verified GitHub repository identity.
- HMAC the scoped key before using it as a Blob key.
- Store the request digest, page ID, response, and expiration.
- Repeating the same key with the same decoded HTML and TTL returns the stored response with `200` without creating another page.
- Changing only the transport encoding between `identity` and `br+base64` is an idempotent replay when the decoded HTML and TTL are unchanged.
- Reusing the key with different decoded HTML or TTL returns `409`.
- Delete idempotency records after the associated page expires.
- Requests without this header retain existing behavior.

This allows the Action to retry timeouts and `5xx` responses without creating multiple reports.

### Storage reliability

Reorder multi-Blob page persistence so every partial upload is discoverable by cleanup:

1. Write the expiration index.
2. Write HTML.
3. Write metadata last.

If any write fails, attempt compensating deletion. The expiration index remains the final cleanup backstop if compensation also fails.

Do not migrate existing page records. Existing rate-limit keys expire naturally under their current retention window.

### Documentation

Add a public API section to `README.md` or `docs/api.md` containing:

- Plain JSON curl example.
- Brotli/base64 request format.
- Allowed TTL values and 12-hour default.
- Size limits.
- Response and error formats.
- Anonymous and verified GitHub quotas.
- OIDC audience and permission requirements.
- Idempotency behavior.
- Reminder that pages are public, sandboxed, reportable, and temporary.
- Explicit warning not to upload secrets, credentials, private source, or sensitive test data.

An OpenAPI document is out of scope for this first API issue.

### Observability

Emit structured events without uploaded HTML, tokens, raw IPs, or repository names:

- Upload accepted with actor type, hashed actor, compressed bytes, raw bytes, and TTL.
- OIDC validation failure category.
- Rate-limit rejection with actor type and hashed subject.
- Idempotency hit or conflict.
- Storage compensation failure.
- Decompression or size rejection.

Verify the Netlify deploy log confirms the function-level rate-limit configuration because invalid code-based rules do not necessarily fail deployment. [Netlify rate-limiting documentation](https://docs.netlify.com/manage/security/secure-access-to-sites/rate-limiting/)

### API tests

Add unit and integration coverage for:

- Existing plain HTML requests remain valid.
- Default and every supported TTL.
- Absolute response URL.
- Valid `br+base64` report.
- Malformed base64 and Brotli.
- Compressed size boundary.
- Decompressed 20 MB boundary and compression-bomb protection.
- Omitted bearer token uses anonymous identity.
- Valid GitHub JWT uses `repository_id`.
- Invalid signature, issuer, audience, expiry, and missing required claims.
- Invalid supplied token does not fall back to anonymous.
- Anonymous rate limiting ignores User-Agent rotation.
- Verified repositories have independent buckets even from one IP.
- Concurrent counter updates retry ETag conflicts without losing increments.
- `429` response headers.
- Repeated idempotent request returns the same page.
- Same idempotency key with a changed payload returns `409`.
- Expired idempotency records are cleaned.
- Partial page writes are compensating-deleted or later found by cleanup.
- Browser upload and viewer end-to-end tests remain green.
- Existing reporting and admin deletion flows remain unchanged.

### API acceptance criteria

- A CI client can upload one self-contained report and receive an absolute public URL.
- Plain browser uploads remain backward-compatible.
- GitHub OIDC works without a stored API secret.
- Anonymous fallback remains available.
- Both actor types enforce ten uploads per ten minutes.
- Rate-limit updates are safe under concurrent requests.
- Large compressible reports can use the encoded form without exceeding the Netlify request limit.
- Retried uploads do not create duplicates when an idempotency key is supplied.
- `vp check`, `vp test`, `vp run test:e2e`, and the production build pass.

## Issue 2: Publish the GitHub Action

**Repository:** new public `schalkneethling/ephemeral-pages-action` repository  
**Suggested title:** `Create the Ephemeral Pages report publishing Action`

A separate repository is the selected design because it decouples Action releases from the web application and supports a Marketplace-compatible root `action.yml`. This also follows [GitHub’s recommendation for publicly shared actions](https://docs.github.com/en/actions/how-tos/create-and-publish-actions/manage-custom-actions).

### Action implementation

Create a TypeScript JavaScript Action using:

- `@actions/core`
- `@actions/github`
- Node.js built-in `fs`, `path`, `crypto`, and `zlib`
- Node 24 Action runtime
- A bundled `dist/index.js` checked into the repository

`action.yml`:

```yaml
runs:
  using: node24
  main: dist/index.js
```

Node 24 is currently supported in Action metadata. [GitHub Action metadata syntax](https://docs.github.com/en/enterprise-cloud%40latest/actions/reference/workflows-and-actions/metadata-syntax)

### Inputs

```yaml
inputs:
  report-path:
    description: Path to the self-contained HTML report
    required: true

  ttl-hours:
    description: Ephemeral Pages TTL in hours
    required: false
    default: "12"

  report-name:
    description: Label shown in the pull request comment
    required: false
    default: "Accessibility report"

  service-url:
    description: Ephemeral Pages service origin
    required: false
    default: "https://ephemeral.schalkneethling.com"

  github-token:
    description: Automatic GitHub token used to create or update the PR comment
    required: true
```

### Outputs

```yaml
outputs:
  page-id:
    description: Ephemeral Pages page identifier

  page-url:
    description: Absolute report URL

  expires-at:
    description: ISO-8601 expiration timestamp

  comment-id:
    description: GitHub ID of the created or updated PR comment
```

### Event and fork safeguards

Before reading or uploading the report, require all of the following:

- `github.event_name === "pull_request"`
- The event is not `pull_request_target`.
- A pull-request payload and number are present.
- `pull_request.head.repo.full_name === github.repository`
- The base repository is the current upstream repository.

If any condition fails, fail the Action before upload with an explicit message.

This intentionally means:

- Fork PRs are unsupported.
- Non-PR workflow events are unsupported.
- `pull_request_target` is unsupported.
- The Action never uses elevated upstream permissions to process fork-controlled HTML.

### Upload behavior

1. Resolve `report-path` inside the workspace.
2. Require a regular file; reject directories, missing files, and symlink escapes outside the workspace.
3. Enforce the 20 MB raw limit locally.
4. Validate `ttl-hours` against the API allowlist.
5. Brotli-compress the report.
6. Reject compressed output above 2 MB before making a request.
7. Attempt `core.getIDToken(serviceOrigin)`:
   - If successful, send it as the bearer token.
   - If unavailable because `id-token: write` was omitted, emit a warning and continue anonymously.
   - Do not print the token.
8. Send `encoding: "br+base64"` and an idempotency key to `POST /api/pages`.
9. Retry network failures, `429`, and transient `5xx` responses up to three times.
10. Honor `Retry-After`; otherwise use bounded exponential backoff with jitter.
11. Do not retry permanent `4xx` responses.
12. Verify the response schema and ensure the returned page URL belongs to the configured service origin.
13. Set outputs before creating the PR comment.

### PR comment behavior

Maintain one comment per `report-name` instead of posting a new comment on every run.

Use a stable hidden marker derived from the normalized report name:

```html
<!-- ephemeral-pages-action:<report-name-digest> -->
```

Search all PR issue comments with pagination. Only update a comment that:

- Contains the exact marker.
- Was authored by `github-actions[bot]` or the authenticated token owner.

Otherwise create a new comment.

Comment format:

```md
### Accessibility report

[Open the temporary HTML report](https://ephemeral.schalkneethling.com/p/...)

Expires: 2026-07-27 22:00 UTC  
Commit: `abcdef1`  
Workflow run: [View run](...)

_This report is temporary and will be deleted automatically._
```

On reruns, replace the URL, expiry, commit, and workflow-run link in the existing comment.

If upload succeeds but commenting fails, fail the Action and expose the uploaded URL in the job log and outputs. The page will still expire normally.

### Required workflow permissions

Document this minimum configuration:

```yaml
permissions:
  contents: read
  pull-requests: write
  id-token: write
```

- `pull-requests: write` permits comment creation and updates.
- `id-token: write` enables the preferred repository-scoped API quota.
- Omitting `id-token: write` invokes the anonymous fallback.
- No PAT, Ephemeral Pages API key, or repository secret is required.

Example usage:

```yaml
- uses: actions/checkout@v4

- name: Run accessibility tests
  run: npm run test:a11y

- name: Publish accessibility report
  id: publish-report
  uses: schalkneethling/ephemeral-pages-action@v1
  with:
    report-path: playwright-report/index.html
    ttl-hours: "24"
    report-name: Accessibility report
    github-token: ${{ github.token }}
```

Explicitly warn consumers not to change the trigger to `pull_request_target`.

### Action repository quality gates

Include:

- `README.md` with setup, permissions, security notes, inputs, outputs, and examples
- MIT license
- `action.yml`
- TypeScript source
- Bundled `dist/index.js`
- Unit tests
- Dependabot configuration
- CI for lint, typecheck, tests, and bundle verification
- Release workflow or documented release checklist
- A script that fails if `dist/index.js` differs from a fresh build

### Action tests

Cover:

- Same-repository `pull_request` is accepted.
- Fork PR is rejected before reading or uploading.
- `pull_request_target` and non-PR events are rejected.
- Missing, directory, oversized, and workspace-escaping paths fail.
- Every valid TTL is accepted; unsupported TTLs fail locally.
- Brotli/Base64 request body matches the API contract.
- OIDC token is attached when available.
- Missing OIDC permission warns and falls back anonymously.
- OIDC and GitHub tokens never appear in logs or thrown errors.
- Stable idempotency key across retries.
- New run attempt produces a new idempotency key.
- `429` honors `Retry-After`.
- Transient failures retry; permanent validation errors do not.
- Response URL must use the configured service origin.
- First run creates a comment.
- Repeated run updates the marked comment.
- Different `report-name` values maintain separate comments.
- Comment pagination is handled.
- Comment failure fails the Action while preserving outputs.
- Built `dist/index.js` executes under the Node 24 Action runtime.

### Release

After the API deployment is smoke-tested:

1. Run the Action against a same-repository test PR.
2. Verify the report renders correctly under the existing sandbox and CSP.
3. Verify a rerun updates the prior comment.
4. Verify expiry and scheduled deletion.
5. Publish `v1.0.0`.
6. Move or create the floating `v1` tag at that release.
7. Publish to GitHub Marketplace if desired; Marketplace publication expects a public repository with a root Action metadata file. [GitHub Marketplace publishing](https://docs.github.com/en/actions/how-tos/create-and-publish-actions/publish-in-github-marketplace)

## Rollout Order

1. Create both issues, marking the Action issue as blocked by the API issue.
2. Implement API hardening in the existing repository and open PR 1.
3. Deploy PR 1 to a preview environment and inspect Netlify’s rate-limit configuration output.
4. Merge and deploy PR 1 to `https://ephemeral.schalkneethling.com`.
5. Smoke-test plain, compressed, anonymous, OIDC, idempotent, and rate-limited requests.
6. Build the Action in the separate repository and open PR 2.
7. Test PR-comment creation and updating against the production API.
8. Merge PR 2 and publish `v1.0.0`/`v1`.
9. Monitor function invocation volume, `429` rates, OIDC fallback usage, storage growth, and cleanup failures.
10. Revisit quotas only with observed data; the first release intentionally retains the selected `10 uploads per 10 minutes` policy and does not introduce a global daily budget.

## Compatibility and Migration

- No existing page or metadata migration is required.
- Existing browser requests remain valid.
- Existing pages retain their URLs and expiration behavior.
- Old IP-plus-User-Agent rate-limit records may remain until their existing cleanup window passes.
- New anonymous and GitHub rate-limit records use separate prefixes.
- Idempotency records are a new storage prefix and are removed by cleanup.
- The browser, viewer, abuse-reporting, admin-delete, CSP, and scheduled-expiry behavior remain in scope and must not regress.

## Explicit Assumptions and Defaults

- The canonical service origin is `https://ephemeral.schalkneethling.com`.
- The Action repository will be `schalkneethling/ephemeral-pages-action`.
- The Action is only for same-repository `pull_request` events.
- Fork PRs fail before any upload.
- `pull_request_target` is never supported.
- One PR comment is updated per report name.
- The Action both uploads and comments; upload-only operation is not part of v1.
- GitHub OIDC is preferred but anonymous fallback is supported.
- No Ephemeral Pages API keys, accounts, or long-lived secrets are introduced.
- The current TTL allowlist and 12-hour default remain unchanged.
- The current effective quota of 10 uploads per 10 minutes remains unchanged.
- No global daily page or byte budget is added in this release.
- No CORS support or OpenAPI document is required for v1; human-readable API documentation is required.
