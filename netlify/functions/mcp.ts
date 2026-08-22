import type { Config } from "@netlify/functions";
import { createMcpHandler } from "@modelcontextprotocol/server";

import { NETLIFY_EDGE_RATE_LIMIT } from "../../src/constants.ts";
import { mcpCorsHeaders, mcpHostOriginGuard } from "../../src/mcp/allowlist.ts";
import { createEphemeralPagesMcpServer } from "../../src/mcp/server.ts";
import { captureException, initSentry } from "./security.ts";
import { createPageStore } from "./storage.ts";

export const MCP_HANDLER_OPTIONS = {
  legacy: "reject",
  responseMode: "json",
} as const;

export const config: Config & {
  rateLimit: { aggregateBy: string[]; windowSize: number; windowLimit: number };
} = {
  path: "/mcp",
  rateLimit: NETLIFY_EDGE_RATE_LIMIT,
};

function createRequestHandler(incoming: Request) {
  return createMcpHandler(
    () =>
      createEphemeralPagesMcpServer({
        incoming,
        store: createPageStore(),
      }),
    {
      ...MCP_HANDLER_OPTIONS,
      onerror: (error) => {
        captureException(error);
      },
    },
  );
}

function withCors(request: Request, response: Response): Response {
  const cors = mcpCorsHeaders(request);
  if (Object.keys(cors).length === 0) {
    return response;
  }

  const headers = new Headers(response.headers);
  for (const [name, value] of Object.entries(cors)) {
    headers.set(name, value);
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

export default async function mcp(req: Request): Promise<Response> {
  initSentry();

  const rejected = mcpHostOriginGuard(req);
  if (rejected) {
    return rejected;
  }

  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: mcpCorsHeaders(req) });
  }

  return withCors(req, await createRequestHandler(req).fetch(req));
}
