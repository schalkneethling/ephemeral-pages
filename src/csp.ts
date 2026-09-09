const TRUSTED_CDN_ORIGINS = [
  "https://cdn.jsdelivr.net",
  "https://unpkg.com",
  "https://cdnjs.cloudflare.com",
] as const;

const TRUSTED_STYLE_ORIGINS = [...TRUSTED_CDN_ORIGINS, "https://fonts.googleapis.com"] as const;
const TRUSTED_FONT_ORIGINS = ["https://fonts.gstatic.com"] as const;

export function buildUploadedPageCsp(): string {
  const scripts = ["'unsafe-inline'", ...TRUSTED_CDN_ORIGINS].join(" ");
  const styles = ["'unsafe-inline'", ...TRUSTED_STYLE_ORIGINS].join(" ");

  return [
    "default-src 'none'",
    `script-src ${scripts}`,
    `style-src ${styles}`,
    `font-src ${TRUSTED_FONT_ORIGINS.join(" ")}`,
    "img-src data: blob:",
    "media-src data: blob:",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
  ].join("; ");
}

export function buildUploadedPageHttpCsp(): string {
  return `sandbox allow-scripts; ${buildUploadedPageCsp()}`;
}

export function buildCollaborativeUploadedPageHttpCsp(): string {
  return [
    "sandbox allow-scripts",
    "default-src 'none'",
    "script-src 'unsafe-inline'",
    "style-src 'unsafe-inline'",
    "img-src data: blob:",
    "media-src data: blob:",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
  ].join("; ");
}

export function buildAppShellCsp(collaborationWebSocketUrl?: string): string {
  const collaborationOrigin = collaborationWebSocketUrl
    ? collaborationConnectOrigin(collaborationWebSocketUrl)
    : null;
  const connectSources = ["'self'", ...(collaborationOrigin ? [collaborationOrigin] : [])];
  return [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self'",
    "img-src 'self' data:",
    "font-src 'self'",
    `connect-src ${connectSources.join(" ")}`,
    "frame-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join("; ");
}

function collaborationConnectOrigin(value: string): string {
  const url = new URL(value);
  const localDevelopment =
    url.protocol === "ws:" &&
    (url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]");
  if (url.protocol !== "wss:" && !localDevelopment) {
    throw new Error("Collaboration WebSocket URL must use wss:// outside local development");
  }
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.pathname !== "/" && url.pathname !== "")
  ) {
    throw new Error(
      "Collaboration WebSocket CSP source must be an origin without credentials or a path",
    );
  }
  return url.origin;
}

export function cspMetaTag(): string {
  return `<meta http-equiv="Content-Security-Policy" content="${buildUploadedPageCsp()}">`;
}

export function injectCsp(html: string): string {
  const meta = cspMetaTag();
  if (/<head[\s>]/i.test(html)) {
    return html.replace(/(<head[\s>])/i, `$1\n  ${meta}`);
  }
  if (/<html[\s>]/i.test(html)) {
    return html.replace(/(<html[\s>])/i, `$1\n<head>\n  ${meta}\n</head>`);
  }
  throw new Error("Cannot inject CSP into HTML without an <html> or <head> element.");
}
