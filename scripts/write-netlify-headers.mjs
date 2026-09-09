import { writeFile } from "node:fs/promises";
import { buildAppShellCsp } from "../src/csp.ts";

const productionSocket = "wss://collaboration.ephemeral.schalkneethling.com";
const configuredSocket = process.env.COLLABORATION_WEBSOCKET_URL;
const production = !process.env.CONTEXT || process.env.CONTEXT === "production";
const socket = configuredSocket || (production ? productionSocket : "");
let socketOrigin = "";
if (socket) {
  const url = new URL(socket);
  if (
    url.protocol !== "wss:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/" ||
    socket.trim() !== socket
  ) {
    throw new Error("COLLABORATION_WEBSOCKET_URL must be a bare secure WebSocket origin");
  }
  socketOrigin = url.origin;
}
const csp = buildAppShellCsp(socketOrigin || undefined);
await writeFile(
  "dist/_headers",
  `/*
  Content-Security-Policy: ${csp}
  Permissions-Policy: camera=(), geolocation=(), microphone=(), payment=(), usb=()
  Referrer-Policy: no-referrer
  X-Content-Type-Options: nosniff
`,
);
