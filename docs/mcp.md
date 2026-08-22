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

This is a public Streamable HTTP endpoint. No API key or OAuth is required. Optional GitHub
OIDC still uses `Authorization: Bearer <JWT>` when you want the repository quota. Clients that
only speak 2025-era MCP will fail.

Each client has its own config file and field names. Use the official docs for the client you
run; the snippets below are the minimum working shapes for this URL.

### Codex

[Codex MCP docs](https://developers.openai.com/codex/mcp)

```bash
codex mcp add ephemeral-pages --url https://ephemeral.schalkneethling.com/mcp
```

Or add a table to `~/.codex/config.toml` (or a trusted project's `.codex/config.toml`):

```toml
[mcp_servers.ephemeral-pages]
url = "https://ephemeral.schalkneethling.com/mcp"
```

Do not set a bearer token. Codex connects without credentials when none are configured.

### Cursor

[Cursor MCP docs](https://cursor.com/docs/mcp)

Project file `.cursor/mcp.json`, or `~/.cursor/mcp.json` for every workspace:

```json
{
  "mcpServers": {
    "ephemeral-pages": {
      "url": "https://ephemeral.schalkneethling.com/mcp"
    }
  }
}
```

### Claude Code

[Claude Code MCP docs](https://code.claude.com/docs/en/mcp)

```bash
claude mcp add --transport http ephemeral-pages https://ephemeral.schalkneethling.com/mcp
```

JSON in `.mcp.json` or `~/.claude.json` must include `"type": "http"`. A `url` with no `type` is
read as stdio and skipped:

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

### OpenCode

[OpenCode MCP docs](https://opencode.ai/docs/mcp-servers) (current). [OpenCode v2](https://opencode.ai/v2/docs/mcp-servers)
nests the same remote entry under `mcp.servers` and uses `disabled` instead of `enabled`.

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "ephemeral-pages": {
      "type": "remote",
      "url": "https://ephemeral.schalkneethling.com/mcp"
    }
  }
}
```

If the client starts an OAuth flow against this public server, set `oauth` to `false` on the
remote entry.

### Pi

Pi does not ship MCP. Install the community
[pi-mcp-extension](https://pi.dev/packages/pi-mcp-extension), then add
`~/.pi/agent/mcp.json` or a project `.pi/mcp.json`:

```json
{
  "mcpServers": {
    "ephemeral-pages": {
      "transport": "streamable-http",
      "url": "https://ephemeral.schalkneethling.com/mcp",
      "lifecycle": "eager"
    }
  }
}
```

That extension documents MCP 2025-03-26. This server rejects 2025-era clients, so the
connection only works if the client negotiates 2026-07-28.

### Other clients

| Client | Official docs |
| ------ | ------------- |
| VS Code / Copilot | [MCP servers](https://code.visualstudio.com/docs/copilot/customization/mcp-servers) — workspace `.vscode/mcp.json` uses `"type": "http"` and `url` under `servers` |
| MCP clients | [Model Context Protocol](https://modelcontextprotocol.io/) |

Look for a remote / HTTP / Streamable HTTP server. Point it at the production URL. Do not
invent an API key, OAuth client, or stdio `command` for this service.

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
