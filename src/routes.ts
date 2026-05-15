import "urlpattern-polyfill";

export type ApiRoute =
  | { name: "create-page" }
  | { name: "create-report" }
  | { name: "delete-page"; id: string }
  | { name: "get-page"; id: string }
  | { name: "get-page-content"; id: string };

const apiPatterns = [
  {
    name: "delete-page",
    method: "DELETE",
    pattern: new URLPattern({ pathname: "/api/admin/pages/:id" }),
  },
  {
    name: "create-page",
    method: "POST",
    pattern: new URLPattern({ pathname: "/api/pages" }),
  },
  {
    name: "create-report",
    method: "POST",
    pattern: new URLPattern({ pathname: "/api/reports" }),
  },
  {
    name: "get-page",
    method: "GET",
    pattern: new URLPattern({ pathname: "/api/pages/:id" }),
  },
  {
    name: "get-page-content",
    method: "GET",
    pattern: new URLPattern({ pathname: "/api/pages/:id/content" }),
  },
] as const;

const adminPattern = new URLPattern({ pathname: "/admin" });
const viewPattern = new URLPattern({ pathname: "/p/:id" });

export function matchApiRoute(req: Request): ApiRoute | null {
  for (const route of apiPatterns) {
    if (route.method !== req.method) {
      continue;
    }

    const match = route.pattern.exec(req.url);
    if (!match) {
      continue;
    }

    if (route.name === "create-page" || route.name === "create-report") {
      return { name: route.name };
    }

    const id = match.pathname.groups.id;
    if (!id) {
      return null;
    }

    return { name: route.name, id };
  }

  return null;
}

export function matchAdminRoute(pathname: string): boolean {
  return Boolean(adminPattern.exec({ pathname }));
}

export function matchViewRoute(pathname: string): { id: string } | null {
  const match = viewPattern.exec({ pathname });
  const id = match?.pathname.groups.id;
  return id ? { id } : null;
}
