# Ephemeral Pages collaboration Worker

This Worker provides one SQLite-backed Durable Object per collaborative page. The outer Worker
rejects invalid origins and tickets before routing an accepted WebSocket to its room.

## Integration contract

- Connect with `GET /rooms/{pageId}/websocket` and `Origin` exactly matching one entry in
  `ALLOWED_ORIGINS`.
- Offer exactly two WebSocket protocols in this order:
  `ephemeral-collaboration-v1`, then the compact JWT ticket. The server selects only
  `ephemeral-collaboration-v1`.
- Sign tickets with HS256 using `TICKET_HMAC_SECRET`. The JWT payload uses the fields from
  `CollaborationTicketClaims` unchanged: `version`, `roomId`, `role`, `audience`, `issuedAt`,
  `expiresAt`, `pageExpiresAt`, and `ticketId`.
- All three timestamps are integer Unix epoch seconds. Tickets must be valid for no more than five
  minutes, must not outlive the page, and use the configured `TICKET_AUDIENCE`.
- Each ticket ID is single-use until its ticket expiry. Consumption is persisted in the room, so
  closing a WebSocket does not make its ticket reusable.
- Delete with `DELETE /rooms/{pageId}`, `Authorization: Bearer {ADMIN_TOKEN}`, and
  `X-Ephemeral-Page-Expires-At: {epochSeconds}`. Deletion leaves a tombstone until page expiry so
  previously minted tickets cannot recreate a deleted room.

Neither ticket values, page state, nor secret values are logged. Metrics contain room IDs, roles,
rejection categories, revisions, operation counts, and state byte counts only.

## Frozen screenshot capture

- Netlify calls `POST /rooms/{pageId}/captures` with the admin bearer and an empty body. Query
  parameters and caller-supplied URLs are rejected.
- The room atomically freezes its current state and revision and permits one capture at a time. A
  random, one-use render token expires after at most 60 seconds and is stored only as a hash.
- Browser Run navigates only to
  `${PUBLIC_WORKER_ORIGIN}/rooms/{pageId}/captures/{token}/render`. That trusted wrapper embeds only
  `${PAGE_CONTENT_ORIGIN}/api/pages/{pageId}/content` in the existing `sandbox="allow-scripts"`
  iframe and sends the frozen state through a read-only `postMessage` bridge.
- Successful responses contain a PNG body plus `X-Ephemeral-Capture-Revision` and
  `X-Ephemeral-Captured-At`. The viewport is fixed at 1440×900, navigation/readiness/action timers
  total 10 seconds, and output above 8 MiB is rejected. Browser Run and quota failures return 503.

## Local validation and deployment

Set local secrets in an ignored `collaboration-worker/.dev.vars` file:

```text
TICKET_HMAC_SECRET=replace-with-a-long-random-secret
ADMIN_TOKEN=replace-with-an-independent-long-random-secret
```

Use the same HMAC secret in the Netlify ticket issuer. Before production deployment, replace the
local `ALLOWED_ORIGINS`, `PAGE_CONTENT_ORIGIN`, and `PUBLIC_WORKER_ORIGIN` values with exact HTTPS
production origins and provision secrets interactively:

```sh
wrangler secret put TICKET_HMAC_SECRET --config collaboration-worker/wrangler.jsonc
wrangler secret put ADMIN_TOKEN --config collaboration-worker/wrangler.jsonc
wrangler types --config collaboration-worker/wrangler.jsonc collaboration-worker/worker-configuration.d.ts
wrangler deploy --dry-run --config collaboration-worker/wrangler.jsonc
wrangler deploy --config collaboration-worker/wrangler.jsonc
```

Browser Run Quick Actions require a remote binding during development. Use `wrangler dev --remote`
for an end-to-end capture smoke test; unit tests use a local fake and consume no browser quota.

Validation commands:

```sh
node_modules/.bin/tsc -p collaboration-worker/tsconfig.json --noEmit
cd collaboration-worker && bunx vitest run --config vitest.config.ts
```
