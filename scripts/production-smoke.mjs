import { brotliCompressSync } from "node:zlib";

const productionOrigin = "https://ephemeral.schalkneethling.com";
const serviceUrl = new URL(process.env.EPHEMERAL_PAGES_SERVICE_URL ?? productionOrigin).origin;

if (!process.argv.includes("--confirm-production")) {
  throw new Error(
    "This test creates two one-hour pages and exhausts one upload quota bucket. Re-run with --confirm-production to continue.",
  );
}

if (!serviceUrl.startsWith("https://")) {
  throw new Error("EPHEMERAL_PAGES_SERVICE_URL must use HTTPS");
}

const oidcToken = await requestGitHubOidcToken(serviceUrl);
const runId = `${Date.now()}-${crypto.randomUUID()}`;
const plainKey = `production-smoke-plain-${runId}`;
const compressedKey = `production-smoke-compressed-${runId}`;
const html = `<!doctype html><html><head><meta charset="utf-8"><title>Production smoke ${runId}</title></head><body><h1>Ephemeral Pages production smoke test</h1><p>${runId}</p></body></html>`;

async function createPage(body, idempotencyKey) {
  const headers = {
    "Content-Type": "application/json",
    "Idempotency-Key": idempotencyKey,
  };
  if (oidcToken) headers.Authorization = `Bearer ${oidcToken}`;

  const response = await fetch(`${serviceUrl}/api/pages`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  const payload = await response.json();
  return {
    status: response.status,
    payload,
    headers: {
      limit: response.headers.get("x-ratelimit-limit"),
      remaining: response.headers.get("x-ratelimit-remaining"),
      reset: response.headers.get("x-ratelimit-reset"),
      retryAfter: response.headers.get("retry-after"),
    },
  };
}

function assert(condition, message, details) {
  if (!condition) throw new Error(`${message}: ${JSON.stringify(details)}`);
}

const plain = await createPage({ html, expirationHours: 1 }, plainKey);
assert(plain.status === 201, "Plain upload did not return 201", plain);
assert(
  new URL(plain.payload.url).origin === serviceUrl,
  "Plain upload URL origin is invalid",
  plain,
);
assert(plain.headers.limit === "10", "Plain upload rate-limit header is invalid", plain);

const replay = await createPage({ html, expirationHours: 1 }, plainKey);
assert(replay.status === 200, "Idempotent replay did not return 200", replay);
assert(replay.payload.id === plain.payload.id, "Idempotent replay returned another page", replay);

const conflict = await createPage(
  {
    html: html.replace("production smoke test", "changed production smoke test"),
    expirationHours: 1,
  },
  plainKey,
);
assert(conflict.status === 409, "Changed idempotent request did not return 409", conflict);

const compressedHtml = brotliCompressSync(Buffer.from(html, "utf8")).toString("base64");
const equivalentEncodingReplay = await createPage(
  { html: compressedHtml, encoding: "br+base64", expirationHours: 1 },
  plainKey,
);
assert(
  equivalentEncodingReplay.status === 200 &&
    equivalentEncodingReplay.payload.id === plain.payload.id,
  "Equivalent compressed replay was not idempotent",
  equivalentEncodingReplay,
);

const compressed = await createPage(
  { html: compressedHtml, encoding: "br+base64", expirationHours: 1 },
  compressedKey,
);
assert(compressed.status === 201, "Compressed upload did not return 201", compressed);
assert(
  compressed.payload.id !== plain.payload.id,
  "Compressed upload did not create a distinct page",
  compressed,
);

let rateLimited;
let meteredReplays = 0;
for (; meteredReplays < 12; meteredReplays += 1) {
  const attempt = await createPage(
    { html: compressedHtml, encoding: "br+base64", expirationHours: 1 },
    compressedKey,
  );
  if (attempt.status === 429) {
    rateLimited = attempt;
    break;
  }
  assert(attempt.status === 200, "Metered replay returned an unexpected status", attempt);
  assert(
    attempt.payload.id === compressed.payload.id,
    "Metered replay returned another page",
    attempt,
  );
}

assert(rateLimited?.status === 429, "Quota did not return 429", rateLimited);
assert(rateLimited.headers.limit === "10", "429 limit header is invalid", rateLimited);
assert(rateLimited.headers.remaining === "0", "429 remaining header is invalid", rateLimited);
assert(
  Number(rateLimited.headers.reset) > Math.floor(Date.now() / 1000),
  "429 reset is invalid",
  rateLimited,
);
assert(Number(rateLimited.headers.retryAfter) > 0, "429 Retry-After is invalid", rateLimited);

console.log(
  JSON.stringify(
    {
      runId,
      actor: oidcToken ? "github-oidc" : "anonymous",
      checks: {
        plainUpload: "passed",
        compressedUpload: "passed",
        idempotentReplay: "passed",
        encodingIndependentReplay: "passed",
        idempotencyConflict: "passed",
        successfulRateLimitHeaders: "passed",
        quotaExhaustionHeaders: "passed",
      },
      pages: [
        { id: plain.payload.id, url: plain.payload.url, expiresAt: plain.payload.expiresAt },
        {
          id: compressed.payload.id,
          url: compressed.payload.url,
          expiresAt: compressed.payload.expiresAt,
        },
      ],
      rateLimit: { meteredReplays, ...rateLimited.headers },
    },
    null,
    2,
  ),
);

async function requestGitHubOidcToken(audience) {
  const requestUrl = process.env.ACTIONS_ID_TOKEN_REQUEST_URL;
  const requestToken = process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
  if (!requestUrl && !requestToken) return null;
  if (!requestUrl || !requestToken) {
    throw new Error("GitHub Actions exposed incomplete OIDC configuration");
  }

  const url = new URL(requestUrl);
  url.searchParams.set("audience", audience);
  const response = await fetch(url, { headers: { Authorization: `Bearer ${requestToken}` } });
  if (!response.ok) throw new Error(`GitHub OIDC token request failed with ${response.status}`);

  const payload = await response.json();
  if (typeof payload?.value !== "string" || payload.value.length === 0) {
    throw new Error("GitHub OIDC token response was invalid");
  }
  return payload.value;
}
