import { describe, expect, it } from "vitest";

import { config, MCP_HANDLER_OPTIONS } from "../../netlify/functions/mcp.ts";

describe("MCP Netlify mount options", () => {
  it("serves only /mcp and does not take over /api/*", () => {
    expect(config.path).toBe("/mcp");
    expect(config.path).not.toBe("/api/*");
  });

  it("uses the same edge rate limit window as the public API", () => {
    expect(config.rateLimit).toEqual({
      aggregateBy: ["ip", "domain"],
      windowSize: 60,
      windowLimit: 120,
    });
  });

  it("configures a modern-only JSON handler", () => {
    expect(MCP_HANDLER_OPTIONS).toEqual({
      legacy: "reject",
      responseMode: "json",
    });
  });
});
