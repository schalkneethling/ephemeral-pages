import { constants } from "node:fs";
import { open, readFile, rename, unlink } from "node:fs/promises";
import { dirname, resolve } from "node:path";

export const PINNED_PROVIDER_CLI_VERSIONS = {
  "netlify-cli": "27.5.0",
  wrangler: "4.125.0",
} as const;

type SafetyErrorFactory = () => Error;

type LockErrorFactory = (kind: "invalid-input" | "locked") => Error;

export type AtomicJsonStore<T> = {
  load(): Promise<T | null>;
  save(value: T): Promise<void>;
};

const hasErrorCode = (error: unknown, code: string): boolean =>
  typeof error === "object" && error !== null && "code" in error && error.code === code;

export const readBoundedJson = async (
  path: string,
  maxBytes: number,
  createError: SafetyErrorFactory,
): Promise<unknown> => {
  let handle;
  try {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new Error();
    handle = await open(path, constants.O_RDONLY);
    const initial = await handle.stat();
    if (!initial.isFile() || initial.size > maxBytes) throw new Error();
    const bytes = Buffer.alloc(Math.min(initial.size + 1, maxBytes + 1));
    let length = 0;
    while (length < bytes.length) {
      const { bytesRead } = await handle.read(bytes, length, bytes.length - length, length);
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    const final = await handle.stat();
    if (
      !final.isFile() ||
      final.size !== initial.size ||
      final.size !== length ||
      length > maxBytes
    )
      throw new Error();
    const contents = bytes.subarray(0, length).toString("utf8");
    return JSON.parse(contents) as unknown;
  } catch {
    throw createError();
  } finally {
    await handle?.close().catch(() => undefined);
  }
};

export const assertPinnedCliVersions = async (
  root: string,
  packageNames: readonly (keyof typeof PINNED_PROVIDER_CLI_VERSIONS)[],
  createError: SafetyErrorFactory,
): Promise<void> => {
  try {
    for (const packageName of packageNames) {
      const value = JSON.parse(
        await readFile(resolve(root, "node_modules", packageName, "package.json"), "utf8"),
      ) as unknown;
      if (
        typeof value !== "object" ||
        value === null ||
        !("version" in value) ||
        value.version !== PINNED_PROVIDER_CLI_VERSIONS[packageName]
      ) {
        throw new Error();
      }
    }
  } catch {
    throw createError();
  }
};

export const createAtomicJsonStore = <T>(
  path: string,
  maxBytes: number,
  createError: SafetyErrorFactory,
): AtomicJsonStore<T> => ({
  load: async () => {
    try {
      return (await readBoundedJson(path, maxBytes, createError)) as T;
    } catch {
      try {
        const handle = await open(path, constants.O_RDONLY);
        await handle.close();
      } catch (error) {
        if (hasErrorCode(error, "ENOENT")) return null;
      }
      throw createError();
    }
  },
  save: async (value) => {
    const temporaryPath = `${path}.tmp-${process.pid}`;
    let handle;
    let ownsTemporaryPath = false;
    try {
      handle = await open(
        temporaryPath,
        constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
        0o600,
      );
      ownsTemporaryPath = true;
      await handle.writeFile(`${JSON.stringify(value)}\n`, "utf8");
      await handle.sync();
      await handle.close();
      handle = undefined;
      await rename(temporaryPath, path);
      ownsTemporaryPath = false;
      const directory = await open(dirname(path), constants.O_RDONLY);
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
    } catch {
      await handle?.close().catch(() => undefined);
      if (ownsTemporaryPath) await unlink(temporaryPath).catch(() => undefined);
      throw createError();
    }
  },
});

export const withExclusiveFileLock = async <T>(
  path: string,
  operation: () => Promise<T>,
  createError: LockErrorFactory,
): Promise<T> => {
  const lockPath = `${path}.lock`;
  let lock;
  let ownsLockPath = false;
  try {
    lock = await open(lockPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
    ownsLockPath = true;
    await lock.writeFile(`${process.pid}\n`, "utf8");
  } catch (error) {
    await lock?.close().catch(() => undefined);
    if (ownsLockPath) await unlink(lockPath).catch(() => undefined);
    throw createError(hasErrorCode(error, "EEXIST") ? "locked" : "invalid-input");
  }
  try {
    return await operation();
  } finally {
    await lock.close().catch(() => undefined);
    if (ownsLockPath) await unlink(lockPath).catch(() => undefined);
  }
};
