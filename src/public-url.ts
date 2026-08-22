export function resolvePublicBaseUrl(
  req: Request,
  configuredUrl: string | undefined,
): string | null {
  try {
    const url = new URL(configuredUrl ?? new URL(req.url).origin);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) {
      return null;
    }
    return url.origin;
  } catch {
    return null;
  }
}

export function pagePublicUrl(id: string, publicBaseUrl: string): string {
  return new URL(`/p/${id}`, publicBaseUrl).href;
}
