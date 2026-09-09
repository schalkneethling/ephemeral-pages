# Collaboration production release

Release started on 2026-09-09. This log records deployment evidence; reusable configuration
guidance is in [collaboration.md](collaboration.md).

## Services

- App: https://ephemeral.schalkneethling.com
- Worker: `ephemeral-pages-collaboration`, Wrangler environment `production`
- Worker HTTPS: https://ephemeral-pages-collaboration.volume4-schalk.workers.dev
- Worker WSS: wss://ephemeral-pages-collaboration.volume4-schalk.workers.dev
- Audience: `ephemeral-pages-collaboration`

The production environment has its own Worker and Durable Object namespace. It allows only the
production app origin. Its first deployed version is `605f9c2c-990f-43b8-8572-382772158e81`;
the health endpoint returned `{"status":"ok"}`. No custom DNS record is required for this origin.

## Netlify production configuration

Use the Production context and preserve the existing preview branch overrides. All scopes is
appropriate for the current Netlify plan. Do not record secret values here.

| Variable                                   | Production value                                                       |
| ------------------------------------------ | ---------------------------------------------------------------------- |
| `PUBLIC_BASE_URL`                          | `https://ephemeral.schalkneethling.com`                                |
| `COLLABORATION_SERVICE_URL`                | `https://ephemeral-pages-collaboration.volume4-schalk.workers.dev`     |
| `COLLABORATION_WEBSOCKET_URL`              | `wss://ephemeral-pages-collaboration.volume4-schalk.workers.dev`       |
| `COLLABORATION_TICKET_AUDIENCE`            | `ephemeral-pages-collaboration`                                        |
| `COLLABORATION_CAPABILITY_CURRENT_VERSION` | `v1`                                                                   |
| `COLLABORATION_CAPABILITY_CURRENT_SECRET`  | New production-only random secret                                      |
| `COLLABORATION_TICKET_SECRET`              | New production-only random secret; matches Worker `TICKET_HMAC_SECRET` |
| `COLLABORATION_SERVICE_TOKEN`              | New production-only random secret; matches Worker `ADMIN_TOKEN`        |
| `COLLABORATION_ENABLED`                    | Leave unset until configuration is ready; then `true`                  |

Keep all previous-key variables unset for this initial release. The new secrets must each contain
at least 32 bytes and be retained in the password manager. Only the three secret values should use
Netlify's secret designation.

## Release sequence and status

1. Production Worker configuration and initial health check: complete.
2. Netlify production secrets: saved, user-confirmed on 2026-09-09. The production gate remains unset.
3. Matching Worker secrets: pending. Enter them interactively with
   `bunx wrangler secret put TICKET_HMAC_SECRET --config collaboration-worker/wrangler.jsonc --env production`
   and the same command with `ADMIN_TOKEN` for the service token.
4. Remaining Netlify production values: pending.
5. Preview rollback drill: complete. Restored version `872b6a39-e8b9-4560-af53-f28906ab6f68`,
   verified health, then restored `9cd69e53-93b1-4604-9989-1c870e0bbe3f` and verified health again.
   This exercised version rollback without reverting Durable Object storage or migrations.
6. Merge PR #33 and verify the production deployment with the gate disabled: pending.
7. Enable production collaboration, redeploy, and verify upload, editing, viewing, reconnect,
   and screenshot capture: pending.
8. Run the production API smoke workflow and record results: pending.

To disable new collaboration uploads and tickets, set the production `COLLABORATION_ENABLED`
value to `false` and redeploy Netlify. Existing sockets are not revoked by this flag. Worker rollback
must retain SQLite migration history; restore a known-good Worker version rather than removing
migration tags. Record the verified rollback target after the drill.
