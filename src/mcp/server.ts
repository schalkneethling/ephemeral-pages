import { McpServer } from "@modelcontextprotocol/server";

import { PRODUCTION_HOST } from "../constants.ts";
import type { PageStore } from "../../netlify/functions/storage.ts";
import {
  CREATE_PAGE_TOOL_DESCRIPTION,
  CREATE_PAGE_TOOL_NAME,
  GET_PAGE_TOOL_DESCRIPTION,
  GET_PAGE_TOOL_NAME,
  PUBLISH_HTML_PAGE_PROMPT_DESCRIPTION,
  PUBLISH_HTML_PAGE_PROMPT_NAME,
  createPageInputSchema,
  getPageInputSchema,
  publishHtmlPagePromptArgs,
  publishHtmlPagePromptText,
} from "./definitions.ts";
import { publishPage, readPage, type PageToolDependencies } from "./tools.ts";

export interface CreateEphemeralPagesMcpServerOptions {
  incoming: Request;
  store: PageStore;
  dependencies?: PageToolDependencies;
}

function toolResponse(result: Awaited<ReturnType<typeof publishPage>>) {
  if (result.isError) {
    return {
      isError: true,
      content: [{ type: "text" as const, text: result.text }],
    };
  }

  return {
    content: [{ type: "text" as const, text: result.text }],
    structuredContent: result.structuredContent,
  };
}

export function createEphemeralPagesMcpServer({
  incoming,
  store,
  dependencies,
}: CreateEphemeralPagesMcpServerOptions): McpServer {
  const server = new McpServer(
    {
      name: "ephemeral-pages",
      title: "Ephemeral Pages",
      version: "0.5.0",
      description: "Publish short-lived public HTML pages that expire automatically.",
      websiteUrl: `https://${PRODUCTION_HOST}`,
    },
    {
      instructions:
        "Use create_page with a full HTML document, then share the returned URL. Use get_page to look up metadata for a known id.",
      cacheHints: {
        "tools/list": { ttlMs: 24 * 60 * 60 * 1000, cacheScope: "public" },
        "prompts/list": { ttlMs: 24 * 60 * 60 * 1000, cacheScope: "public" },
      },
    },
  );

  server.registerTool(
    CREATE_PAGE_TOOL_NAME,
    {
      title: "Create ephemeral page",
      description: CREATE_PAGE_TOOL_DESCRIPTION,
      inputSchema: createPageInputSchema,
    },
    async (args) =>
      toolResponse(
        await publishPage(
          incoming,
          {
            html: args.html,
            expirationHours: args.expirationHours,
            idempotencyKey: args.idempotencyKey,
          },
          store,
          dependencies,
        ),
      ),
  );

  server.registerTool(
    GET_PAGE_TOOL_NAME,
    {
      title: "Get ephemeral page metadata",
      description: GET_PAGE_TOOL_DESCRIPTION,
      inputSchema: getPageInputSchema,
    },
    async (args) => toolResponse(await readPage(incoming, { id: args.id }, store, dependencies)),
  );

  server.registerPrompt(
    PUBLISH_HTML_PAGE_PROMPT_NAME,
    {
      title: "Publish an HTML page",
      description: PUBLISH_HTML_PAGE_PROMPT_DESCRIPTION,
      argsSchema: publishHtmlPagePromptArgs,
    },
    ({ html }) => ({
      messages: [
        {
          role: "user" as const,
          content: { type: "text" as const, text: publishHtmlPagePromptText(html) },
        },
      ],
    }),
  );

  return server;
}
