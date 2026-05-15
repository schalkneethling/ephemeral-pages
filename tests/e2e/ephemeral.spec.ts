import { expect, test } from "@playwright/test";

import { buildUploadedPageHttpCsp } from "../../src/csp.ts";
import { PAGE_UNAVAILABLE_REASON } from "../../src/domain.ts";

test("uploads valid HTML and renders the shared page", async ({ page }) => {
  const id = "page-123";
  const html = '<html><body><h1 id="shared-title">Shared page</h1></body></html>';

  await page.route("**/api/pages", async (route) => {
    await route.fulfill({
      status: 201,
      contentType: "application/json",
      body: JSON.stringify({
        id,
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 12 * 60 * 60 * 1000).toISOString(),
        url: `/p/${id}`,
      }),
    });
  });
  await page.route(`**/api/pages/${id}`, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        id,
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 12 * 60 * 60 * 1000).toISOString(),
      }),
    });
  });
  await page.route(`**/api/pages/${id}/content`, async (route) => {
    await route.fulfill({ status: 200, contentType: "text/html", body: html });
  });

  await page.goto("/");
  await page.setInputFiles("#file-input", {
    name: "page.html",
    mimeType: "text/html",
    buffer: Buffer.from(html),
  });
  await page.getByRole("button", { name: /deploy a page/i }).click();

  await expect(page.locator("#share-url")).toHaveValue(new RegExp(`/p/${id}$`));
  await expect(page.locator("#result-section")).toBeFocused();

  await page.goto(`/p/${id}`);
  await expect(page.frameLocator("#page-iframe").locator("#shared-title")).toHaveText(
    "Shared page",
  );
  await expect(page.locator("#view-content")).toBeFocused();
  await expect(page.locator("#view-loading")).toBeHidden();
  await expect(page.locator("#view-expired")).toBeHidden();
  await expect(page.locator("#view-notfound")).toBeHidden();
  await expect(page.locator("#view-error")).toBeHidden();
  await expect(page.locator("#page-iframe")).toHaveAttribute(
    "title",
    `Shared ephemeral page ${id}`,
  );
});

test("flags a shared page through the abuse report form", async ({ page }) => {
  const id = "flagged-page";
  const html = "<html><body><h1>Flag me</h1></body></html>";
  let reportBody: { pageId?: string; flaggedUrl?: string } = {};

  await page.route(`**/api/pages/${id}`, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        id,
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 12 * 60 * 60 * 1000).toISOString(),
      }),
    });
  });
  await page.route(`**/api/pages/${id}/content`, async (route) => {
    await route.fulfill({ status: 200, contentType: "text/html", body: html });
  });
  await page.route("**/api/reports", async (route) => {
    reportBody = route.request().postDataJSON() as { pageId?: string; flaggedUrl?: string };
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ reported: true }),
    });
  });

  await page.goto(`/p/${id}`);
  await page.getByRole("button", { name: /flag this url/i }).click();

  await expect(page.locator("#flag-page-message")).toHaveText("Report sent. Thank you.");
  expect(reportBody.pageId).toBe(id);
  expect(reportBody.flaggedUrl).toContain(`/p/${id}`);
});

test("hard-deletes a flagged page from the admin review page", async ({ page }) => {
  const id = "reported-page";
  let authHeader: string | null = null;

  await page.route(`**/api/admin/pages/${id}`, async (route) => {
    authHeader = route.request().headers().authorization ?? null;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ deleted: true, id, existed: true }),
    });
  });

  await page.goto(`/admin?url=${encodeURIComponent(`http://127.0.0.1:5173/p/${id}`)}`);
  await expect(page.locator("code")).toHaveText(id);
  await page.locator("#admin-token").fill("secret-token");
  await page.getByRole("button", { name: /hard delete page/i }).click();

  await expect(page.locator("#admin-delete-message")).toContainText("Deleted");
  expect(authHeader).toBe("Bearer secret-token");
});

test("rejects invalid file types before upload", async ({ page }) => {
  await page.goto("/");
  await page.setInputFiles("#file-input", {
    name: "notes.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("plain text"),
  });

  await expect(page.locator("#upload-message")).toContainText("Only .html files are allowed.");
  await expect(page.locator("#upload-message")).toBeFocused();
  await expect(page.getByRole("button", { name: /deploy a page/i })).toBeEnabled();
});

test("keeps submit discoverable and validates missing file on submit", async ({ page }) => {
  await page.goto("/");

  const submitButton = page.getByRole("button", { name: /deploy a page/i });

  await expect(submitButton).toBeEnabled();
  await submitButton.click();

  await expect(page.locator("#upload-message")).toContainText("Please select an HTML file first.");
  await expect(page.locator("#upload-message")).toBeFocused();
  await expect(submitButton).toBeEnabled();
});

test("shows unavailable state for expired pages", async ({ page }) => {
  await page.route("**/api/pages/expired", async (route) => {
    await route.fulfill({
      status: 410,
      contentType: "application/json",
      body: JSON.stringify({ error: PAGE_UNAVAILABLE_REASON.gone }),
    });
  });

  await page.goto("/p/expired");
  await expect(page.getByRole("heading", { name: /410 gone/i })).toBeVisible();
  await expect(page.locator("#view-expired")).toBeFocused();
});

test("runs inline script and blocks disallowed remote script", async ({ page }) => {
  const id = "csp-test";
  const html = `
    <html>
      <body>
        <h1 id="status">Waiting</h1>
        <script>document.querySelector("#status").textContent = "Inline works";</script>
        <script src="https://example.invalid/not-allowed.js"></script>
      </body>
    </html>
  `;

  await page.route("**/api/pages/csp-test", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        id,
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 12 * 60 * 60 * 1000).toISOString(),
      }),
    });
  });
  await page.route("**/api/pages/csp-test/content", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "text/html",
      headers: {
        "Content-Security-Policy": buildUploadedPageHttpCsp(),
      },
      body: html,
    });
  });
  await page.route("https://example.invalid/not-allowed.js", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "text/javascript",
      body: "document.querySelector('#status').textContent = 'Remote ran';",
    });
  });

  await page.goto("/p/csp-test");

  await expect(page.locator("#page-iframe")).toHaveAttribute("src", "/api/pages/csp-test/content");
  await expect(page.frameLocator("#page-iframe").locator("#status")).toHaveText("Inline works");
  await page.waitForTimeout(250);
  await expect(page.frameLocator("#page-iframe").locator("#status")).toHaveText("Inline works");
});
