import { expect, it } from "vitest";
import { parseProductionArguments } from "./production-args.ts";
const flags = [
  "--promotion-pr",
  "50",
  "--rehearsal-run-id",
  "100",
  "--approval-sha256",
  "a".repeat(64),
  "--workspace",
  "/tmp/release",
];
it("parses explicit promotion and resumption without target overrides", () => {
  expect(parseProductionArguments(["promote", ...flags], "/tmp")).toMatchObject({
    operation: "promote",
    promotionPr: 50,
    rehearsalRunId: 100,
    workspace: "/tmp/release",
  });
  expect(
    parseProductionArguments(["resume", ...flags, "--resume-run-id", "101"], "/tmp").resumeRunId,
  ).toBe(101);
});
it.each([
  ["promote", ...flags, "--resume-run-id", "101"],
  ["resume", ...flags],
  ["promote", ...flags, "--promotion-pr", "51"],
  ["promote", ...flags, "--environment", "staging"],
  ["promote", ...flags, "--config", "elsewhere"],
  ["promote", ...flags, "unexpected"],
  ["recover", ...flags],
  ["promote", ...flags.slice(2), "--promotion-pr", "9007199254740992"],
])("rejects invalid or ambiguous arguments %j", (...args) => {
  expect(() => parseProductionArguments(args, "/tmp")).toThrow("Invalid release command arguments");
});
