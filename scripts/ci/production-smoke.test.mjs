import { describe, expect, it, vi } from "vitest";
import { parseApiSmokeArguments, runApiSmoke } from "../production-smoke.mjs";

const origin = "https://smoke.example.test";
const args = ["--origin", origin, "--confirm-external-smoke", "--confirm-quota-exhaustion"];
const secret = "SECRET_SENTINEL";
const response = (status, id = secret, headers = {}) =>
  new Response(JSON.stringify({ id, url: `${origin}/p/${id}`, details: secret }), {
    status,
    headers: { "x-ratelimit-limit": "10", ...headers },
  });
const responseWithoutId = (status, headers = {}) =>
  new Response(JSON.stringify({ url: `${origin}/p/missing`, details: secret }), {
    status,
    headers: { "x-ratelimit-limit": "10", ...headers },
  });

function successfulResponses() {
  return [
    response(201),
    response(200),
    response(409),
    response(200),
    response(201, `${secret}-compressed`),
    response(200, `${secret}-compressed`),
    response(429, secret, {
      "x-ratelimit-remaining": "0",
      "x-ratelimit-reset": String(Math.floor(Date.now() / 1000) + 600),
      "retry-after": "600",
    }),
  ];
}

describe("API smoke target and evidence", () => {
  it.each([
    [],
    args.slice(0, -1),
    args.slice(2),
    [...args, "--origin", origin],
    [...args, "--unknown"],
    ["--origin", "http://smoke.example.test", ...args.slice(2)],
    ...["/", "/p/private", "?ticket=private", "#edit=private"].map((suffix) => [
      "--origin",
      `${origin}${suffix}`,
      ...args.slice(2),
    ]),
  ])("rejects unsafe or incomplete arguments without network access: %j", async (...input) => {
    // Each table row is the argument array itself.
    const fetch = vi.fn();
    const report = await runApiSmoke(input, { fetch, env: {} });
    expect(report.outcome).toBe("blocked");
    expect(report.checks).toEqual([{ id: "arguments", outcome: "blocked" }]);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("accepts an explicit origin and both quota opt-ins", () => {
    expect(parseApiSmokeArguments(args)).toEqual({ origin });
  });

  it("retains checks and request count without sensitive success data", async () => {
    const responses = successfulResponses();
    const fetch = vi.fn(async () => responses.shift());
    const report = await runApiSmoke(args, { fetch, env: {} });
    expect(report.outcome).toBe("passed");
    expect(report.checks.map(({ id }) => id)).toEqual([
      "plain-upload",
      "idempotency",
      "compressed-upload",
      "quota",
    ]);
    expect(report.usage.uploadRequests).toBe(7);
    expect(report.retryAfterSeconds).toBe(600);
    expect(fetch).toHaveBeenCalledTimes(7);
    expect(JSON.stringify(report)).not.toContain(secret);
    expect(JSON.stringify(report)).not.toContain(origin);
    for (const [, options] of fetch.mock.calls) {
      expect(options.signal).toBeInstanceOf(AbortSignal);
      expect(options.redirect).toBe("error");
    }
  });

  it("stops on early rate limiting without exposing the payload", async () => {
    const fetch = vi.fn(async () => response(429));
    const report = await runApiSmoke(args, { fetch, env: {} });
    expect(report.outcome).toBe("blocked");
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(report)).not.toContain(secret);
  });

  it("redacts thrown transport errors and incomplete authentication", async () => {
    const fetch = vi.fn(async () => {
      throw new Error(secret);
    });
    const report = await runApiSmoke(args, { fetch, env: {} });
    expect(report.outcome).toBe("blocked");
    expect(JSON.stringify(report)).not.toContain(secret);
    fetch.mockClear();
    const missing = await runApiSmoke(args, {
      fetch,
      env: { ACTIONS_ID_TOKEN_REQUEST_TOKEN: secret },
    });
    expect(missing.checks).toEqual([{ id: "authentication", outcome: "blocked" }]);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects incorrect idempotent replay and quota metadata", async () => {
    for (const invalid of ["replay", "quota"]) {
      const responses = successfulResponses();
      if (invalid === "replay") responses[1] = response(200, "different");
      else responses[6] = response(429);
      const fetch = vi.fn(async () => responses.shift());
      const report = await runApiSmoke(args, { fetch, env: {} });
      expect(report.outcome).toBe("blocked");
      expect(report.checks.at(-1).id).toBe(invalid === "replay" ? "idempotency" : "quota");
    }
  });

  it.each([
    { index: 0, status: 201, phase: "plain-upload", missing: true },
    { index: 0, status: 201, phase: "plain-upload", missing: false },
    { index: 1, status: 200, phase: "idempotency", missing: true },
    { index: 3, status: 200, phase: "idempotency", missing: true },
    { index: 4, status: 201, phase: "compressed-upload", missing: true },
    { index: 5, status: 200, phase: "quota", missing: true },
  ])(
    "rejects an absent or empty response ID during $phase",
    async ({ index, status, phase, missing }) => {
      const responses = successfulResponses();
      responses[index] = missing ? responseWithoutId(status) : response(status, "");
      const fetch = vi.fn(async () => responses.shift());
      const report = await runApiSmoke(args, { fetch, env: {} });
      expect(report.outcome).toBe("blocked");
      expect(report.checks.at(-1)).toEqual({ id: phase, outcome: "blocked" });
      expect(JSON.stringify(report)).not.toContain(secret);
    },
  );

  it.each([
    ["x-ratelimit-reset", "Infinity"],
    ["x-ratelimit-reset", `${Math.floor(Date.now() / 1000) + 600}.5`],
    ["x-ratelimit-reset", "9007199254740992"],
    ["x-ratelimit-reset", String(Math.floor(Date.now() / 1000))],
    ["retry-after", "Infinity"],
    ["retry-after", "0.5"],
    ["retry-after", "0"],
    ["retry-after", "9007199254740992"],
  ])("rejects noncanonical quota header %s=%s", async (name, value) => {
    const responses = successfulResponses();
    const validHeaders = Object.fromEntries(responses[6].headers.entries());
    responses[6] = response(429, secret, { ...validHeaders, [name]: value });
    const fetch = vi.fn(async () => responses.shift());
    const report = await runApiSmoke(args, { fetch, env: {} });
    expect(report.outcome).toBe("blocked");
    expect(report.checks.at(-1)).toEqual({ id: "quota", outcome: "blocked" });
    expect(JSON.stringify(report)).not.toContain(secret);
  });
});
