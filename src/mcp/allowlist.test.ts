import { describe, expect, it } from "vitest";

import { PRODUCTION_HOST } from "../constants.ts";
import {
  hostnameFromHostHeader,
  isAllowedMcpHostname,
  mcpCorsHeaders,
  mcpHostOriginGuard,
} from "./allowlist.ts";

function requestWith(headers: Record<string, string>): Request {
  return new Request("https://example.com/mcp", { headers });
}

describe("MCP host and origin allowlist", () => {
  it("allows origin-less requests, including when Host is absent", () => {
    expect(mcpHostOriginGuard(requestWith({}))).toBeNull();
    expect(mcpHostOriginGuard(requestWith({ Host: PRODUCTION_HOST }))).toBeNull();
  });

  it("allows localhost and production hostnames", () => {
    expect(isAllowedMcpHostname("localhost")).toBe(true);
    expect(isAllowedMcpHostname("127.0.0.1")).toBe(true);
    expect(isAllowedMcpHostname("::1")).toBe(true);
    expect(isAllowedMcpHostname(PRODUCTION_HOST)).toBe(true);
  });

  it("rejects Netlify hosts for both Host and Origin", () => {
    expect(isAllowedMcpHostname("deploy-preview-12--ephemeral-pages.netlify.app")).toBe(false);
    expect(isAllowedMcpHostname("ephemeral-pages.netlify.app")).toBe(false);
  });

  it("strips ports and IPv6 brackets from Host headers", () => {
    expect(hostnameFromHostHeader("localhost:8888")).toBe("localhost");
    expect(hostnameFromHostHeader("[::1]:8888")).toBe("::1");
  });

  it("allows the guard for local ports and production Origin", () => {
    expect(mcpHostOriginGuard(requestWith({ Host: "localhost:8888" }))).toBeNull();
    expect(
      mcpHostOriginGuard(
        requestWith({
          Host: PRODUCTION_HOST,
          Origin: `https://${PRODUCTION_HOST}`,
        }),
      ),
    ).toBeNull();
  });

  it("rejects disallowed Host or Origin values", async () => {
    const badHost = mcpHostOriginGuard(requestWith({ Host: "evil.example" }));
    const badOrigin = mcpHostOriginGuard(
      requestWith({ Host: PRODUCTION_HOST, Origin: "https://evil.example" }),
    );
    const malformedOrigin = mcpHostOriginGuard(
      requestWith({ Host: PRODUCTION_HOST, Origin: "not-a-url" }),
    );
    const netlifyHost = mcpHostOriginGuard(
      requestWith({ Host: "deploy-preview-12--ephemeral-pages.netlify.app" }),
    );

    expect(badHost?.status).toBe(403);
    expect(badOrigin?.status).toBe(403);
    expect(malformedOrigin?.status).toBe(403);
    expect(netlifyHost?.status).toBe(403);
    expect(await badHost?.text()).toBe("Forbidden");
  });

  it("emits CORS only for allowlisted Origins and never uses a wildcard", () => {
    expect(mcpCorsHeaders(requestWith({}))).toEqual({});
    expect(mcpCorsHeaders(requestWith({ Origin: "https://evil.example" }))).toEqual({});

    const allowed = mcpCorsHeaders(requestWith({ Origin: "http://localhost:6274" }));
    expect(allowed["Access-Control-Allow-Origin"]).toBe("http://localhost:6274");
    expect(allowed["Access-Control-Allow-Origin"]).not.toBe("*");
    expect(
      mcpCorsHeaders(
        requestWith({ Origin: "https://deploy-preview-12--ephemeral-pages.netlify.app" }),
      ),
    ).toEqual({});
  });
});
