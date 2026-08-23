const SDK_MARKER = "data-ephemeral-collaboration-sdk";

function collaborationBootstrap(window: Window & typeof globalThis, crypto: Crypto) {
  const SOURCE = "ephemeral-collaboration";
  const VERSION = 1;
  let mode = "view";
  let snapshot = { state: {}, revision: 0 };
  let readyResolved = false;
  let resolveReady: (value: unknown) => void;
  const listeners = new Set<(value: unknown) => void>();
  const pending = new Map<
    string,
    {
      resolve: (value: unknown) => void;
      reject: (error: Error) => void;
      apply: (state: Record<string, unknown>) => Record<string, unknown>;
      timeout: number;
    }
  >();

  const ready = new Promise((resolve) => {
    resolveReady = resolve;
  });

  function clone<T>(value: T): T {
    return JSON.parse(JSON.stringify(value)) as T;
  }

  function applyOperations(
    current: Record<string, unknown>,
    operations: Array<{ type: string; path: string[]; value?: unknown }>,
  ) {
    const next = clone(current);
    for (const operation of operations) {
      let target = next;
      for (const segment of operation.path.slice(0, -1)) {
        const child = target[segment];
        if (!child || typeof child !== "object" || Array.isArray(child)) {
          target[segment] = {};
        }
        target = target[segment] as Record<string, unknown>;
      }
      const key = operation.path.at(-1)!;
      if (operation.type === "delete") delete target[key];
      else target[key] = clone(operation.value);
    }
    return next;
  }

  function publish() {
    const value = clone(snapshot);
    for (const listener of listeners) listener(value);
  }

  function send(message: Record<string, unknown>) {
    window.parent.postMessage(
      { source: SOURCE, version: VERSION, direction: "page-to-parent", message },
      "*",
    );
  }

  function request(
    message: Record<string, unknown>,
    apply: (state: Record<string, unknown>) => Record<string, unknown>,
  ) {
    if (mode !== "edit") return Promise.reject(new Error("This collaboration link is read-only"));
    const requestId = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      const timeout = window.setTimeout(() => {
        pending.delete(requestId);
        reject(new Error("Collaboration request timed out; the change may not have been saved"));
      }, 10_000);
      pending.set(requestId, { resolve, reject, apply, timeout });
      send({ ...message, requestId });
    });
  }

  const api = Object.freeze({
    ready,
    get mode() {
      return mode;
    },
    initialize(state: Record<string, unknown>) {
      return request({ type: "initialize", state: clone(state) }, () => clone(state));
    },
    transact(operations: Array<{ type: string; path: string[]; value?: unknown }>) {
      const safeOperations = clone(operations);
      return request({ type: "transact", operations: safeOperations }, (state) =>
        applyOperations(state, safeOperations),
      );
    },
    subscribe(listener: (value: unknown) => void) {
      if (typeof listener !== "function") throw new TypeError("Subscriber must be a function");
      listeners.add(listener);
      if (readyResolved) listener(clone(snapshot));
      return () => listeners.delete(listener);
    },
  });

  Object.defineProperty(window, "ephemeralCollab", {
    configurable: false,
    enumerable: true,
    value: api,
    writable: false,
  });

  window.addEventListener("message", (event) => {
    if (event.source !== window.parent) return;
    const envelope = event.data;
    if (
      !envelope ||
      envelope.source !== SOURCE ||
      envelope.version !== VERSION ||
      envelope.direction !== "parent-to-page" ||
      !envelope.message ||
      typeof envelope.message !== "object"
    ) {
      return;
    }

    const message = envelope.message;
    if (message.type === "snapshot") {
      mode = message.mode;
      snapshot = { state: clone(message.state), revision: message.revision };
      if (!readyResolved) {
        readyResolved = true;
        resolveReady(clone(snapshot));
      }
      publish();
      return;
    }
    if (message.type === "update" && message.revision > snapshot.revision) {
      snapshot = {
        state: applyOperations(snapshot.state, message.operations),
        revision: message.revision,
      };
      publish();
      return;
    }
    if (message.type === "ack") {
      const request = pending.get(message.requestId);
      if (!request) return;
      pending.delete(message.requestId);
      window.clearTimeout(request.timeout);
      snapshot = { state: request.apply(snapshot.state), revision: message.revision };
      publish();
      request.resolve(clone(snapshot));
      return;
    }
    if (message.type === "error") {
      if (message.requestId) {
        const request = pending.get(message.requestId);
        if (!request) return;
        pending.delete(message.requestId);
        window.clearTimeout(request.timeout);
        request.reject(new Error(message.message));
      } else if (message.code === "unavailable") {
        rejectPending(message.message);
      }
    }
  });

  function rejectPending(message: string) {
    for (const request of pending.values()) {
      window.clearTimeout(request.timeout);
      request.reject(new Error(message));
    }
    pending.clear();
  }

  window.addEventListener("beforeunload", () => rejectPending("Page closed before changes saved"));

  send({ type: "sdk-ready" });
}

export function collaborationBootstrapScript(): string {
  return `;(${collaborationBootstrap.toString()})(window,crypto);`;
}

export function installCollaborationSdk(
  targetWindow: Window & typeof globalThis,
  cryptoApi: Crypto,
): void {
  collaborationBootstrap(targetWindow, cryptoApi);
}

export function injectCollaborationBootstrap(html: string): string {
  if (html.includes(SDK_MARKER)) return html;
  const script = `<script ${SDK_MARKER}>${collaborationBootstrapScript()}</script>`;
  if (/<\/head\s*>/i.test(html)) return html.replace(/<\/head\s*>/i, `${script}\n</head>`);
  if (/<\/body\s*>/i.test(html)) return html.replace(/<\/body\s*>/i, `${script}\n</body>`);
  throw new Error("Cannot inject collaboration SDK without a <head> or <body> element.");
}
