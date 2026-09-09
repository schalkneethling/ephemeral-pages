# Connecting the collaboration preview

Work through one step at a time. Record the result before continuing. This runbook covers PR #33;
its preview URL and branch are temporary and must be revisited when the PR closes.

## 1. Identify the two services

The Netlify application serves the UI, stores uploaded pages, and issues short-lived connection
tickets. The Cloudflare Worker verifies those tickets and maintains shared state in Durable Objects.

- Netlify preview: https://deploy-preview-33--ephemeral-pages.netlify.app
- Git branch: `codex/ephemeral-pages-collaboration`
- Worker: `ephemeral-pages-collaboration-preview`
- Worker HTTPS origin: https://ephemeral-pages-collaboration-preview.volume4-schalk.workers.dev
- Worker WebSocket origin: wss://ephemeral-pages-collaboration-preview.volume4-schalk.workers.dev
- Ticket audience: `ephemeral-pages-collaboration-preview`

The HTTPS and WebSocket addresses identify the same Worker. HTTPS handles service requests such as
screenshot capture; WSS is the encrypted, persistent connection used for collaboration updates.

Status on 2026-09-09: the Worker was deployed with the Durable Object and Browser Run bindings.
Its `/healthz` endpoint returned `{"status":"ok"}`. This establishes that the Worker responds, not
that ticket authentication, shared editing, or screenshots work. The remaining setup status is recorded below.

## 2. Configure preview environment values

Completed (user-confirmed on 2026-09-09). All five values below were saved with All scopes and a
branch override for `codex/ephemeral-pages-collaboration`. Existing production values were retained.
The preview smoke below verified the deployment. Free-plan variables use all scopes; deploy context is a
separate setting.

- `COLLABORATION_CAPABILITY_CURRENT_VERSION`: `v1`
- `COLLABORATION_TICKET_AUDIENCE`: the preview audience above
- `COLLABORATION_WEBSOCKET_URL`: the preview WSS origin above
- `COLLABORATION_SERVICE_URL`: the preview HTTPS origin above
- `PUBLIC_BASE_URL`: the Netlify preview URL above, so generated page links stay in preview

Verify the selected branch context before saving. These values alone do not enable collaboration.

## 3. Configure matching secrets

Completed (user-confirmed on 2026-09-09). The three Netlify secrets were saved for the preview
branch. Both matching Worker secrets were added with Wrangler to the preview environment.
Values are retained in the user's password manager and have not been read or recorded here.
Never put secret values in this document, Git, screenshots, or PR descriptions.

- Netlify `COLLABORATION_CAPABILITY_CURRENT_SECRET`: editor capability key; Netlify only.
- Netlify `COLLABORATION_TICKET_SECRET` and Worker `TICKET_HMAC_SECRET`: the same ticket-signing value.
- Netlify `COLLABORATION_SERVICE_TOKEN` and Worker `ADMIN_TOKEN`: the same service authorization value.

The capability and ticket keys must contain at least 32 bytes. Leave previous capability-key
variables unset on first setup. Add Worker secrets to the preview environment only. These are
separate from the application's existing admin deletion and rate-limiting secrets.

## 4. Permit the preview WebSocket in the app-shell CSP

Verified on 2026-09-09 after preview deployment of commit `3ac2113`. The live response returned
HTTP 200 and a CSP allowing only the preview Worker origin alongside self in `connect-src`.
Permissions-Policy, Referrer-Policy, and X-Content-Type-Options were also present. CSP is a browser-enforced policy sent with the Netlify page. Its `connect-src` directive
must permit the exact preview WSS origin. The Worker independently checks the browser's Origin
header against `ALLOWED_ORIGINS`; both sides must agree.

The build now runs `scripts/write-netlify-headers.mjs` after Vite to write `dist/_headers`.
It reads the non-secret `COLLABORATION_WEBSOCKET_URL` available during the build. Production and
local builds retain the previous production origin when unset; other contexts omit external socket
access unless configured. Invalid or non-WSS origins fail the build. The global header declarations
were removed from `netlify.toml`, and the other security headers remain in the generated file.
The uploaded-page CSP is unchanged: uploaded HTML communicates through the trusted parent.

## 5. Redeploy and verify the full path

Preview collaboration and screenshot smoke passed on 2026-09-09. The user confirmed collaborative
upload, editor mutation, live viewer synchronization, read-only viewing, and persistence/editor
access after refresh. A screenshot request returned HTTP 201 at 19:52 UTC, capturing revision 5
as a 46,754-byte PNG. Download and visual inspection confirmed the current Kanban cards and
read-only controls. Browser Run did not return its usage-time header for this successful capture;
its browser-time cost remains unmeasured.

During troubleshooting, a zero-byte POST reproduced a Worker 400: an empty body stream was
incorrectly rejected. A regression test and fix now accept an empty stream while rejecting body
content. A subsequent Browser Run 422 was followed by the successful capture; its cause was not
established. Rendering errors now return 502 rather than being reported as exhausted capacity.
Bounded diagnostic logging records fixed error categories without capture tokens or upstream URLs.
The browser also blocked Netlify preview script injection in uploaded HTML, as intended by CSP.

The user independently confirmed screenshot success. The former three-attempt/ten-minute limit
has been replaced with a 30-second per-IP/page cooldown and shared admission allowing one
attempt every 10 seconds across this site's pages and clients. Failed attempts consume the short
cooldown. Responses preserve valid upstream retry seconds, increased if our remaining cooldown
is longer; missing/invalid upstream timing falls back to 60 seconds. The UI describes temporary
unavailability without incorrectly attributing every 503 to a daily quota. Daily and page-lifetime
budgets remain unchanged. The shared gate cannot coordinate other apps on the Cloudflare account.

Deployment of `303c50e` verified the new cooldown: an immediate retry returned HTTP 429,
`X-RateLimit-Limit: 1`, and `Retry-After: 25`. CI, 184 unit tests, four screenshot browser tests,
and the build passed. Live capture attempts also reproduced an intermittent rendering failure:
the Worker logged `capture_rendered`, followed by Browser Run HTTP 422 with the fixed diagnostic
category `selector`. Earlier successful captures remain valid evidence, but rendering reliability
needs follow-up before the full preview smoke is considered complete.

Netlify environment changes require a new deployment. Check the response CSP, create a
collaborative fixture, open two editor sessions and one viewer, and verify editing, read-only access,
refresh, and reconnect. Then request a real screenshot and verify its revision and download.
Record results here without capability URLs or tickets.

Continue with expiry, deletion, capacity, isolation, and rollback validation in
[issue #28](https://github.com/schalkneethling/ephemeral-pages/issues/28) before production rollout.
There is currently no explicit production feature flag; capability-key configuration alone allows
collaborative page creation, so production enablement needs a separate deliberate step.

## References

- [Netlify environment contexts and scopes](https://docs.netlify.com/build/environment-variables/overview/)
- [Context-specific headers](https://docs.netlify.com/manage/routing/headers/#custom-headers-for-different-branch-or-deploy-contexts)
- [Function environment variables](https://docs.netlify.com/build/functions/environment-variables/)
- [Collaboration architecture and operations](collaboration.md)
