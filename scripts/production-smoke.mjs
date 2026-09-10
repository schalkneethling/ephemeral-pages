import { brotliCompressSync } from "node:zlib";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";

const FETCH_TIMEOUT_MS = 30_000;
export function parseApiSmokeArguments(args) {
  const parsed = parseArgs({
    args,
    strict: true,
    allowPositionals: false,
    tokens: true,
    options: {
      origin: { type: "string" },
      "confirm-external-smoke": { type: "boolean" },
      "confirm-quota-exhaustion": { type: "boolean" },
    },
  });
  const names = parsed.tokens.filter((token) => token.kind === "option").map((token) => token.name);
  const origin = parsed.values.origin;
  if (
    new Set(names).size !== names.length ||
    !parsed.values["confirm-external-smoke"] ||
    !parsed.values["confirm-quota-exhaustion"] ||
    !origin ||
    new URL(origin).protocol !== "https:" ||
    new URL(origin).origin !== origin
  ) {
    throw new Error("Invalid API smoke arguments.");
  }
  return { origin };
}

export async function runApiSmoke(
  args,
  { fetch: fetchRequest = globalThis.fetch, env = process.env } = {},
) {
  const report = {
    schemaVersion: 1,
    operation: "api-smoke",
    outcome: "blocked",
    checks: [],
    usage: { uploadRequests: 0 },
  };
  let phase = "arguments";
  try {
    const { origin: serviceUrl } = parseApiSmokeArguments(args);
    phase = "authentication";
    const oidcToken = await requestGitHubOidcToken(serviceUrl, fetchRequest, env);
    phase = "plain-upload";
    const runId = `${Date.now()}-${crypto.randomUUID()}`;
    const plainKey = `api-smoke-plain-${runId}`;
    const compressedKey = `api-smoke-compressed-${runId}`;
    const html = `<!doctype html><html><head><meta charset="utf-8"><title>API smoke ${runId}</title></head><body><h1>Ephemeral Pages API smoke test</h1><p>${runId}</p></body></html>`;

    async function createPage(body, idempotencyKey) {
      const headers = {
        "Content-Type": "application/json",
        "Idempotency-Key": idempotencyKey,
      };
      if (oidcToken) headers.Authorization = `Bearer ${oidcToken}`;

      report.usage.uploadRequests += 1;
      const response = await fetchRequest(`${serviceUrl}/api/pages`, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        redirect: "error",
      });
      if (response.status === 429) {
        const retryAfter = response.headers.get("retry-after");
        const seconds = Number(retryAfter);
        if (/^[1-9][0-9]*$/u.test(retryAfter ?? "") && Number.isSafeInteger(seconds)) {
          report.retryAfterSeconds = seconds;
        }
      }
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

    function assert(condition) {
      if (!condition) throw new Error("API smoke check failed.");
    }
    function passed(id) {
      report.checks.push({ id, outcome: "passed" });
    }

    const plain = await createPage({ html, expirationHours: 1 }, plainKey);
    assert(plain.status === 201, "Plain upload did not return 201", plain);
    assert(
      new URL(plain.payload.url).origin === serviceUrl,
      "Plain upload URL origin is invalid",
      plain,
    );
    assert(plain.headers.limit === "10", "Plain upload rate-limit header is invalid", plain);

    passed("plain-upload");
    phase = "idempotency";
    const replay = await createPage({ html, expirationHours: 1 }, plainKey);
    assert(replay.status === 200, "Idempotent replay did not return 200", replay);
    assert(
      replay.payload.id === plain.payload.id,
      "Idempotent replay returned another page",
      replay,
    );

    const conflict = await createPage(
      {
        html: html.replace("API smoke test", "changed API smoke test"),
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

    passed("idempotency");
    phase = "compressed-upload";
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

    passed("compressed-upload");
    phase = "quota";
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

    passed("quota");
    report.outcome = "passed";
  } catch {
    report.checks.push({ id: phase, outcome: "blocked" });
  }
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const report = await runApiSmoke(process.argv.slice(2));
  console.log(JSON.stringify(report, null, 2));
  if (report.outcome !== "passed") process.exitCode = 1;
}

async function requestGitHubOidcToken(audience, fetchRequest, env) {
  const requestUrl = env.ACTIONS_ID_TOKEN_REQUEST_URL;
  const requestToken = env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
  if (!requestUrl && !requestToken) return null;
  if (!requestUrl || !requestToken) {
    throw new Error("GitHub Actions exposed incomplete OIDC configuration");
  }

  const url = new URL(requestUrl);
  if (url.protocol !== "https:") throw new Error("Invalid OIDC endpoint.");
  url.searchParams.set("audience", audience);
  const response = await fetchRequest(url, {
    headers: { Authorization: `Bearer ${requestToken}` },
    redirect: "error",
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`GitHub OIDC token request failed with ${response.status}`);

  const payload = await response.json();
  if (typeof payload?.value !== "string" || payload.value.length === 0) {
    throw new Error("GitHub OIDC token response was invalid");
  }
  return payload.value;
}
