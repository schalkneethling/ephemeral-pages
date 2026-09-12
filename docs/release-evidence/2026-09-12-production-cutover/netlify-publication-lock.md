# Production publication cutover

Status: verified locked through the authenticated Netlify UI.

Production deployment: `6aa43cfb4b7bde0008cfc4d9`.
Git source: `65aab59bd6ec4a9ae84aa55f8154287b5bbd9e8b`, branch `main`.
Origin: https://ephemeral.schalkneethling.com

Netlify dashboard identifies this as the published production deployment and offers “Lock to stop auto publishing”. Both Varlock production-token attempts timed out before executing the API helper; no API checkpoint exists. The operator-authorized fallback uses the existing authenticated Netlify browser session.

Verified at 2026-09-12T08:16:17.807033+00:00. The deployment detail page now reports “Published & locked deploy for ephemeral-pages”, “Publishing is locked to this deploy”, and offers “Unlock to start auto publishing”. The production source remains `main@65aab59`, and the deployment URL remains `6aa43cfb4b7bde0008cfc4d9`. The lock operation did not replace the published production deployment.

After promotion PR #60 merged as `5ae34ea8773790e7a855b86d387b6e63a7e2a5a1`, the Netlify deploy list showed the new Git-triggered production build `6aa50a5abdfc8c000888a11d` as Completed, while the header still showed “Auto Publishing Locked” and “Published main@65aab59”. Thus build `6aa50a5abdfc8c000888a11d` remained unpublished and did not replace the published production deployment.
