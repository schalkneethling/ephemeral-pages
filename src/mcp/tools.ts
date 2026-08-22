import { createPage, getPageMetadata } from "../../netlify/functions/pages.ts";
import { getEnv } from "../../netlify/functions/security.ts";
import type { PageStore } from "../../netlify/functions/storage.ts";
import { createJsonApiRequest, readApiError, readApiJson } from "../api-http.ts";
import type { CreatePageResponse } from "../domain.ts";
import { pagePublicUrl, resolvePublicBaseUrl } from "../public-url.ts";

export interface PublishPageArgs {
  html: string;
  expirationHours?: number;
  idempotencyKey?: string;
}

export interface ReadPageArgs {
  id: string;
}

export interface PageToolDependencies {
  publicBaseUrl?: string;
  now?: () => Date;
  createId?: () => string;
}

export interface PageToolSuccess {
  isError: false;
  text: string;
  structuredContent: {
    id: string;
    createdAt: string;
    expiresAt: string;
    url: string;
  };
}

export interface PageToolFailure {
  isError: true;
  text: string;
}

export type PageToolResult = PageToolSuccess | PageToolFailure;

function pageResultText(page: {
  id: string;
  createdAt: string;
  expiresAt: string;
  url: string;
}): string {
  return `Published ${page.url} (id ${page.id}, expires ${page.expiresAt}).`;
}

async function failureFromResponse(response: Response): Promise<PageToolFailure> {
  const error = await readApiError(response);
  const retryAfter = response.headers.get("Retry-After");
  const text = retryAfter ? `${error} Retry after ${retryAfter} seconds.` : error;
  return { isError: true, text };
}

export async function publishPage(
  incoming: Request,
  args: PublishPageArgs,
  store: PageStore,
  dependencies: PageToolDependencies = {},
): Promise<PageToolResult> {
  const request = createJsonApiRequest(
    incoming,
    {
      html: args.html,
      ...(args.expirationHours == null ? {} : { expirationHours: args.expirationHours }),
    },
    args.idempotencyKey == null ? {} : { idempotencyKey: args.idempotencyKey },
  );
  const response = await createPage(request, store, dependencies);
  if (!response.ok) {
    return failureFromResponse(response);
  }

  const body = await readApiJson<CreatePageResponse>(response);
  if (
    !body ||
    typeof body.id !== "string" ||
    typeof body.createdAt !== "string" ||
    typeof body.expiresAt !== "string" ||
    typeof body.url !== "string"
  ) {
    return { isError: true, text: "Something went wrong" };
  }

  return {
    isError: false,
    text: pageResultText(body),
    structuredContent: body,
  };
}

export async function readPage(
  incoming: Request,
  args: ReadPageArgs,
  store: PageStore,
  dependencies: PageToolDependencies = {},
): Promise<PageToolResult> {
  const response = await getPageMetadata(args.id, store);
  if (!response.ok) {
    return failureFromResponse(response);
  }

  const body = await readApiJson<{
    id: string;
    createdAt: string;
    expiresAt: string;
  }>(response);
  if (
    !body ||
    typeof body.id !== "string" ||
    typeof body.createdAt !== "string" ||
    typeof body.expiresAt !== "string"
  ) {
    return { isError: true, text: "Something went wrong" };
  }

  const publicBaseUrl = resolvePublicBaseUrl(
    incoming,
    dependencies.publicBaseUrl ?? getEnv("PUBLIC_BASE_URL"),
  );
  if (!publicBaseUrl) {
    return { isError: true, text: "Public page URL is not configured correctly" };
  }

  const page = {
    id: body.id,
    createdAt: body.createdAt,
    expiresAt: body.expiresAt,
    url: pagePublicUrl(body.id, publicBaseUrl),
  };

  return {
    isError: false,
    text: pageResultText(page),
    structuredContent: page,
  };
}
