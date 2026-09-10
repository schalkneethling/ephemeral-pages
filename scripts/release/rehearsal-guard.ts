import { createAtomicJsonStore, withExclusiveFileLock } from "./bootstrap-safety.ts";

type GuardRecord = {
  schemaVersion: 1;
  candidate: string;
  reportDirectory: string;
  outcome: "running" | "passed" | "blocked";
};
export async function withRehearsalGuard<
  T extends { outcome: "passed" | "blocked" | "pending" | "running" | "failed" },
>(
  path: string,
  candidate: string,
  reportDirectory: string,
  operation: () => Promise<T>,
): Promise<T> {
  const error = () =>
    new Error("An unresolved staging rehearsal requires inspection before another run.");
  return withExclusiveFileLock(
    path,
    async () => {
      const store = createAtomicJsonStore<GuardRecord>(path, 16 * 1024, error);
      const previous = await store.load();
      if (previous && (previous.schemaVersion !== 1 || previous.outcome !== "passed"))
        throw error();
      const record: GuardRecord = {
        schemaVersion: 1,
        candidate,
        reportDirectory,
        outcome: "running",
      };
      await store.save(record);
      // An exception deliberately leaves the running guard in place.
      const result = await operation();
      await store.save({ ...record, outcome: result.outcome === "passed" ? "passed" : "blocked" });
      return result;
    },
    error,
  );
}
