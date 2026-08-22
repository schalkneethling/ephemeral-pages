import { describe, expect, it } from "vitest";

import { config as pagesConfig } from "../../netlify/functions/pages.ts";
import { config, MCP_HANDLER_OPTIONS } from "../../netlify/functions/mcp.ts";
import { NETLIFY_EDGE_RATE_LIMIT } from "../constants.ts";

describe("MCP Netlify mount options", () => {
  it("serves only /mcp and does not take over /api/*", () => {
    expect(config.path).toBe("/mcp");
    expect(config.path).not.toBe("/api/*");
  });

  it("uses the same edge rate limit window as the public API", () => {
    expect(NETLIFY_EDGE_RATE_LIMIT).toEqual({
      aggregateBy: ["ip", "domain"],
      windowSize: 60,
      windowLimit: 120,
    });
    expect(config.rateLimit).toEqual(NETLIFY_EDGE_RATE_LIMIT);
    expect(pagesConfig.rateLimit).toEqual(config.rateLimit);
  });

  it("configures a modern-only JSON handler", () => {
    expect(MCP_HANDLER_OPTIONS).toEqual({
      legacy: "reject",
      responseMode: "json",
    });
  });
});
