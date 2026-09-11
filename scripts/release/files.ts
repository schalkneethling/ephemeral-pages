import { readFile, stat } from "node:fs/promises";

import type { z } from "zod/v4";

const MAX_JSON_BYTES = 1024 * 1024;

export class ReleaseFileError extends Error {
  constructor() {
    super("Release input file is missing or invalid.");
    this.name = "ReleaseFileError";
  }
}

export async function readReleaseJson<T>(path: string, schema: z.ZodType<T>): Promise<T> {
  try {
    const metadata = await stat(path);
    if (!metadata.isFile() || metadata.size > MAX_JSON_BYTES) throw new ReleaseFileError();
    const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
    const result = schema.safeParse(parsed);
    if (!result.success) throw new ReleaseFileError();
    return result.data;
  } catch (error) {
    if (error instanceof ReleaseFileError) throw error;
    throw new ReleaseFileError();
  }
}
