import { expect, test } from "@playwright/test";
import {
  captureRoomScreenshot,
  renderFrozenCapture,
} from "../../collaboration-worker/src/capture.ts";
import { injectCollaborationBootstrap } from "../../src/collaboration/bootstrap.ts";
import { buildCollaborativeUploadedPageHttpCsp } from "../../src/csp.ts";

test("captures frozen state after a slow embedded page load", async ({ page }) => {
  const token = "a".repeat(43);
  const capturedAt = "2026-09-09T12:00:00.000Z";
  const room = {
    async createCapture() {
      return { ok: true, token, revision: 7, capturedAt, expiresAt: 1_800_000_000 };
    },
    async consumeCapture() {
      return {
        ok: true,
        stateJson: JSON.stringify({ title: "Frozen revision seven" }),
        revision: 7,
        capturedAt,
      };
    },
    async finishCapture() {},
  };
  const contentOrigin = "https://pages.example";
  const workerOrigin = "https://capture.example";
  const html = injectCollaborationBootstrap(`<!doctype html><html><head></head><body>
    <h1 id="title">Waiting</h1><script>
      window.ephemeralCollab.ready.then(({ state }) => {
        document.getElementById("title").textContent = state.title;
      });
    </script></body></html>`);
  await page.route(`${contentOrigin}/api/pages/room-1/content`, async (route) => {
    // A slow response must not exhaust the entire SDK/readiness allowance.
    await new Promise((resolve) => setTimeout(resolve, 5_000));
    await route.fulfill({
      body: html,
      headers: {
        "Content-Type": "text/html",
        "Content-Security-Policy": buildCollaborativeUploadedPageHttpCsp(),
      },
    });
  });
  await page.route(`${workerOrigin}/rooms/room-1/captures/${token}/render`, async (route) => {
    const response = await renderFrozenCapture(
      "room-1",
      token,
      room,
      contentOrigin,
      async () => new Response(null, { headers: { "Content-Type": "text/html" } }),
    );
    await route.fulfill({
      status: response.status,
      headers: Object.fromEntries(response.headers),
      body: await response.text(),
    });
  });
  const response = await captureRoomScreenshot(
    "room-1",
    room,
    {
      async quickAction(_action, options) {
        await page.goto(options.url, {
          waitUntil: "domcontentloaded",
          timeout: options.gotoOptions?.timeout,
        });
        // Puppeteer's default selector wait checks presence, not visibility of this hidden marker.
        await page.waitForSelector(options.waitForSelector.selector, {
          state: "attached",
          timeout: options.waitForSelector.timeout,
        });
        await expect(page.frameLocator("#capture-frame").locator("#title")).toHaveText(
          "Frozen revision seven",
        );
        return new Response(
          new Uint8Array(await page.screenshot({ type: "png", timeout: options.actionTimeout })),
          {
            headers: { "Content-Type": "image/png" },
          },
        );
      },
    },
    { pageContentOrigin: contentOrigin, publicWorkerOrigin: workerOrigin },
  );
  expect(response.status).toBe(200);
  expect(response.headers.get("X-Ephemeral-Capture-Revision")).toBe("7");
});
