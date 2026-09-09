export const COLLABORATION_PROTOCOL_VERSION = 1 as const;

export const COLLABORATION_LIMITS = Object.freeze({
  connectionsPerRoom: 25,
  stateBytes: 256 * 1024,
  incomingFrameBytes: 16 * 1024,
  transactionBytes: 16 * 1024,
  operationsPerTransaction: 100,
  jsonDepth: 16,
  pathSegmentLength: 128,
  requestIdLength: 128,
  mutationBurstPerSecond: 10,
  mutationsPerMinute: 300,
});

export const FORBIDDEN_JSON_KEYS = new Set(["__proto__", "constructor", "prototype"]);

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];
export type JsonObject = { [key: string]: JsonValue };

export type CollaborationRole = "view" | "edit";

export type CollaborationSnapshot = {
  state: JsonObject;
  revision: number;
};

export type SetOperation = {
  type: "set";
  path: string[];
  value: JsonValue;
};

export type DeleteOperation = {
  type: "delete";
  path: string[];
};

export type CollaborationOperation = SetOperation | DeleteOperation;

export type InitializeMessage = {
  type: "initialize";
  requestId: string;
  state: JsonObject;
};

export type TransactionMessage = {
  type: "transact";
  requestId: string;
  operations: CollaborationOperation[];
};

export type ClientCollaborationMessage = InitializeMessage | TransactionMessage;

export type SnapshotMessage = CollaborationSnapshot & {
  type: "snapshot";
  mode: CollaborationRole;
};

export type AcknowledgementMessage = {
  type: "ack";
  requestId: string;
  revision: number;
};

export type UpdateMessage = {
  type: "update";
  operations: CollaborationOperation[];
  revision: number;
};

export type CollaborationErrorCode =
  | "capacity_exceeded"
  | "expired"
  | "forbidden"
  | "invalid_message"
  | "not_initialized"
  | "rate_limited"
  | "state_too_large"
  | "unavailable";

export type ErrorMessage = {
  type: "error";
  code: CollaborationErrorCode;
  message: string;
  requestId?: string;
};

export type ServerCollaborationMessage =
  | SnapshotMessage
  | AcknowledgementMessage
  | UpdateMessage
  | ErrorMessage;

export type CollaborationTicketClaims = {
  version: typeof COLLABORATION_PROTOCOL_VERSION;
  roomId: string;
  role: CollaborationRole;
  audience: string;
  issuedAt: number;
  expiresAt: number;
  pageExpiresAt: number;
  ticketId: string;
};

export type ValidationResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: string; code: "invalid_message" | "state_too_large" };

export function validateClientMessage(
  value: unknown,
): ValidationResult<ClientCollaborationMessage> {
  if (!isRecord(value)) return invalid("Message must be an object");
  if (!validRequestId(value.requestId)) return invalid("Message requestId is invalid");

  if (value.type === "initialize") {
    const state = validateJsonObject(value.state);
    if (!state.ok) return state;
    if (encodedBytes(value) > COLLABORATION_LIMITS.incomingFrameBytes) {
      return tooLarge("Initialize message exceeds the incoming frame limit");
    }
    return {
      ok: true,
      value: { type: "initialize", requestId: value.requestId, state: state.value },
    };
  }

  if (value.type === "transact") {
    if (!Array.isArray(value.operations) || value.operations.length === 0) {
      return invalid("Transaction must contain at least one operation");
    }
    if (value.operations.length > COLLABORATION_LIMITS.operationsPerTransaction) {
      return tooLarge("Transaction contains too many operations");
    }
    if (encodedBytes(value) > COLLABORATION_LIMITS.transactionBytes) {
      return tooLarge("Transaction exceeds the transaction size limit");
    }

    const operations: CollaborationOperation[] = [];
    for (const operation of value.operations) {
      const validated = validateOperation(operation);
      if (!validated.ok) return validated;
      operations.push(validated.value);
    }
    return { ok: true, value: { type: "transact", requestId: value.requestId, operations } };
  }

  return invalid("Message type is unsupported");
}

export function validateJsonObject(value: unknown): ValidationResult<JsonObject> {
  const validation = validateJsonValue(value, 0, new Set());
  if (!validation.ok) return validation;
  if (!isRecord(validation.value)) return invalid("State must be a JSON object");
  if (encodedBytes(validation.value) > COLLABORATION_LIMITS.stateBytes) {
    return tooLarge("State exceeds the state size limit");
  }
  return { ok: true, value: validation.value };
}

export function encodedBytes(value: unknown): number {
  try {
    return new TextEncoder().encode(JSON.stringify(value)).byteLength;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

function validateOperation(value: unknown): ValidationResult<CollaborationOperation> {
  if (!isRecord(value) || !validPath(value.path)) return invalid("Operation path is invalid");

  if (value.type === "delete") {
    return { ok: true, value: { type: "delete", path: value.path } };
  }
  if (value.type !== "set") return invalid("Operation type is unsupported");

  const json = validateJsonValue(value.value, value.path.length, new Set());
  if (!json.ok) return json;
  return { ok: true, value: { type: "set", path: value.path, value: json.value } };
}

function validateJsonValue(
  value: unknown,
  depth: number,
  ancestors: Set<object>,
): ValidationResult<JsonValue> {
  if (depth > COLLABORATION_LIMITS.jsonDepth) return invalid("JSON value is too deeply nested");
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return { ok: true, value };
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? { ok: true, value } : invalid("JSON numbers must be finite");
  }
  if (typeof value !== "object") return invalid("Value is not valid JSON");
  if (ancestors.has(value)) return invalid("JSON value must not contain cycles");

  ancestors.add(value);
  if (Array.isArray(value)) {
    const result: JsonValue[] = [];
    for (const item of value) {
      const validated = validateJsonValue(item, depth + 1, ancestors);
      if (!validated.ok) return validated;
      result.push(validated.value);
    }
    ancestors.delete(value);
    return { ok: true, value: result };
  }

  const result: JsonObject = {};
  for (const [key, item] of Object.entries(value)) {
    if (!validKey(key)) return invalid("JSON object contains a forbidden or oversized key");
    const validated = validateJsonValue(item, depth + 1, ancestors);
    if (!validated.ok) return validated;
    result[key] = validated.value;
  }
  ancestors.delete(value);
  return { ok: true, value: result };
}

function validPath(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.length <= COLLABORATION_LIMITS.jsonDepth &&
    value.every((segment) => typeof segment === "string" && validKey(segment))
  );
}

function validKey(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= COLLABORATION_LIMITS.pathSegmentLength &&
    !FORBIDDEN_JSON_KEYS.has(value)
  );
}

function validRequestId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= COLLABORATION_LIMITS.requestIdLength
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalid<T>(error: string): ValidationResult<T> {
  return { ok: false, error, code: "invalid_message" };
}

function tooLarge<T>(error: string): ValidationResult<T> {
  return { ok: false, error, code: "state_too_large" };
}
