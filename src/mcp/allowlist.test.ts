import { describe, expect, it } from "vitest";

import {
  hostnameFromHostHeader,
  isAllowedMcpHostHostname,
  isAllowedMcpOriginHostname,
  mcpCorsHeaders,
  mcpHostOriginGuard,
  PRODUCTION_MCP_HOST,
} from "./allowlist.ts";

function requestWith(headers: Record<string, string>): Request {
  return new Request("https://example.com/mcp", { headers });
}

describe("MCP host and origin allowlist", () => {
  it("allows origin-less requests, including when Host is absent", () => {
    expect(mcpHostOriginGuard(requestWith({}))).toBeNull();
    expect(mcpHostOriginGuard(requestWith({ Host: PRODUCTION_MCP_HOST }))).toBeNull();
  });

  it("allows localhost, production, and Netlify deploy-preview Host hostnames", () => {
    expect(isAllowedMcpHostHostname("localhost")).toBe(true);
    expect(isAllowedMcpHostHostname("127.0.0.1")).toBe(true);
    expect(isAllowedMcpHostHostname("::1")).toBe(true);
    expect(isAllowedMcpHostHostname(PRODUCTION_MCP_HOST)).toBe(true);
    expect(isAllowedMcpHostHostname("deploy-preview-12--ephemeral-pages.netlify.app")).toBe(true);
  });

  it("does not treat Netlify preview hosts as allowed Origins", () => {
    expect(isAllowedMcpOriginHostname("deploy-preview-12--ephemeral-pages.netlify.app")).toBe(
      false,
    );
  });

  it("strips ports and IPv6 brackets from Host headers", () => {
    expect(hostnameFromHostHeader("localhost:8888")).toBe("localhost");
    expect(hostnameFromHostHeader("[::1]:8888")).toBe("::1");
  });

  it("allows the guard for local ports, deploy-preview Hosts, and production Origin", () => {
    expect(mcpHostOriginGuard(requestWith({ Host: "localhost:8888" }))).toBeNull();
    expect(
      mcpHostOriginGuard(requestWith({ Host: "deploy-preview-12--ephemeral-pages.netlify.app" })),
    ).toBeNull();
    expect(
      mcpHostOriginGuard(
        requestWith({
          Host: PRODUCTION_MCP_HOST,
          Origin: `https://${PRODUCTION_MCP_HOST}`,
        }),
      ),
    ).toBeNull();
  });

  it("rejects disallowed Host or Origin values", async () => {
    const badHost = mcpHostOriginGuard(requestWith({ Host: "evil.example" }));
    const badOrigin = mcpHostOriginGuard(
      requestWith({ Host: PRODUCTION_MCP_HOST, Origin: "https://evil.example" }),
    );
    const malformedOrigin = mcpHostOriginGuard(
      requestWith({ Host: PRODUCTION_MCP_HOST, Origin: "not-a-url" }),
    );

    expect(badHost?.status).toBe(403);
    expect(badOrigin?.status).toBe(403);
    expect(malformedOrigin?.status).toBe(403);
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
