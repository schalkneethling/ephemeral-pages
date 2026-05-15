type TemporalLike = {
  Instant?: {
    from(value: string): { epochMilliseconds: number };
  };
};

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

export function formatExpiryText(
  expiresAt: string,
  now = new Date(),
  temporal: TemporalLike | undefined = getTemporal(),
): string {
  if (!temporal?.Instant) {
    return `expires ${new Date(expiresAt).toLocaleString()}`;
  }

  const expiresAtMs = temporal.Instant.from(expiresAt).epochMilliseconds;
  const nowMs = temporal.Instant.from(now.toISOString()).epochMilliseconds;
  const remainingMs = expiresAtMs - nowMs;

  if (remainingMs <= 0) {
    return "expired";
  }

  if (remainingMs < HOUR_MS) {
    return `expires in ${Math.max(1, Math.ceil(remainingMs / MINUTE_MS))}m`;
  }

  if (remainingMs < 2 * DAY_MS) {
    return `expires in ${Math.ceil(remainingMs / HOUR_MS)}h`;
  }

  return `expires in ${Math.ceil(remainingMs / DAY_MS)}d`;
}

export function supportsTemporal(temporal: TemporalLike | undefined = getTemporal()): boolean {
  return typeof temporal?.Instant?.from === "function";
}

function getTemporal(): TemporalLike | undefined {
  return (globalThis as typeof globalThis & { Temporal?: TemporalLike }).Temporal;
}
