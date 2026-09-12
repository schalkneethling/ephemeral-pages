import { createHash } from "node:crypto";
import { constants } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { createRequire } from "node:module";
import { basename, dirname, isAbsolute, posix, relative, resolve, sep } from "node:path";

import {
  zipFunctions,
  type Config as NetlifyFunctionsConfig,
  type FunctionResult,
  type Manifest as NetlifyFunctionsManifest,
  type TrafficRules,
} from "@netlify/zip-it-and-ship-it";

import { prepareNetlifyDeployConfiguration } from "./netlify-deploy-config.ts";

const NETLIFY_CLI_VERSION = "27.5.0";
const ZIP_IT_AND_SHIP_IT_VERSION = "15.5.1";
const HEADERS_PATH = "_headers";
const INVENTORY_PATH = "inventory.json";
const FUNCTIONS_MANIFEST_PATH = "functions/manifest.json";
const ZIP_LOCAL_FILE_HEADER = 0x04034b50;
const ZIP_CENTRAL_DIRECTORY_HEADER = 0x02014b50;
const ZIP_END_OF_CENTRAL_DIRECTORY = 0x06054b50;
const ZIP_END_MINIMUM_BYTES = 22;
const ZIP_MAX_COMMENT_BYTES = 65_535;
const UNIX_FILE_TYPE_MASK = 0o170000;
const UNIX_SYMBOLIC_LINK = 0o120000;
const require = createRequire(import.meta.url);

export type NetlifyArtifactLimits = {
  maxFiles: number;
  maxFileBytes: number;
  maxTotalBytes: number;
  maxZipEntries: number;
};

export type PrepareNetlifyArtifactsInput = {
  artifactDirectory: string;
  repositoryRoot: string;
  publishDirectory: string;
  userFunctionsDirectory: string;
  generatedFunctionDirectories?: readonly string[];
  functionConfig?: NetlifyFunctionsConfig;
  functionConfigDirectories?: readonly string[];
  limits?: Partial<NetlifyArtifactLimits>;
};

export type NetlifyArtifactFile = {
  relativePath: string;
  bytes: number;
  sha256: string;
};

export type NetlifyFunctionArtifact = NetlifyArtifactFile & {
  name: string;
  runtime: string;
  runtimeVersion?: string;
  invocationMode?: "background" | "buffer" | "stream";
  timeout?: number;
};

export type NetlifyFunctionSchedule = {
  name: string;
  cron: string;
};

export type NetlifyFunctionConfig = {
  /** API wire keys match netlify-cli's `hash-fns` transformation. */
  display_name?: string;
  excluded_routes?: readonly unknown[];
  generator?: string;
  build_data?: {
    bootstrapVersion?: string;
    runtimeAPIVersion?: number;
  };
  memory?: number;
  priority?: number;
  region?: string;
  routes?: readonly unknown[];
  traffic_rules?: {
    action: {
      type?: string;
      config: {
        rate_limit_config: {
          algorithm?: string;
          window_size?: number;
          window_limit?: number;
        };
        aggregate?: TrafficRules["action"]["config"]["aggregate"];
        to?: string;
      };
    };
  };
  vcpu?: number;
};

export type NetlifyDeployConfigurationArtifact = {
  file: NetlifyArtifactFile;
  sha1: string;
};

export type NetlifyArtifactInventory = {
  schemaVersion: 1;
  netlifyCliVersion: typeof NETLIFY_CLI_VERSION;
  zipItAndShipItVersion: typeof ZIP_IT_AND_SHIP_IT_VERSION;
  headers: NetlifyArtifactFile;
  deployConfiguration: NetlifyDeployConfigurationArtifact;
  staticFiles: readonly NetlifyArtifactFile[];
  functions: readonly NetlifyFunctionArtifact[];
  functionSchedules: readonly NetlifyFunctionSchedule[];
  functionsConfig: Readonly<Record<string, NetlifyFunctionConfig>>;
  functionsManifest: NetlifyArtifactFile;
};

export type PreparedNetlifyArtifacts = {
  artifactDirectory: string;
  inventory: NetlifyArtifactInventory;
  inventorySha256: string;
};

export class NetlifyArtifactError extends Error {
  readonly kind: "bounds" | "invalid-input" | "invalid-output" | "state";

  constructor(kind: NetlifyArtifactError["kind"], cause?: unknown) {
    super(
      "Netlify artifacts could not be prepared or verified safely.",
      cause instanceof Error ? { cause } : undefined,
    );
    this.name = "NetlifyArtifactError";
    this.kind = kind;
  }
}

const DEFAULT_LIMITS: NetlifyArtifactLimits = {
  maxFiles: 20_000,
  maxFileBytes: 64 * 1024 * 1024,
  maxTotalBytes: 512 * 1024 * 1024,
  maxZipEntries: 50_000,
};

const SHA256 = /^[0-9a-f]{64}$/u;
const FUNCTION_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/u;

const isInside = (parent: string, child: string): boolean => {
  const candidate = relative(parent, child);
  return candidate === "" || (candidate !== ".." && !candidate.startsWith(`..${sep}`));
};

const normalizeRelativePath = (path: string): string => {
  const normalized = path.split(sep).join("/");
  if (
    normalized.length === 0 ||
    normalized.startsWith("/") ||
    normalized.includes("\\") ||
    normalized.includes("\0") ||
    normalized.split("/").some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    throw new NetlifyArtifactError("invalid-output");
  }
  return normalized;
};

const boundedInteger = (value: number): boolean =>
  Number.isSafeInteger(value) && value > 0 && value <= Number.MAX_SAFE_INTEGER;

const resolveLimits = (
  input: Partial<NetlifyArtifactLimits> | undefined,
): NetlifyArtifactLimits => {
  const limits = { ...DEFAULT_LIMITS, ...input };
  if (
    !boundedInteger(limits.maxFiles) ||
    !boundedInteger(limits.maxFileBytes) ||
    !boundedInteger(limits.maxTotalBytes) ||
    !boundedInteger(limits.maxZipEntries) ||
    limits.maxFileBytes > limits.maxTotalBytes
  ) {
    throw new NetlifyArtifactError("invalid-input");
  }
  return limits;
};

const hash = (contents: Uint8Array): string => createHash("sha256").update(contents).digest("hex");

const hashSha1 = (contents: Uint8Array): string =>
  createHash("sha1").update(contents).digest("hex");

const readRegularFile = async (path: string, maximumBytes: number): Promise<Buffer> => {
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const metadata = await handle.stat();
    if (!metadata.isFile() || metadata.size > maximumBytes) {
      throw new NetlifyArtifactError("bounds");
    }
    const contents = await handle.readFile();
    if (contents.byteLength !== metadata.size) throw new NetlifyArtifactError("state");
    return contents;
  } catch (error) {
    if (error instanceof NetlifyArtifactError) throw error;
    throw new NetlifyArtifactError("invalid-input");
  } finally {
    await handle?.close().catch(() => undefined);
  }
};

type TreeFile = {
  absolutePath: string;
  relativePath: string;
  bytes: number;
  sha256: string;
};

const collectTree = async (
  root: string,
  limits: NetlifyArtifactLimits,
  copyRoot?: string,
): Promise<TreeFile[]> => {
  const files: TreeFile[] = [];
  let totalBytes = 0;
  const visit = async (directory: string, relativeDirectory: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      throw new NetlifyArtifactError("invalid-input");
    }
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const sourcePath = resolve(directory, entry.name);
      const relativePath = normalizeRelativePath(
        relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name,
      );
      if (entry.isSymbolicLink()) throw new NetlifyArtifactError("invalid-input");
      if (entry.isDirectory()) {
        if (copyRoot) await mkdir(resolve(copyRoot, relativePath), { mode: 0o700 });
        await visit(sourcePath, relativePath);
        continue;
      }
      if (!entry.isFile()) throw new NetlifyArtifactError("invalid-input");
      if (files.length >= limits.maxFiles) throw new NetlifyArtifactError("bounds");
      const contents = await readRegularFile(sourcePath, limits.maxFileBytes);
      totalBytes += contents.byteLength;
      if (totalBytes > limits.maxTotalBytes) throw new NetlifyArtifactError("bounds");
      if (copyRoot) {
        await writeFile(resolve(copyRoot, relativePath), contents, {
          flag: "wx",
          mode: 0o600,
        });
      }
      files.push({
        absolutePath: sourcePath,
        relativePath,
        bytes: contents.byteLength,
        sha256: hash(contents),
      });
    }
  };
  await visit(root, "");
  return files;
};

const assertDirectory = async (path: string): Promise<string> => {
  try {
    const metadata = await stat(path);
    const linkMetadata = await lstat(path);
    if (!metadata.isDirectory() || linkMetadata.isSymbolicLink()) throw new Error();
    return await realpath(path);
  } catch {
    throw new NetlifyArtifactError("invalid-input");
  }
};

const assertPinnedPackage = async (name: string, expectedVersion: string): Promise<void> => {
  try {
    const manifest = JSON.parse(
      await readFile(require.resolve(`${name}/package.json`), "utf8"),
    ) as {
      version?: unknown;
    };
    if (manifest.version !== expectedVersion) throw new Error();
  } catch {
    throw new NetlifyArtifactError("invalid-input");
  }
};

const zipEntryName = (value: Buffer): string => {
  const name = value.toString("utf8");
  const path = name.endsWith("/") ? name.slice(0, -1) : name;
  if (
    path.length === 0 ||
    path.startsWith("/") ||
    /^[A-Za-z]:/u.test(path) ||
    path.includes("\\") ||
    path.includes("\0") ||
    !Buffer.from(name, "utf8").equals(value) ||
    path.split("/").some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    throw new NetlifyArtifactError("invalid-output");
  }
  return path;
};

const validateZip = (contents: Buffer, maximumEntries: number): void => {
  if (contents.length < ZIP_END_MINIMUM_BYTES) {
    throw new NetlifyArtifactError("invalid-output");
  }
  const minimumOffset = Math.max(
    0,
    contents.length - ZIP_END_MINIMUM_BYTES - ZIP_MAX_COMMENT_BYTES,
  );
  let endOffset = -1;
  for (let offset = contents.length - ZIP_END_MINIMUM_BYTES; offset >= minimumOffset; offset -= 1) {
    if (contents.readUInt32LE(offset) === ZIP_END_OF_CENTRAL_DIRECTORY) {
      endOffset = offset;
      break;
    }
  }
  if (endOffset < 0) throw new NetlifyArtifactError("invalid-output");
  const disk = contents.readUInt16LE(endOffset + 4);
  const centralDisk = contents.readUInt16LE(endOffset + 6);
  const entriesOnDisk = contents.readUInt16LE(endOffset + 8);
  const entries = contents.readUInt16LE(endOffset + 10);
  const centralSize = contents.readUInt32LE(endOffset + 12);
  const centralOffset = contents.readUInt32LE(endOffset + 16);
  const commentBytes = contents.readUInt16LE(endOffset + 20);
  if (
    disk !== 0 ||
    centralDisk !== 0 ||
    entries !== entriesOnDisk ||
    entries === 0 ||
    entries === 0xffff ||
    entries > maximumEntries ||
    endOffset + ZIP_END_MINIMUM_BYTES + commentBytes !== contents.length ||
    centralOffset + centralSize !== endOffset
  ) {
    throw new NetlifyArtifactError("invalid-output");
  }
  const names = new Set<string>();
  const symbolicLinks: Array<{ name: string; target: string }> = [];
  let offset = centralOffset;
  for (let index = 0; index < entries; index += 1) {
    if (offset + 46 > endOffset || contents.readUInt32LE(offset) !== ZIP_CENTRAL_DIRECTORY_HEADER) {
      throw new NetlifyArtifactError("invalid-output");
    }
    const madeBy = contents.readUInt16LE(offset + 4) >>> 8;
    const flags = contents.readUInt16LE(offset + 8);
    const compressionMethod = contents.readUInt16LE(offset + 10);
    const compressedBytes = contents.readUInt32LE(offset + 20);
    const uncompressedBytes = contents.readUInt32LE(offset + 24);
    const nameBytes = contents.readUInt16LE(offset + 28);
    const extraBytes = contents.readUInt16LE(offset + 30);
    const entryCommentBytes = contents.readUInt16LE(offset + 32);
    const externalAttributes = contents.readUInt32LE(offset + 38);
    const localOffset = contents.readUInt32LE(offset + 42);
    const nextOffset = offset + 46 + nameBytes + extraBytes + entryCommentBytes;
    if (
      (flags & 1) !== 0 ||
      nextOffset > endOffset ||
      localOffset + 30 > centralOffset ||
      contents.readUInt32LE(localOffset) !== ZIP_LOCAL_FILE_HEADER
    ) {
      throw new NetlifyArtifactError("invalid-output");
    }
    const centralName = contents.subarray(offset + 46, offset + 46 + nameBytes);
    const localFlags = contents.readUInt16LE(localOffset + 6);
    const localNameBytes = contents.readUInt16LE(localOffset + 26);
    const localExtraBytes = contents.readUInt16LE(localOffset + 28);
    const localNameStart = localOffset + 30;
    const localNameEnd = localNameStart + localNameBytes;
    const localDataStart = localNameEnd + localExtraBytes;
    if (
      localFlags !== flags ||
      localDataStart + compressedBytes > centralOffset ||
      !contents.subarray(localNameStart, localNameEnd).equals(centralName)
    ) {
      throw new NetlifyArtifactError("invalid-output");
    }
    const name = zipEntryName(centralName);
    if (names.has(name)) throw new NetlifyArtifactError("invalid-output");
    names.add(name);
    if (
      (madeBy === 3 && (externalAttributes >>> 16) & UNIX_FILE_TYPE_MASK) === UNIX_SYMBOLIC_LINK
    ) {
      const targetBytes = contents.subarray(localDataStart, localDataStart + compressedBytes);
      const target = targetBytes.toString("utf8");
      if (
        compressionMethod !== 0 ||
        compressedBytes !== uncompressedBytes ||
        target.length === 0 ||
        target.includes("\\") ||
        target.includes("\0") ||
        /^[A-Za-z]:/u.test(target) ||
        posix.isAbsolute(target) ||
        !Buffer.from(target, "utf8").equals(targetBytes)
      ) {
        throw new NetlifyArtifactError("invalid-output");
      }
      symbolicLinks.push({ name, target });
    }
    offset = nextOffset;
  }
  if (offset !== endOffset) throw new NetlifyArtifactError("invalid-output");
  const archivePaths = new Set(names);
  for (const name of names) {
    let parent = posix.dirname(name);
    while (parent !== ".") {
      archivePaths.add(parent);
      parent = posix.dirname(parent);
    }
  }
  const linkTargets = new Map<string, string>();
  for (const link of symbolicLinks) {
    const target = posix.normalize(posix.join(posix.dirname(link.name), link.target));
    if (
      target === "." ||
      target === link.name ||
      target === ".." ||
      target.startsWith("../") ||
      !archivePaths.has(target)
    ) {
      throw new NetlifyArtifactError("invalid-output");
    }
    linkTargets.set(link.name, target);
  }
  for (const start of linkTargets.keys()) {
    const visited = new Set<string>();
    let current: string | undefined = start;
    while (current !== undefined) {
      if (visited.has(current)) throw new NetlifyArtifactError("invalid-output");
      visited.add(current);
      current = linkTargets.get(current);
    }
  }
};

const artifactFile = async (
  artifactDirectory: string,
  relativePath: string,
  limits: NetlifyArtifactLimits,
): Promise<NetlifyArtifactFile> => {
  const contents = await readRegularFile(
    resolve(artifactDirectory, relativePath),
    limits.maxFileBytes,
  );
  return { relativePath, bytes: contents.byteLength, sha256: hash(contents) };
};

const compareFiles = (
  actual: readonly NetlifyArtifactFile[],
  expected: readonly NetlifyArtifactFile[],
) =>
  actual.length === expected.length &&
  actual.every(
    (file, index) =>
      file.relativePath === expected[index]?.relativePath &&
      file.bytes === expected[index]?.bytes &&
      file.sha256 === expected[index]?.sha256,
  );

const assertAggregateBounds = (
  files: readonly Pick<NetlifyArtifactFile, "bytes">[],
  limits: NetlifyArtifactLimits,
): void => {
  if (
    files.length > limits.maxFiles ||
    files.reduce((total, file) => total + file.bytes, 0) > limits.maxTotalBytes
  ) {
    throw new NetlifyArtifactError("bounds");
  }
};

// This is the pinned CLI's `trafficRulesConfig` function from
// `dist/utils/deploy/hash-fns.js`, kept here so the upload adapter receives the
// same wire shape as `netlify deploy`.
const toNetlifyTrafficRules = (
  trafficRules: TrafficRules | undefined,
): NetlifyFunctionConfig["traffic_rules"] | undefined => {
  if (!trafficRules) return undefined;
  return {
    action: {
      type: trafficRules.action?.type,
      config: {
        rate_limit_config: {
          algorithm: trafficRules.action?.config?.rateLimitConfig?.algorithm,
          window_size: trafficRules.action?.config?.rateLimitConfig?.windowSize,
          window_limit: trafficRules.action?.config?.rateLimitConfig?.windowLimit,
        },
        aggregate: trafficRules.action?.config?.aggregate,
        to: trafficRules.action?.config?.to,
      },
    },
  };
};

/**
 * Maps ZISI's post-pack result to the exact snake_case `functions_config`
 * request body used by pinned netlify-cli 27.5.0. Call this only after zipping:
 * ZISI supplies the build-data and route metadata at that point.
 */
export const toNetlifyDeployFunctionConfig = (
  result: FunctionResult,
): NetlifyFunctionConfig | undefined => {
  const buildData = result.buildData ?? {
    bootstrapVersion: result.bootstrapVersion,
    runtimeAPIVersion: result.runtimeAPIVersion,
  };
  // Keep this filter byte-for-byte equivalent in meaning to the CLI's
  // `hash-fns` filter. It intentionally does not include excluded_routes alone.
  if (
    !(
      result.displayName ||
      result.generator ||
      result.routes ||
      buildData ||
      result.priority ||
      result.trafficRules ||
      result.region ||
      result.memory ||
      result.vcpu
    )
  ) {
    return undefined;
  }
  return {
    display_name: result.displayName,
    excluded_routes: result.excludedRoutes,
    generator: result.generator,
    memory: result.memory,
    region: result.region,
    routes: result.routes,
    build_data: buildData,
    priority: result.priority,
    traffic_rules: toNetlifyTrafficRules(result.trafficRules),
    vcpu: result.vcpu,
  };
};

const validateFunctionResults = async (
  artifactDirectory: string,
  results: readonly FunctionResult[],
  limits: NetlifyArtifactLimits,
): Promise<{
  functions: NetlifyFunctionArtifact[];
  functionSchedules: NetlifyFunctionSchedule[];
  functionsConfig: Readonly<Record<string, NetlifyFunctionConfig>>;
}> => {
  if (results.length === 0) throw new NetlifyArtifactError("invalid-output");
  const names = new Set<string>();
  const functions: NetlifyFunctionArtifact[] = [];
  const functionSchedules: NetlifyFunctionSchedule[] = [];
  const functionsConfig: Record<string, NetlifyFunctionConfig> = {};
  for (const result of results) {
    if (
      !FUNCTION_NAME.test(result.name) ||
      names.has(result.name) ||
      !["container", "go", "js", "rs"].includes(result.runtime) ||
      !isAbsolute(result.path) ||
      !isInside(resolve(artifactDirectory, "functions"), result.path) ||
      basename(result.path) !== `${result.name}.zip`
    ) {
      throw new NetlifyArtifactError("invalid-output");
    }
    names.add(result.name);
    const relativePath = normalizeRelativePath(relative(artifactDirectory, result.path));
    const contents = await readRegularFile(result.path, limits.maxFileBytes);
    if (result.size !== contents.byteLength) throw new NetlifyArtifactError("invalid-output");
    validateZip(contents, limits.maxZipEntries);
    const invocationMode = result.invocationMode;
    if (
      invocationMode !== undefined &&
      invocationMode !== "background" &&
      invocationMode !== "buffer" &&
      invocationMode !== "stream"
    ) {
      throw new NetlifyArtifactError("invalid-output");
    }
    if (
      result.timeout !== undefined &&
      (!Number.isInteger(result.timeout) || result.timeout <= 0)
    ) {
      throw new NetlifyArtifactError("invalid-output");
    }
    const artifact: NetlifyFunctionArtifact = {
      name: result.name,
      runtime: result.runtime,
      relativePath,
      bytes: contents.byteLength,
      sha256: hash(contents),
      ...(result.runtimeVersion ? { runtimeVersion: result.runtimeVersion } : {}),
      ...(invocationMode ? { invocationMode } : {}),
      ...(result.timeout ? { timeout: result.timeout } : {}),
    };
    functions.push(artifact);
    if (result.schedule) functionSchedules.push({ name: result.name, cron: result.schedule });
    const config = toNetlifyDeployFunctionConfig(result);
    if (config) functionsConfig[result.name] = config;
  }
  return {
    functions: functions.sort((left, right) => left.name.localeCompare(right.name)),
    functionSchedules: functionSchedules.sort((left, right) => left.name.localeCompare(right.name)),
    functionsConfig,
  };
};

const validateFunctionsManifest = async (
  path: string,
  functions: readonly NetlifyFunctionArtifact[],
  limits: NetlifyArtifactLimits,
): Promise<void> => {
  const contents = await readRegularFile(path, limits.maxFileBytes);
  let manifest: NetlifyFunctionsManifest;
  try {
    manifest = JSON.parse(contents.toString("utf8")) as NetlifyFunctionsManifest;
  } catch {
    throw new NetlifyArtifactError("invalid-output");
  }
  if (
    manifest.version !== 1 ||
    !Number.isFinite(manifest.timestamp) ||
    !Array.isArray(manifest.functions) ||
    manifest.functions.length !== functions.length
  ) {
    throw new NetlifyArtifactError("invalid-output");
  }
  const expectedByName = new Map(functions.map((func) => [func.name, func]));
  for (const func of manifest.functions) {
    const expected = expectedByName.get(func.name);
    if (
      !expected ||
      !isAbsolute(func.path) ||
      resolve(func.path) !== resolve(dirname(path), `${func.name}.zip`) ||
      func.runtime !== expected.runtime
    ) {
      throw new NetlifyArtifactError("invalid-output");
    }
    expectedByName.delete(func.name);
  }
  if (expectedByName.size !== 0) throw new NetlifyArtifactError("invalid-output");
};

/**
 * ZISI's on-disk manifest records source-machine absolute `path` and `mainFile`
 * values. Validate that manifest first, then replace it with this portable
 * inventory view before freezing the artifact directory.
 */
const portableFunctionsManifestContents = (metadata: {
  functions: readonly NetlifyFunctionArtifact[];
  functionSchedules: readonly NetlifyFunctionSchedule[];
  functionsConfig: Readonly<Record<string, NetlifyFunctionConfig>>;
}): Buffer => {
  const schedules = new Map(
    metadata.functionSchedules.map((schedule) => [schedule.name, schedule.cron]),
  );
  return Buffer.from(
    `${JSON.stringify({
      version: 1,
      functions: metadata.functions.map((func) => ({
        name: func.name,
        runtime: func.runtime,
        ...(func.runtimeVersion ? { runtimeVersion: func.runtimeVersion } : {}),
        ...(func.invocationMode ? { invocationMode: func.invocationMode } : {}),
        ...(func.timeout ? { timeout: func.timeout } : {}),
        ...(schedules.has(func.name) ? { schedule: schedules.get(func.name) } : {}),
        ...(metadata.functionsConfig[func.name]?.build_data
          ? { buildData: metadata.functionsConfig[func.name].build_data }
          : {}),
      })),
      functions_config: metadata.functionsConfig,
    })}\n`,
    "utf8",
  );
};

const freezeTree = async (root: string): Promise<void> => {
  const visit = async (directory: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile()) await chmod(path, 0o400);
      else throw new NetlifyArtifactError("invalid-output");
    }
    await chmod(directory, 0o500);
  };
  await visit(root);
};

const makeTreeWritable = async (root: string): Promise<void> => {
  const visit = async (path: string): Promise<void> => {
    const metadata = await lstat(path);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) return;
    await chmod(path, 0o700);
    const entries = await readdir(path, { withFileTypes: true });
    await Promise.all(
      entries
        .filter((entry) => entry.isDirectory())
        .map((entry) => visit(resolve(path, entry.name))),
    );
  };
  await visit(root).catch(() => undefined);
};

const inventoryContents = (inventory: NetlifyArtifactInventory): Buffer =>
  Buffer.from(`${JSON.stringify(inventory)}\n`, "utf8");

export async function prepareNetlifyArtifacts(
  input: PrepareNetlifyArtifactsInput,
): Promise<PreparedNetlifyArtifacts> {
  const limits = resolveLimits(input.limits);
  const repositoryRoot = await assertDirectory(resolve(input.repositoryRoot));
  const publishDirectory = await assertDirectory(resolve(input.publishDirectory));
  const userFunctionsDirectory = await assertDirectory(resolve(input.userFunctionsDirectory));
  const generatedFunctionDirectories = await Promise.all(
    (input.generatedFunctionDirectories ?? []).map((path) => assertDirectory(resolve(path))),
  );
  const functionConfigDirectories = await Promise.all(
    (input.functionConfigDirectories ?? []).map((path) => assertDirectory(resolve(path))),
  );
  const artifactDirectory = resolve(input.artifactDirectory);
  if (
    !isInside(repositoryRoot, userFunctionsDirectory) ||
    [...generatedFunctionDirectories, ...functionConfigDirectories].some(
      (path) => !isInside(repositoryRoot, path),
    ) ||
    [publishDirectory, userFunctionsDirectory, ...generatedFunctionDirectories].some(
      (path) => isInside(path, artifactDirectory) || isInside(artifactDirectory, path),
    )
  ) {
    throw new NetlifyArtifactError("invalid-input");
  }
  await assertPinnedPackage("netlify-cli", NETLIFY_CLI_VERSION);
  await assertPinnedPackage("@netlify/zip-it-and-ship-it", ZIP_IT_AND_SHIP_IT_VERSION);
  const deployConfiguration = await prepareNetlifyDeployConfiguration({
    repositoryRoot,
    publishDirectory,
  });
  let artifactCreated = false;
  try {
    await mkdir(artifactDirectory, { mode: 0o700 });
    artifactCreated = true;
    const publishOutput = resolve(artifactDirectory, "publish");
    const functionsOutput = resolve(artifactDirectory, "functions");
    const deployOutput = resolve(artifactDirectory, "deploy");
    await mkdir(publishOutput, { mode: 0o700 });
    await mkdir(functionsOutput, { mode: 0o700 });
    await mkdir(deployOutput, { mode: 0o700 });
    await writeFile(
      resolve(artifactDirectory, deployConfiguration.artifact.relativePath),
      deployConfiguration.artifact.contents,
      {
        flag: "wx",
        mode: 0o600,
      },
    );
    const deployConfigFile = await artifactFile(
      artifactDirectory,
      deployConfiguration.artifact.relativePath,
      limits,
    );
    if (
      deployConfigFile.bytes !== deployConfiguration.artifact.bytes ||
      hashSha1(deployConfiguration.artifact.contents) !== deployConfiguration.artifact.sha1
    ) {
      throw new NetlifyArtifactError("state");
    }
    const staticTree = await collectTree(publishDirectory, limits, publishOutput);
    const staticFiles = staticTree.map(({ relativePath, bytes, sha256 }) => ({
      relativePath: `publish/${relativePath}`,
      bytes,
      sha256,
    }));
    const headers = staticFiles.find(
      ({ relativePath }) => relativePath === `publish/${HEADERS_PATH}`,
    );
    if (!headers || headers.bytes === 0) throw new NetlifyArtifactError("invalid-input");
    const sourceBefore = await Promise.all(
      [userFunctionsDirectory, ...generatedFunctionDirectories].map((path) =>
        collectTree(path, limits),
      ),
    );
    assertAggregateBounds(sourceBefore.flat(), limits);
    const results = await zipFunctions(
      {
        generated: { directories: generatedFunctionDirectories },
        user: { directories: [userFunctionsDirectory] },
      },
      functionsOutput,
      {
        basePath: repositoryRoot,
        config: input.functionConfig ?? deployConfiguration.functionConfig,
        configFileDirectories: functionConfigDirectories,
        manifest: resolve(artifactDirectory, FUNCTIONS_MANIFEST_PATH),
        parallelLimit: 1,
        repositoryRoot,
      },
    );
    const sourceAfter = await Promise.all(
      [userFunctionsDirectory, ...generatedFunctionDirectories].map((path) =>
        collectTree(path, limits),
      ),
    );
    if (
      sourceBefore.some(
        (files, index) =>
          !compareFiles(
            files.map(({ relativePath, bytes, sha256 }) => ({ relativePath, bytes, sha256 })),
            sourceAfter[index]?.map(({ relativePath, bytes, sha256 }) => ({
              relativePath,
              bytes,
              sha256,
            })) ?? [],
          ),
      )
    ) {
      throw new NetlifyArtifactError("state");
    }
    const functionMetadata = await validateFunctionResults(artifactDirectory, results, limits);
    const functionsManifestPath = resolve(artifactDirectory, FUNCTIONS_MANIFEST_PATH);
    await validateFunctionsManifest(functionsManifestPath, functionMetadata.functions, limits);
    await writeFile(functionsManifestPath, portableFunctionsManifestContents(functionMetadata), {
      flag: "w",
      mode: 0o600,
    });
    const functionsManifest = await artifactFile(
      artifactDirectory,
      FUNCTIONS_MANIFEST_PATH,
      limits,
    );
    const inventory: NetlifyArtifactInventory = {
      schemaVersion: 1,
      netlifyCliVersion: NETLIFY_CLI_VERSION,
      zipItAndShipItVersion: ZIP_IT_AND_SHIP_IT_VERSION,
      headers,
      deployConfiguration: {
        file: deployConfigFile,
        sha1: deployConfiguration.artifact.sha1,
      },
      staticFiles,
      functions: functionMetadata.functions,
      functionSchedules: functionMetadata.functionSchedules,
      functionsConfig: functionMetadata.functionsConfig,
      functionsManifest,
    };
    const serializedInventory = inventoryContents(inventory);
    assertAggregateBounds(
      [
        ...staticFiles,
        deployConfigFile,
        ...functionMetadata.functions,
        functionsManifest,
        { bytes: serializedInventory.byteLength },
      ],
      limits,
    );
    if (serializedInventory.byteLength > limits.maxFileBytes) {
      throw new NetlifyArtifactError("bounds");
    }
    await writeFile(resolve(artifactDirectory, INVENTORY_PATH), serializedInventory, {
      flag: "wx",
      mode: 0o600,
    });
    await freezeTree(artifactDirectory);
    const prepared = {
      artifactDirectory,
      inventory,
      inventorySha256: hash(serializedInventory),
    };
    await verifyNetlifyArtifacts(prepared, limits);
    return prepared;
  } catch (error) {
    if (artifactCreated) {
      await makeTreeWritable(artifactDirectory);
      await rm(artifactDirectory, { force: true, recursive: true }).catch(() => undefined);
    }
    if (error instanceof NetlifyArtifactError) throw error;
    throw new NetlifyArtifactError("invalid-output");
  }
}

const verifyNetlifyArtifactsUnsafe = async (
  prepared: PreparedNetlifyArtifacts,
  requestedLimits?: Partial<NetlifyArtifactLimits>,
  requireImmutableModes = true,
): Promise<void> => {
  const limits = resolveLimits(requestedLimits);
  const artifactDirectory = resolve(prepared.artifactDirectory);
  const inventoryPath = resolve(artifactDirectory, INVENTORY_PATH);
  const rootEntries = await readdir(artifactDirectory, { withFileTypes: true }).catch((error) => {
    throw new NetlifyArtifactError("state", error);
  });
  if (
    rootEntries.length !== 4 ||
    !rootEntries.some((entry) => entry.name === INVENTORY_PATH && entry.isFile()) ||
    !rootEntries.some((entry) => entry.name === "publish" && entry.isDirectory()) ||
    !rootEntries.some((entry) => entry.name === "functions" && entry.isDirectory()) ||
    !rootEntries.some((entry) => entry.name === "deploy" && entry.isDirectory()) ||
    rootEntries.some((entry) => entry.isSymbolicLink())
  ) {
    throw new NetlifyArtifactError("state");
  }
  const inventory = await readRegularFile(inventoryPath, limits.maxFileBytes);
  if (
    !SHA256.test(prepared.inventorySha256) ||
    hash(inventory) !== prepared.inventorySha256 ||
    !inventory.equals(inventoryContents(prepared.inventory))
  ) {
    throw new NetlifyArtifactError("state");
  }
  const actualStatic = (await collectTree(resolve(artifactDirectory, "publish"), limits)).map(
    ({ relativePath, bytes, sha256 }) => ({
      relativePath: `publish/${relativePath}`,
      bytes,
      sha256,
    }),
  );
  if (!compareFiles(actualStatic, prepared.inventory.staticFiles)) {
    throw new NetlifyArtifactError("state");
  }
  const deployConfig = await artifactFile(
    artifactDirectory,
    prepared.inventory.deployConfiguration.file.relativePath,
    limits,
  );
  if (
    !compareFiles([deployConfig], [prepared.inventory.deployConfiguration.file]) ||
    hashSha1(
      await readRegularFile(
        resolve(artifactDirectory, deployConfig.relativePath),
        limits.maxFileBytes,
      ),
    ) !== prepared.inventory.deployConfiguration.sha1
  ) {
    throw new NetlifyArtifactError("state");
  }
  const functionEntries = await readdir(resolve(artifactDirectory, "functions"), {
    withFileTypes: true,
  });
  const expectedFunctionPaths = new Set([
    FUNCTIONS_MANIFEST_PATH,
    ...prepared.inventory.functions.map(({ relativePath }) => relativePath),
  ]);
  const actualFunctionPaths = new Set(
    functionEntries.map(({ name }) => `functions/${normalizeRelativePath(name)}`),
  );
  if (
    functionEntries.some((entry) => !entry.isFile() || entry.isSymbolicLink()) ||
    actualFunctionPaths.size !== expectedFunctionPaths.size ||
    [...actualFunctionPaths].some((path) => !expectedFunctionPaths.has(path))
  ) {
    throw new NetlifyArtifactError("state");
  }
  for (const func of prepared.inventory.functions) {
    const contents = await readRegularFile(
      resolve(artifactDirectory, func.relativePath),
      limits.maxFileBytes,
    );
    validateZip(contents, limits.maxZipEntries);
    if (contents.byteLength !== func.bytes || hash(contents) !== func.sha256) {
      throw new NetlifyArtifactError("state");
    }
  }
  const functionsManifest = await artifactFile(artifactDirectory, FUNCTIONS_MANIFEST_PATH, limits);
  if (!compareFiles([functionsManifest], [prepared.inventory.functionsManifest])) {
    throw new NetlifyArtifactError("state");
  }
  const paths = [
    inventoryPath,
    ...actualStatic.map(({ relativePath }) => resolve(artifactDirectory, relativePath)),
    resolve(artifactDirectory, prepared.inventory.deployConfiguration.file.relativePath),
    ...[...expectedFunctionPaths].map((path) => resolve(artifactDirectory, path)),
  ];
  if (requireImmutableModes) {
    for (const path of paths) {
      const metadata = await stat(path);
      if ((metadata.mode & 0o222) !== 0) throw new NetlifyArtifactError("state");
    }
  }
  for (const path of [
    artifactDirectory,
    resolve(artifactDirectory, "deploy"),
    resolve(artifactDirectory, "publish"),
    resolve(artifactDirectory, "functions"),
  ]) {
    const metadata = await lstat(path);
    if (
      !metadata.isDirectory() ||
      metadata.isSymbolicLink() ||
      (requireImmutableModes && (metadata.mode & 0o222) !== 0)
    ) {
      throw new NetlifyArtifactError("state");
    }
  }
  assertAggregateBounds(
    [
      ...actualStatic,
      deployConfig,
      ...prepared.inventory.functions,
      functionsManifest,
      { bytes: inventory.byteLength },
    ],
    limits,
  );
};

export async function verifyNetlifyArtifacts(
  prepared: PreparedNetlifyArtifacts,
  requestedLimits?: Partial<NetlifyArtifactLimits>,
): Promise<void> {
  try {
    await verifyNetlifyArtifactsUnsafe(prepared, requestedLimits);
  } catch (error) {
    if (error instanceof NetlifyArtifactError) throw error;
    throw new NetlifyArtifactError("state", error);
  }
}

export async function restoreExtractedNetlifyArtifacts(
  prepared: PreparedNetlifyArtifacts,
  requestedLimits?: Partial<NetlifyArtifactLimits>,
): Promise<void> {
  try {
    // GitHub artifact extraction deliberately creates private writable files.
    // Validate every retained path and byte before restoring immutable modes.
    await verifyNetlifyArtifactsUnsafe(prepared, requestedLimits, false);
    await freezeTree(resolve(prepared.artifactDirectory));
    await verifyNetlifyArtifactsUnsafe(prepared, requestedLimits);
  } catch (error) {
    if (error instanceof NetlifyArtifactError) throw error;
    throw new NetlifyArtifactError("state", error);
  }
}
