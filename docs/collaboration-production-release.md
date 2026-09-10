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
2. Netlify production secrets: saved, user-confirmed on 2026-09-09. The production gate was unset at this checkpoint.
3. Matching Worker secrets: saved, user-confirmed and secret names verified on 2026-09-09.
   The production version containing both secrets is `4b747f21-d3a0-4566-8026-8dae1ea13109`.
   Enter or rotate them interactively with
   `bunx wrangler secret put TICKET_HMAC_SECRET --config collaboration-worker/wrangler.jsonc --env production`
   and the same command with `ADMIN_TOKEN` for the service token.
4. Remaining Netlify production values: saved, user-confirmed on 2026-09-09. The gate was still unset at this checkpoint.
5. Preview rollback drill: complete. Restored version `872b6a39-e8b9-4560-af53-f28906ab6f68`,
   verified health, then restored `9cd69e53-93b1-4604-9989-1c870e0bbe3f` and verified health again.
   This exercised version rollback without reverting Durable Object storage or migrations.
6. PR #33 merged as `39b7a6a69b6b61400325326473665490538f84c1`.
   Production returned the app-shell CSP with the production Worker WSS origin. Before enablement,
   the ticket endpoint returned HTTP 503 with `Collaboration is disabled`, as expected.
7. Production enablement (`COLLABORATION_ENABLED=true`) and redeployment: user-confirmed on 2026-09-09. The live browser smoke
   passed at 20:44 UTC: collaboration upload returned 201; two independent editor sessions
   synchronized card creation and movement; the viewer synchronized changes with editing controls
   disabled; an editor reconnected after reload with state preserved. A separate network-loss
   recovery scenario was not exercised in this production smoke.
   Browser Run captured revision 3, and the downloaded PNG was visually checked against the board.
   Test page `f959b50b-41dc-4b72-8fb8-9cc383a6aa06` expires at 2026-09-09T21:44:02.121Z.
8. [Production API smoke workflow](https://github.com/schalkneethling/ephemeral-pages/actions/runs/34402828230):
   passed on 2026-09-09. Verified plain and compressed uploads, idempotent replay across encodings,
   conflicting replay rejection, and successful-request and exhausted-quota headers using GitHub OIDC.

The verified production Worker rollback target is `4b747f21-d3a0-4566-8026-8dae1ea13109`,
which includes both production secrets. Do not roll back to the initial version without secrets.

Netlify deployment identity was verified through its API on 2026-09-10: published deploy
`6aa1c499a64d39a10fb86df2`, source commit `39b7a6a69b6b61400325326473665490538f84c1`,
published at 2026-09-09T20:42:46.198Z. Together with the Worker version above, this identifies the
deployment pair used by the 20:44 UTC production smoke. This historical log predates the release
runner and does not contain its proposed artifact hashes or configuration fingerprints.

To disable new collaboration uploads and tickets, set the production `COLLABORATION_ENABLED`
value to `false` and redeploy Netlify. Existing sockets are not revoked by this flag. Worker rollback
must retain SQLite migration history; restore a known-good Worker version rather than removing
migration tags. Record the verified rollback target after the drill.
