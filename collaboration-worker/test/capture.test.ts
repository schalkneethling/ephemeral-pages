import { describe, expect, it, vi } from "vitest";

import {
  captureRoomScreenshot,
  type CaptureRoomRpc,
  renderFrozenCapture,
  type ScreenshotBrowser,
} from "../src/capture.ts";
import type { CaptureReservation, FrozenCapture } from "../src/room.ts";

const TOKEN = "a".repeat(43);

describe("captureRoomScreenshot", () => {
  it("uses only the configured render target and returns bounded PNG metadata", async () => {
    const room = new FakeRoom();
    const browser = new FakeBrowser(
      new Response(new Uint8Array([137, 80, 78, 71]), {
        headers: { "Content-Type": "image/png", "X-Browser-Ms-Used": "125" },
      }),
    );

    const response = await captureRoomScreenshot("room-1", room, browser, {
      pageContentOrigin: "https://pages.example",
      publicWorkerOrigin: "https://collaboration.example",
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("image/png");
    expect(response.headers.get("X-Ephemeral-Capture-Revision")).toBe("7");
    expect(response.headers.get("X-Ephemeral-Captured-At")).toBe("2026-08-23T00:00:00.000Z");
    expect(browser.options?.url).toBe(
      `https://collaboration.example/rooms/room-1/captures/${TOKEN}/render`,
    );
    expect(browser.options).toMatchObject({
      viewport: { width: 1440, height: 900, deviceScaleFactor: 1 },
      gotoOptions: { timeout: 4_000 },
      waitForSelector: { selector: "#ephemeral-capture-ready", timeout: 4_000 },
      actionTimeout: 2_000,
      cacheTTL: 0,
    });
    expect(room.finished).toEqual([{ roomId: "room-1", token: TOKEN }]);
  });

  it("fails closed on Browser Run quota errors and always releases the lease", async () => {
    const room = new FakeRoom();
    const browser = new FakeBrowser(
      Response.json(
        { success: false, errors: [{ message: "quota" }] },
        { status: 429, headers: { "Retry-After": "300" } },
      ),
    );

    const response = await captureRoomScreenshot("room-1", room, browser, {
      pageContentOrigin: "https://pages.example",
      publicWorkerOrigin: "https://collaboration.example",
    });
    expect(response.status).toBe(503);
    expect(response.headers.get("Retry-After")).toBe("300");
    expect(room.finished).toHaveLength(1);
  });

  it("rejects an oversized declared output before buffering it", async () => {
    const room = new FakeRoom();
    const browser = new FakeBrowser(
      new Response(new Uint8Array([1]), {
        headers: {
          "Content-Type": "image/png",
          "Content-Length": String(8 * 1024 * 1024 + 1),
        },
      }),
    );
    const response = await captureRoomScreenshot("room-1", room, browser, {
      pageContentOrigin: "https://pages.example",
      publicWorkerOrigin: "https://collaboration.example",
    });
    expect(response.status).toBe(503);
  });

  it("cancels Browser Run output as soon as the stream crosses 8 MiB", async () => {
    const room = new FakeRoom();
    let canceled = false;
    let chunksProduced = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        chunksProduced += 1;
        controller.enqueue(new Uint8Array(3 * 1024 * 1024));
      },
      cancel() {
        canceled = true;
      },
    });
    const browser = new FakeBrowser(
      new Response(body, { headers: { "Content-Type": "image/png" } }),
    );

    const response = await captureRoomScreenshot("room-1", room, browser, {
      pageContentOrigin: "https://pages.example",
      publicWorkerOrigin: "https://collaboration.example",
    });

    expect(response.status).toBe(503);
    expect(canceled).toBe(true);
    // The stream implementation may prefetch one chunk before cancellation is observed.
    expect(chunksProduced).toBeLessThanOrEqual(4);
    expect(room.finished).toHaveLength(1);
  });

  it("logs only fixed categories when Browser Run throws", async () => {
    const room = new FakeRoom();
    const logs = captureConsoleLogs();
    const secretUrl = `https://collaboration.example/rooms/room-1/captures/${TOKEN}/render`;
    const browser = {
      async quickAction() {
        throw new Error(`navigation failed for ${secretUrl}`);
      },
    } satisfies ScreenshotBrowser;

    try {
      const response = await captureRoomScreenshot("room-1", room, browser, {
        pageContentOrigin: "https://pages.example",
        publicWorkerOrigin: "https://collaboration.example",
      });
      expect(response.status).toBe(503);
      expect(logs.text()).toContain("browser_exception");
      expect(logs.text()).not.toContain(TOKEN);
      expect(logs.error).not.toHaveBeenCalled();
    } finally {
      logs.restore();
    }
  });
});

describe("renderFrozenCapture", () => {
  it("fetches only the configured content URL and serves a read-only frozen bridge", async () => {
    const room = new FakeRoom();
    room.consumeResult = {
      ok: true,
      stateJson: JSON.stringify({ title: "</script><script>globalThis.pwned=true</script>" }),
      revision: 7,
      capturedAt: "2026-08-23T00:00:00.000Z",
    };
    const fetched: string[] = [];
    const response = await renderFrozenCapture(
      "room-1",
      TOKEN,
      room,
      "https://pages.example",
      async (input) => {
        fetched.push(
          input instanceof Request ? input.url : input instanceof URL ? input.href : input,
        );
        return new Response("<html></html>", { headers: { "Content-Type": "text/html" } });
      },
    );

    expect(fetched).toEqual(["https://pages.example/api/pages/room-1/content"]);
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Security-Policy")).toContain(
      "frame-src https://pages.example",
    );
    const html = await response.text();
    expect(html).toContain('sandbox="allow-scripts"');
    expect(html).toContain('mode: "view"');
    expect(html).toContain("window.__EPHEMERAL_CAPTURE_READY__ = true");
    expect(html).toContain("\\u003c/script>");
    expect(html).not.toContain("</script><script>globalThis.pwned");
  });

  it("does not fetch page content for an invalid or consumed token", async () => {
    const room = new FakeRoom();
    room.consumeResult = { ok: false, code: "consumed" };
    let fetched = false;
    const response = await renderFrozenCapture(
      "room-1",
      TOKEN,
      room,
      "https://pages.example",
      async () => {
        fetched = true;
        return new Response();
      },
    );
    expect(response.status).toBe(410);
    expect(fetched).toBe(false);
  });

  it("logs only a fixed category when the trusted content fetch throws", async () => {
    const room = new FakeRoom();
    const logs = captureConsoleLogs();
    try {
      const response = await renderFrozenCapture(
        "room-1",
        TOKEN,
        room,
        "https://pages.example",
        async () => {
          throw new Error(`trusted fetch exposed ${TOKEN}`);
        },
      );
      expect(response.status).toBe(502);
      expect(logs.text()).toContain("trusted_fetch_exception");
      expect(logs.text()).not.toContain(TOKEN);
      expect(logs.error).not.toHaveBeenCalled();
    } finally {
      logs.restore();
    }
  });
});

function captureConsoleLogs() {
  const output: string[] = [];
  const log = vi.spyOn(console, "log").mockImplementation((...values: unknown[]) => {
    output.push(JSON.stringify(values));
  });
  const error = vi.spyOn(console, "error").mockImplementation((...values: unknown[]) => {
    output.push(JSON.stringify(values));
  });
  return {
    error,
    text: () => output.join("\n"),
    restore: () => {
      log.mockRestore();
      error.mockRestore();
    },
  };
}

class FakeRoom implements CaptureRoomRpc {
  createResult: CaptureReservation = {
    ok: true,
    token: TOKEN,
    revision: 7,
    capturedAt: "2026-08-23T00:00:00.000Z",
    expiresAt: 1_800_000_060,
  };
  consumeResult: FrozenCapture = {
    ok: true,
    stateJson: "{}",
    revision: 7,
    capturedAt: "2026-08-23T00:00:00.000Z",
  };
  finished: Array<{ roomId: string; token: string }> = [];

  async createCapture(_roomId: string): Promise<CaptureReservation> {
    return this.createResult;
  }

  async consumeCapture(_roomId: string, _token: string): Promise<FrozenCapture> {
    return this.consumeResult;
  }

  async finishCapture(roomId: string, token: string): Promise<void> {
    this.finished.push({ roomId, token });
  }
}

class FakeBrowser implements ScreenshotBrowser {
  options?: BrowserRunScreenshotOptions & { url: string };
  private readonly response: Response;

  constructor(response: Response) {
    this.response = response;
  }

  async quickAction(
    _action: "screenshot",
    options: BrowserRunScreenshotOptions,
  ): Promise<Response> {
    if ("url" in options) this.options = options;
    return this.response;
  }
}
