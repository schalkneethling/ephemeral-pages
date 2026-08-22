import { describe, expect, it } from "vitest";

import { createJsonApiRequest, readApiError, readApiJson } from "./api-http.ts";

describe("API HTTP helpers", () => {
  it("clones incoming headers, drops Authorization, and applies an idempotency key", () => {
    const incoming = new Request("https://example.com/mcp", {
      headers: {
        Authorization: "Bearer token",
        "x-nf-client-connection-ip": "203.0.113.1",
      },
    });
    const request = createJsonApiRequest(
      incoming,
      { html: "<html></html>" },
      { idempotencyKey: "run-1" },
    );

    expect(request.url).toBe("https://example.com/mcp");
    expect(request.headers.get("Authorization")).toBeNull();
    expect(request.headers.get("x-nf-client-connection-ip")).toBe("203.0.113.1");
    expect(request.headers.get("Content-Type")).toBe("application/json");
    expect(request.headers.get("Idempotency-Key")).toBe("run-1");
  });

  it("does not set Idempotency-Key when the key is null or omitted", () => {
    const incoming = new Request("https://example.com/mcp");
    const omitted = createJsonApiRequest(incoming, { html: "<html></html>" });
    const explicitNull = createJsonApiRequest(
      incoming,
      { html: "<html></html>" },
      { idempotencyKey: null },
    );

    expect(omitted.headers.get("Idempotency-Key")).toBeNull();
    expect(explicitNull.headers.get("Idempotency-Key")).toBeNull();
  });

  it("reads a JSON API error string and falls back when the body is unusable", async () => {
    const jsonError = new Response(JSON.stringify({ error: "Gone" }), { status: 410 });
    const empty = new Response("not-json", { status: 500 });
    const missing = new Response(JSON.stringify({}), { status: 500 });

    expect(await readApiError(jsonError)).toBe("Gone");
    expect(await readApiError(empty)).toBe("Something went wrong");
    expect(await readApiError(missing)).toBe("Something went wrong");
  });

  it("parses JSON bodies and returns null for invalid JSON", async () => {
    const ok = new Response(JSON.stringify({ id: "abc" }));
    const invalid = new Response("nope");

    expect(await readApiJson<{ id: string }>(ok)).toEqual({ id: "abc" });
    expect(await readApiJson(invalid)).toBeNull();
  });
});
