# Project Goal

## North Star

Ephemeral Pages should make it fast and safe to publish a short-lived HTML page: upload a file, choose a TTL, get a shareable URL, and trust that the content will expire and be deleted.

Security and abuse protection are first-class product requirements, not follow-up hardening work. The service should stay useful precisely because uploaded pages are temporary, constrained, reportable, and operationally understandable.

## Who This Is For

- People who need a temporary public URL for a small HTML page, prototype, demo, test fixture, or throwaway document.
- Maintainers who want a lightweight Netlify-hosted service with clear storage, expiry, security, and abuse-handling boundaries.
- Viewers who receive a shared URL and need to see the uploaded page without signing in or installing anything.

## Core Goals

1. **Simple temporary publishing**
   - Accept `.html` and `.htm` uploads up to 2 MB compressed.
   - Offer clear TTL choices from 1 hour through 7 days, with 12 hours as the default.
   - Return stable `/p/:id` URLs that render the uploaded page until it expires.

2. **Predictable deletion**
   - Treat expiration as a hard boundary: expired pages should be unavailable and scheduled for permanent deletion.
   - Keep expiration indexes and cleanup behavior understandable, testable, and robust against malformed records.
   - Avoid retaining rate-limit data beyond its enforcement window.

3. **Constrained uploaded content**
   - Render uploaded pages inside a sandboxed iframe.
   - Serve uploaded HTML with a restrictive Content Security Policy.
   - Allow only intentionally approved declarative script, stylesheet, and font loading.
   - Block programmatic network access such as `fetch`, XHR, and WebSocket.

4. **Responsible operation**
   - Rate-limit uploads, reports, and failed admin-delete attempts.
   - Store rate-limit keys as pseudonymous HMAC-derived records rather than raw IP addresses or user agents.
   - Provide a same-origin flagging flow and token-protected admin deletion for reported pages.
   - Keep production observability focused on failures, abuse signals, and security events.

5. **Small, maintainable implementation**
   - Keep the browser app, Netlify Functions, storage layer, routing, validation, and policy constants easy to inspect.
   - Cover security-sensitive behavior with tests, especially CSP, routing, expiration, validation, deletion, and abuse workflows.
   - Use the project's Vite+ toolchain for formatting, linting, type checking, building, and testing.

## Success Looks Like

- A user can upload valid HTML, choose a TTL, copy the resulting URL, and view the page before expiry without creating an account.
- Invalid file types, malformed HTML, oversized uploads, unsupported TTLs, expired pages, and missing pages all produce clear states.
- Uploaded content can run allowed inline/declarative code but cannot escape the sandbox or make arbitrary network requests.
- Expired pages and expired rate-limit records are hard-deleted by cleanup jobs.
- Abuse reports lead maintainers to a review URL where reported pages can be hard-deleted with the admin token.
- `vp check`, `vp test`, and relevant end-to-end tests stay green for changes that affect behavior.

## Non-Goals

Ephemeral Pages is not a CMS, website builder, blog host, pastebin clone, file-sharing service, or permanent hosting platform. The project will not:

- Add accounts, profiles, comments, analytics dashboards, custom domains, page editing, version history, or long-term archives unless the project goal is deliberately revisited.
- Optimize for arbitrary third-party integrations or broad network access from uploaded pages.
- Store raw actor identifiers for rate limiting when pseudonymous enforcement is enough.
- Make moderation fully automatic; flagged-page deletion remains an owner review action.
- Grow into a general backend platform beyond the storage, cleanup, reporting, and admin flows needed for temporary HTML publishing.

## Principles and Constraints

- Default to deletion and data minimization.
- Keep uploaded content isolated from the app shell and from other origins.
- Prefer explicit allowlists over broad permissions.
- Keep the approved external script, style, and font origins as deliberate maintainer-controlled policy. People who need looser requirements should host their own instance and change the policy there.
- Make operational failure modes visible without collecting unnecessary personal data.
- Keep the public workflow frictionless: no signup, no tracking, no framework requirement.
- Preserve the service's narrow scope even when adding features.

## Current Focus

- Maintain the secure upload, view, report, admin-delete, and cleanup flows already present in the app.
- Keep the security model documented in `README.md` and reflected in tests.
- Validate behavior through Vite+, Vitest, and Playwright where changes affect user-facing or security-sensitive paths.
