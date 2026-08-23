import {
  COLLABORATION_PROTOCOL_VERSION,
  type CollaborationRole,
  type ServerCollaborationMessage,
  validateClientMessage,
  validateJsonObject,
} from "./protocol.ts";

const SOURCE = "ephemeral-collaboration";
const SESSION_PREFIX = "ephemeral-pages:edit-capability:";
const SOCKET_PROTOCOL = `ephemeral-collaboration-v${COLLABORATION_PROTOCOL_VERSION}`;

type TicketResponse = {
  ticket: string;
  websocketUrl: string;
  role: CollaborationRole;
};

export type CollaborationStatus =
  | "connecting"
  | "connected"
  | "reconnecting"
  | "read-only"
  | "unavailable";

type BridgeOptions = {
  iframe: HTMLIFrameElement;
  pageId: string;
  capability?: string;
  onStatus?: (status: CollaborationStatus) => void;
};

export function consumeEditorCapability(pageId: string): string | undefined {
  const key = `${SESSION_PREFIX}${pageId}`;
  const fragment = new URLSearchParams(window.location.hash.slice(1));
  const supplied = fragment.get("edit") ?? undefined;
  let capability = supplied;

  if (supplied && isCapability(supplied)) {
    try {
      sessionStorage.setItem(key, supplied);
    } catch {
      // The in-memory value still authorizes this page load when storage is unavailable.
    }
  } else if (!supplied) {
    try {
      capability = sessionStorage.getItem(key) ?? undefined;
    } catch {
      capability = undefined;
    }
  } else {
    capability = undefined;
  }

  if (window.location.hash) {
    history.replaceState(history.state, "", `${window.location.pathname}${window.location.search}`);
  }
  return capability;
}

export class CollaborationBridge {
  readonly #iframe: HTMLIFrameElement;
  readonly #pageId: string;
  readonly #capability?: string;
  readonly #onStatus: (status: CollaborationStatus) => void;
  #socket?: WebSocket;
  #role: CollaborationRole = "view";
  #stopped = false;
  #pageReady = false;
  #queuedMessages: ServerCollaborationMessage[] = [];
  #reconnectAttempt = 0;
  #reconnectTimer?: number;

  constructor(options: BridgeOptions) {
    this.#iframe = options.iframe;
    this.#pageId = options.pageId;
    this.#capability = options.capability;
    this.#onStatus = options.onStatus ?? (() => undefined);
  }

  start() {
    window.addEventListener("message", this.#handlePageMessage);
    void this.#connect();
  }

  stop() {
    this.#stopped = true;
    window.removeEventListener("message", this.#handlePageMessage);
    window.clearTimeout(this.#reconnectTimer);
    this.#socket?.close(1000, "Page closed");
  }

  async #connect() {
    this.#onStatus(this.#reconnectAttempt === 0 ? "connecting" : "reconnecting");
    try {
      const ticket = await this.#mintTicket();
      if (this.#stopped) return;
      this.#role = ticket.role;
      const socket = new WebSocket(ticket.websocketUrl, [SOCKET_PROTOCOL, ticket.ticket]);
      this.#socket = socket;
      socket.addEventListener("open", () => {
        this.#reconnectAttempt = 0;
        this.#onStatus(this.#role === "view" ? "read-only" : "connected");
      });
      socket.addEventListener("message", (event) => this.#handleSocketMessage(event));
      socket.addEventListener("close", () => this.#scheduleReconnect());
      socket.addEventListener("error", () => socket.close());
    } catch (error) {
      if (error instanceof TerminalCollaborationError) {
        this.#onStatus("unavailable");
        this.#postToPage({
          type: "error",
          code: "unavailable",
          message: error.message,
        });
        return;
      }
      this.#scheduleReconnect();
    }
  }

  async #mintTicket(): Promise<TicketResponse> {
    const response = await fetch(
      `/api/pages/${encodeURIComponent(this.#pageId)}/collaboration-ticket`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(this.#capability ? { capability: this.#capability } : {}),
      },
    );
    if (!response.ok) {
      const message = `Ticket request failed with status ${response.status}`;
      if ([400, 403, 404, 409, 410].includes(response.status)) {
        throw new TerminalCollaborationError(message);
      }
      throw new Error(message);
    }
    const value = (await response.json()) as unknown;
    if (!isTicketResponse(value)) throw new Error("Ticket response is invalid");
    return value;
  }

  #handlePageMessage = (event: MessageEvent) => {
    if (event.source !== this.#iframe.contentWindow || !isPageEnvelope(event.data)) return;
    if (event.data.message.type === "sdk-ready") {
      this.#pageReady = true;
      for (const message of this.#queuedMessages.splice(0)) this.#postToPage(message);
      return;
    }
    const validated = validateClientMessage(event.data.message);
    if (!validated.ok) {
      this.#postToPage({
        type: "error",
        code: validated.code,
        message: validated.error,
        requestId: readRequestId(event.data.message),
      });
      return;
    }
    if (this.#role !== "edit") {
      this.#postToPage({
        type: "error",
        code: "forbidden",
        message: "This collaboration link is read-only",
        requestId: validated.value.requestId,
      });
      return;
    }
    if (!this.#socket || this.#socket.readyState !== WebSocket.OPEN) {
      this.#postToPage({
        type: "error",
        code: "unavailable",
        message: "Collaboration is disconnected; changes were not queued",
        requestId: validated.value.requestId,
      });
      return;
    }
    this.#socket.send(JSON.stringify(validated.value));
  };

  #handleSocketMessage(event: MessageEvent) {
    if (typeof event.data !== "string") return;
    try {
      const value = JSON.parse(event.data) as unknown;
      if (isServerMessage(value)) this.#postToPage(value);
    } catch {
      // Ignore malformed server frames rather than exposing them to uploaded code.
    }
  }

  #postToPage(message: ServerCollaborationMessage) {
    if (!this.#pageReady) {
      if (this.#queuedMessages.length >= 100) this.#queuedMessages.shift();
      this.#queuedMessages.push(message);
      return;
    }
    this.#iframe.contentWindow?.postMessage(
      {
        source: SOURCE,
        version: COLLABORATION_PROTOCOL_VERSION,
        direction: "parent-to-page",
        message,
      },
      "*",
    );
  }

  #scheduleReconnect() {
    if (this.#stopped || this.#reconnectTimer !== undefined) return;
    this.#onStatus("reconnecting");
    this.#postToPage({
      type: "error",
      code: "unavailable",
      message: "Collaboration disconnected; pending changes were not saved",
    });
    const delay = Math.min(10_000, 500 * 2 ** this.#reconnectAttempt);
    this.#reconnectAttempt += 1;
    this.#reconnectTimer = window.setTimeout(() => {
      this.#reconnectTimer = undefined;
      void this.#connect();
    }, delay);
  }
}

function isCapability(value: string): boolean {
  return /^[A-Za-z0-9_-]{1,32}\.[A-Za-z0-9_-]{43}$/.test(value);
}

function isTicketResponse(value: unknown): value is TicketResponse {
  if (!isRecord(value)) return false;
  if (typeof value.ticket !== "string" || value.ticket.length === 0) return false;
  if (value.role !== "view" && value.role !== "edit") return false;
  if (typeof value.websocketUrl !== "string") return false;
  try {
    const url = new URL(value.websocketUrl);
    return url.protocol === "wss:" || (url.protocol === "ws:" && isLocalhost(url.hostname));
  } catch {
    return false;
  }
}

function isPageEnvelope(value: unknown): value is {
  message: Record<string, unknown> & { type: string };
} {
  return (
    isRecord(value) &&
    value.source === SOURCE &&
    value.version === COLLABORATION_PROTOCOL_VERSION &&
    value.direction === "page-to-parent" &&
    isRecord(value.message) &&
    typeof value.message.type === "string"
  );
}

function isServerMessage(value: unknown): value is ServerCollaborationMessage {
  if (!isRecord(value) || typeof value.type !== "string") return false;
  if (value.type === "snapshot") {
    return (
      validateJsonObject(value.state).ok &&
      isRevision(value.revision) &&
      (value.mode === "view" || value.mode === "edit")
    );
  }
  if (value.type === "ack") {
    return typeof value.requestId === "string" && isRevision(value.revision);
  }
  if (value.type === "update") {
    return (
      isRevision(value.revision) &&
      validateClientMessage({
        type: "transact",
        requestId: "server-update",
        operations: value.operations,
      }).ok
    );
  }
  return (
    value.type === "error" &&
    typeof value.code === "string" &&
    ERROR_CODES.has(value.code) &&
    typeof value.message === "string" &&
    (value.requestId === undefined || typeof value.requestId === "string")
  );
}

const ERROR_CODES = new Set([
  "capacity_exceeded",
  "expired",
  "forbidden",
  "invalid_message",
  "not_initialized",
  "rate_limited",
  "state_too_large",
  "unavailable",
]);

class TerminalCollaborationError extends Error {}

function readRequestId(value: Record<string, unknown>): string | undefined {
  return typeof value.requestId === "string" ? value.requestId : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isRevision(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isLocalhost(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
}
