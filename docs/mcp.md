# MCP server

Ephemeral Pages exposes a hosted [Model Context Protocol](https://modelcontextprotocol.io/) server
for agents. It is a first-party adapter of the existing [`POST /api/pages` API](api.md): same
validation, rate limits, optional GitHub OIDC, and public `/p/:id` URLs. It is not a new product
surface — no accounts, listing, or page editing.

The server speaks **MCP 2026-07-28 only**. Older 2025-era clients are not supported.

## Connect

Production URL:

```text
https://ephemeral.schalkneethling.com/mcp
```

Cursor / Claude HTTP config:

```json
{
  "mcpServers": {
    "ephemeral-pages": {
      "url": "https://ephemeral.schalkneethling.com/mcp"
    }
  }
}
```

## Tools and prompt

| Name                | Kind   | Purpose                                                                           |
| ------------------- | ------ | --------------------------------------------------------------------------------- |
| `create_page`       | tool   | Publish a full HTML document and return `id`, `createdAt`, `expiresAt`, and `url` |
| `get_page`          | tool   | Return metadata for a known page id (never the HTML)                              |
| `publish-html-page` | prompt | Instructions for publishing a full page with `create_page`                        |

`create_page` arguments:

- `html` (required): a **complete, self-contained HTML page**. Typical form is a doctype plus
  `html`, `head`, and `body`. Fragments, Markdown, and a bare `body` are not a page.
- `expirationHours` (optional): `1`, `3`, `5`, `7`, `12` (default), `24`, `72`, `120`, or `168`.
- `idempotencyKey` (optional): 1–200 printable ASCII characters; same key and payload replay the
  original page.

There is no `encoding` argument. Large CI reports should keep using the REST API with
`encoding: "br+base64"`.

## Limits

- Netlify buffered request body is about 6 MB.
- Raw HTML is limited to 20 MiB; Brotli-compressed HTML to 2 MiB (same as REST).
- Anonymous uploads: 10 per 10 minutes per client IP. Verified GitHub OIDC uploads: 10 per 10
  minutes per repository. `/mcp` also has the same 120 requests per minute edge limit as `/api/*`.

## Security

- Published URLs are **public**. Never upload secrets, credentials, private source, or sensitive
  data.
- Uploaded pages are sandboxed. Declarative scripts, stylesheets, and fonts may load only from the
  approved CDNs. `fetch`, XHR, and WebSocket are blocked.
- Authentication is optional. Send `Authorization: Bearer <GitHub OIDC JWT>` to use the repository
  quota. A supplied invalid token is rejected and never falls back to anonymous access.
- Admin delete, page HTML content, and abuse reporting are **not** MCP tools.

## Future idea

An [MCP Apps](https://modelcontextprotocol.io/extensions/apps/overview) preview (confirm HTML in
the client before or after publish) is tracked as a later exploration:
[issue #14](https://github.com/schalkneethling/ephemeral-pages/issues/14). No preview UI exists
today.
