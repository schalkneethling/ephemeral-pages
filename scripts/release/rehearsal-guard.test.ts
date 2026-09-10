import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { withRehearsalGuard } from "./rehearsal-guard.ts";
it("blocks a different output directory after an unresolved operation", async () => {
  const root = await mkdtemp(join(tmpdir(), "rehearsal-guard-"));
  try {
    let mutations = 0;
    const run = () =>
      withRehearsalGuard(
        join(root, "guard"),
        "candidate",
        join(root, String(mutations)),
        async () => {
          mutations += 1;
          throw new Error("ambiguous");
        },
      );
    await expect(run()).rejects.toThrow("ambiguous");
    await expect(run()).rejects.toThrow("unresolved");
    expect(mutations).toBe(1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
it("permits a subsequent run only after a passed rehearsal", async () => {
  const root = await mkdtemp(join(tmpdir(), "rehearsal-guard-"));
  try {
    await withRehearsalGuard(join(root, "guard"), "candidate", "first", async () => ({
      outcome: "passed" as const,
    }));
    await expect(
      withRehearsalGuard(join(root, "guard"), "next", "second", async () => ({
        outcome: "blocked" as const,
      })),
    ).resolves.toEqual({ outcome: "blocked" });
    await expect(
      withRehearsalGuard(join(root, "guard"), "next", "third", async () => ({
        outcome: "passed" as const,
      })),
    ).rejects.toThrow("unresolved");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
