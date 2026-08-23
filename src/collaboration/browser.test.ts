import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { buildAppShellCsp } from "../csp.ts";
import {
  collaborationBootstrapScript,
  injectCollaborationBootstrap,
  installCollaborationSdk,
} from "./bootstrap.ts";

describe("collaboration browser integration", () => {
  it("injects one self-contained SDK before page code", () => {
    const html =
      "<html><head><title>Board</title></head><body><script>start()</script></body></html>";
    const injected = injectCollaborationBootstrap(html);

    expect(injected).toContain("data-ephemeral-collaboration-sdk");
    expect(injected.indexOf("data-ephemeral-collaboration-sdk")).toBeLessThan(
      injected.indexOf("<body>"),
    );
    expect(injectCollaborationBootstrap(injected)).toBe(injected);
    expect(collaborationBootstrapScript()).toContain("ephemeralCollab");
    expect(collaborationBootstrapScript()).not.toContain("fetch(");
    expect(collaborationBootstrapScript()).not.toContain("WebSocket");
    expect(collaborationBootstrapScript()).toContain("Collaboration request timed out");
    expect(collaborationBootstrapScript()).toContain('addEventListener("beforeunload"');
  });

  it("rejects a sent mutation when its acknowledgement times out", async () => {
    const parent = { postMessage: () => undefined };
    const listeners = new Map<string, (event: unknown) => void>();
    const timeouts = new Map<number, () => void>();
    let timeoutId = 0;
    const fakeWindow = {
      parent,
      addEventListener(type: string, listener: (event: unknown) => void) {
        listeners.set(type, listener);
      },
      setTimeout(callback: () => void) {
        timeoutId += 1;
        timeouts.set(timeoutId, callback);
        return timeoutId;
      },
      clearTimeout(id: number) {
        timeouts.delete(id);
      },
    } as unknown as Window &
      typeof globalThis & {
        ephemeralCollab: {
          transact(operations: unknown[]): Promise<unknown>;
        };
      };

    installCollaborationSdk(fakeWindow, {
      randomUUID: () => "request-1",
    } as unknown as Crypto);
    listeners.get("message")?.({
      source: parent,
      data: {
        source: "ephemeral-collaboration",
        version: 1,
        direction: "parent-to-page",
        message: { type: "snapshot", state: {}, revision: 0, mode: "edit" },
      },
    });

    const mutation = fakeWindow.ephemeralCollab.transact([
      { type: "set", path: ["ready"], value: true },
    ]);
    timeouts.get(timeoutId)?.();

    await expect(mutation).rejects.toThrow(/timed out/);
  });

  it("adds only the configured collaboration origin to app connect-src", () => {
    expect(buildAppShellCsp("wss://collaboration.example.com")).toContain(
      "connect-src 'self' wss://collaboration.example.com",
    );
    expect(buildAppShellCsp("wss://collaboration.example.com")).not.toContain("https://");
    expect(() => buildAppShellCsp("ws://collaboration.example.com")).toThrow(/wss/);
    expect(() => buildAppShellCsp("wss://collaboration.example.com/socket")).toThrow(/origin/);
  });

  it("keeps the Kanban fixture self-contained and SDK-only", async () => {
    const fixture = await readFile("tests/fixtures/collaborative-kanban.html", "utf8");

    expect(fixture).toContain("window.ephemeralCollab.ready");
    expect(fixture).toMatch(/window\.ephemeralCollab\s*\n\s*\.transact/);
    expect(fixture).toContain('role="status"');
    expect(fixture).not.toMatch(/<script\s+src=/i);
    expect(fixture).not.toMatch(/\b(?:fetch|XMLHttpRequest|WebSocket|EventSource)\s*\(/);
  });
});
