import { z } from "zod/v4";

import { DEFAULT_HOURS } from "../domain.ts";

const expirationHours = [1, 3, 5, 7, 12, 24, 72, 120, 168] as const;

export const CREATE_PAGE_TOOL_NAME = "create_page";
export const GET_PAGE_TOOL_NAME = "get_page";
export const PUBLISH_HTML_PAGE_PROMPT_NAME = "publish-html-page";

export const CREATE_PAGE_TOOL_DESCRIPTION =
  "Publish a complete, self-contained HTML document as a public ephemeral page. The resulting URL is public, expires automatically, and is deleted after expiry. Never include secrets, credentials, private source, or sensitive data. Uploaded pages are sandboxed: declarative script, stylesheet, and font tags may load only from approved CDNs (jsDelivr, unpkg, cdnjs, Google Fonts); fetch, XHR, and WebSocket are blocked. html must be a full HTML page (typically a doctype plus html, head, and body). Optional expirationHours: 1, 3, 5, 7, 12 (default), 24, 72, 120, or 168. Optional idempotencyKey (1-200 printable ASCII) retries the same publish safely.";

export const GET_PAGE_TOOL_DESCRIPTION =
  "Return metadata for a previously published ephemeral page by id: id, createdAt, expiresAt, and the public URL. Does not return HTML. Expired pages are gone; unknown ids are not found.";

export const CREATE_PAGE_TOOL_ANNOTATIONS = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: false,
} as const;

export const GET_PAGE_TOOL_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;

export const PUBLISH_HTML_PAGE_PROMPT_DESCRIPTION = `Instructions for publishing a full HTML page with ${CREATE_PAGE_TOOL_NAME}, from a file path or pasted HTML.`;

export const createPageInputSchema = z.object({
  html: z
    .string()
    .min(1)
    .describe(
      "A complete, self-contained HTML document. Typical form: doctype plus html, head, and body. Fragments, Markdown, and a bare body are not a page.",
    ),
  expirationHours: z
    .literal(expirationHours)
    .optional()
    .describe(
      `TTL in hours. Allowed values: ${expirationHours.join(", ")}. Default ${DEFAULT_HOURS}.`,
    ),
  idempotencyKey: z
    .string()
    .min(1)
    .max(200)
    .regex(/^[\x20-\x7E]+$/)
    .optional()
    .describe("Optional 1-200 printable ASCII key that replays the same publish safely."),
});

export const getPageInputSchema = z.object({
  id: z.string().min(1).describe(`The page id returned by ${CREATE_PAGE_TOOL_NAME}.`),
});

export const publishHtmlPagePromptArgs = z.object({
  path: z
    .string()
    .min(1)
    .optional()
    .describe(
      `Optional path to an HTML file. The agent should read that file, then call ${CREATE_PAGE_TOOL_NAME} with its contents.`,
    ),
  html: z
    .string()
    .optional()
    .describe("Optional full HTML document to include in the prompt as a starting point."),
});

export const mcpToolDefinitions = [
  {
    name: CREATE_PAGE_TOOL_NAME,
    description: CREATE_PAGE_TOOL_DESCRIPTION,
    requiredArguments: ["html"],
    optionalArguments: ["expirationHours", "idempotencyKey"],
  },
  {
    name: GET_PAGE_TOOL_NAME,
    description: GET_PAGE_TOOL_DESCRIPTION,
    requiredArguments: ["id"],
    optionalArguments: [],
  },
] as const;

export const mcpPromptDefinitions = [
  {
    name: PUBLISH_HTML_PAGE_PROMPT_NAME,
    description: PUBLISH_HTML_PAGE_PROMPT_DESCRIPTION,
    optionalArguments: ["path", "html"],
  },
] as const;

export function publishHtmlPagePromptText({
  html,
  path,
}: {
  html?: string;
  path?: string;
} = {}): string {
  const extras: string[] = [];
  if (path) {
    extras.push(
      `The caller provided a file path. Read the file at that path, then call ${CREATE_PAGE_TOOL_NAME} with its contents (or a corrected full page). Do not guess the HTML if the file can be read.\n\nPath: ${path}`,
    );
  }
  if (html) {
    extras.push(
      path
        ? `If the file cannot be read, use this HTML instead (or a corrected full page):\n\n${html}`
        : `The caller already drafted this HTML. Review it, then call ${CREATE_PAGE_TOOL_NAME} with it (or a corrected full page):\n\n${html}`,
    );
  }

  return `Publish HTML to Ephemeral Pages using the ${CREATE_PAGE_TOOL_NAME} tool.

Requirements:
- html must be a complete, self-contained HTML document (doctype plus html, head, and body). Do not send Markdown, fragments, or a bare body.
- The page URL will be public and will expire. Never include secrets, credentials, private source, or sensitive test data.
- Scripts, styles, and fonts may load only from the service allowlist (jsDelivr, unpkg, cdnjs, Google Fonts). fetch, XHR, and WebSocket are blocked.
- Choose expirationHours from 1, 3, 5, 7, 12, 24, 72, 120, or 168. Default is 12 hours.
- After publishing, share the returned url with the user.
${extras.length > 0 ? `\n${extras.join("\n\n")}\n` : ""}`;
}
