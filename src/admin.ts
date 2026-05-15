import { html, render } from "lit";

import { API_BASE } from "./domain.ts";
import { icon } from "./icons.ts";
import { matchViewRoute } from "./routes.ts";

export function renderAdminPage(container: HTMLDivElement) {
  const flaggedUrl = new URL(window.location.href).searchParams.get("url") ?? "";
  const pageId = pageIdFromUrl(flaggedUrl);

  render(adminPageTemplate(flaggedUrl, pageId), container);
  bindAdminDelete(flaggedUrl, pageId);
}

function adminPageTemplate(flaggedUrl: string, pageId: string | null) {
  return html`
    <div class="upload-page admin-page">
      <header class="app-header">
        <a href="/" class="brand-mark" aria-label="Ephemeral Pages home">
          ${icon("rocket", "brand-icon")}
        </a>
        <p class="eyebrow">Owner tools</p>
        <h1 class="app-title">Review flagged URL</h1>
        <p class="tagline">Hard-delete reported pages after review.</p>
      </header>
      <main class="upload-form-container">
        <form class="upload-form admin-form" id="admin-delete-form">
          <div class="form-heading">
            <p>
              Confirm the flagged URL and enter the admin delete token to remove the page and its
              stored resources.
            </p>
          </div>

          <dl class="admin-review-list">
            <div>
              <dt>Flagged URL</dt>
              <dd>
                ${flaggedUrl
                  ? html`<a href=${flaggedUrl} rel="noopener noreferrer">${flaggedUrl}</a>`
                  : html`<span>No URL was provided.</span>`}
              </dd>
            </div>
            <div>
              <dt>Page ID</dt>
              <dd><code>${pageId ?? "Unavailable"}</code></dd>
            </div>
          </dl>

          <label class="field-label" for="admin-token">Admin delete token</label>
          <input
            id="admin-token"
            class="admin-token-input"
            type="password"
            autocomplete="current-password"
            ?disabled=${!pageId}
            required
          />

          <button type="submit" class="btn-primary btn-danger" ?disabled=${!pageId}>
            ${icon("trash", "icon btn-icon")} Hard delete page
          </button>

          <p id="admin-delete-message" class="form-message" role="status" tabindex="-1">
            ${pageId
              ? ""
              : "Open this page from a same-origin flag report containing a /p/:id URL."}
          </p>
        </form>
      </main>
    </div>
  `;
}

function bindAdminDelete(flaggedUrl: string, pageId: string | null) {
  const form = document.getElementById("admin-delete-form") as HTMLFormElement | null;
  const tokenInput = document.getElementById("admin-token") as HTMLInputElement | null;
  const message = document.getElementById("admin-delete-message") as HTMLParagraphElement | null;

  if (!form || !tokenInput || !message || !pageId) {
    return;
  }

  form.addEventListener("submit", async (event) => {
    event.preventDefault();

    const token = tokenInput.value.trim();
    if (!token) {
      setMessage(message, "Enter the admin delete token first.", true);
      return;
    }

    const submitButton = form.querySelector<HTMLButtonElement>('button[type="submit"]')!;
    submitButton.disabled = true;
    setMessage(message, "Deleting page...", false);

    try {
      const response = await fetch(`${API_BASE}/admin/pages/${encodeURIComponent(pageId)}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${token}` },
      });

      if (!response.ok) {
        throw new Error(`Unexpected status: ${response.status}`);
      }

      setMessage(message, `Deleted ${flaggedUrl}.`, false);
      tokenInput.value = "";
      tokenInput.disabled = true;
    } catch {
      submitButton.disabled = false;
      setMessage(message, "Delete failed. Check the token and try again.", true);
    }
  });
}

function pageIdFromUrl(value: string): string | null {
  if (!value) {
    return null;
  }

  try {
    const url = new URL(value, window.location.origin);
    if (url.origin !== window.location.origin) {
      return null;
    }

    return matchViewRoute(url.pathname)?.id ?? null;
  } catch {
    return null;
  }
}

function setMessage(element: HTMLElement, text: string, isError: boolean) {
  element.textContent = text;
  element.classList.toggle("form-message-error", isError);
  element.focus();
}
