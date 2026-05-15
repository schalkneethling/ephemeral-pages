import { html, render } from "lit";

import {
  API_BASE,
  ALLOWED_EXPIRATIONS,
  MAX_HTML_BYTES,
  type ApiErrorResponse,
  type CreatePageResponse,
} from "./domain.ts";
import { htmlIcon, icon, type IconName } from "./icons.ts";
import { formatExpiryText, supportsTemporal } from "./ttl.ts";

const ACCEPTED_TYPES = [".html", ".htm"];
const UPLOAD_BUTTON_HTML = `${htmlIcon("rocket", "icon btn-icon")} Deploy a page`;
const UPLOAD_BUTTON_LOADING_HTML = `${htmlIcon("loader", "icon btn-icon icon-spin")} Deploying...`;

export function renderUploadPage(container: HTMLDivElement) {
  render(uploadPageTemplate(), container);
  setupUploadForm(container);
}

function uploadPageTemplate() {
  return html`
    <div class="upload-page">
      <header class="app-header">
        <div class="brand-mark" aria-hidden="true">${icon("sparkles", "icon brand-icon")}</div>
        <p class="eyebrow">
          <abbr title="HyperText Markup Language">HTML</abbr> with a
          <abbr title="Time to Live">TTL</abbr>
        </p>
        <h1 class="app-title">Ephemeral Pages</h1>
        <p class="tagline">Like <code>/tmp</code>, but for the web.</p>
      </header>

      <main class="upload-form-container">
        <form id="upload-form" class="upload-form" novalidate>
          <div class="form-heading">
            <p>
              Upload an HTML page. Set a TTL. Get a URL. The page self-destructs when the timer runs
              out. No frameworks, no accounts, no nonsense.
            </p>
          </div>

          <div
            id="drop-zone"
            class="drop-zone"
            role="button"
            tabindex="0"
            aria-label="Drop your HTML file here or click to browse"
          >
            <div class="drop-zone-inner">
              <div class="drop-icon" aria-hidden="true">
                ${icon("fileUp", "icon drop-icon-svg")}
              </div>
              <p class="drop-text">
                <strong>Drop your HTML</strong>
                <span>or click to browse</span>
              </p>
              <p class="drop-hint">Only .html files - max 2 MB</p>
            </div>
            <input type="file" id="file-input" class="file-input-hidden" accept=".html,.htm" />
            <label for="file-input" class="file-input-hidden">Choose an HTML file to upload</label>
          </div>

          <div id="file-preview" class="file-preview" hidden>
            <div class="file-preview-icon" aria-hidden="true">${icon("fileCode")}</div>
            <div class="file-preview-info">
              <span id="file-name" class="file-name"></span>
              <span id="file-size" class="file-size"></span>
            </div>
            <button type="button" id="file-remove" class="file-remove" aria-label="Remove file">
              ${icon("trash")}
            </button>
          </div>

          <div class="form-group">
            <label for="expiration-select">
              <abbr title="Time to Live">TTL</abbr>
            </label>
            <select id="expiration-select" class="expiration-select">
              <button type="button" class="select-button">
                <selectedcontent></selectedcontent>
                ${icon("chevronDown", "icon select-chevron")}
              </button>
              ${ALLOWED_EXPIRATIONS.map((option) => expirationOptionTemplate(option.hours))}
            </select>
          </div>

          <div class="form-actions">
            <button type="submit" class="btn-primary" id="upload-btn">
              ${icon("rocket", "icon btn-icon")} Deploy a page
            </button>
          </div>

          <div
            id="upload-message"
            class="message"
            role="status"
            aria-live="polite"
            tabindex="-1"
            hidden
          ></div>

          <div id="upload-progress" class="upload-progress" hidden>
            <progress class="upload-progress-bar" aria-label="Uploading your page"></progress>
            <p class="progress-label">Uploading your page...</p>
          </div>
        </form>

        <div
          id="result-section"
          class="result-section"
          role="status"
          aria-live="polite"
          tabindex="-1"
          hidden
        >
          <div class="result-icon" aria-hidden="true">${icon("checkCircle")}</div>
          <h2>Page deployed</h2>
          <p class="expires-info" id="expires-info">Share the URL before the TTL runs out.</p>
          <div class="share-url-container">
            <input type="text" id="share-url" class="share-url-input" readonly />
            <button id="copy-btn" class="btn-copy">${icon("copy", "icon btn-icon")} Copy</button>
          </div>
        </div>
      </main>

      <footer class="app-footer">
        <ul aria-label="Service details">
          <li>${icon("lock")} No signup.</li>
          <li>${icon("sparkles")} No tracking.</li>
          <li>${icon("clock")} <code>rm -rf</code> on schedule.</li>
        </ul>
      </footer>
    </div>
  `;
}

function expirationOptionTemplate(hours: number) {
  const option = ALLOWED_EXPIRATIONS.find((item) => item.hours === hours)!;
  const durationClass = hours <= 7 ? "short" : hours <= 24 ? "medium" : "long";

  return html`
    <option
      value=${option.hours}
      class=${`expiration-option expiration-option-${durationClass}`}
      ?selected=${option.default === true}
    >
      <span class="option-icon" aria-hidden="true">${icon(expirationIcon(hours))}</span>
      <span class="option-copy">
        <span class="option-label">${option.label}</span>
        <span class="option-hint">${expirationHint(hours)}</span>
      </span>
      <span class="option-track" aria-hidden="true">${expirationTrack(hours)}</span>
    </option>
  `;
}

function setupUploadForm(container: HTMLDivElement) {
  const uploadPage = query<HTMLDivElement>(container, ".upload-page");
  const elements = getUploadElements(uploadPage);
  let fileHtml: string | null = null;
  let expiryInterval: number | undefined;

  uploadPage.addEventListener("click", (e) => {
    const target = e.target;
    if (!(target instanceof Element)) {
      return;
    }

    if (target.closest("#drop-zone")) {
      elements.fileInput.click();
      return;
    }

    if (target.closest("#file-remove")) {
      clearFile();
      return;
    }

    if (target.closest("#copy-btn")) {
      copyShareUrl();
    }
  });

  uploadPage.addEventListener("keydown", (e) => {
    const target = e.target;
    if (!(target instanceof Element) || !target.closest("#drop-zone")) {
      return;
    }

    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      elements.fileInput.click();
    }
  });

  uploadPage.addEventListener("change", (e) => {
    if (e.target !== elements.fileInput) {
      return;
    }

    const files = elements.fileInput.files;
    if (files && files.length > 0) {
      handleFile(files[0]);
    }
  });

  uploadPage.addEventListener("dragover", (e) => {
    if (!dragEventTargetsDropZone(e, elements.dropZone)) {
      return;
    }

    e.preventDefault();
    e.stopPropagation();
    elements.dropZone.classList.add("drop-zone-active");
  });

  uploadPage.addEventListener("dragleave", (e) => {
    if (!dragEventTargetsDropZone(e, elements.dropZone)) {
      return;
    }

    e.preventDefault();
    e.stopPropagation();
    elements.dropZone.classList.remove("drop-zone-active");
  });

  uploadPage.addEventListener("drop", (e) => {
    if (!dragEventTargetsDropZone(e, elements.dropZone)) {
      return;
    }

    e.preventDefault();
    e.stopPropagation();
    elements.dropZone.classList.remove("drop-zone-active");

    const files = e.dataTransfer?.files;
    if (files && files.length > 0) {
      handleFile(files[0]);
    }
  });

  uploadPage.addEventListener("submit", async (e) => {
    if (e.target !== elements.form) {
      return;
    }

    e.preventDefault();
    await submitUpload();
  });

  function handleFile(file: File) {
    elements.message.hidden = true;
    elements.result.hidden = true;

    const ext = "." + file.name.split(".").pop()?.toLowerCase();
    if (!ACCEPTED_TYPES.includes(ext)) {
      showMessage(elements.message, "Only .html files are allowed.", "error");
      return;
    }

    if (file.size > MAX_HTML_BYTES) {
      showMessage(elements.message, "File is too large. Maximum size is 2 MB.", "error");
      return;
    }

    const reader = new FileReader();
    reader.onload = () => {
      fileHtml = reader.result as string;
      elements.fileName.textContent = file.name;
      elements.fileSize.textContent = formatSize(file.size);
      elements.filePreview.hidden = false;
      elements.dropZone.classList.add("drop-zone-has-file");
    };
    reader.onerror = () => {
      showMessage(elements.message, "Failed to read the file. Please try again.", "error");
    };
    reader.readAsText(file);
  }

  function clearFile() {
    fileHtml = null;
    elements.fileInput.value = "";
    elements.filePreview.hidden = true;
    elements.dropZone.classList.remove("drop-zone-has-file");
  }

  async function submitUpload() {
    if (!fileHtml) {
      showMessage(elements.message, "Please select an HTML file first.", "error");
      return;
    }

    const expirationHours = Number.parseFloat(elements.expirationSelect.value);

    elements.uploadButton.disabled = true;
    elements.uploadButton.innerHTML = UPLOAD_BUTTON_LOADING_HTML;
    elements.message.hidden = true;
    elements.result.hidden = true;
    elements.progress.hidden = false;

    try {
      const response = await fetch(`${API_BASE}/pages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ html: fileHtml, expirationHours }),
      });

      if (!response.ok) {
        const data = await readApiError(response);
        showMessage(
          elements.message,
          data.error || "Something went wrong. Please try again.",
          "error",
        );
        return;
      }

      const data = (await response.json()) as CreatePageResponse;

      const fullUrl = `${window.location.origin}${data.url}`;
      elements.shareUrl.value = fullUrl;

      startExpirySnippet(data.expiresAt);

      elements.progress.hidden = true;
      elements.result.hidden = false;
      elements.message.hidden = true;
      elements.result.focus();
    } catch {
      showMessage(
        elements.message,
        "The upload could not be completed. Please try again.",
        "error",
      );
    } finally {
      elements.uploadButton.disabled = false;
      elements.uploadButton.innerHTML = UPLOAD_BUTTON_HTML;
      elements.progress.hidden = true;
    }
  }

  function copyShareUrl() {
    navigator.clipboard
      .writeText(elements.shareUrl.value)
      .then(() => {
        elements.copyButton.innerHTML = `${htmlIcon("check", "icon btn-icon")} Copied`;
        setTimeout(() => {
          elements.copyButton.innerHTML = `${htmlIcon("copy", "icon btn-icon")} Copy`;
        }, 2000);
      })
      .catch(() => {
        elements.shareUrl.select();
      });
  }

  function startExpirySnippet(expiresAt: string) {
    window.clearInterval(expiryInterval);

    const renderSnippet = () => {
      const expiryText = formatExpiryText(expiresAt);
      elements.expiresInfo.textContent = `Share the URL before the TTL runs out. - ${expiryText}`;

      if (expiryText === "expired") {
        window.clearInterval(expiryInterval);
      }
    };

    renderSnippet();

    if (supportsTemporal()) {
      expiryInterval = window.setInterval(renderSnippet, 60 * 1000);
    }
  }
}

function expirationIcon(hours: number): IconName {
  if (hours <= 3) {
    return "rocket";
  }
  if (hours <= 12) {
    return "hourglass";
  }
  return "clock";
}

function expirationHint(hours: number): string {
  if (hours <= 3) {
    return "A quick handoff";
  }
  if (hours <= 7) {
    return "Good for a focused review";
  }
  if (hours === 12) {
    return "A workday plus a little";
  }
  if (hours === 24) {
    return "One tidy day";
  }
  return "More time, still temporary";
}

function expirationTrack(hours: number) {
  const totalBlocks = 5;
  const filledBlocks = Math.max(1, Math.ceil((hours / 168) * totalBlocks));
  return Array.from({ length: totalBlocks }, (_, index) => {
    const isFilled = index < filledBlocks;
    return html`<span class=${isFilled ? "track-dot track-dot-filled" : "track-dot"}></span>`;
  });
}

interface UploadElements {
  form: HTMLFormElement;
  dropZone: HTMLDivElement;
  fileInput: HTMLInputElement;
  filePreview: HTMLDivElement;
  fileName: HTMLSpanElement;
  fileSize: HTMLSpanElement;
  uploadButton: HTMLButtonElement;
  message: HTMLDivElement;
  progress: HTMLDivElement;
  result: HTMLDivElement;
  shareUrl: HTMLInputElement;
  copyButton: HTMLButtonElement;
  expiresInfo: HTMLParagraphElement;
  expirationSelect: HTMLSelectElement;
}

function getUploadElements(root: HTMLElement): UploadElements {
  return {
    form: query(root, "#upload-form"),
    dropZone: query(root, "#drop-zone"),
    fileInput: query(root, "#file-input"),
    filePreview: query(root, "#file-preview"),
    fileName: query(root, "#file-name"),
    fileSize: query(root, "#file-size"),
    uploadButton: query(root, "#upload-btn"),
    message: query(root, "#upload-message"),
    progress: query(root, "#upload-progress"),
    result: query(root, "#result-section"),
    shareUrl: query(root, "#share-url"),
    copyButton: query(root, "#copy-btn"),
    expiresInfo: query(root, "#expires-info"),
    expirationSelect: query(root, "#expiration-select"),
  };
}

function query<T extends Element>(root: ParentNode, selector: string): T {
  const element = root.querySelector(selector);
  if (!element) {
    throw new Error(`Missing expected upload element: ${selector}`);
  }
  return element as T;
}

function dragEventTargetsDropZone(event: DragEvent, dropZone: HTMLElement): boolean {
  const target = event.target;
  return target instanceof Element && dropZone.contains(target);
}

function showMessage(el: HTMLElement, text: string, type: "error" | "info") {
  el.textContent = text;
  el.className = `message message-${type}`;
  el.setAttribute("role", type === "error" ? "alert" : "status");
  el.setAttribute("aria-live", type === "error" ? "assertive" : "polite");
  el.hidden = false;
  el.focus();
}

function formatSize(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

async function readApiError(response: Response): Promise<ApiErrorResponse> {
  try {
    return (await response.json()) as ApiErrorResponse;
  } catch {
    return { error: `Request failed with status ${response.status}` };
  }
}
