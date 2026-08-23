export type MetricName =
  | "capture_accepted"
  | "capture_completed"
  | "capture_rejected"
  | "capture_rendered"
  | "connection_accepted"
  | "connection_rejected"
  | "mutation_accepted"
  | "mutation_rejected"
  | "room_deleted"
  | "room_expired"
  | "socket_send_failed"
  | "ticket_rejected";

export function logMetric(
  name: MetricName,
  fields: Record<string, string | number | boolean>,
): void {
  console.log(
    JSON.stringify({
      event: "collaboration_metric",
      metric: name,
      ...fields,
    }),
  );
}

export function logError(message: string, error: unknown): void {
  console.error(
    JSON.stringify({
      event: "collaboration_error",
      message,
      error: error instanceof Error ? error.message : String(error),
    }),
  );
}
