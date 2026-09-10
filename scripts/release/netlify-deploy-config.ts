import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import type { Config as NetlifyFunctionsConfig } from "@netlify/zip-it-and-ship-it";

const cliRequire = createRequire(import.meta.url);
const netlifyCliRequire = createRequire(cliRequire.resolve("netlify-cli/package.json"));

type ResolveConfig = (options: {
  cwd: string;
  repositoryRoot: string;
  context: "production";
  offline: true;
  mode: "cli";
}) => Promise<{ config: unknown }>;

type ParseRedirects = (options: {
  configRedirects: unknown;
  redirectsFiles: readonly string[];
  minimal: true;
}) => Promise<{ redirects: unknown }>;

type ParseHeaders = (options: {
  configHeaders: unknown;
  headersFiles: readonly string[];
  minimal: true;
}) => Promise<{ headers: unknown }>;

type NormalizeFunctionsConfig = (options: {
  functionsConfig: unknown;
  projectRoot: string;
  siteEnv: Record<string, never>;
}) => NetlifyFunctionsConfig;

type Tomlify = {
  toToml(
    value: unknown,
    options: { space: number; replace: (key: string, value: unknown) => string | false },
  ): string;
};

type ResolvedConfig = {
  build?: {
    environment?: unknown;
    services?: unknown;
  };
  functions?: unknown;
  functionsDirectory?: unknown;
  functionsDirectoryOrigin?: unknown;
  headers?: unknown;
  plugins?: unknown;
  redirects?: unknown;
  redirectsOrigin?: unknown;
};

export type NetlifyDeployConfigArtifact = {
  relativePath: "deploy/netlify.toml";
  contents: Buffer;
  bytes: number;
  sha1: string;
};

export type PreparedNetlifyDeployConfiguration = {
  artifact: NetlifyDeployConfigArtifact;
  /**
   * This is consumed only by ZISI while the local ZIPs are produced. It is
   * deliberately absent for the CLI's implicit `{ "*": {} }` default: that
   * default adds host-specific base paths without changing function behavior.
   */
  functionConfig?: NetlifyFunctionsConfig;
};

export class NetlifyDeployConfigError extends Error {
  readonly kind: "invalid-input" | "invalid-output";

  constructor(kind: NetlifyDeployConfigError["kind"]) {
    super("Netlify deploy configuration could not be prepared safely.");
    this.name = "NetlifyDeployConfigError";
    this.kind = kind;
  }
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const sha1 = (contents: Uint8Array): string => createHash("sha1").update(contents).digest("hex");

const loadPinnedModule = async <T>(packageName: string): Promise<T> =>
  (await import(pathToFileURL(netlifyCliRequire.resolve(packageName)).href)) as T;

const assertResolvedConfigIsDeploySafe = (value: unknown): ResolvedConfig => {
  if (!isObject(value)) throw new NetlifyDeployConfigError("invalid-output");
  const allowed = new Set([
    "build",
    "functions",
    "functionsDirectory",
    "functionsDirectoryOrigin",
    "headers",
    "plugins",
    "redirects",
    "redirectsOrigin",
  ]);
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    throw new NetlifyDeployConfigError("invalid-output");
  }
  const config = value as ResolvedConfig;
  if (!isObject(config.build) || !isObject(config.functions) || !Array.isArray(config.plugins)) {
    throw new NetlifyDeployConfigError("invalid-output");
  }
  if (
    config.plugins.length !== 0 ||
    !isObject(config.build.environment) ||
    Object.keys(config.build.environment).length !== 0 ||
    !isObject(config.build.services) ||
    Object.keys(config.build.services).length !== 0
  ) {
    throw new NetlifyDeployConfigError("invalid-input");
  }
  return config;
};

const serializeToml = (tomlify: Tomlify, config: object): Buffer =>
  Buffer.from(
    tomlify.toToml(config, {
      space: 2,
      replace: (_key, value) => (Number.isInteger(value) ? String(value) : false),
    }),
    "utf8",
  );

const hasExplicitFunctionConfiguration = (value: unknown): boolean =>
  isObject(value) &&
  Object.values(value).some((entry) => isObject(entry) && Object.keys(entry).length > 0);

export const prepareNetlifyDeployConfiguration = async (input: {
  repositoryRoot: string;
  publishDirectory: string;
}): Promise<PreparedNetlifyDeployConfiguration> => {
  const repositoryRoot = resolve(input.repositoryRoot);
  const publishDirectory = resolve(input.publishDirectory);
  try {
    const [
      { resolveConfig },
      { parseAllRedirects },
      { parseAllHeaders },
      { normalizeFunctionsConfig },
      tomlifyModule,
    ] = await Promise.all([
      loadPinnedModule<{ resolveConfig: ResolveConfig }>("@netlify/config"),
      loadPinnedModule<{ parseAllRedirects: ParseRedirects }>("@netlify/redirect-parser"),
      loadPinnedModule<{ parseAllHeaders: ParseHeaders }>("@netlify/headers-parser"),
      loadPinnedModule<{ normalizeFunctionsConfig: NormalizeFunctionsConfig }>(
        "netlify-cli/dist/lib/functions/config.js",
      ),
      loadPinnedModule<{ default: Tomlify }>("tomlify-j0.4"),
    ]);
    const resolved = await resolveConfig({
      cwd: repositoryRoot,
      repositoryRoot,
      context: "production",
      offline: true,
      mode: "cli",
    });
    const config = assertResolvedConfigIsDeploySafe(resolved.config);
    const [{ redirects }, { headers }] = await Promise.all([
      parseAllRedirects({
        configRedirects: config.redirects,
        redirectsFiles: [resolve(publishDirectory, "_redirects")],
        minimal: true,
      }),
      parseAllHeaders({
        configHeaders: config.headers,
        headersFiles: [resolve(publishDirectory, "_headers")],
        minimal: true,
      }),
    ]);
    const portableConfig = { redirects, headers };
    const contents = serializeToml(tomlifyModule.default, portableConfig);
    const functionConfig = hasExplicitFunctionConfiguration(config.functions)
      ? normalizeFunctionsConfig({
          functionsConfig: config.functions,
          projectRoot: repositoryRoot,
          // Do not pass the resolved build environment into the packer. It can
          // contain credentials, and the only value the CLI normalizer reads is
          // the non-secret AWS runtime override.
          siteEnv: {},
        })
      : undefined;
    return {
      artifact: {
        relativePath: "deploy/netlify.toml",
        contents,
        bytes: contents.byteLength,
        sha1: sha1(contents),
      },
      functionConfig,
    };
  } catch (error) {
    if (error instanceof NetlifyDeployConfigError) throw error;
    throw new NetlifyDeployConfigError("invalid-input");
  }
};
