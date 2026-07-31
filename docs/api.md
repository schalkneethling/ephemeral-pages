# Page-creation API

Ephemeral Pages exposes a public JSON API for browser uploads and unattended CI report publishing.
Uploaded pages are public, temporary, reportable, and rendered with the service's sandbox and
Content Security Policy. **Never upload secrets, credentials, private source code, or sensitive
test data.**

## Create a page

```http
POST /api/pages
Content-Type: application/json
```

Plain HTML is the default:

```sh
curl --fail-with-body https://ephemeral.schalkneethling.com/api/pages \
  --header 'Content-Type: application/json' \
  --header 'Idempotency-Key: example-report-123' \
  --data '{"html":"<html><body><h1>Report</h1></body></html>","expirationHours":12}'
```

The request accepts `html`, an optional `expirationHours`, and an optional `encoding`. Supported
TTLs are `1`, `3`, `5`, `7`, `12`, `24`, `72`, `120`, and `168` hours; the default is 12 hours.
Omit `encoding` or use `identity` for plain HTML.

For large, compressible reports, Brotli-compress the UTF-8 HTML and send its canonical Base64
representation:

```json
{
  "html": "<base64-encoded Brotli bytes>",
  "encoding": "br+base64",
  "expirationHours": 24
}
```

Raw/decompressed HTML is limited to 20 MiB and compressed Brotli data to 2 MiB. Malformed Base64,
invalid Brotli, invalid UTF-8, and documents without a source-authored `<html>` or `<head>` element
are rejected.

A successful response is:

```json
{
  "id": "a-page-id",
  "createdAt": "2026-07-27T10:00:00.000Z",
  "expiresAt": "2026-07-27T22:00:00.000Z",
  "url": "https://ephemeral.schalkneethling.com/p/a-page-id"
}
```

New pages return `201 Created`. An idempotent replay returns the stored response with `200 OK`.

## GitHub Actions OIDC

Authentication is optional. Requests without `Authorization` are anonymous. GitHub Actions can
request a short-lived OIDC token for the audience `https://ephemeral.schalkneethling.com` and send:

```http
Authorization: Bearer <GitHub OIDC JWT>
```

The workflow needs `id-token: write`; no Ephemeral Pages secret or API key is required. A supplied
token that is invalid, expired, incorrectly issued, incorrectly addressed, or missing required
workflow/repository claims returns `401` and never falls back to anonymous access.

Anonymous uploads are limited to 10 per 10 minutes per client IP. Verified GitHub uploads are
limited to 10 per 10 minutes per stable GitHub repository ID. Successful responses include
`X-RateLimit-Limit`, `X-RateLimit-Remaining`, and `X-RateLimit-Reset`, including `200` idempotent
replays because every replay is metered. A `429` response also includes `Retry-After`.

## Idempotency

Clients may send `Idempotency-Key` with 1–200 printable ASCII characters. Keys are HMAC-protected
and scoped to the anonymous IP or verified GitHub repository identity. Repeating the same key,
decoded content, and TTL returns the original page, even if the transport encoding changes. Reusing
it with a different request returns `409 Conflict`. The record is deleted after the page expires.

## Errors

Errors use a stable JSON object:

```json
{ "error": "Human-readable message" }
```

The API uses:

- `400` for malformed JSON, HTML, Base64/Brotli, UTF-8, TTL, or idempotency keys.
- `401` for a supplied but invalid GitHub OIDC token.
- `409` for an idempotency conflict.
- `413` when a raw, compressed, encoded, or decompressed size boundary is exceeded.
- `415` for an unsupported content type or encoding.
- `429` when the application quota is exhausted.
- `500` for unexpected failures or missing required server configuration.
- `503` when quota or idempotency state cannot be updated safely.

The service also applies a coarse Netlify edge limit of 120 requests per minute per IP and domain
across `/api/*`.
