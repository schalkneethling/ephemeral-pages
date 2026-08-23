import {
  type CollaborationOperation,
  type JsonObject,
  type JsonValue,
  validateJsonObject,
} from "../../src/collaboration/protocol.ts";

export class InvalidOperationPathError extends Error {
  override readonly name = "InvalidOperationPathError";
}

export type ReductionResult = {
  state: JsonObject;
};

export function applyOperations(
  state: JsonObject,
  operations: readonly CollaborationOperation[],
): ReductionResult {
  const next = structuredClone(state);

  for (const operation of operations) {
    applyOperation(next, operation);
  }

  const validated = validateJsonObject(next);
  if (!validated.ok) {
    if (validated.code === "state_too_large") {
      throw new StateTooLargeError(validated.error);
    }
    throw new InvalidOperationPathError(validated.error);
  }

  return { state: validated.value };
}

export class StateTooLargeError extends Error {
  override readonly name = "StateTooLargeError";
}

function applyOperation(root: JsonObject, operation: CollaborationOperation): void {
  const parent = resolveParent(root, operation.path);
  const finalSegment = operation.path.at(-1)!;

  if (Array.isArray(parent)) {
    const index = parseArrayIndex(finalSegment);
    if (operation.type === "set") {
      if (index > parent.length) {
        throw new InvalidOperationPathError("Array index is outside the collection");
      }
      parent[index] = structuredClone(operation.value);
      return;
    }
    if (index < parent.length) parent.splice(index, 1);
    return;
  }

  if (
    finalSegment === "__proto__" ||
    finalSegment === "constructor" ||
    finalSegment === "prototype"
  ) {
    throw new InvalidOperationPathError("Object path segment is forbidden");
  }
  if (operation.type === "set") {
    parent[finalSegment] = structuredClone(operation.value);
  } else {
    delete parent[finalSegment];
  }
}

function resolveParent(root: JsonObject, path: readonly string[]): JsonObject | JsonValue[] {
  let current: JsonValue = root;

  for (const segment of path.slice(0, -1)) {
    if (Array.isArray(current)) {
      const index = parseArrayIndex(segment);
      if (index >= current.length) {
        throw new InvalidOperationPathError("Array path does not exist");
      }
      current = current[index];
      continue;
    }

    if (!isJsonObject(current)) {
      throw new InvalidOperationPathError("Path traverses a non-container value");
    }

    if (segment === "__proto__" || segment === "constructor" || segment === "prototype") {
      throw new InvalidOperationPathError("Object path segment is forbidden");
    }
    const child = current[segment];
    if (child === undefined) {
      const created: JsonObject = {};
      current[segment] = created;
      current = created;
      continue;
    }
    current = child;
  }

  if (!Array.isArray(current) && !isJsonObject(current)) {
    throw new InvalidOperationPathError("Path parent is not a container");
  }
  return current;
}

function parseArrayIndex(segment: string): number {
  if (!/^(0|[1-9]\d*)$/.test(segment)) {
    throw new InvalidOperationPathError("Array path segment must be an integer index");
  }
  const index = Number(segment);
  if (!Number.isSafeInteger(index)) {
    throw new InvalidOperationPathError("Array index is outside the supported range");
  }
  return index;
}

function isJsonObject(value: JsonValue): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
