export type CollaborationRoomDeletionNotifier = (
  pageId: string,
  pageExpiresAt: string,
) => Promise<void>;

export function createCollaborationRoomDeletionNotifier({
  serviceUrl,
  serviceToken,
  fetchImpl = fetch,
}: {
  serviceUrl: string | undefined;
  serviceToken: string | undefined;
  fetchImpl?: typeof fetch;
}): CollaborationRoomDeletionNotifier | null {
  if (!serviceUrl || !serviceToken) return null;

  let baseUrl: URL;
  try {
    baseUrl = new URL(serviceUrl);
    if (baseUrl.protocol !== "https:" || baseUrl.username || baseUrl.password || baseUrl.hash) {
      return null;
    }
  } catch {
    return null;
  }

  return async (pageId, pageExpiresAt) => {
    const expiresAtSeconds = Math.floor(new Date(pageExpiresAt).getTime() / 1_000);
    if (!Number.isSafeInteger(expiresAtSeconds) || expiresAtSeconds <= 0) {
      throw new Error("Collaboration room expiry is invalid");
    }
    const target = new URL(`/rooms/${encodeURIComponent(pageId)}`, baseUrl);
    const response = await fetchImpl(target, {
      method: "DELETE",
      headers: {
        Authorization: `Bearer ${serviceToken}`,
        "X-Ephemeral-Page-Expires-At": String(expiresAtSeconds),
      },
    });
    if (!response.ok && response.status !== 404) {
      throw new Error(`Collaboration room deletion failed with status ${response.status}`);
    }
  };
}
