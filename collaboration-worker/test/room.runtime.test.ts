import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import type { ServerCollaborationMessage } from "../../src/collaboration/protocol.ts";
import { CollaborationRoom, INTERNAL_ROOM_HEADERS } from "../src/room.ts";

describe("CollaborationRoom", () => {
  it("persists initialization and atomic transactions before broadcasting revisions", async () => {
    const stub = env.COLLABORATION_ROOMS.getByName("runtime-state-room");
    const editor = await connect(stub, "runtime-state-room", "edit", "editor-ticket");
    const viewer = await connect(stub, "runtime-state-room", "view", "viewer-ticket");

    expect(await nextMessage(editor)).toMatchObject({
      type: "snapshot",
      revision: 0,
      mode: "edit",
    });
    expect(await nextMessage(viewer)).toMatchObject({
      type: "snapshot",
      revision: 0,
      mode: "view",
    });

    editor.send(
      JSON.stringify({
        type: "initialize",
        requestId: "initialize-1",
        state: { cards: { one: { laneId: "todo" } } },
      }),
    );
    expect(await nextMessage(editor)).toEqual({
      type: "ack",
      requestId: "initialize-1",
      revision: 1,
    });
    expect(await nextMessage(editor)).toMatchObject({ type: "snapshot", revision: 1 });
    expect(await nextMessage(viewer)).toMatchObject({ type: "snapshot", revision: 1 });

    editor.send(
      JSON.stringify({
        type: "transact",
        requestId: "move-1",
        operations: [{ type: "set", path: ["cards", "one", "laneId"], value: "done" }],
      }),
    );
    expect(await nextMessage(editor)).toEqual({ type: "ack", requestId: "move-1", revision: 2 });
    expect(await nextMessage(editor)).toMatchObject({ type: "update", revision: 2 });
    expect(await nextMessage(viewer)).toMatchObject({ type: "update", revision: 2 });

    await runInDurableObject(stub, async (instance, state) => {
      expect(instance).toBeInstanceOf(CollaborationRoom);
      const row = state.storage.sql
        .exec<{ state_json: string; revision: number }>(
          "SELECT state_json, revision FROM room WHERE singleton = 1",
        )
        .one();
      expect(row.revision).toBe(2);
      expect(JSON.parse(row.state_json)).toEqual({ cards: { one: { laneId: "done" } } });
    });
  });

  it("rejects viewer mutations and replayed active tickets", async () => {
    const stub = env.COLLABORATION_ROOMS.getByName("runtime-auth-room");
    const viewer = await connect(stub, "runtime-auth-room", "view", "shared-ticket");
    await nextMessage(viewer);

    const replay = await stub.fetch(
      connectionRequest("runtime-auth-room", "view", "shared-ticket"),
    );
    expect(replay.status).toBe(409);

    viewer.send(
      JSON.stringify({
        type: "initialize",
        requestId: "forbidden-1",
        state: { value: true },
      }),
    );
    expect(await nextMessage(viewer)).toEqual({
      type: "error",
      code: "forbidden",
      message: "Read-only connections cannot mutate room state",
      requestId: "forbidden-1",
    });
  });

  it("accepts 25 sockets and rejects the 26th without exceeding room capacity", async () => {
    const stub = env.COLLABORATION_ROOMS.getByName("runtime-capacity-room");
    const sockets: WebSocket[] = [];
    for (let index = 0; index < 25; index += 1) {
      const socket = await connect(
        stub,
        "runtime-capacity-room",
        "view",
        `capacity-ticket-${index}`,
      );
      await nextMessage(socket);
      sockets.push(socket);
    }

    const rejected = await stub.fetch(
      connectionRequest("runtime-capacity-room", "view", "capacity-ticket-26"),
    );
    expect(rejected.status).toBe(429);
    await runInDurableObject(stub, async (_instance, state) => {
      expect(state.getWebSockets()).toHaveLength(25);
    });

    for (const socket of sockets) socket.close(1000, "capacity test complete");
  });

  it("rejects a ticket replay after its WebSocket has closed", async () => {
    const stub = env.COLLABORATION_ROOMS.getByName("runtime-persistent-ticket-room");
    const ticketExpiresAt = Math.floor(Date.now() / 1_000) + 240;
    const viewer = await connect(
      stub,
      "runtime-persistent-ticket-room",
      "view",
      "persistent-ticket",
      ticketExpiresAt,
    );
    await nextMessage(viewer);

    const closed = waitForSocketClose(viewer);
    await runInDurableObject(stub, async (_instance, state) => {
      state.getWebSockets()[0]?.close(1000, "test complete");
    });
    await closed;
    await runInDurableObject(stub, async (_instance, state) => {
      expect(state.getWebSockets()).toHaveLength(0);
      expect(
        state.storage.sql
          .exec<{ expires_at: number }>(
            "SELECT expires_at FROM consumed_tickets WHERE ticket_id = ?",
            "persistent-ticket",
          )
          .one().expires_at,
      ).toBe(ticketExpiresAt);
    });

    const replay = await stub.fetch(
      connectionRequest(
        "runtime-persistent-ticket-room",
        "view",
        "persistent-ticket",
        ticketExpiresAt,
      ),
    );
    expect(replay.status).toBe(409);
  });

  it("atomically prunes an expired ticket record before accepting the new ticket", async () => {
    const stub = env.COLLABORATION_ROOMS.getByName("runtime-ticket-prune-room");
    const seed = await connect(stub, "runtime-ticket-prune-room", "view", "seed-ticket");
    await nextMessage(seed);
    await runInDurableObject(stub, async (_instance, state) => {
      state.storage.sql.exec(
        "INSERT INTO consumed_tickets (ticket_id, expires_at) VALUES (?, ?)",
        "reissued-ticket",
        Math.floor(Date.now() / 1_000) - 1,
      );
    });

    const expiresAt = futureTicketExpiry();
    const accepted = await stub.fetch(
      connectionRequest("runtime-ticket-prune-room", "view", "reissued-ticket", expiresAt),
    );
    expect(accepted.status).toBe(101);
    await runInDurableObject(stub, async (_instance, state) => {
      expect(
        state.storage.sql
          .exec<{ expires_at: number }>(
            "SELECT expires_at FROM consumed_tickets WHERE ticket_id = ?",
            "reissued-ticket",
          )
          .one().expires_at,
      ).toBe(expiresAt);
    });
  });

  it("keeps a deletion tombstone until page expiry", async () => {
    const stub = env.COLLABORATION_ROOMS.getByName("runtime-delete-room");
    await stub.deleteRoom("runtime-delete-room", futureExpiry());

    const response = await stub.fetch(
      connectionRequest("runtime-delete-room", "edit", "after-delete-ticket"),
    );
    expect(response.status).toBe(410);
    await runInDurableObject(stub, async (_instance, state) => {
      expect(
        state.storage.sql
          .exec<{ status: string }>("SELECT status FROM room WHERE singleton = 1")
          .one().status,
      ).toBe("deleted");
      expect(await state.storage.getAlarm()).not.toBeNull();
    });
  });

  it("freezes one immutable revision behind a one-use capture token", async () => {
    const stub = env.COLLABORATION_ROOMS.getByName("runtime-capture-room");
    const editor = await connect(stub, "runtime-capture-room", "edit", "capture-editor");
    await nextMessage(editor);
    editor.send(
      JSON.stringify({
        type: "initialize",
        requestId: "capture-initialize",
        state: { card: { laneId: "todo" } },
      }),
    );
    await nextMessage(editor);
    await nextMessage(editor);

    const frozen = await stub.createCapture("runtime-capture-room");
    expect(frozen).toMatchObject({ ok: true, revision: 1 });
    expect(await stub.createCapture("runtime-capture-room")).toEqual({
      ok: false,
      code: "capacity",
    });
    if (!frozen.ok) throw new Error("Expected capture reservation");

    editor.send(
      JSON.stringify({
        type: "transact",
        requestId: "capture-move",
        operations: [{ type: "set", path: ["card", "laneId"], value: "done" }],
      }),
    );
    await nextMessage(editor);
    await nextMessage(editor);

    const consumed = await stub.consumeCapture("runtime-capture-room", frozen.token);
    expect(consumed).toMatchObject({
      ok: true,
      revision: 1,
    });
    if (consumed.ok) {
      expect(JSON.parse(consumed.stateJson)).toEqual({ card: { laneId: "todo" } });
    }
    expect(await stub.consumeCapture("runtime-capture-room", frozen.token)).toEqual({
      ok: false,
      code: "consumed",
    });

    await stub.finishCapture("runtime-capture-room", frozen.token);
    const next = await stub.createCapture("runtime-capture-room");
    expect(next).toMatchObject({ ok: true, revision: 2 });
    if (next.ok) await stub.finishCapture("runtime-capture-room", next.token);
  });
});

async function connect(
  stub: DurableObjectStub<CollaborationRoom>,
  roomId: string,
  role: "view" | "edit",
  ticketId: string,
  ticketExpiresAt = futureTicketExpiry(),
): Promise<WebSocket> {
  const response = await stub.fetch(connectionRequest(roomId, role, ticketId, ticketExpiresAt));
  expect(response.status).toBe(101);
  expect(response.headers.get("Sec-WebSocket-Protocol")).toBe("ephemeral-collaboration-v1");
  const socket = response.webSocket!;
  socket.accept();
  attachMessageQueue(socket);
  return socket;
}

function connectionRequest(
  roomId: string,
  role: "view" | "edit",
  ticketId: string,
  ticketExpiresAt = futureTicketExpiry(),
): Request {
  return new Request("https://collaboration.internal/websocket", {
    headers: {
      Upgrade: "websocket",
      [INTERNAL_ROOM_HEADERS.roomId]: roomId,
      [INTERNAL_ROOM_HEADERS.role]: role,
      [INTERNAL_ROOM_HEADERS.ticketId]: ticketId,
      [INTERNAL_ROOM_HEADERS.ticketExpiresAt]: String(ticketExpiresAt),
      [INTERNAL_ROOM_HEADERS.pageExpiresAt]: String(futureExpiry()),
    },
  });
}

function futureTicketExpiry(): number {
  return Math.floor(Date.now() / 1_000) + 300;
}

function waitForSocketClose(socket: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error("Timed out waiting for WebSocket close")),
      2_000,
    );
    socket.addEventListener(
      "close",
      () => {
        clearTimeout(timeout);
        resolve();
      },
      { once: true },
    );
  });
}

function futureExpiry(): number {
  return Math.floor(Date.now() / 1_000) + 3_600;
}

type MessageQueue = {
  messages: ServerCollaborationMessage[];
  waiters: Array<(message: ServerCollaborationMessage) => void>;
};

const messageQueues = new WeakMap<WebSocket, MessageQueue>();

function attachMessageQueue(socket: WebSocket): void {
  const queue: MessageQueue = { messages: [], waiters: [] };
  messageQueues.set(socket, queue);
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data)) as ServerCollaborationMessage;
    const waiter = queue.waiters.shift();
    if (waiter) waiter(message);
    else queue.messages.push(message);
  });
}

function nextMessage(socket: WebSocket): Promise<ServerCollaborationMessage> {
  const queue = messageQueues.get(socket);
  if (!queue) return Promise.reject(new Error("WebSocket message queue is unavailable"));
  const buffered = queue.messages.shift();
  if (buffered) return Promise.resolve(buffered);
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      const index = queue.waiters.indexOf(consume);
      if (index >= 0) queue.waiters.splice(index, 1);
      reject(new Error("Timed out waiting for WebSocket message"));
    }, 2_000);
    const consume = (message: ServerCollaborationMessage) => {
      clearTimeout(timeout);
      resolve(message);
    };
    queue.waiters.push(consume);
  });
}
