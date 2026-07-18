import { promisify } from "node:util";
import { brotliCompress } from "node:zlib";

import { parse, type DefaultTreeAdapterTypes } from "parse5";

import { MAX_COMPRESSED_HTML_BYTES, type ValidationResult } from "../../src/domain.ts";

const HTML_REQUIRED_ERROR = "HTML content is required";
const MAX_RAW_HTML_LENGTH = 20 * 1024 * 1024;
const HTML_RAW_SIZE_ERROR = "HTML content cannot exceed 20 MB before compression";
const HTML_SIZE_ERROR = "HTML content cannot exceed 2 MB after Brotli compression";
const HTML_DOCUMENT_ERROR =
  "The uploaded file must include a source-authored <html> or <head> element.";

const compressWithBrotli = promisify(brotliCompress);

export async function validateServerHtml(value: unknown): Promise<ValidationResult<string>> {
  if (!value || typeof value !== "string" || value.trim().length === 0) {
    return { ok: false, error: HTML_REQUIRED_ERROR };
  }

  if (value.length > MAX_RAW_HTML_LENGTH) {
    return { ok: false, error: HTML_RAW_SIZE_ERROR };
  }

  const compressed = await compressWithBrotli(value);
  if (compressed.byteLength > MAX_COMPRESSED_HTML_BYTES) {
    return { ok: false, error: HTML_SIZE_ERROR };
  }

  if (!isHtmlDocumentWithParse5(value)) {
    return { ok: false, error: HTML_DOCUMENT_ERROR };
  }

  return { ok: true, value };
}

export function isHtmlDocumentWithParse5(content: string): boolean {
  const document = parse(content, { sourceCodeLocationInfo: true });
  const htmlElement = document.childNodes.find((node) => isElement(node, "html"));
  const headElement = htmlElement?.childNodes.find((node) => isElement(node, "head"));

  return Boolean(htmlElement?.sourceCodeLocation || headElement?.sourceCodeLocation);
}

function isElement(
  node: DefaultTreeAdapterTypes.ChildNode,
  tagName: string,
): node is DefaultTreeAdapterTypes.Element {
  return "tagName" in node && node.tagName === tagName;
}
