import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, it } from "vitest";
import { z } from "zod/v4";

import { readReleaseJson, ReleaseFileError } from "./files.ts";

it("reads schema-validated release JSON and rejects oversized input", async () => {
  const directory = await mkdtemp(join(tmpdir(), "release-file-"));
  const validPath = join(directory, "valid.json");
  const oversizedPath = join(directory, "oversized.json");
  try {
    await writeFile(validPath, '{"candidate":"a"}\n', "utf8");
    await writeFile(oversizedPath, "x".repeat(1024 * 1024 + 1), "utf8");

    await expect(
      readReleaseJson(validPath, z.strictObject({ candidate: z.literal("a") })),
    ).resolves.toEqual({
      candidate: "a",
    });
    await expect(readReleaseJson(oversizedPath, z.unknown())).rejects.toBeInstanceOf(
      ReleaseFileError,
    );
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});
