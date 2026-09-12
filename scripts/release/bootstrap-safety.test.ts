import type { FileHandle } from "node:fs/promises";

import { afterEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ open: vi.fn() }));

vi.mock("node:fs/promises", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:fs/promises")>()),
  open: mocks.open,
}));

import { readBoundedJson } from "./bootstrap-safety.ts";

const metadata = (size: number) =>
  ({ isFile: () => true, size }) as Awaited<ReturnType<FileHandle["stat"]>>;

afterEach(() => {
  mocks.open.mockReset();
});

it("rejects a file that changes through the opened handle while keeping the read bounded", async () => {
  const source = Buffer.from('{"safe":true}');
  const handle = {
    close: vi.fn(async () => undefined),
    read: vi.fn(async (buffer: Buffer, offset: number, length: number, position: number) => {
      const bytesRead = Math.max(0, Math.min(length, source.length - position));
      source.copy(buffer, offset, position, position + bytesRead);
      return { buffer, bytesRead };
    }),
    stat: vi
      .fn()
      .mockResolvedValueOnce(metadata(source.length))
      .mockResolvedValueOnce(metadata(source.length + 1)),
  };
  mocks.open.mockResolvedValue(handle);
  const error = new Error("unsafe release input");

  await expect(readBoundedJson("/untrusted/input.json", 64, () => error)).rejects.toBe(error);

  expect(mocks.open).toHaveBeenCalledOnce();
  expect(handle.read).toHaveBeenCalledWith(expect.any(Buffer), 0, source.length + 1, 0);
  expect(handle.close).toHaveBeenCalledOnce();
});
