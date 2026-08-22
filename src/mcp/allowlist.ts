import { PRODUCTION_HOST } from "../constants.ts";

export function hostnameFromHostHeader(host: string): string {
  const trimmed = host.trim();
  if (trimmed.startsWith("[")) {
    const end = trimmed.indexOf("]");
    return end === -1 ? trimmed.toLowerCase() : trimmed.slice(1, end).toLowerCase();
  }

  return (trimmed.split(":")[0] ?? "").toLowerCase();
}

function isLocalHostname(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
}

export function isAllowedMcpHostname(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return isLocalHostname(host) || host === PRODUCTION_HOST;
}

export function isAllowedMcpOrigin(originUrl: URL): boolean {
  if (originUrl.username || originUrl.password) {
    return false;
  }

  const host = originUrl.hostname.toLowerCase();
  if (isLocalHostname(host)) {
    return originUrl.protocol === "http:" || originUrl.protocol === "https:";
  }

  return originUrl.protocol === "https:" && host === PRODUCTION_HOST;
}

export function mcpHostOriginGuard(request: Request): Response | null {
  const hostHeader = request.headers.get("host");
  if (hostHeader && !isAllowedMcpHostname(hostnameFromHostHeader(hostHeader))) {
    return new Response("Forbidden", { status: 403 });
  }

  const origin = request.headers.get("origin");
  if (!origin) {
    return null;
  }

  try {
    if (!isAllowedMcpOrigin(new URL(origin))) {
      return new Response("Forbidden", { status: 403 });
    }
  } catch {
    return new Response("Forbidden", { status: 403 });
  }

  return null;
}

export function mcpCorsHeaders(request: Request): Record<string, string> {
  const origin = request.headers.get("origin");
  if (!origin) {
    return {};
  }

  try {
    const originUrl = new URL(origin);
    if (!isAllowedMcpOrigin(originUrl)) {
      return {};
    }

    return {
      "Access-Control-Allow-Origin": origin,
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers":
        "Content-Type, Authorization, MCP-Protocol-Version, Mcp-Method, Mcp-Name",
      Vary: "Origin",
    };
  } catch {
    return {};
  }
}
