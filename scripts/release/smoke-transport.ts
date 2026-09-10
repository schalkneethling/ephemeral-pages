import { createServer } from "node:http";
import { connect, type Socket } from "node:net";
import type { Duplex } from "node:stream";

const LIFETIME_MS = 300_000;
const CONNECT_TIMEOUT_MS = 10_000;
const MAX_CONNECTIONS = 128;

export class SmokeTransportError extends Error {
  constructor() {
    super("The isolated browser transport could not continue.");
    this.name = "SmokeTransportError";
  }
}

export type SmokeTransport = {
  proxyServer: string;
  workerConnections(): number;
  interruptWorker(): number;
  resumeWorker(): void;
  close(): Promise<void>;
};

type Destination = { authority: string; hostname: string; port: number };
type Tunnel = { client: Duplex; upstream: Socket; worker: boolean; connected: boolean };

const destination = (origin: string): Destination => {
  try {
    const url = new URL(origin);
    if (url.protocol !== "https:" || url.origin !== origin) throw new Error();
    const port = Number(url.port || "443");
    return {
      authority: `${url.hostname}:${port}`,
      hostname: url.hostname.replace(/^\[|\]$/gu, ""),
      port,
    };
  } catch {
    throw new SmokeTransportError();
  }
};

/** A loopback CONNECT tunnel: TLS remains between Chromium and the exact target hosts. */
export async function createSmokeTransport(
  origin: string,
  workerOrigin: string,
): Promise<SmokeTransport> {
  const page = destination(origin);
  const worker = destination(workerOrigin);
  if (page.authority === worker.authority) throw new SmokeTransportError();
  const destinations = new Map([page, worker].map((target) => [target.authority, target]));
  const sockets = new Set<Socket>();
  const tunnels = new Set<Tunnel>();
  let connectionAttempts = 0;
  let workerConnections = 0;
  let interrupted = false;
  let closed = false;
  let closing: Promise<void> | undefined;
  let lifetime: ReturnType<typeof setTimeout> | undefined;
  const server = createServer({ maxHeaderSize: 8_192 }, (_request, response) => {
    response.writeHead(403, { Connection: "close" });
    response.end();
  });
  server.headersTimeout = CONNECT_TIMEOUT_MS;
  server.requestTimeout = CONNECT_TIMEOUT_MS;
  server.on("clientError", (_error, socket) => socket.destroy());
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    socket.on("error", () => socket.destroy());
    // A client must issue CONNECT promptly. Established tunnels use the lifetime bound.
    socket.setTimeout(CONNECT_TIMEOUT_MS, () => socket.destroy());
    if (closed || ++connectionAttempts > MAX_CONNECTIONS) socket.destroy();
  });

  server.on("connect", (request, client, head) => {
    const target = destinations.get(request.url ?? "");
    if (closed || !target || (interrupted && target === worker)) {
      client.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
      return;
    }
    const upstream = connect({ host: target.hostname, port: target.port });
    const tunnel: Tunnel = { client, upstream, worker: target === worker, connected: false };
    tunnels.add(tunnel);
    const destroy = () => {
      client.destroy();
      upstream.destroy();
      tunnels.delete(tunnel);
    };
    client.once("close", destroy);
    client.on("error", destroy);
    upstream.once("close", destroy);
    upstream.on("error", destroy);
    upstream.setTimeout(CONNECT_TIMEOUT_MS, destroy);
    upstream.once("connect", () => {
      if (closed || (interrupted && tunnel.worker) || client.destroyed) {
        destroy();
        return;
      }
      tunnel.connected = true;
      if (tunnel.worker) workerConnections += 1;
      upstream.setTimeout(0);
      if ("setTimeout" in client) (client as Socket).setTimeout(0);
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length) upstream.write(head);
      client.pipe(upstream);
      upstream.pipe(client);
    });
  });

  const close = (): Promise<void> => {
    if (closing) return closing;
    closed = true;
    clearTimeout(lifetime);
    for (const tunnel of tunnels) {
      tunnel.client.destroy();
      tunnel.upstream.destroy();
    }
    for (const socket of sockets) socket.destroy();
    closing = new Promise<void>((resolveClose) => {
      if (!server.listening) resolveClose();
      else server.close(() => resolveClose());
    });
    return closing;
  };
  try {
    await new Promise<void>((resolveListen, reject) => {
      server.once("error", () => reject(new SmokeTransportError()));
      server.listen(0, "127.0.0.1", resolveListen);
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new SmokeTransportError();
    lifetime = setTimeout(() => void close(), LIFETIME_MS);
    lifetime.unref();
    return {
      proxyServer: `http://127.0.0.1:${address.port}`,
      workerConnections: () => workerConnections,
      interruptWorker: () => {
        if (closed) throw new SmokeTransportError();
        interrupted = true;
        let interruptedConnections = 0;
        for (const tunnel of tunnels) {
          if (!tunnel.worker) continue;
          if (tunnel.connected) interruptedConnections += 1;
          tunnel.client.destroy();
          tunnel.upstream.destroy();
        }
        return interruptedConnections;
      },
      resumeWorker: () => {
        if (closed) throw new SmokeTransportError();
        interrupted = false;
      },
      close,
    };
  } catch {
    await close();
    throw new SmokeTransportError();
  }
}
