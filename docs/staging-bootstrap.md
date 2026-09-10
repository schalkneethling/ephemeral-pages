# Staging provider bootstrap

This is a one-time operator procedure for the isolated release rehearsal environment. It does not
change production. Keep `environments.staging` null in `scripts/release/environments.json` until
both targets exist, their configuration has been inspected, and the first staging deployment has
passed the required smoke tests.

The proposed names are inputs, not discovered defaults:

- Netlify project: `ephemeral-pages-staging`, in team `schalkneethling`
- Cloudflare Worker and ticket audience: `ephemeral-pages-collaboration-staging`
- Netlify origin: `https://ephemeral-pages-staging.netlify.app`
- Worker HTTPS origin: `https://ephemeral-pages-collaboration-staging.volume4-schalk.workers.dev`
- Worker WebSocket origin: `wss://ephemeral-pages-collaboration-staging.volume4-schalk.workers.dev`

Name availability and the final provider origins must be verified before these values become
release configuration.

## Create the Netlify project

Use `scripts/release/staging-bootstrap.json`, or create a JSON input file containing exactly the six non-secret variables.
The parser rejects extra keys, including secret variable names. The proposed input is:

```json
{
  "accountId": "5ad7250d11b73b30fd9f052f",
  "accountSlug": "schalkneethling",
  "siteName": "ephemeral-pages-staging",
  "nonSecretVariables": {
    "PUBLIC_BASE_URL": "https://ephemeral-pages-staging.netlify.app",
    "COLLABORATION_SERVICE_URL": "https://ephemeral-pages-collaboration-staging.volume4-schalk.workers.dev",
    "COLLABORATION_WEBSOCKET_URL": "wss://ephemeral-pages-collaboration-staging.volume4-schalk.workers.dev",
    "COLLABORATION_TICKET_AUDIENCE": "ephemeral-pages-collaboration-staging",
    "COLLABORATION_CAPABILITY_CURRENT_VERSION": "v1",
    "COLLABORATION_ENABLED": "true"
  }
}
```

Run the executable with a durable checkpoint path outside the repository:

```sh
bun scripts/release/bootstrap-cli.ts \
  --input /secure/operator/staging-bootstrap.json \
  --checkpoint /secure/operator/staging-bootstrap.checkpoint.json
```

The executable accepts no secret arguments. It verifies the installed `netlify-cli` 27.5.0 and
Wrangler 4.125.0 package versions, reads the production project ID from the checked release
configuration, and inspects that project before any mutation. The staging name must differ from
the production project name. An exclusive lock prevents concurrent runs. Checkpoint replacement is
atomic, and the checkpoint contains only the phase, project ID, and input fingerprint.

The helper writes `pending-site-creation` before calling Netlify, uses the exact team API, and
records the returned project ID immediately. Before any environment write, it reads the new project
back and verifies the exact name, team, account, `ssl_url`, and unlinked repository metadata. It
does not use `sites:create`: Netlify CLI 27.5.0 retries a name collision with a random suffix, which
could create an unintended project. The exact creation request is:

```sh
./node_modules/.bin/netlify api createSiteInTeam --data '{"account_slug":"schalkneethling","body":{"name":"ephemeral-pages-staging"}}'
```

The project has no linked Git repository and accepts manual deployments. Netlify returns empty
`build_settings` for a newly created unlinked project; `stop_builds` is not an applicable creation
control here. Bootstrap verifies the absence of Git repository metadata and the exact site identity
before configuring variables. Do not link a repository to this staging project.
The API request uses the pinned CLI’s `post_processing` scope spelling; policy and reports normalize
it to `post-processing`. The helper then creates only these non-secret values in the project's Production context:

| Variable                                   | Value                                                                      | Minimum scopes    |
| ------------------------------------------ | -------------------------------------------------------------------------- | ----------------- |
| `PUBLIC_BASE_URL`                          | `https://ephemeral-pages-staging.netlify.app`                              | Functions         |
| `COLLABORATION_SERVICE_URL`                | `https://ephemeral-pages-collaboration-staging.volume4-schalk.workers.dev` | Functions         |
| `COLLABORATION_WEBSOCKET_URL`              | `wss://ephemeral-pages-collaboration-staging.volume4-schalk.workers.dev`   | Builds, Functions |
| `COLLABORATION_TICKET_AUDIENCE`            | `ephemeral-pages-collaboration-staging`                                    | Functions         |
| `COLLABORATION_CAPABILITY_CURRENT_VERSION` | `v1`                                                                       | Functions         |
| `COLLABORATION_ENABLED`                    | `true`; deploy the app only after Worker and secrets are ready             | Functions         |

Some Netlify account plans expose only All scopes. The helper therefore requests All scopes for
these non-secret variables. The policy above records required minimum scopes, so the additional
`builds`, `runtime`, or `post-processing` scopes are allowed. Inspection must still confirm every
minimum scope.

Every mutation has a pending checkpoint. If a command times out, fails, or returns malformed data,
do not repeat it. The Netlify API client used by CLI 27.5.0 can make up to five internal retries for HTTP 429,
`ETIMEDOUT`, or `ECONNRESET`. Those attempts are part of one checkpointed command. The bootstrap
executable does not make an outer retry; once that command returns ambiguously, the pending
checkpoint blocks another mutation until recovery inspection succeeds.

Inspect the exact target first. After an ambiguous site creation, provide the operator-inspected
candidate ID:

```sh
bun scripts/release/bootstrap-cli.ts \
  --input /secure/operator/staging-bootstrap.json \
  --checkpoint /secure/operator/staging-bootstrap.checkpoint.json \
  --recover-site <verified-site-id>
```

After an ambiguous variable write, request read-only recovery:

```sh
bun scripts/release/bootstrap-cli.ts \
  --input /secure/operator/staging-bootstrap.json \
  --checkpoint /secure/operator/staging-bootstrap.checkpoint.json \
  --recover-variables
```

Recovery advances only after `getSite` or `getEnvVars` proves the exact expected state. If all six
variable keys are absent, recovery returns to `site-created`; partial configuration remains blocked. An
inaccessible provider remains blocked. Never delete or recreate a partial target as an automatic
recovery step. A stale lock also blocks execution and requires operator inspection before removal.

## Provision the staging Worker and storage

Add an explicit `env.staging` entry to `collaboration-worker/wrangler.jsonc` in its own reviewed
change. It must set the exact Worker name, `workers_dev`, required secret names, Browser binding,
the Durable Object binding, and these variables:

| Variable               | Value                                                                      |
| ---------------------- | -------------------------------------------------------------------------- |
| `ALLOWED_ORIGINS`      | `https://ephemeral-pages-staging.netlify.app`                              |
| `PAGE_CONTENT_ORIGIN`  | `https://ephemeral-pages-staging.netlify.app`                              |
| `PUBLIC_WORKER_ORIGIN` | `https://ephemeral-pages-collaboration-staging.volume4-schalk.workers.dev` |
| `TICKET_AUDIENCE`      | `ephemeral-pages-collaboration-staging`                                    |

The per-environment Durable Object binding is required because bindings are not inherited. The
existing top-level migration is inherited by Wrangler 4.125.0:

```jsonc
{
  "tag": "v1",
  "new_sqlite_classes": ["CollaborationRoom"],
}
```

There is no separate namespace-creation command. On the first staging deployment, Wrangler sees no
migration tag for the new Worker and applies the complete migration list, creating a distinct
SQLite-backed namespace for the staging Worker.

The reviewed bootstrap wrapper resolves the staging secrets through Varlock, validates the exact
account and staging configuration, and requires the Worker to be absent. It writes the two Worker
secrets to a temporary file outside the repository with operator-only permissions, removes it after
the command returns, and records a pending checkpoint before deployment. The first deployment is
an explicit Durable Object migration operation; ordinary version promotion cannot replace it.

```sh
bun run release:worker:bootstrap \
  --input scripts/release/staging-worker-bootstrap.json \
  --checkpoint /secure/operator/staging-worker.checkpoint.json
```

The wrapper pins the staging name, Cloudflare API endpoint, and sanitized logging settings in the
child environment. Wrangler disk logs are disabled. A pending checkpoint blocks a duplicate deploy;
use the wrapper's `--recover-version <verified-version-id>` option only after inspecting the exact
version. Recovery verifies its release marker, bindings, and active deployment. Do not start with
`wrangler secret put`: when the Worker is absent, Wrangler 4.125.0 creates and deploys a placeholder
Worker before adding the secret.

## Local secret provisioning with Varlock

`scripts/release/local/staging/.env.schema` resolves only these four references through the
1Password desktop integration. Varlock and its 1Password plugin are pinned in `package.json`.
The desktop app must be available and may require an unlock or authorization prompt.

- `op://dev/ephemeral-pages/STAGE_COLLABORATION_CAPABILITY_CURRENT_SECRET`
- `op://dev/ephemeral-pages/STAGE_COLLABORATION_TICKET_SECRET`
- `op://dev/ephemeral-pages/STAGE_COLLABORATION_SERVICE_TOKEN`
- `op://dev/ephemeral-pages/STAGE_RATE_LIMIT_SECRET`

The references are safe to version; their resolved values are not. Each value must contain at least
32 characters and differ from the other three. Generate at least 32 random bytes for each secret.
The dedicated schema avoids resolving unrelated application secrets. Caching is disabled and only
the required variables are injected into the child, without Varlock's configuration graph.

```sh
bun run release:secrets:check
bun run release:secrets:provision \
  --input scripts/release/staging-bootstrap.json \
  --bootstrap-checkpoint /secure/operator/staging-bootstrap.checkpoint.json \
  --checkpoint /secure/operator/staging-secrets.checkpoint.json
```

The Netlify wrapper uses the pinned CLI's normal authentication and API client. It validates the
unlinked staging site and completed bootstrap checkpoint, rejects existing secret keys, and writes
the four values as secrets in that site's Production context. Secret scopes are Builds, Functions,
and Runtime; post-processing is excluded because Netlify does not allow secrets in that scope.
Values stay in memory and are never command arguments, checkpoint contents, or report fields.
The wrapper limits each request to one HTTP dispatch and bounds execution. An existing provisioning
checkpoint blocks another attempt; inspect provider metadata before handling an interrupted run.

- Netlify `COLLABORATION_CAPABILITY_CURRENT_SECRET` remains Netlify-only.
- Netlify `COLLABORATION_TICKET_SECRET` and Worker `TICKET_HMAC_SECRET` share the ticket value.
- Netlify `COLLABORATION_SERVICE_TOKEN` and Worker `ADMIN_TOKEN` share the service value.
- Netlify `RATE_LIMIT_SECRET` remains Netlify-only and keys upload rate-limit identities.

The completed staging secret checkpoint records the original three collaboration secrets and
remains historical evidence; do not replay it. Add the missing `RATE_LIMIT_SECRET` through a
separate one-time checkpoint that verifies the same staging target, confirms the original secrets
are present, and refuses to write if `RATE_LIMIT_SECRET` already exists.

Netlify CLI `env:set --secret` puts a value in a command argument, and `env:import` does not mark
values secret. Use the wrapper for this provisioning step. Never put resolved values in Git,
release evidence, logs, or a hand-authored input file.

After both wrappers complete, inspect the providers, deploy the staging candidate, and run the
complete collaboration smoke. Only then replace the null staging targets with the verified project
ID, Worker target, expected non-secret configuration, and required secret names.

## Current bootstrap record

On 2026-09-10, the wrappers provisioned the isolated staging targets:

- Netlify project ID: `9c45026a-d351-40e0-a9ed-2eb9dee63bd3`.
- Worker initial version: `b781f975-c8ce-42cf-9e8f-7aa49bafdfc1`.
- Worker deployment: `c7f6d649-0b62-4b1f-82a2-213e2d4b23a9`.
- Netlify configuration and original three-secret provisioning: passed.
- Worker configuration, secret bindings, and active version verification: passed.

This records provider setup, not a rehearsed release. Application deployment and cross-platform
smoke verification are still required before staging release configuration is enabled. These initial
IDs are historical observations, not hard-coded targets for subsequent releases or recovery.

## Verified initial staging baseline — 2026-09-10

The dedicated pair passed the live collaboration smoke at its stable origins:

- Netlify site: `9c45026a-d351-40e0-a9ed-2eb9dee63bd3`
- Published Netlify deployment: `6aa3071fc4ae7b28250acde7`
- App source: `d91985b3defda60764a92abe8858b4169fb1f214`
- Worker version: `b781f975-c8ce-42cf-9e8f-7aa49bafdfc1`
- Worker deployment: `c7f6d649-0b62-4b1f-82a2-213e2d4b23a9`, serving 100% traffic

Upload, editor/viewer permissions, synchronization between two editors and a viewer, reload
persistence, actual Worker connection interruption and recovery, and PNG screenshot download all
passed. The run used one one-hour fixture and one capture. No page identifiers, editor links,
tickets, page contents, or raw browser traces were retained. Provider metadata does not record Git source attribution for either deployment. The app source
above comes from the guarded local bootstrap checkpoint; do not infer a Worker source from it.
The read-only release status operation also passed against this pair, including required secrets,
origins, scopes, and active deployment IDs.

The initial upload check exposed the missing core `RATE_LIMIT_SECRET`. Staging now resolves that
value from `op://dev/ephemeral-pages/STAGE_RATE_LIMIT_SECRET`, alongside the three collaboration
secrets, and the corrected app deployment includes it. Production was not changed.

This establishes the bootstrap baseline, not a prepared-artifact rehearsal or release approval.
The manual draft returned Netlify's `deploy-preview` context. Publishing or restoring that draft
must not be assumed to replace its function environment with Production-context secrets.
The subsequent staging publish used the Production context. The later
[artifact rehearsal](release-evidence/2026-09-10-staging/README.md) verified that a held
Production-context candidate could be inspected and activated without rebuilding.
The IDs above remain historical bootstrap evidence; consult the rehearsal record for its verified pair.
