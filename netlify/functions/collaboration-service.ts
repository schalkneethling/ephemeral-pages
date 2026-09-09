export type CollaborationRoomDeletionNotifier = (
  pageId: string,
  pageExpiresAt: string,
) => Promise<void>;

export const COLLABORATION_ROOM_DELETION_TIMEOUT_MS = 5_000;

export function createCollaborationRoomDeletionNotifier({
  serviceUrl,
  serviceToken,
  fetchImpl = fetch,
  timeoutMs = COLLABORATION_ROOM_DELETION_TIMEOUT_MS,
}: {
  serviceUrl: string | undefined;
  serviceToken: string | undefined;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): CollaborationRoomDeletionNotifier | null {
  if (
    !serviceUrl ||
    !serviceToken ||
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > COLLABORATION_ROOM_DELETION_TIMEOUT_MS
  ) {
    return null;
  }

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
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok && response.status !== 404) {
      throw new Error(`Collaboration room deletion failed with status ${response.status}`);
    }
  };
}
