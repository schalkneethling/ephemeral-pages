import { DurableObject } from "cloudflare:workers";

import {
  COLLABORATION_LIMITS,
  encodedBytes,
  type CollaborationErrorCode,
  type CollaborationRole,
  type CollaborationSnapshot,
  type ErrorMessage,
  type JsonObject,
  type ServerCollaborationMessage,
  validateClientMessage,
} from "../../src/collaboration/protocol.ts";
import { APPLICATION_PROTOCOL, isValidRoomId } from "./auth.ts";
import { consumeMutation, newMutationBudget, type MutationBudget } from "./limits.ts";
import { logError, logMetric } from "./metrics.ts";
import { applyOperations, InvalidOperationPathError, StateTooLargeError } from "./reducer.ts";

export const INTERNAL_ROOM_HEADERS = Object.freeze({
  roomId: "X-Ephemeral-Room-Id",
  role: "X-Ephemeral-Role",
  ticketId: "X-Ephemeral-Ticket-Id",
  ticketExpiresAt: "X-Ephemeral-Ticket-Expires-At",
  pageExpiresAt: "X-Ephemeral-Page-Expires-At",
});

const CLOSE_CODE_EXPIRED = 4_001;
const CLOSE_CODE_DELETED = 4_002;

type RoomRow = {
  room_id: string;
  state_json: string | null;
  revision: number;
  expires_at: number;
  status: "active" | "deleted";
  initialized: 0 | 1;
};

type ConnectionAttachment = {
  role: CollaborationRole;
  ticketId: string;
  budget: MutationBudget;
};

export type CaptureReservation =
  | {
      ok: true;
      token: string;
      revision: number;
      capturedAt: string;
      expiresAt: number;
    }
  | { ok: false; code: "capacity" | "gone" | "not_initialized" };

export type FrozenCapture =
  | {
      ok: true;
      stateJson: string;
      revision: number;
      capturedAt: string;
    }
  | { ok: false; code: "consumed" | "expired" | "invalid" };

const CAPTURE_TOKEN_LIFETIME_SECONDS = 60;
const CAPTURE_TOKEN_BYTES = 32;

export class CollaborationRoom extends DurableObject<Env> {
  private storageDeleted = false;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    void ctx.blockConcurrencyWhile(async () => {
      this.migrate();
    });
  }

  async fetch(request: Request): Promise<Response> {
    if (this.storageDeleted) return errorResponse("Room has expired", 410);
    if (request.method !== "GET" || request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return errorResponse("Expected a WebSocket upgrade", 426, { Upgrade: "websocket" });
    }

    const roomId = request.headers.get(INTERNAL_ROOM_HEADERS.roomId);
    const role = request.headers.get(INTERNAL_ROOM_HEADERS.role);
    const ticketId = request.headers.get(INTERNAL_ROOM_HEADERS.ticketId);
    const ticketExpiresAt = Number(request.headers.get(INTERNAL_ROOM_HEADERS.ticketExpiresAt));
    const pageExpiresAt = Number(request.headers.get(INTERNAL_ROOM_HEADERS.pageExpiresAt));
    if (
      !roomId ||
      !isValidRoomId(roomId) ||
      (role !== "view" && role !== "edit") ||
      !ticketId ||
      ticketId.length > 128 ||
      !Number.isSafeInteger(ticketExpiresAt) ||
      !Number.isSafeInteger(pageExpiresAt) ||
      pageExpiresAt <= 0
    ) {
      return errorResponse("Internal connection metadata is invalid", 400);
    }

    const nowSeconds = Math.floor(Date.now() / 1_000);
    if (ticketExpiresAt <= nowSeconds || ticketExpiresAt > pageExpiresAt) {
      return errorResponse("Internal ticket expiry is invalid", 400);
    }
    if (pageExpiresAt <= nowSeconds) {
      await this.expireRoom("room_expired");
      return errorResponse("Room has expired", 410);
    }

    const room = this.ensureRoom(roomId, pageExpiresAt);
    if (room.status === "deleted") {
      logMetric("connection_rejected", { room_id: roomId, reason: "deleted" });
      return errorResponse("Room has been deleted", 410);
    }
    if (room.expires_at <= nowSeconds) {
      await this.expireRoom("room_expired");
      return errorResponse("Room has expired", 410);
    }
    await this.ctx.storage.setAlarm(room.expires_at * 1_000);

    const connections = this.ctx.getWebSockets();
    if (connections.length >= COLLABORATION_LIMITS.connectionsPerRoom) {
      logMetric("connection_rejected", { room_id: roomId, reason: "capacity" });
      return errorResponse("Room connection capacity has been reached", 429);
    }
    if (!this.consumeTicket(ticketId, ticketExpiresAt, nowSeconds)) {
      logMetric("connection_rejected", { room_id: roomId, reason: "ticket_replay" });
      return errorResponse("Ticket has already been used", 409);
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({
      role,
      ticketId,
      budget: newMutationBudget(Date.now()),
    } satisfies ConnectionAttachment);
    this.send(server, snapshotMessage(room, role));
    logMetric("connection_accepted", {
      room_id: roomId,
      role,
      connections: connections.length + 1,
    });

    return new Response(null, {
      status: 101,
      webSocket: client,
      headers: { "Sec-WebSocket-Protocol": APPLICATION_PROTOCOL },
    });
  }

  async deleteRoom(roomId: string, pageExpiresAt: number): Promise<void> {
    if (!isValidRoomId(roomId) || !Number.isSafeInteger(pageExpiresAt) || pageExpiresAt <= 0) {
      throw new Error("Invalid room deletion metadata");
    }

    const nowSeconds = Math.floor(Date.now() / 1_000);
    if (pageExpiresAt <= nowSeconds) {
      await this.expireRoom("room_expired");
      return;
    }

    this.ctx.storage.transactionSync(() => {
      const existing = this.getRoom();
      if (existing && existing.room_id !== roomId) throw new Error("Room identity mismatch");
      const expiresAt = existing ? Math.min(existing.expires_at, pageExpiresAt) : pageExpiresAt;
      this.ctx.storage.sql.exec(
        `INSERT INTO room
          (singleton, room_id, state_json, revision, expires_at, status, initialized)
         VALUES (1, ?, NULL, 0, ?, 'deleted', 0)
         ON CONFLICT(singleton) DO UPDATE SET
           state_json = NULL,
           expires_at = excluded.expires_at,
           status = 'deleted',
           initialized = 0`,
        roomId,
        expiresAt,
      );
      this.ctx.storage.sql.exec("DELETE FROM capture_tokens");
      this.ctx.storage.sql.exec("DELETE FROM capture_lease");
    });
    await this.ctx.storage.setAlarm(Math.min(pageExpiresAt, this.getRoom()!.expires_at) * 1_000);
    this.closeAll(CLOSE_CODE_DELETED, "Room deleted");
    logMetric("room_deleted", { room_id: roomId });
  }

  async createCapture(roomId: string): Promise<CaptureReservation> {
    if (!isValidRoomId(roomId) || this.storageDeleted) return { ok: false, code: "gone" };

    const token = randomCaptureToken();
    const tokenHash = await captureTokenHash(token);
    const nowMilliseconds = Date.now();
    const nowSeconds = Math.floor(nowMilliseconds / 1_000);
    const capturedAt = new Date(nowMilliseconds).toISOString();

    return this.ctx.storage.transactionSync(() => {
      this.clearExpiredCaptures(nowSeconds);
      const room = this.getRoom();
      if (
        !room ||
        room.room_id !== roomId ||
        room.status !== "active" ||
        room.expires_at <= nowSeconds
      ) {
        return { ok: false, code: "gone" } as const;
      }
      if (room.initialized !== 1 || room.state_json === null) {
        return { ok: false, code: "not_initialized" } as const;
      }
      const lease = this.ctx.storage.sql
        .exec<{ expires_at: number }>("SELECT expires_at FROM capture_lease WHERE singleton = 1")
        .toArray()[0];
      if (lease && lease.expires_at > nowSeconds) {
        return { ok: false, code: "capacity" } as const;
      }

      const expiresAt = Math.min(room.expires_at, nowSeconds + CAPTURE_TOKEN_LIFETIME_SECONDS);
      this.ctx.storage.sql.exec(
        `INSERT INTO capture_tokens
          (token_hash, room_id, snapshot_json, revision, captured_at, expires_at, consumed)
         VALUES (?, ?, ?, ?, ?, ?, 0)`,
        tokenHash,
        roomId,
        room.state_json,
        room.revision,
        capturedAt,
        expiresAt,
      );
      this.ctx.storage.sql.exec(
        `INSERT INTO capture_lease (singleton, token_hash, expires_at)
         VALUES (1, ?, ?)
         ON CONFLICT(singleton) DO UPDATE SET
           token_hash = excluded.token_hash,
           expires_at = excluded.expires_at`,
        tokenHash,
        expiresAt,
      );
      return {
        ok: true,
        token,
        revision: room.revision,
        capturedAt,
        expiresAt,
      } as const;
    });
  }

  async consumeCapture(roomId: string, token: string): Promise<FrozenCapture> {
    if (!isValidRoomId(roomId) || !isCaptureToken(token) || this.storageDeleted) {
      return { ok: false, code: "invalid" };
    }
    const tokenHash = await captureTokenHash(token);
    const nowSeconds = Math.floor(Date.now() / 1_000);

    return this.ctx.storage.transactionSync(() => {
      const record = this.ctx.storage.sql
        .exec<{
          room_id: string;
          snapshot_json: string;
          revision: number;
          captured_at: string;
          expires_at: number;
          consumed: 0 | 1;
        }>("SELECT * FROM capture_tokens WHERE token_hash = ?", tokenHash)
        .toArray()[0];
      if (!record || record.room_id !== roomId) return { ok: false, code: "invalid" } as const;
      if (record.expires_at <= nowSeconds) {
        this.ctx.storage.sql.exec("DELETE FROM capture_tokens WHERE token_hash = ?", tokenHash);
        this.ctx.storage.sql.exec("DELETE FROM capture_lease WHERE token_hash = ?", tokenHash);
        return { ok: false, code: "expired" } as const;
      }
      if (record.consumed === 1) return { ok: false, code: "consumed" } as const;

      this.ctx.storage.sql.exec(
        "UPDATE capture_tokens SET consumed = 1 WHERE token_hash = ?",
        tokenHash,
      );
      return {
        ok: true,
        stateJson: record.snapshot_json,
        revision: record.revision,
        capturedAt: record.captured_at,
      } as const;
    });
  }

  async finishCapture(roomId: string, token: string): Promise<void> {
    if (!isValidRoomId(roomId) || !isCaptureToken(token) || this.storageDeleted) return;
    const tokenHash = await captureTokenHash(token);
    this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec(
        "DELETE FROM capture_tokens WHERE token_hash = ? AND room_id = ?",
        tokenHash,
        roomId,
      );
      this.ctx.storage.sql.exec("DELETE FROM capture_lease WHERE token_hash = ?", tokenHash);
    });
  }

  async alarm(): Promise<void> {
    await this.expireRoom("room_expired");
  }

  async webSocketMessage(socket: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const attachment = attachmentFor(socket);
    if (!attachment) {
      socket.close(1011, "Connection state unavailable");
      return;
    }

    const room = this.getRoom();
    const nowSeconds = Math.floor(Date.now() / 1_000);
    if (!room || room.status === "deleted") {
      socket.close(CLOSE_CODE_DELETED, "Room deleted");
      return;
    }
    if (room.expires_at <= nowSeconds) {
      await this.expireRoom("room_expired");
      return;
    }

    const rate = consumeMutation(attachment.budget, Date.now());
    attachment.budget = rate.budget;
    socket.serializeAttachment(attachment);
    if (!rate.allowed) {
      this.rejectMutation(socket, room.room_id, "rate_limited", "Mutation rate limit exceeded");
      return;
    }

    const frameBytes =
      typeof message === "string"
        ? new TextEncoder().encode(message).byteLength
        : message.byteLength;
    if (frameBytes > COLLABORATION_LIMITS.incomingFrameBytes) {
      this.rejectMutation(socket, room.room_id, "state_too_large", "Message exceeds frame limit");
      socket.close(1009, "Message too large");
      return;
    }
    if (typeof message !== "string") {
      this.rejectMutation(
        socket,
        room.room_id,
        "invalid_message",
        "Binary messages are unsupported",
      );
      return;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(message);
    } catch {
      this.rejectMutation(socket, room.room_id, "invalid_message", "Message must be valid JSON");
      return;
    }
    const validated = validateClientMessage(parsed);
    if (!validated.ok) {
      this.rejectMutation(socket, room.room_id, validated.code, validated.error);
      return;
    }
    if (attachment.role !== "edit") {
      this.rejectMutation(
        socket,
        room.room_id,
        "forbidden",
        "Read-only connections cannot mutate room state",
        validated.value.requestId,
      );
      return;
    }

    if (validated.value.type === "initialize") {
      const current = this.getRoom()!;
      if (current.initialized === 1) {
        this.send(socket, {
          type: "ack",
          requestId: validated.value.requestId,
          revision: current.revision,
        });
        this.send(socket, snapshotMessage(current, attachment.role));
        return;
      }

      const serialized = JSON.stringify(validated.value.state);
      const revision = this.ctx.storage.transactionSync(() => {
        const authoritative = this.getRoom();
        if (!authoritative || authoritative.status !== "active") {
          throw new Error("Room is unavailable");
        }
        if (authoritative.initialized === 1) return authoritative.revision;
        return this.ctx.storage.sql
          .exec<{ revision: number }>(
            `UPDATE room
             SET state_json = ?, initialized = 1, revision = revision + 1
             WHERE singleton = 1
             RETURNING revision`,
            serialized,
          )
          .one().revision;
      });
      const initialized = this.getRoom()!;
      this.send(socket, { type: "ack", requestId: validated.value.requestId, revision });
      this.broadcastSnapshots(initialized);
      logMetric("mutation_accepted", {
        room_id: room.room_id,
        type: "initialize",
        revision,
        state_bytes: encodedBytes(validated.value.state),
      });
      return;
    }

    const requestId = validated.value.requestId;
    const operations = validated.value.operations;
    try {
      const result = this.ctx.storage.transactionSync(() => {
        const authoritative = this.getRoom();
        if (!authoritative || authoritative.status !== "active") {
          throw new Error("Room is unavailable");
        }
        if (authoritative.initialized !== 1 || authoritative.state_json === null) {
          throw new RoomNotInitializedError();
        }
        const reduction = applyOperations(
          JSON.parse(authoritative.state_json) as JsonObject,
          operations,
        );
        const serialized = JSON.stringify(reduction.state);
        const revision = this.ctx.storage.sql
          .exec<{ revision: number }>(
            `UPDATE room
             SET state_json = ?, revision = revision + 1
             WHERE singleton = 1
             RETURNING revision`,
            serialized,
          )
          .one().revision;
        return { revision, stateBytes: new TextEncoder().encode(serialized).byteLength };
      });
      this.send(socket, { type: "ack", requestId, revision: result.revision });
      this.broadcast({ type: "update", operations, revision: result.revision });
      logMetric("mutation_accepted", {
        room_id: room.room_id,
        type: "transact",
        revision: result.revision,
        operations: operations.length,
        state_bytes: result.stateBytes,
      });
    } catch (error) {
      if (error instanceof RoomNotInitializedError) {
        this.rejectMutation(socket, room.room_id, "not_initialized", error.message, requestId);
      } else if (error instanceof StateTooLargeError) {
        this.rejectMutation(socket, room.room_id, "state_too_large", error.message, requestId);
      } else if (error instanceof InvalidOperationPathError) {
        this.rejectMutation(socket, room.room_id, "invalid_message", error.message, requestId);
      } else {
        logError("Failed to apply room transaction", error);
        this.rejectMutation(
          socket,
          room.room_id,
          "unavailable",
          "Mutation is unavailable",
          requestId,
        );
      }
    }
  }

  webSocketClose(_socket: WebSocket, _code: number, _reason: string, _wasClean: boolean): void {
    // Close frames are automatically acknowledged at this compatibility date.
  }

  webSocketError(socket: WebSocket, error: unknown): void {
    logError("Collaboration WebSocket failed", error);
    try {
      socket.close(1011, "Connection failed");
    } catch {
      // The socket may already be closed.
    }
  }

  private migrate(): void {
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS _sql_schema_migrations (
        id INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS room (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        room_id TEXT NOT NULL,
        state_json TEXT,
        revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
        expires_at INTEGER NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('active', 'deleted')),
        initialized INTEGER NOT NULL DEFAULT 0 CHECK (initialized IN (0, 1))
      );
      CREATE TABLE IF NOT EXISTS capture_tokens (
        token_hash TEXT PRIMARY KEY,
        room_id TEXT NOT NULL,
        snapshot_json TEXT NOT NULL,
        revision INTEGER NOT NULL CHECK (revision >= 0),
        captured_at TEXT NOT NULL,
        expires_at INTEGER NOT NULL,
        consumed INTEGER NOT NULL DEFAULT 0 CHECK (consumed IN (0, 1))
      );
      CREATE TABLE IF NOT EXISTS capture_lease (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        token_hash TEXT NOT NULL,
        expires_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS consumed_tickets (
        ticket_id TEXT PRIMARY KEY,
        expires_at INTEGER NOT NULL
      );
      INSERT OR IGNORE INTO _sql_schema_migrations (id) VALUES (1), (2), (3);
    `);
  }

  private consumeTicket(ticketId: string, expiresAt: number, nowSeconds: number): boolean {
    return this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec("DELETE FROM consumed_tickets WHERE expires_at <= ?", nowSeconds);
      const replay = this.ctx.storage.sql
        .exec<{ ticket_id: string }>(
          "SELECT ticket_id FROM consumed_tickets WHERE ticket_id = ?",
          ticketId,
        )
        .toArray()[0];
      if (replay) return false;
      this.ctx.storage.sql.exec(
        "INSERT INTO consumed_tickets (ticket_id, expires_at) VALUES (?, ?)",
        ticketId,
        expiresAt,
      );
      return true;
    });
  }

  private clearExpiredCaptures(nowSeconds: number): void {
    this.ctx.storage.sql.exec("DELETE FROM capture_tokens WHERE expires_at <= ?", nowSeconds);
    this.ctx.storage.sql.exec("DELETE FROM capture_lease WHERE expires_at <= ?", nowSeconds);
  }

  private ensureRoom(roomId: string, pageExpiresAt: number): RoomRow {
    return this.ctx.storage.transactionSync(() => {
      const existing = this.getRoom();
      if (!existing) {
        this.ctx.storage.sql.exec(
          `INSERT INTO room
            (singleton, room_id, state_json, revision, expires_at, status, initialized)
           VALUES (1, ?, NULL, 0, ?, 'active', 0)`,
          roomId,
          pageExpiresAt,
        );
        return this.getRoom()!;
      }
      if (existing.room_id !== roomId) throw new Error("Room identity mismatch");
      if (pageExpiresAt < existing.expires_at) {
        this.ctx.storage.sql.exec(
          "UPDATE room SET expires_at = ? WHERE singleton = 1",
          pageExpiresAt,
        );
        return { ...existing, expires_at: pageExpiresAt };
      }
      return existing;
    });
  }

  private getRoom(): RoomRow | null {
    return (
      this.ctx.storage.sql.exec<RoomRow>("SELECT * FROM room WHERE singleton = 1").toArray()[0] ??
      null
    );
  }

  private rejectMutation(
    socket: WebSocket,
    roomId: string,
    code: CollaborationErrorCode,
    message: string,
    requestId?: string,
  ): void {
    const payload: ErrorMessage = { type: "error", code, message };
    if (requestId !== undefined) payload.requestId = requestId;
    this.send(socket, payload);
    logMetric("mutation_rejected", { room_id: roomId, reason: code });
  }

  private broadcast(message: ServerCollaborationMessage): void {
    for (const socket of this.ctx.getWebSockets()) this.send(socket, message);
  }

  private broadcastSnapshots(room: RoomRow): void {
    for (const socket of this.ctx.getWebSockets()) {
      const attachment = attachmentFor(socket);
      if (attachment) this.send(socket, snapshotMessage(room, attachment.role));
    }
  }

  private send(socket: WebSocket, message: ServerCollaborationMessage): void {
    try {
      socket.send(JSON.stringify(message));
    } catch (error) {
      logMetric("socket_send_failed", { reason: "send_error" });
      logError("Failed to send collaboration message", error);
      try {
        socket.close(1011, "Send failed");
      } catch {
        // The socket may already be closed.
      }
    }
  }

  private closeAll(code: number, reason: string): void {
    for (const socket of this.ctx.getWebSockets()) {
      try {
        socket.close(code, reason);
      } catch (error) {
        logError("Failed to close collaboration socket", error);
      }
    }
  }

  private async expireRoom(metric: "room_expired"): Promise<void> {
    if (this.storageDeleted) return;
    const roomId = this.getRoom()?.room_id ?? "unknown";
    this.closeAll(CLOSE_CODE_EXPIRED, "Room expired");
    await this.ctx.storage.deleteAll();
    this.storageDeleted = true;
    logMetric(metric, { room_id: roomId });
  }
}

class RoomNotInitializedError extends Error {
  override readonly name = "RoomNotInitializedError";

  constructor() {
    super("Room has not been initialized");
  }
}

function snapshotMessage(room: RoomRow, mode: CollaborationRole) {
  const snapshot: CollaborationSnapshot = {
    state: room.state_json === null ? {} : (JSON.parse(room.state_json) as JsonObject),
    revision: room.revision,
  };
  return { type: "snapshot", mode, ...snapshot } as const;
}

function attachmentFor(socket: WebSocket): ConnectionAttachment | null {
  const value: unknown = socket.deserializeAttachment();
  if (!isRecord(value) || (value.role !== "view" && value.role !== "edit")) return null;
  if (typeof value.ticketId !== "string" || !isMutationBudget(value.budget)) return null;
  return { role: value.role, ticketId: value.ticketId, budget: value.budget };
}

function isMutationBudget(value: unknown): value is MutationBudget {
  return (
    isRecord(value) &&
    isFiniteNumber(value.burstTokens) &&
    isFiniteNumber(value.burstRefillAt) &&
    isFiniteNumber(value.sustainedTokens) &&
    isFiniteNumber(value.sustainedRefillAt)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function randomCaptureToken(): string {
  const bytes = new Uint8Array(CAPTURE_TOKEN_BYTES);
  crypto.getRandomValues(bytes);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function isCaptureToken(value: string): boolean {
  return value.length === 43 && /^[A-Za-z0-9_-]+$/.test(value);
}

async function captureTokenHash(token: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function errorResponse(message: string, status: number, headers?: HeadersInit): Response {
  return Response.json(
    { error: message },
    {
      status,
      headers: { "Cache-Control": "no-store", ...Object.fromEntries(new Headers(headers)) },
    },
  );
}
