export function createJsonApiRequest(
  incoming: Request,
  body: unknown,
  options: { idempotencyKey?: string } = {},
): Request {
  const headers = new Headers(incoming.headers);
  headers.delete("Authorization");
  headers.set("Content-Type", "application/json");
  if (options.idempotencyKey !== undefined) {
    headers.set("Idempotency-Key", options.idempotencyKey);
  }

  return new Request(incoming.url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

export async function readApiError(response: Response): Promise<string> {
  try {
    const body = (await response.clone().json()) as { error?: unknown };
    if (typeof body.error === "string" && body.error.length > 0) {
      return body.error;
    }
  } catch {
    // Fall through to the generic message when the body is not JSON.
  }

  return "Something went wrong";
}

export async function readApiJson<T>(response: Response): Promise<T | null> {
  try {
    return (await response.clone().json()) as T;
  } catch {
    return null;
  }
}
