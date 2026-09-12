import { describe, expect, it } from "vitest";

import { ReleaseUsageError } from "./args.ts";
import { parseRecoveryArguments } from "./recovery-args.ts";

describe("recovery arguments", () => {
  it("parses a fresh recovery source without accepting target overrides", () => {
    expect(
      parseRecoveryArguments(
        ["--recovery-source-run-id", "101", "--workspace", "../recovery-output"],
        "/repo/root",
      ),
    ).toEqual({
      recoverySourceRunId: 101,
      workspace: "/repo/recovery-output",
    });
  });

  it("parses a resumed recovery as a distinct run identity", () => {
    expect(
      parseRecoveryArguments(
        [
          "--recovery-source-run-id",
          "101",
          "--resume-recovery-run-id",
          "110",
          "--workspace",
          "/tmp/recovery-output",
        ],
        "/repo/root",
      ),
    ).toEqual({
      recoverySourceRunId: 101,
      resumeRecoveryRunId: 110,
      workspace: "/tmp/recovery-output",
    });
  });

  const invalidArguments: readonly (readonly string[])[] = [
    [],
    ["--recovery-source-run-id", "1", "--workspace", "/tmp/out", "extra"],
    ["--recovery-source-run-id", "0", "--workspace", "/tmp/out"],
    ["--recovery-source-run-id", "01", "--workspace", "/tmp/out"],
    ["--recovery-source-run-id", "1.5", "--workspace", "/tmp/out"],
    ["--recovery-source-run-id", "1", "--resume-recovery-run-id", "1", "--workspace", "/tmp/out"],
    ["--recovery-source-run-id", "2", "--resume-recovery-run-id", "1", "--workspace", "/tmp/out"],
    ["--recovery-source-run-id", "1", "--recovery-source-run-id", "2", "--workspace", "/tmp/out"],
    ["--recovery-source-run-id", "1", "--workspace", "/tmp/a", "--workspace", "/tmp/b"],
    ["--recovery-source-run-id", "1", "--site-id", "site", "--workspace", "/tmp/out"],
    ["--recovery-source-run-id", "1", "--workspace", ""],
  ];

  it.each(invalidArguments.map((args) => [args] as const))(
    "rejects incomplete, duplicate, or unsupported input",
    (args) => {
      expect(() => parseRecoveryArguments(args, "/repo/root")).toThrow(ReleaseUsageError);
    },
  );
});
