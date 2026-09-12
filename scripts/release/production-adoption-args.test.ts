import { expect, it } from "vitest";

import { ReleaseUsageError } from "./args.ts";
import { parseProductionAdoptionArguments } from "./production-adoption-args.ts";

it("parses the bounded adoption and resume selectors", () => {
  expect(
    parseProductionAdoptionArguments(
      [
        "adopt",
        "--promotion-pr",
        "12",
        "--rehearsal-run-id",
        "34",
        "--resume-adoption-run-id",
        "56",
        "--workspace",
        "evidence",
      ],
      "/tmp",
    ),
  ).toEqual({
    promotionPr: 12,
    rehearsalRunId: 34,
    resumeAdoptionRunId: 56,
    workspace: "/tmp/evidence",
  });
});

it.each([
  ["adopt", "--promotion-pr", "12", "--rehearsal-run-id", "34"],
  ["promote", "--promotion-pr", "12", "--rehearsal-run-id", "34", "--workspace", "/tmp/x"],
  [
    "adopt",
    "--promotion-pr",
    "12",
    "--promotion-pr",
    "13",
    "--rehearsal-run-id",
    "34",
    "--workspace",
    "/tmp/x",
  ],
  ["adopt", "--promotion-pr", "0", "--rehearsal-run-id", "34", "--workspace", "/tmp/x"],
  [
    "adopt",
    "--promotion-pr",
    "12",
    "--rehearsal-run-id",
    "34",
    "--workspace",
    "/tmp/x",
    "--worker-name",
    "substitute",
  ],
])("rejects incomplete, duplicate, or override arguments", (...args) => {
  expect(() => parseProductionAdoptionArguments(args, "/tmp")).toThrow(ReleaseUsageError);
});
