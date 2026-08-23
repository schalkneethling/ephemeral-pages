import { readFile } from "node:fs/promises";

import { expect, test, type BrowserContext, type WebSocketRoute } from "@playwright/test";

import { injectCollaborationBootstrap } from "../../src/collaboration/bootstrap.ts";
import type {
  CollaborationOperation,
  CollaborationRole,
  JsonObject,
  JsonValue,
} from "../../src/collaboration/protocol.ts";

test("synchronizes the Kanban fixture between two editors and a viewer", async ({ browser }) => {
  const pageId = "kanban-room";
  const capability = `v1.${"c".repeat(43)}`;
  const fixture = injectCollaborationBootstrap(
    await readFile("tests/fixtures/collaborative-kanban.html", "utf8"),
  );
  const context = await browser.newContext();
  const room = createMockRoom();
  await routeCollaborativePage(context, pageId, capability, fixture, room);

  const editor = await context.newPage();
  const secondEditor = await context.newPage();
  const viewer = await context.newPage();
  await editor.goto(`/p/${pageId}#edit=${capability}`);
  await secondEditor.goto(`/p/${pageId}#edit=${capability}`);
  await viewer.goto(`/p/${pageId}`);

  const editorFrame = editor.frameLocator("#page-iframe");
  const secondEditorFrame = secondEditor.frameLocator("#page-iframe");
  const viewerFrame = viewer.frameLocator("#page-iframe");
  await expect(editorFrame.locator("#connection")).toHaveText("Connected — editing");
  await expect(secondEditorFrame.locator("#connection")).toHaveText("Connected — editing");
  await expect(viewerFrame.locator("#connection")).toHaveText("Connected — view only");
  await expect(viewerFrame.locator("#new-card-form button")).toBeDisabled();
  expect(room.connectionCount()).toBe(3);

  await editorFrame.locator("#card-title").fill("Review collaboration security");
  await editorFrame.getByRole("button", { name: "Add card" }).click();
  await expect(editorFrame.locator("#connection")).toHaveText("Connected — editing");
  await expect.poll(() => room.cardTitles()).toContain("Review collaboration security");

  await expect(secondEditorFrame.getByText("Review collaboration security")).toBeVisible();
  await expect(viewerFrame.getByText("Review collaboration security")).toBeVisible();
  await expect(
    viewerFrame.getByRole("button", { name: "Move to In progress" }).last(),
  ).toBeDisabled();

  await secondEditorFrame.getByRole("button", { name: "Move to In progress" }).last().click();

  await expect(
    editorFrame
      .locator('.lane[aria-labelledby="lane-doing"]')
      .getByText("Review collaboration security"),
  ).toBeVisible();
  await expect(
    viewerFrame
      .locator('.lane[aria-labelledby="lane-doing"]')
      .getByText("Review collaboration security"),
  ).toBeVisible();
  await context.close();
});

type MockRoom = {
  connect(socket: WebSocketRoute, role: CollaborationRole): void;
  connectionCount(): number;
  cardTitles(): string[];
};

function createMockRoom(): MockRoom {
  let state: JsonObject = {};
  let revision = 0;
  const clients = new Map<WebSocketRoute, CollaborationRole>();

  function snapshot(socket: WebSocketRoute, role: CollaborationRole) {
    socket.send(JSON.stringify({ type: "snapshot", state, revision, mode: role }));
  }

  function broadcast(message: unknown) {
    for (const socket of clients.keys()) socket.send(JSON.stringify(message));
  }

  return {
    connectionCount() {
      return clients.size;
    },
    cardTitles() {
      const cards = isJsonObject(state.cards) ? Object.values(state.cards) : [];
      return cards.flatMap((card) =>
        isJsonObject(card) && typeof card.title === "string" ? [card.title] : [],
      );
    },
    connect(socket, role) {
      clients.set(socket, role);
      snapshot(socket, role);
      socket.onClose(() => clients.delete(socket));
      socket.onMessage((raw) => {
        if (typeof raw !== "string" || role !== "edit") return;
        const message = JSON.parse(raw) as {
          type: "initialize" | "transact";
          requestId: string;
          state?: JsonObject;
          operations?: CollaborationOperation[];
        };
        if (message.type === "initialize" && Object.keys(state).length === 0 && message.state) {
          state = structuredClone(message.state);
          revision += 1;
          socket.send(JSON.stringify({ type: "ack", requestId: message.requestId, revision }));
          for (const [client, clientRole] of clients) snapshot(client, clientRole);
        } else if (message.type === "transact" && message.operations) {
          state = applyOperations(state, message.operations);
          revision += 1;
          socket.send(JSON.stringify({ type: "ack", requestId: message.requestId, revision }));
          broadcast({ type: "update", operations: message.operations, revision });
        } else {
          socket.send(JSON.stringify({ type: "ack", requestId: message.requestId, revision }));
        }
      });
    },
  };
}

async function routeCollaborativePage(
  context: BrowserContext,
  pageId: string,
  capability: string,
  fixture: string,
  room: MockRoom,
) {
  await context.route(`**/api/pages/${pageId}`, (route) =>
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
  await context.route(`**/api/pages/${pageId}/content`, (route) =>
    route.fulfill({ status: 200, contentType: "text/html", body: fixture }),
  );
  await context.route(`**/api/pages/${pageId}/collaboration-ticket`, async (route) => {
    const body = route.request().postDataJSON() as { capability?: string };
    const role: CollaborationRole = body.capability === capability ? "edit" : "view";
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        ticket: role === "edit" ? "editor-ticket" : "viewer-ticket",
        websocketUrl: `ws://127.0.0.1:5173/__collaboration/${pageId}`,
        role,
      }),
    });
  });
  await context.routeWebSocket(`ws://127.0.0.1:5173/__collaboration/${pageId}`, (socket) => {
    const role = socket.protocols().includes("editor-ticket") ? "edit" : "view";
    room.connect(socket, role);
  });
}

function applyOperations(state: JsonObject, operations: CollaborationOperation[]): JsonObject {
  const next = structuredClone(state);
  for (const operation of operations) {
    let target: JsonObject = next;
    for (const segment of operation.path.slice(0, -1)) {
      const child = target[segment];
      if (!isJsonObject(child)) target[segment] = {};
      target = target[segment] as JsonObject;
    }
    const key = operation.path.at(-1)!;
    if (operation.type === "delete") delete target[key];
    else target[key] = structuredClone(operation.value);
  }
  return next;
}

function isJsonObject(value: JsonValue | undefined): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
