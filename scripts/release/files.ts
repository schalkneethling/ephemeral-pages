import type { z } from "zod/v4";

import { readBoundedJson } from "./bootstrap-safety.ts";

const MAX_JSON_BYTES = 1024 * 1024;

export class ReleaseFileError extends Error {
  constructor() {
    super("Release input file is missing or invalid.");
    this.name = "ReleaseFileError";
  }
}

export async function readReleaseJson<T>(path: string, schema: z.ZodType<T>): Promise<T> {
  try {
    const parsed = await readBoundedJson(path, MAX_JSON_BYTES, () => new ReleaseFileError());
    const result = schema.safeParse(parsed);
    if (!result.success) throw new ReleaseFileError();
    return result.data;
  } catch (error) {
    if (error instanceof ReleaseFileError) throw error;
    throw new ReleaseFileError();
  }
}
