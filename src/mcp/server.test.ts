import { describe, expect, it } from "vitest";

import {
  CREATE_PAGE_TOOL_ANNOTATIONS,
  CREATE_PAGE_TOOL_DESCRIPTION,
  CREATE_PAGE_TOOL_NAME,
  GET_PAGE_TOOL_ANNOTATIONS,
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
    expect(CREATE_PAGE_TOOL_DESCRIPTION).toContain(
      "complete, self-contained HTML document as a public ephemeral page",
    );
    expect(CREATE_PAGE_TOOL_DESCRIPTION).toContain(
      "The resulting URL is public, expires automatically",
    );
    expect(CREATE_PAGE_TOOL_DESCRIPTION).toContain(
      "Never include secrets, credentials, private source, or sensitive data",
    );
    expect(CREATE_PAGE_TOOL_DESCRIPTION).toContain("fetch, XHR, and WebSocket are blocked");
    expect(CREATE_PAGE_TOOL_DESCRIPTION).toContain("html must be a full HTML page");
    expect(CREATE_PAGE_TOOL_DESCRIPTION).not.toContain("source-authored");
    expect(createPageInputSchema.shape.html.description).toContain(
      "A complete, self-contained HTML document",
    );
    expect(createPageInputSchema.shape.expirationHours).toBeDefined();
    expect(createPageInputSchema.shape.idempotencyKey).toBeDefined();
    expect(CREATE_PAGE_TOOL_ANNOTATIONS).toEqual({
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    });
  });

  it("describes get_page as metadata-only", () => {
    const getPage = mcpToolDefinitions.find((tool) => tool.name === GET_PAGE_TOOL_NAME);
    expect(getPage?.requiredArguments).toEqual(["id"]);
    expect(GET_PAGE_TOOL_DESCRIPTION).toContain("Does not return HTML");
    expect(getPageInputSchema.shape.id).toBeDefined();
    expect(GET_PAGE_TOOL_ANNOTATIONS).toEqual({
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    });
  });

  it("instructs publish-html-page to read a file path and call create_page", () => {
    const path = "reports/latest.html";
    expect(mcpPromptDefinitions.map((prompt) => prompt.name)).toEqual([
      PUBLISH_HTML_PAGE_PROMPT_NAME,
    ]);
    expect(mcpPromptDefinitions[0]?.requiredArguments).toEqual(["path"]);
    expect(mcpPromptDefinitions[0]?.optionalArguments).toEqual([]);

    const text = publishHtmlPagePromptText(path);
    expect(text).toContain(`using the ${CREATE_PAGE_TOOL_NAME} tool`);
    expect(text).toContain("Read the file at that path");
    expect(text).toContain(`call ${CREATE_PAGE_TOOL_NAME} with its contents`);
    expect(text).toContain("Do not guess the HTML if the file can be read");
    expect(text).toContain(`Path: ${path}`);
    expect(text).toContain(
      "html must be a complete, self-contained HTML document (doctype plus html, head, and body)",
    );
    expect(text).toContain(
      "Never include secrets, credentials, private source, or sensitive test data",
    );
    expect(text).toContain("jsDelivr, unpkg, cdnjs, Google Fonts");
    expect(text).toContain("fetch, XHR, and WebSocket are blocked");
    expect(text).toContain("1, 3, 5, 7, 12, 24, 72, 120, or 168");
    expect(text).not.toContain("source-authored");
  });
});
