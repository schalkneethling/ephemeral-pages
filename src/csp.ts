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

export function buildAppShellCsp(): string {
  return [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self'",
    "img-src 'self' data:",
    "font-src 'self'",
    "connect-src 'self'",
    "frame-src blob:",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join("; ");
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
