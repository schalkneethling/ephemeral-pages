import { once } from "node:events";
import { connect, createServer, type Socket } from "node:net";

import { describe, expect, it, vi } from "vitest";

import { createSmokeTransport, type SmokeTransport } from "./smoke-transport.ts";

async function echoTarget() {
  const sockets = new Set<Socket>();
  let connections = 0;
  const server = createServer((socket) => {
    connections += 1;
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    socket.on("error", () => socket.destroy());
    socket.pipe(socket);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Local fixture did not start.");
  return {
    origin: `https://127.0.0.1:${address.port}`,
    authority: `127.0.0.1:${address.port}`,
    connections: () => connections,
    activeConnections: () => sockets.size,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

async function client(transport: SmokeTransport) {
  const url = new URL(transport.proxyServer);
  const socket = connect({ host: url.hostname, port: Number(url.port) });
  socket.on("error", () => socket.destroy());
  await once(socket, "connect");
  return socket;
}

function readThrough(socket: Socket, marker: string): Promise<string> {
  return new Promise((resolve, reject) => {
    let value = "";
    const cleanup = () => {
      clearTimeout(timer);
      socket.off("data", data);
      socket.off("close", failed);
    };
    const failed = () => {
      cleanup();
      reject(new Error("Local tunnel read did not complete."));
    };
    const data = (chunk: Buffer) => {
      value += chunk.toString();
      if (value.length > 8_192) return failed();
      if (value.includes(marker)) {
        cleanup();
        resolve(value);
      }
    };
    const timer = setTimeout(failed, 2_000);
    socket.on("data", data);
    socket.once("close", failed);
  });
}

async function tunnel(transport: SmokeTransport, authority: string) {
  const socket = await client(transport);
  const response = readThrough(socket, "\r\n\r\n");
  socket.write(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n\r\n`);
  expect(await response).toBe("HTTP/1.1 200 Connection Established\r\n\r\n");
  return socket;
}

describe("isolated smoke transport", () => {
  it.each([
    "http://worker.example",
    "https://user:credential@worker.example",
    "https://worker.example/path",
    "https://worker.example?secret=value",
    "https://worker.example#secret",
    "https://pages.example",
  ])("rejects invalid or shared Worker origin %s before listening", async (origin) => {
    await expect(createSmokeTransport("https://pages.example", origin)).rejects.toThrow(
      "The isolated browser transport could not continue.",
    );
  });

  it("passes opaque bytes, cuts only Worker tunnels, and requires a fresh connection", async () => {
    const page = await echoTarget();
    const worker = await echoTarget();
    const transport = await createSmokeTransport(page.origin, worker.origin);
    try {
      const pageSocket = await tunnel(transport, page.authority);
      const workerSocket = await tunnel(transport, worker.authority);
      const payload = "opaque-synthetic-payload";
      const echoed = readThrough(workerSocket, payload);
      workerSocket.write(payload);
      expect(await echoed).toBe(payload);
      expect(transport.workerConnections()).toBe(1);
      const disconnected = once(workerSocket, "close");
      expect(transport.interruptWorker()).toBe(1);
      await disconnected;
      expect(pageSocket.destroyed).toBe(false);
      const pageEchoed = readThrough(pageSocket, "page-still-connected");
      pageSocket.write("page-still-connected");
      expect(await pageEchoed).toBe("page-still-connected");

      const blocked = await client(transport);
      const denied = readThrough(blocked, "\r\n\r\n");
      blocked.write(`CONNECT ${worker.authority} HTTP/1.1\r\n\r\n`);
      expect(await denied).toContain("403 Forbidden");
      expect(worker.connections()).toBe(1);
      blocked.destroy();

      transport.resumeWorker();
      const fresh = await tunnel(transport, worker.authority);
      expect(transport.workerConnections()).toBe(2);
      const freshEcho = readThrough(fresh, "fresh-connection");
      fresh.write("fresh-connection");
      expect(await freshEcho).toBe("fresh-connection");
      const freshClosed = once(fresh, "close");
      const pageClosed = once(pageSocket, "close");
      await transport.close();
      await Promise.all([freshClosed, pageClosed]);
      await transport.close();
      expect(() => transport.resumeWorker()).toThrow();
    } finally {
      await transport.close();
      await Promise.all([page.close(), worker.close()]);
    }
  });

  it("rejects plain HTTP and every authority outside the exact allowlist", async () => {
    const page = await echoTarget();
    const worker = await echoTarget();
    const transport = await createSmokeTransport(page.origin, worker.origin);
    try {
      const requests = [
        "GET http://untrusted.invalid/ HTTP/1.1\r\nHost: untrusted.invalid\r\n\r\n",
        ...[
          "untrusted.invalid:443",
          `user:credential@${worker.authority}`,
          `${worker.authority}/path`,
          `${worker.authority}?secret=value`,
          `${worker.authority}#fragment`,
          `https://${worker.authority}`,
        ].map((authority) => `CONNECT ${authority} HTTP/1.1\r\n\r\n`),
      ];
      for (const request of requests) {
        const socket = await client(transport);
        // Node's HTTP parser closes some malformed CONNECT targets before our handler.
        const response = readThrough(socket, "\r\n\r\n").catch(() => null);
        socket.write(request);
        const denied = await response;
        expect(denied === null || denied.includes("403 Forbidden")).toBe(true);
        socket.destroy();
      }
      expect(page.connections()).toBe(0);
      expect(worker.connections()).toBe(0);
    } finally {
      await transport.close();
      await Promise.all([page.close(), worker.close()]);
    }
  });

  it("allows more than 128 connections when earlier tunnels have closed", async () => {
    const page = await echoTarget();
    const worker = await echoTarget();
    const transport = await createSmokeTransport(page.origin, worker.origin);
    try {
      for (let index = 0; index < 129; index += 1) {
        const socket = await tunnel(transport, worker.authority);
        const closed = once(socket, "close");
        socket.destroy();
        await closed;
      }
      expect(transport.workerConnections()).toBe(129);
    } finally {
      await transport.close();
      await Promise.all([page.close(), worker.close()]);
    }
  });

  it("rejects a 129th live connection and reuses capacity after a tunnel closes", async () => {
    const page = await echoTarget();
    const worker = await echoTarget();
    const transport = await createSmokeTransport(page.origin, worker.origin);
    try {
      const active = [];
      for (let index = 0; index < 128; index += 1) {
        active.push(await tunnel(transport, worker.authority));
      }
      const overflow = await client(transport);
      await once(overflow, "close");
      expect(worker.connections()).toBe(128);

      const closed = once(active[0]!, "close");
      active[0]!.destroy();
      await closed;
      await expect.poll(worker.activeConnections).toBe(127);
      const replacement = await tunnel(transport, worker.authority);
      expect(transport.workerConnections()).toBe(129);
      const echoed = readThrough(replacement, "replacement-tunnel");
      replacement.write("replacement-tunnel");
      expect(await echoed).toBe("replacement-tunnel");
    } finally {
      await transport.close();
      await Promise.all([page.close(), worker.close()]);
    }
  });

  it("closes the listener when the five-minute lifetime expires", async () => {
    vi.useFakeTimers();
    let transport: SmokeTransport | undefined;
    try {
      transport = await createSmokeTransport("https://pages.example", "https://worker.example");
      await vi.advanceTimersByTimeAsync(299_999);
      expect(() => transport!.resumeWorker()).not.toThrow();
      await vi.advanceTimersByTimeAsync(1);
      expect(() => transport!.interruptWorker()).toThrow();
      expect(() => transport!.resumeWorker()).toThrow();
      await expect(client(transport)).rejects.toThrow();
    } finally {
      await transport?.close();
      vi.useRealTimers();
    }
  });
});
