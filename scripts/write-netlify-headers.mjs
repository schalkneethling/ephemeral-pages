import { writeFile } from "node:fs/promises";

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
const csp = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "font-src 'self'",
  `connect-src 'self'${socketOrigin ? ` ${socketOrigin}` : ""}`,
  "frame-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");
await writeFile(
  "dist/_headers",
  `/*
  Content-Security-Policy: ${csp}
  Permissions-Policy: camera=(), geolocation=(), microphone=(), payment=(), usb=()
  Referrer-Policy: no-referrer
  X-Content-Type-Options: nosniff
`,
);
