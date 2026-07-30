import { promisify } from "node:util";
import { brotliCompress, brotliDecompress } from "node:zlib";

import { parse, type DefaultTreeAdapterTypes } from "parse5";

import { MAX_COMPRESSED_HTML_BYTES, MAX_RAW_HTML_BYTES } from "../../src/domain.ts";

const HTML_REQUIRED_ERROR = "HTML content is required";
const HTML_RAW_SIZE_ERROR = "HTML content cannot exceed 20 MB before compression";
const HTML_SIZE_ERROR = "HTML content cannot exceed 2 MB after Brotli compression";
const HTML_DOCUMENT_ERROR =
  "The uploaded file must include a source-authored <html> or <head> element.";

const compressWithBrotli = promisify(brotliCompress);
const decompressWithBrotli = promisify(brotliDecompress);

export type HtmlRequestValidation =
  | { ok: true; value: string; compressedBytes: number; rawBytes: number }
  | {
      ok: false;
      error: string;
      status: 400 | 413 | 415;
      reason:
        | "required"
        | "raw_size"
        | "compressed_size"
        | "html"
        | "encoding"
        | "base64"
        | "decompressed_size"
        | "brotli"
        | "utf8";
    };

export async function validateServerHtml(value: unknown): Promise<HtmlRequestValidation> {
  if (!value || typeof value !== "string" || value.trim().length === 0) {
    return { ok: false, error: HTML_REQUIRED_ERROR, status: 400, reason: "required" };
  }

  const rawBytes = new TextEncoder().encode(value).byteLength;
  if (rawBytes > MAX_RAW_HTML_BYTES) {
    return { ok: false, error: HTML_RAW_SIZE_ERROR, status: 413, reason: "raw_size" };
  }

  const compressed = await compressWithBrotli(value);
  if (compressed.byteLength > MAX_COMPRESSED_HTML_BYTES) {
    return { ok: false, error: HTML_SIZE_ERROR, status: 413, reason: "compressed_size" };
  }

  if (!isHtmlDocumentWithParse5(value)) {
    return { ok: false, error: HTML_DOCUMENT_ERROR, status: 400, reason: "html" };
  }

  return { ok: true, value, rawBytes, compressedBytes: compressed.byteLength };
}

export async function decodeAndValidateHtml(
  value: unknown,
  encoding: unknown,
): Promise<HtmlRequestValidation> {
  if (encoding === undefined || encoding === "identity") {
    return validateServerHtml(value);
  }

  if (encoding !== "br+base64") {
    return { ok: false, error: "Unsupported content encoding", status: 415, reason: "encoding" };
  }

  if (typeof value !== "string" || !isCanonicalBase64(value)) {
    return { ok: false, error: "HTML must be canonical Base64", status: 400, reason: "base64" };
  }

  const compressed = Buffer.from(value, "base64");
  if (compressed.byteLength > MAX_COMPRESSED_HTML_BYTES) {
    return {
      ok: false,
      error: HTML_SIZE_ERROR,
      status: 413,
      reason: "compressed_size",
    };
  }

  let raw: Buffer;
  try {
    raw = await decompressWithBrotli(compressed, { maxOutputLength: MAX_RAW_HTML_BYTES });
  } catch (error) {
    if (
      error instanceof Error &&
      (error.message.includes("Cannot create a Buffer larger") ||
        ("code" in error && error.code === "ERR_BUFFER_TOO_LARGE"))
    ) {
      return { ok: false, error: HTML_RAW_SIZE_ERROR, status: 413, reason: "decompressed_size" };
    }
    return { ok: false, error: "HTML is not valid Brotli data", status: 400, reason: "brotli" };
  }

  let html: string;
  try {
    html = new TextDecoder("utf-8", { fatal: true }).decode(raw);
  } catch {
    return {
      ok: false,
      error: "Decompressed HTML must be valid UTF-8",
      status: 400,
      reason: "utf8",
    };
  }

  if (!isHtmlDocumentWithParse5(html)) {
    return { ok: false, error: HTML_DOCUMENT_ERROR, status: 400, reason: "html" };
  }

  return {
    ok: true,
    value: html,
    rawBytes: raw.byteLength,
    compressedBytes: compressed.byteLength,
  };
}

function isCanonicalBase64(value: string): boolean {
  if (value.length === 0 || value.length % 4 !== 0) return false;
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    return false;
  }
  return Buffer.from(value, "base64").toString("base64") === value;
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
