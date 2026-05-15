import { html, render } from "lit";

import { API_BASE, mapUnavailableStatus, type PageMetadata } from "./domain.ts";
import { icon } from "./icons.ts";

export async function renderViewPage(container: HTMLDivElement, pageId: string) {
  render(viewPageTemplate(pageId), container);
  bindReportPage(pageId);
  await loadPage(pageId);
}

function viewPageTemplate(pageId: string) {
  return html`
    <div class="view-page">
      <section
        id="view-loading"
        class="view-status"
        aria-live="polite"
        aria-label="Loading shared page"
        tabindex="-1"
      >
        <div class="status-card">
          <div class="status-icon status-icon-loading" aria-hidden="true">${icon("loader")}</div>
          <p>Loading page...</p>
        </div>
      </section>
      <section
        id="view-expired"
        class="view-status"
        aria-labelledby="view-expired-heading"
        tabindex="-1"
        hidden
      >
        <div class="expired-message status-card">
          <div class="status-icon" aria-hidden="true">${icon("hourglass")}</div>
          <h2 id="view-expired-heading">410 Gone</h2>
          <p>This page has expired and its contents have been permanently deleted.</p>
          <a href="/" class="btn-primary">${icon("rocket", "icon btn-icon")} Create a new page</a>
        </div>
      </section>
      <section
        id="view-notfound"
        class="view-status"
        aria-labelledby="view-notfound-heading"
        tabindex="-1"
        hidden
      >
        <div class="expired-message status-card">
          <div class="status-icon" aria-hidden="true">${icon("ban")}</div>
          <h2 id="view-notfound-heading">404 Not Found</h2>
          <p>This resource does not exist, or it has already been cleaned up.</p>
          <a href="/" class="btn-primary">${icon("rocket", "icon btn-icon")} Create a new page</a>
        </div>
      </section>
      <main id="view-content" aria-labelledby="view-content-heading" tabindex="-1" hidden>
        <h1 id="view-content-heading" class="visually-hidden">Shared ephemeral page</h1>
        <div class="page-bar">
          <div class="page-bar-info">
            <span class="page-id-label">${icon("fileCode")} Page</span>
            <span class="page-id-value">${pageId}</span>
            <span class="page-expires" id="page-expires-label">${icon("clock")}</span>
          </div>
          <div class="page-bar-actions">
            <button type="button" id="flag-page" class="btn-secondary btn-danger">
              ${icon("flag", "icon btn-icon")} Flag this URL
            </button>
            <a href="/" class="btn-secondary">
              ${icon("externalLink", "icon btn-icon")} Create your own
            </a>
          </div>
        </div>
        <p id="flag-page-message" class="page-bar-message" aria-live="polite"></p>
        <iframe
          id="page-iframe"
          class="page-iframe"
          sandbox="allow-scripts"
          title=${`Shared ephemeral page ${pageId}`}
        ></iframe>
      </main>
      <section
        id="view-error"
        class="view-status"
        role="alert"
        aria-labelledby="view-error-heading"
        tabindex="-1"
        hidden
      >
        <div class="expired-message status-card">
          <div class="status-icon status-icon-error" aria-hidden="true">${icon("circleAlert")}</div>
          <h2 id="view-error-heading">Something went wrong</h2>
          <p id="view-error-text">Failed to load the page. It may have expired or been deleted.</p>
          <a href="/" class="btn-primary">${icon("rocket", "icon btn-icon")} Create a new page</a>
        </div>
      </section>
    </div>
  `;
}

function bindReportPage(pageId: string) {
  const flagButton = document.getElementById("flag-page") as HTMLButtonElement | null;
  const flagMessage = document.getElementById("flag-page-message");

  flagButton?.addEventListener("click", async () => {
    flagButton.disabled = true;
    flagMessage!.textContent = "Sending report...";

    try {
      const flaggedUrl = window.location.href;
      const response = await fetch(`${API_BASE}/reports`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          pageId,
          flaggedUrl,
        }),
      });

      if (!response.ok) {
        throw new Error(`Unexpected status: ${response.status}`);
      }

      flagMessage!.textContent = "Report sent. Thank you.";
    } catch {
      flagMessage!.textContent = "Report failed. Please try again.";
      flagButton.disabled = false;
    }
  });
}

async function loadPage(pageId: string) {
  const loadingEl = document.getElementById("view-loading")!;
  const expiredEl = document.getElementById("view-expired")!;
  const notFoundEl = document.getElementById("view-notfound")!;
  const contentEl = document.getElementById("view-content")!;
  const errorEl = document.getElementById("view-error")!;
  const errorText = document.getElementById("view-error-text")!;

  try {
    // First check metadata
    const metaResponse = await fetch(`${API_BASE}/pages/${pageId}`);

    const metaUnavailable = mapUnavailableStatus(metaResponse.status);
    if (metaUnavailable) {
      loadingEl.hidden = true;
      expiredEl.hidden = metaUnavailable !== "expired";
      notFoundEl.hidden = metaUnavailable !== "not-found";
      focusVisibleState(metaUnavailable === "expired" ? expiredEl : notFoundEl);
      return;
    }

    if (!metaResponse.ok) {
      throw new Error(`Unexpected status: ${metaResponse.status}`);
    }

    const meta = (await metaResponse.json()) as PageMetadata;

    // Check the HTML content before revealing the viewer.
    const contentResponse = await fetch(`${API_BASE}/pages/${pageId}/content`);

    const contentUnavailable = mapUnavailableStatus(contentResponse.status);
    if (contentUnavailable) {
      loadingEl.hidden = true;
      expiredEl.hidden = contentUnavailable !== "expired";
      notFoundEl.hidden = contentUnavailable !== "not-found";
      focusVisibleState(contentUnavailable === "expired" ? expiredEl : notFoundEl);
      return;
    }

    if (!contentResponse.ok) {
      throw new Error(`Unexpected status: ${contentResponse.status}`);
    }

    const iframe = document.getElementById("page-iframe") as HTMLIFrameElement;
    iframe.src = `${API_BASE}/pages/${pageId}/content`;

    // Set expiration label
    const expiresLabel = document.getElementById("page-expires-label")!;
    const expiresDate = new Date(meta.expiresAt);
    expiresLabel.append(`Expires ${expiresDate.toLocaleString()}`);

    // Show content
    loadingEl.hidden = true;
    contentEl.hidden = false;
    focusVisibleState(contentEl);
  } catch {
    loadingEl.hidden = true;
    errorEl.hidden = false;
    errorText.textContent = "Failed to load the page. It may have expired or been deleted.";
    focusVisibleState(errorEl);
  }
}

function focusVisibleState(element: HTMLElement) {
  element.focus();
}
