export const PRODUCTION_MCP_HOST = "ephemeral.schalkneethling.com";

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

export function isAllowedMcpHostHostname(hostname: string): boolean {
  const host = hostname.toLowerCase();
  if (isLocalHostname(host) || host === PRODUCTION_MCP_HOST) {
    return true;
  }

  return host.endsWith(".netlify.app");
}

export function isAllowedMcpOriginHostname(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return isLocalHostname(host) || host === PRODUCTION_MCP_HOST;
}

export function mcpHostOriginGuard(request: Request): Response | null {
  const hostHeader = request.headers.get("host");
  if (hostHeader && !isAllowedMcpHostHostname(hostnameFromHostHeader(hostHeader))) {
    return new Response("Forbidden", { status: 403 });
  }

  const origin = request.headers.get("origin");
  if (!origin) {
    return null;
  }

  try {
    const originUrl = new URL(origin);
    if (
      !["http:", "https:"].includes(originUrl.protocol) ||
      originUrl.username ||
      originUrl.password
    ) {
      return new Response("Forbidden", { status: 403 });
    }
    if (!isAllowedMcpOriginHostname(originUrl.hostname)) {
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
    if (!isAllowedMcpOriginHostname(originUrl.hostname)) {
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
