# Ephemeral Pages

Ephemeral Pages lets users publish short-lived HTML pages that expire automatically.

## Using it

The server is a public Streamable HTTP endpoint. There is no API key, bearer token, or OAuth flow
to set up, and nothing to install or run locally. Point a client at it:

```text
https://ephemeral.schalkneethling.com/mcp
```

This deployment uses the transport's buffered JSON response mode rather than SSE for normal
requests.

With Codex, that is one command:

```bash
codex mcp add ephemeral-pages --url https://ephemeral.schalkneethling.com/mcp
```

Claude Code has an equivalent. Using its CLI is the simplest path because it writes the
configuration for you:

```bash
claude mcp add --transport http ephemeral-pages https://ephemeral.schalkneethling.com/mcp
```

Without `--scope`, that command creates a local-scoped entry for the current project inside
`~/.claude.json`. Add `--scope project` to write a shareable `.mcp.json` at the project root, or
`--scope user` to make the server available in every project.

If you prefer to write the configuration by hand, use `.mcp.json` at the project root or
`~/.claude.json` for a user-scoped server. Neither location is `settings.json`, and
`claude_desktop_config.json` belongs to the desktop application rather than Claude Code.

```json
{
  "mcpServers": {
    "ephemeral-pages": {
      "type": "http",
      "url": "https://ephemeral.schalkneethling.com/mcp"
    }
  }
}
```

The `type` field is the part to get right. Claude Code requires it for a remote HTTP entry; without
it, the configuration will not connect as an HTTP server. It also accepts `streamable-http` as an
alias for `http` if you prefer to match the specification's transport name.

Cursor reads a similar shape from `.cursor/mcp.json` in the project or `~/.cursor/mcp.json`
globally, and it infers the transport from the presence of a `url`:

```json
{
  "mcpServers": {
    "ephemeral-pages": {
      "url": "https://ephemeral.schalkneethling.com/mcp"
    }
  }
}
```

That difference matters when copying configuration between clients: the Cursor entry above needs
`"type": "http"` before it can be used by Claude Code.

The server intentionally sets `legacy: "reject"`: it speaks MCP `2026-07-28` and nothing else. A
client pinned to a 2025-era protocol version will not connect rather than degrading to a partial
experience.

Once connected, an agent discovers the `create_page` and `get_page` tools and the
`publish-html-page` prompt. In practice, ask it to publish a complete HTML document, choose one of
the supported expiration periods if 12 hours is not what you want, and share the returned URL. That
URL is public for as long as the page lives, so nothing sensitive should ever go into a page: no
secrets, credentials, private source, or real customer data.

Configuration examples for OpenCode, Pi, VS Code, and MCP Inspector, along with the full tool
arguments, limits, and security model, are in the [MCP guide](docs/mcp.md).

## Public API

The documented [`POST /api/pages` API](docs/api.md) supports plain JSON uploads, Brotli/Base64 CI
reports, optional GitHub Actions OIDC identity, actor-scoped idempotency, and stable error/rate-limit
responses. The MCP server uses the same create/get behavior through an agent-oriented interface.

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
