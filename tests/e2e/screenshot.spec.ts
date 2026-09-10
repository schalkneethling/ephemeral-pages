import { expect, test, type Page } from "@playwright/test";

for (const width of [1280, 390]) {
  test(`captures without layout shifts at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    const pageId = "capture-success";
    let requestCount = 0;
    let releaseCapture!: () => void;
    const captureGate = new Promise<void>((resolve) => {
      releaseCapture = resolve;
    });
    await routeCollaborativeViewer(page, pageId);
    await page.route(`**/api/pages/${pageId}/screenshots`, async (route) => {
      requestCount += 1;
      await captureGate;
      await route.fulfill({
        status: 201,
        contentType: "application/json",
        body: JSON.stringify({
          id: "shot-1",
          pageId,
          createdAt: "2026-08-23T10:15:00.000Z",
          expiresAt: "2026-08-23T22:15:00.000Z",
          revision: 17,
          sizeBytes: 42_000,
          url: `/api/pages/${pageId}/screenshots/shot-1`,
        }),
      });
    });

    await page.goto(`/p/${pageId}`);
    const button = page.locator("#capture-page");
    await expect(button).toBeVisible();
    await page.evaluate(() => document.fonts.ready);
    const initialFrame = await page.locator("#page-iframe").boundingBox();
    const initialButton = await button.boundingBox();
    await button.focus();
    await page.keyboard.press("Enter");

    await expect(button).toBeDisabled();
    expect(await page.locator("#page-iframe").boundingBox()).toEqual(initialFrame);
    expect(await button.boundingBox()).toEqual(initialButton);
    await expect(page.getByRole("status")).toHaveText("Capturing the current shared page…");
    await button.evaluate((element) => {
      if (element instanceof HTMLButtonElement) {
        element.disabled = false;
        element.click();
      }
    });
    expect(requestCount).toBe(1);

    releaseCapture();
    await expect(button).toBeEnabled();
    await expect(page.locator("#capture-message")).toHaveText(
      /Screenshot captured at .+ Revision 17\./,
    );
    expect(await page.locator("#page-iframe").boundingBox()).toEqual(initialFrame);
    expect(await button.boundingBox()).toEqual(initialButton);
    const download = page.getByRole("link", { name: "Download screenshot (revision 17)" });
    await expect(download).toHaveAttribute(
      "href",
      `http://127.0.0.1:5173/api/pages/${pageId}/screenshots/shot-1`,
    );
    await expect(download).toHaveAttribute("download", `ephemeral-page-${pageId}-revision-17.png`);
  });
}

const failureScenarios: Array<{
  name: string;
  status: number;
  headers: Record<string, string>;
  message: string;
  disabled: boolean;
}> = [
  {
    name: "rate limit",
    status: 429,
    headers: { "Retry-After": "30" },
    message: "Too many screenshot requests. Try again in 30 seconds.",
    disabled: false,
  },
  {
    name: "temporary unavailability",
    status: 503,
    headers: { "Retry-After": "45" },
    message: "Screenshot capture is temporarily unavailable. Try again in 45 seconds.",
    disabled: false,
  },
  {
    name: "page expiry",
    status: 410,
    headers: {},
    message: "This page expired before the screenshot could be captured.",
    disabled: true,
  },
];

for (const scenario of failureScenarios) {
  test(`announces screenshot ${scenario.name}`, async ({ page }) => {
    const pageId = `capture-${scenario.status}`;
    await routeCollaborativeViewer(page, pageId);
    await page.route(`**/api/pages/${pageId}/screenshots`, (route) =>
      route.fulfill({
        status: scenario.status,
        contentType: "application/json",
        headers: scenario.headers,
        body: JSON.stringify({ error: scenario.message }),
      }),
    );

    await page.goto(`/p/${pageId}`);
    const button = page.getByRole("button", { name: "Capture screenshot" });
    await button.click();

    await expect(page.getByRole("alert")).toHaveText(scenario.message);
    if (scenario.disabled) await expect(button).toBeDisabled();
    else await expect(button).toBeEnabled();
    await expect(page.locator("#capture-download")).toBeHidden();
  });
}

async function routeCollaborativeViewer(page: Page, pageId: string) {
  await page.addInitScript(() => {
    class TestWebSocket extends EventTarget {
      static readonly OPEN = 1;
      readonly readyState = TestWebSocket.OPEN;
      constructor() {
        super();
        queueMicrotask(() => this.dispatchEvent(new Event("open")));
      }
      close() {}
      send() {}
    }
    Object.defineProperty(window, "WebSocket", { value: TestWebSocket });
  });
  await page.route(`**/api/pages/${pageId}`, (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        id: pageId,
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        collaboration: true,
      }),
    }),
  );
  await page.route(`**/api/pages/${pageId}/content`, (route) =>
    route.fulfill({
      status: 200,
      contentType: "text/html",
      body: "<html><body><h1>Shared board</h1></body></html>",
    }),
  );
  await page.route(`**/api/pages/${pageId}/collaboration-ticket`, (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        ticket: "viewer-ticket",
        websocketUrl: "ws://127.0.0.1:8787",
        role: "view",
      }),
    }),
  );
}
