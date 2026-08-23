# Ephemeral Pages

Development and security gates are documented in
[development governance](docs/development-governance.md).

Ephemeral Pages lets users publish short-lived HTML pages that expire automatically.

## Public API

The documented [`POST /api/pages` API](docs/api.md) supports plain JSON uploads, Brotli/Base64 CI
reports, optional GitHub Actions OIDC identity, actor-scoped idempotency, and stable error/rate-limit
responses.

Agents can use the same create/get surface through the hosted [MCP 2026-07-28 server](docs/mcp.md)
at `https://ephemeral.schalkneethling.com/mcp`.

## Uploaded Content Security Model

Uploaded pages are intentionally constrained. The content endpoint returns uploaded HTML with
a sandboxed Content Security Policy, and the normal viewer renders the content endpoint in a
sandboxed same-origin iframe.

Allowed external loading is limited to declarative script, stylesheet, and font use:

- `<script src="...">` may load JavaScript from the approved script CDNs.
- `<link rel="stylesheet" href="...">` and CSS `@import` may load stylesheets from approved
  style origins, including Google Fonts CSS.
- Font files may load from the approved font origin.

Programmatic network access is blocked. Uploaded pages do not define `connect-src`, so `fetch`,
XHR, WebSocket, and similar requests fall back to `default-src 'none'`, even when the target
origin is allowed for `script-src` or `style-src`.

That means this is allowed when the origin is on the approved script list:

```html
<script src="https://cdn.jsdelivr.net/npm/lodash/lodash.min.js"></script>
```

But this is blocked:

```js
fetch("https://cdn.jsdelivr.net/npm/lodash/lodash.min.js");
```

## Rate-Limit Data Retention

Rate limits use short-lived, pseudonymous JSON records in Netlify Blobs. The record key is derived
from an HMAC of the request actor signal and rate-limit subject, so raw IP addresses and verified
GitHub repository identities are not stored in Blob keys.

Expired rate-limit records are hard-deleted by the scheduled cleanup function once their `resetAt`
window has passed. Malformed rate-limit records are also deleted during cleanup because they cannot
be used for enforcement.
