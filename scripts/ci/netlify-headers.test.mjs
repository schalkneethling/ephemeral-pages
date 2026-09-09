import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { buildAppShellCsp } from "../../src/csp.ts";

function buildHeaders(context, socket = "") {
  const directory = mkdtempSync(join(tmpdir(), "netlify-headers-"));
  try {
    mkdirSync(join(directory, "dist"));
    execFileSync(
      process.execPath,
      [fileURLToPath(new URL("../write-netlify-headers.mjs", import.meta.url))],
      {
        cwd: directory,
        env: { ...process.env, CONTEXT: context, COLLABORATION_WEBSOCKET_URL: socket },
        stdio: "pipe",
      },
    );
    return readFileSync(join(directory, "dist/_headers"), "utf8");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}
it("preserves production headers", () => {
  const headers = buildHeaders("production");
  expect(headers).toContain(
    "connect-src 'self' wss://collaboration.ephemeral.schalkneethling.com;",
  );
  expect(headers).toContain(
    "frame-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  );
  expect(headers).toContain(
    "Permissions-Policy: camera=(), geolocation=(), microphone=(), payment=(), usb=()",
  );
  expect(headers).toContain("Referrer-Policy: no-referrer");
  expect(headers).toContain("X-Content-Type-Options: nosniff");
});
it("allows only the configured preview socket", () => {
  const headers = buildHeaders("deploy-preview", "wss://preview.example.com");
  expect(headers).toContain(
    `Content-Security-Policy: ${buildAppShellCsp("wss://preview.example.com")}\n`,
  );
  expect(headers).toContain("connect-src 'self' wss://preview.example.com;");
  expect(headers).not.toContain("collaboration.ephemeral.schalkneethling.com");
});
it("does not give unconfigured previews production socket access", () => {
  expect(buildHeaders("deploy-preview")).toContain("connect-src 'self';");
});
it("rejects unsafe or non-origin configuration", () => {
  for (const socket of [
    "ws://example.com",
    "wss://user:password@example.com",
    "wss://example.com/path",
    "wss://example.com?query=1",
    "wss://example.com#fragment",
    "wss://example.com\n  X-Injected: yes",
  ]) {
    expect(() => buildHeaders("deploy-preview", socket)).toThrow();
  }
});
