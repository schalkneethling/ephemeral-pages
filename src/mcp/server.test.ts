import { describe, expect, it } from "vitest";

import {
  CREATE_PAGE_TOOL_DESCRIPTION,
  CREATE_PAGE_TOOL_NAME,
  GET_PAGE_TOOL_DESCRIPTION,
  GET_PAGE_TOOL_NAME,
  PUBLISH_HTML_PAGE_PROMPT_NAME,
  createPageInputSchema,
  getPageInputSchema,
  mcpPromptDefinitions,
  mcpToolDefinitions,
  publishHtmlPagePromptText,
} from "./definitions.ts";

describe("MCP tool and prompt definitions", () => {
  it("exports exactly create_page and get_page", () => {
    expect(mcpToolDefinitions.map((tool) => tool.name)).toEqual([
      CREATE_PAGE_TOOL_NAME,
      GET_PAGE_TOOL_NAME,
    ]);
    expect(mcpToolDefinitions.map((tool) => tool.name)).not.toContain("delete_page");
    expect(mcpToolDefinitions.map((tool) => tool.name)).not.toContain("get_page_content");
    expect(mcpToolDefinitions.map((tool) => tool.name)).not.toContain("report_page");
  });

  it("describes create_page as a public, expiring, full-HTML publish", () => {
    const createPage = mcpToolDefinitions.find((tool) => tool.name === CREATE_PAGE_TOOL_NAME);
    expect(createPage?.requiredArguments).toEqual(["html"]);
    expect(createPage?.optionalArguments).toEqual(["expirationHours", "idempotencyKey"]);
    expect(CREATE_PAGE_TOOL_DESCRIPTION).toContain("public");
    expect(CREATE_PAGE_TOOL_DESCRIPTION).toContain("expire");
    expect(CREATE_PAGE_TOOL_DESCRIPTION.toLowerCase()).toContain("secret");
    expect(CREATE_PAGE_TOOL_DESCRIPTION).toContain("fetch");
    expect(CREATE_PAGE_TOOL_DESCRIPTION).toContain("full HTML page");
    expect(CREATE_PAGE_TOOL_DESCRIPTION).not.toContain("source-authored");
    expect(createPageInputSchema.shape.html.description).toContain("complete, self-contained HTML");
    expect(createPageInputSchema.shape.expirationHours).toBeDefined();
    expect(createPageInputSchema.shape.idempotencyKey).toBeDefined();
  });

  it("describes get_page as metadata-only", () => {
    const getPage = mcpToolDefinitions.find((tool) => tool.name === GET_PAGE_TOOL_NAME);
    expect(getPage?.requiredArguments).toEqual(["id"]);
    expect(GET_PAGE_TOOL_DESCRIPTION).toContain("Does not return HTML");
    expect(getPageInputSchema.shape.id).toBeDefined();
  });

  it("instructs publish-html-page to send a full page and call create_page", () => {
    expect(mcpPromptDefinitions.map((prompt) => prompt.name)).toEqual([
      PUBLISH_HTML_PAGE_PROMPT_NAME,
    ]);
    expect(mcpPromptDefinitions[0]?.optionalArguments).toEqual(["html"]);

    const text = publishHtmlPagePromptText("<!doctype html><html></html>");
    expect(text).toContain("create_page");
    expect(text).toContain("complete, self-contained HTML document");
    expect(text).toContain("Never include secrets");
    expect(text).toContain("Google Fonts");
    expect(text).toContain("1, 3, 5, 7, 12, 24, 72, 120, or 168");
    expect(text).toContain("<!doctype html><html></html>");
    expect(text).not.toContain("source-authored");
  });
});
