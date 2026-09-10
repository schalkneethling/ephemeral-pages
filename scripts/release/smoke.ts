import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import type { Browser, BrowserContext, Page } from "@playwright/test";

import { readReleaseJson } from "./files.ts";
import { createSmokeTransport, type SmokeTransport } from "./smoke-transport.ts";
import { configurationFingerprint, type CheckOutcome, type ReleaseCheck } from "./planner.ts";
import {
  environmentSchema,
  releaseConfigSchema,
  type ReleaseConfig,
  type ReleaseEnvironment,
} from "./schema.ts";

const FETCH_TIMEOUT_MS = 30_000;
const BROWSER_TIMEOUT_MS = 30_000;
const PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];
const DIAGNOSTIC_ENVIRONMENT_KEYS = ["DEBUG", "DEBUG_FILE", "PWDEBUG", "PWDEBUGIMPL"] as const;
type BrowserExpect = typeof import("@playwright/test").expect;

export type CollaborationSmokeArguments = {
  environment: ReleaseEnvironment;
  origin: string;
  capture: boolean;
  configPath: string;
  configSource: "default" | "override";
};

export type CollaborationSmokeReport = {
  schemaVersion: 1;
  operation: "collaboration-smoke";
  outcome: CheckOutcome;
  environment: ReleaseEnvironment;
  configuration: {
    source: "default" | "override";
    fingerprint: string;
  };
  checks: readonly ReleaseCheck[];
  retryAfterSeconds?: number;
  usage: {
    uploads: 0 | 1;
    captureRequested: boolean;
    captureRequests: 0 | 1;
  };
};

export type CollaborationSmokePreflight =
  | { ok: true; config: ReleaseConfig }
  | { ok: false; report: CollaborationSmokeReport };

type CreatedPage = {
  id: string;
  collaboration: {
    viewUrl: string;
    editUrl: string;
  };
};

type SmokeFailure = {
  check: ReleaseCheck;
  retryAfterSeconds?: number;
};

export class SmokeUsageError extends Error {
  constructor() {
    super("Invalid collaboration smoke arguments.");
    this.name = "SmokeUsageError";
  }
}

export function parseCollaborationSmokeArguments(
  args: readonly string[],
  { cwd, repositoryRoot }: { cwd: string; repositoryRoot: string },
): CollaborationSmokeArguments {
  let parsed: ReturnType<typeof parseArgs>;
  try {
    parsed = parseArgs({
      args,
      allowPositionals: false,
      strict: true,
      tokens: true,
      options: {
        environment: { type: "string" },
        origin: { type: "string" },
        config: { type: "string" },
        "confirm-external-smoke": { type: "boolean" },
        capture: { type: "boolean" },
      },
    });
  } catch {
    throw new SmokeUsageError();
  }

  if (
    parsed.tokens?.some(
      (token) =>
        token.kind === "option" &&
        parsed.tokens!.filter((item) => item.kind === "option" && item.name === token.name).length >
          1,
    )
  ) {
    throw new SmokeUsageError();
  }
  const environment = environmentSchema.safeParse(parsed.values.environment);
  const origin = parsed.values.origin;
  if (
    !environment.success ||
    typeof origin !== "string" ||
    parsed.values["confirm-external-smoke"] !== true
  ) {
    throw new SmokeUsageError();
  }
  const exactOrigin = parseExactHttpsOrigin(origin);
  if (!exactOrigin) throw new SmokeUsageError();

  const defaultConfigPath = resolve(repositoryRoot, "scripts/release/environments.json");
  const configInput = parsed.values.config;
  const configPath =
    typeof configInput === "string" ? resolve(cwd, configInput) : defaultConfigPath;
  return {
    environment: environment.data,
    origin: exactOrigin,
    capture: parsed.values.capture === true,
    configPath,
    configSource: configPath === defaultConfigPath ? "default" : "override",
  };
}

export async function preflightCollaborationSmoke(
  arguments_: CollaborationSmokeArguments,
): Promise<CollaborationSmokePreflight> {
  let config: ReleaseConfig;
  try {
    config = await readReleaseJson(arguments_.configPath, releaseConfigSchema);
  } catch {
    return {
      ok: false,
      report: blockedReport(arguments_, "config.invalid", "Release configuration is unavailable."),
    };
  }
  const target = config.environments[arguments_.environment];
  if (!target.netlify || !target.cloudflare) {
    return {
      ok: false,
      report: blockedReport(
        arguments_,
        "target.unprovisioned",
        "The selected environment does not have complete deployment targets.",
        config,
      ),
    };
  }
  if (target.netlify.expectedNonSecretVariables.PUBLIC_BASE_URL !== arguments_.origin) {
    return {
      ok: false,
      report: blockedReport(
        arguments_,
        "target.origin",
        "The smoke origin does not match configured PUBLIC_BASE_URL.",
        config,
      ),
    };
  }
  const workerOrigin = target.cloudflare.expectedNonSecretVariables.PUBLIC_WORKER_ORIGIN;
  if (!workerOrigin || !parseExactHttpsOrigin(workerOrigin) || workerOrigin === arguments_.origin) {
    return {
      ok: false,
      report: blockedReport(
        arguments_,
        "target.worker-origin",
        "The selected environment must identify its separate HTTPS Worker origin.",
        config,
      ),
    };
  }
  return { ok: true, config };
}

export async function runCollaborationSmoke(
  arguments_: CollaborationSmokeArguments,
  config: ReleaseConfig,
): Promise<CollaborationSmokeReport> {
  const checks: ReleaseCheck[] = [];
  const usage = {
    uploads: 0 as 0 | 1,
    captureRequested: arguments_.capture,
    captureRequests: 0 as 0 | 1,
  };
  let browser: Browser | undefined;
  let transport: SmokeTransport | undefined;
  const contexts: BrowserContext[] = [];
  let fallback = blocked("upload.request", "The collaborative upload did not complete.");
  let retryAfterSeconds: number | undefined;

  try {
    fallback = blocked(
      "browser.diagnostics",
      "Browser diagnostics must be disabled before running the smoke.",
    );
    if (DIAGNOSTIC_ENVIRONMENT_KEYS.some((key) => Boolean(process.env[key]))) {
      throw new Error();
    }
    const { chromium, expect } = await import("@playwright/test");
    fallback = blocked("browser.transport", "The isolated browser transport could not start.");
    const workerOrigin =
      config.environments[arguments_.environment].cloudflare?.expectedNonSecretVariables
        .PUBLIC_WORKER_ORIGIN;
    if (!workerOrigin) throw new Error();
    transport = await createSmokeTransport(arguments_.origin, workerOrigin);
    fallback = blocked("upload.request", "The collaborative upload did not complete.");
    const created = await createCollaborativePage(arguments_.origin, usage);
    checks.push(passed("upload.collaboration", "One collaborative page was created."));

    fallback = blocked("browser.launch", "The browser smoke could not start.");
    browser = await chromium.launch();
    const editorContext = await browser.newContext({ proxy: { server: transport.proxyServer } });
    const secondEditorContext = await browser.newContext();
    const viewerContext = await browser.newContext();
    editorContext.setDefaultTimeout(BROWSER_TIMEOUT_MS);
    secondEditorContext.setDefaultTimeout(BROWSER_TIMEOUT_MS);
    viewerContext.setDefaultTimeout(BROWSER_TIMEOUT_MS);
    contexts.push(editorContext, secondEditorContext, viewerContext);
    const editor = await editorContext.newPage();
    const secondEditor = await secondEditorContext.newPage();
    const viewer = await viewerContext.newPage();

    await Promise.all([
      editor.goto(created.collaboration.editUrl, {
        waitUntil: "domcontentloaded",
        timeout: BROWSER_TIMEOUT_MS,
      }),
      secondEditor.goto(created.collaboration.editUrl, {
        waitUntil: "domcontentloaded",
        timeout: BROWSER_TIMEOUT_MS,
      }),
      viewer.goto(created.collaboration.viewUrl, {
        waitUntil: "domcontentloaded",
        timeout: BROWSER_TIMEOUT_MS,
      }),
    ]);
    fallback = blocked("roles.editor-viewer", "Editor and viewer roles could not be verified.");
    await verifyRoles(editor, secondEditor, viewer, expect);
    checks.push(passed("roles.editor-viewer", "Editor and viewer roles were enforced."));

    const title = `smoke-${randomUUID()}`;
    fallback = blocked("sync.mutation", "The editor mutation did not reach the viewer.");
    await addCard(editor, title);
    await expect(viewer.frameLocator("#page-iframe").getByText(title)).toBeVisible({
      timeout: BROWSER_TIMEOUT_MS,
    });
    await expect(secondEditor.frameLocator("#page-iframe").getByText(title)).toBeVisible({
      timeout: BROWSER_TIMEOUT_MS,
    });
    const secondEditorFrame = secondEditor.frameLocator("#page-iframe");
    await secondEditorFrame.getByRole("button", { name: "Move to In progress" }).last().click();
    await Promise.all([
      expect(
        editor
          .frameLocator("#page-iframe")
          .locator('.lane[aria-labelledby="lane-doing"]')
          .getByText(title),
      ).toBeVisible({ timeout: BROWSER_TIMEOUT_MS }),
      expect(
        viewer
          .frameLocator("#page-iframe")
          .locator('.lane[aria-labelledby="lane-doing"]')
          .getByText(title),
      ).toBeVisible({ timeout: BROWSER_TIMEOUT_MS }),
    ]);
    checks.push(
      passed(
        "sync.two-editors-viewer",
        "Both editors and the viewer synchronized committed mutations.",
      ),
    );

    fallback = blocked("persistence.reload", "The editor did not recover state after reload.");
    await editor.reload({ waitUntil: "domcontentloaded", timeout: BROWSER_TIMEOUT_MS });
    await expect(editor.frameLocator("#page-iframe").getByText(title)).toBeVisible({
      timeout: BROWSER_TIMEOUT_MS,
    });
    checks.push(
      passed("persistence.reload", "The editor recovered authoritative state after reload."),
    );

    fallback = blocked(
      "recovery.network-loss",
      "The editor did not recover from simulated network loss.",
    );
    const previousWorkerConnections = transport.workerConnections();
    await editorContext.setOffline(true);
    if (transport.interruptWorker() === 0) throw new Error();
    await expect(editor.locator("#collaboration-status")).toHaveText(
      "Collaboration disconnected — reconnecting…",
      { timeout: BROWSER_TIMEOUT_MS },
    );
    transport.resumeWorker();
    await editorContext.setOffline(false);
    await expect
      .poll(() => transport!.workerConnections(), {
        timeout: BROWSER_TIMEOUT_MS,
      })
      .toBeGreaterThan(previousWorkerConnections);
    await expect(editor.locator("#collaboration-status")).toHaveText(
      "Collaboration connected — editing",
      { timeout: BROWSER_TIMEOUT_MS },
    );
    const recoveryTitle = `recovered-${randomUUID()}`;
    await addCard(editor, recoveryTitle);
    await expect(viewer.frameLocator("#page-iframe").getByText(recoveryTitle)).toBeVisible({
      timeout: BROWSER_TIMEOUT_MS,
    });
    checks.push(
      passed("recovery.network-loss", "The editor reconnected and synchronized a fresh mutation."),
    );

    if (arguments_.capture) {
      usage.captureRequests = 1;
      fallback = blocked("capture.request", "The screenshot capture did not complete.");
      await verifyCapture(viewer, created.id, arguments_.origin, expect);
      checks.push(passed("capture.png", "One screenshot capture returned a PNG."));
    }
  } catch (error) {
    const failure = failureCheck(error, fallback);
    checks.push(failure.check);
    retryAfterSeconds = failure.retryAfterSeconds;
  } finally {
    await transport?.close().catch(() => undefined);
    await Promise.allSettled(contexts.map((context) => context.close()));
    await browser?.close().catch(() => undefined);
  }

  return {
    schemaVersion: 1,
    operation: "collaboration-smoke",
    outcome: checks.some((check) => check.outcome === "blocked") ? "blocked" : "passed",
    environment: arguments_.environment,
    configuration: {
      source: arguments_.configSource,
      fingerprint: configurationFingerprint(config),
    },
    checks,
    usage,
    ...(retryAfterSeconds ? { retryAfterSeconds } : {}),
  };
}

async function createCollaborativePage(
  origin: string,
  usage: { uploads: 0 | 1 },
): Promise<CreatedPage> {
  usage.uploads = 1;
  const oidcToken = await requestGitHubOidcToken(origin);
  const html = await readFile(
    new URL("../../tests/fixtures/collaborative-kanban.html", import.meta.url),
    "utf8",
  );
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (oidcToken) headers.Authorization = `Bearer ${oidcToken}`;
  const response = await fetch(`${origin}/api/pages`, {
    method: "POST",
    headers,
    body: JSON.stringify({ html, collaboration: true, expirationHours: 1 }),
    redirect: "error",
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!response.ok) {
    const retryAfterSeconds = retryAfter(response.headers.get("Retry-After"));
    throw smokeFailure(
      response.status === 429 ? "upload.rate-limited" : "upload.request",
      response.status === 429
        ? "The single collaborative upload was rate limited."
        : `The collaborative upload returned HTTP ${response.status}.`,
      retryAfterSeconds,
    );
  }
  const value = (await response.json()) as unknown;
  if (!isCreatedPage(value, origin)) {
    throw smokeFailure("upload.response", "The collaborative upload response was invalid.");
  }
  return value;
}

async function verifyRoles(editor: Page, secondEditor: Page, viewer: Page, expect: BrowserExpect) {
  await Promise.all([
    expect(editor.locator("#collaboration-status")).toHaveText(
      "Collaboration connected — editing",
      {
        timeout: BROWSER_TIMEOUT_MS,
      },
    ),
    expect(secondEditor.locator("#collaboration-status")).toHaveText(
      "Collaboration connected — editing",
      { timeout: BROWSER_TIMEOUT_MS },
    ),
    expect(viewer.locator("#collaboration-status")).toHaveText(
      "Collaboration connected — view only",
      {
        timeout: BROWSER_TIMEOUT_MS,
      },
    ),
    expect(viewer.frameLocator("#page-iframe").locator("#new-card-form button")).toBeDisabled({
      timeout: BROWSER_TIMEOUT_MS,
    }),
  ]);
}

async function addCard(page: Page, title: string) {
  const frame = page.frameLocator("#page-iframe");
  await frame.locator("#card-title").fill(title);
  await frame.getByRole("button", { name: "Add card" }).click();
}

async function verifyCapture(page: Page, pageId: string, origin: string, expect: BrowserExpect) {
  const [response] = await Promise.all([
    page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        new URL(response.url()).pathname === `/api/pages/${encodeURIComponent(pageId)}/screenshots`,
      { timeout: BROWSER_TIMEOUT_MS },
    ),
    page.getByRole("button", { name: "Capture screenshot" }).click(),
  ]);
  if (!response.ok()) {
    const retryAfterSeconds = retryAfter(response.headers()["retry-after"]);
    throw smokeFailure(
      response.status() === 429 ? "capture.rate-limited" : "capture.request",
      response.status() === 429
        ? "The single screenshot capture was rate limited."
        : `The screenshot capture returned HTTP ${response.status()}.`,
      retryAfterSeconds,
    );
  }
  const download = page.locator("#capture-download");
  await expect(download).toBeVisible({ timeout: BROWSER_TIMEOUT_MS });
  const href = await download.getAttribute("href");
  const url = href ? new URL(href, origin) : null;
  const expectedPath = `/api/pages/${encodeURIComponent(pageId)}/screenshots/`;
  if (
    !url ||
    url.origin !== origin ||
    !url.pathname.startsWith(expectedPath) ||
    url.search ||
    url.hash
  ) {
    throw smokeFailure("capture.response", "The screenshot download response was invalid.");
  }
  const png = await fetch(url, {
    redirect: "error",
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  const bytes = new Uint8Array(await png.arrayBuffer());
  if (
    !png.ok ||
    !png.headers.get("Content-Type")?.startsWith("image/png") ||
    !hasPngSignature(bytes)
  ) {
    throw smokeFailure("capture.png", "The screenshot download was not a PNG.");
  }
}

function isCreatedPage(value: unknown, origin: string): value is CreatedPage {
  if (!isRecord(value) || typeof value.id !== "string" || !isRecord(value.collaboration))
    return false;
  if (
    typeof value.collaboration.viewUrl !== "string" ||
    typeof value.collaboration.editUrl !== "string"
  ) {
    return false;
  }
  const path = `/p/${encodeURIComponent(value.id)}`;
  try {
    const view = new URL(value.collaboration.viewUrl);
    const edit = new URL(value.collaboration.editUrl);
    return (
      view.origin === origin &&
      view.pathname === path &&
      !view.search &&
      !view.hash &&
      edit.origin === origin &&
      edit.pathname === path &&
      !edit.search &&
      /^#edit=[A-Za-z0-9_-]{1,32}\.[A-Za-z0-9_-]{43}$/.test(edit.hash)
    );
  } catch {
    return false;
  }
}

function hasPngSignature(bytes: Uint8Array) {
  return PNG_SIGNATURE.every((byte, index) => bytes[index] === byte);
}

function retryAfter(value: string | null | undefined): number | undefined {
  if (!value || !/^\d+$/u.test(value)) return undefined;
  const seconds = Number(value);
  return Number.isSafeInteger(seconds) && seconds > 0 ? seconds : undefined;
}

function parseExactHttpsOrigin(value: string): string | null {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && value === url.origin ? url.origin : null;
  } catch {
    return null;
  }
}

function passed(id: string, summary: string): ReleaseCheck {
  return { id, outcome: "passed", summary };
}

function blocked(id: string, summary: string): ReleaseCheck {
  return { id, outcome: "blocked", summary };
}

function smokeFailure(id: string, summary: string, retryAfterSeconds?: number): SmokeFailure {
  return { check: blocked(id, summary), retryAfterSeconds };
}

function failureCheck(error: unknown, fallback: ReleaseCheck): SmokeFailure {
  if (isSmokeFailure(error)) return error;
  return { check: fallback };
}

function isSmokeFailure(value: unknown): value is SmokeFailure {
  return isRecord(value) && isRecord(value.check) && value.check.outcome === "blocked";
}

function blockedReport(
  arguments_: CollaborationSmokeArguments,
  id: string,
  summary: string,
  config?: ReleaseConfig,
): CollaborationSmokeReport {
  return {
    schemaVersion: 1,
    operation: "collaboration-smoke",
    outcome: "blocked",
    environment: arguments_.environment,
    configuration: {
      source: arguments_.configSource,
      fingerprint: config
        ? configurationFingerprint(config)
        : createHash("sha256").update("invalid").digest("hex"),
    },
    checks: [{ id, outcome: "blocked", summary }],
    usage: { uploads: 0, captureRequested: arguments_.capture, captureRequests: 0 },
  };
}

async function requestGitHubOidcToken(audience: string): Promise<string | null> {
  const requestUrl = process.env.ACTIONS_ID_TOKEN_REQUEST_URL;
  const requestToken = process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
  if (!requestUrl && !requestToken) return null;
  if (!requestUrl || !requestToken)
    throw smokeFailure("authentication.oidc", "OIDC configuration is incomplete.");
  const url = new URL(requestUrl);
  url.searchParams.set("audience", audience);
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${requestToken}` },
    redirect: "error",
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!response.ok)
    throw smokeFailure("authentication.oidc", "OIDC token issuance did not succeed.");
  const value = (await response.json()) as unknown;
  if (!isRecord(value) || typeof value.value !== "string" || value.value.length === 0) {
    throw smokeFailure("authentication.oidc", "OIDC token issuance returned an invalid response.");
  }
  return value.value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
