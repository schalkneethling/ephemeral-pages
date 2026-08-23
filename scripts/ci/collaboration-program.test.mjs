import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import {
  isCollaborationPullRequest,
  validateCollaborationPullRequest,
} from "./collaboration-program.mjs";

const manifest = JSON.parse(
  await readFile(new URL("../../.github/collaboration-program.json", import.meta.url), "utf8"),
);

const implementation = {
  filename: "collaboration-worker/src/reducer.ts",
  additions: 20,
  deletions: 2,
};
const test = { filename: "collaboration-worker/test/reducer.test.ts", additions: 20, deletions: 0 };
const evidenceFile = {
  filename: ".github/collaboration-evidence/24.json",
  additions: 20,
  deletions: 0,
};
const evidence = {
  issue: 24,
  phase: 2,
  red: {
    testFiles: [test.filename],
    command: "vp test reducer",
    expectedFailure: "unsafe paths are accepted",
    observedFailure: "expected InvalidOperationPathError",
  },
  green: { commands: ["vp test reducer"], result: "passed" },
  refactor: { status: "completed", notes: "centralized path checks", validation: "passed" },
};

describe("collaboration program gate", () => {
  it("accepts one green issue after all dependencies close", () => {
    expect(
      validateCollaborationPullRequest({
        manifest,
        body: "Collaboration-Issue: #24\n\nCloses #24",
        files: [implementation, test, evidenceFile],
        evidence,
        dependencyStates: { 22: "closed", 23: "closed", 25: "closed" },
      }),
    ).toEqual({ applies: true, issue: 24, errors: [] });
  });

  it("rejects combined issues, open dependencies, and unauditable evidence", () => {
    const result = validateCollaborationPullRequest({
      manifest,
      body: "Collaboration-Issue: #24\n\nCloses #24\nCloses #25",
      files: [implementation, evidenceFile],
      evidence: { ...evidence, red: { ...evidence.red, testFiles: [test.filename] } },
      dependencyStates: { 22: "closed", 23: "open", 25: "open" },
    });
    expect(result.errors).toEqual(
      expect.arrayContaining([
        "The PR must close only its declared collaboration issue (#24).",
        "Dependency #23 must be closed before issue #24 can merge.",
        "Dependency #25 must be closed before issue #24 can merge.",
        `Focused red test file must change in this PR: ${test.filename}.`,
      ]),
    );
  });

  it("rejects the shape of the one-pass collaboration PR", () => {
    const files = Array.from({ length: 60 }, (_, index) => ({
      filename: index === 0 ? implementation.filename : `src/collaboration/file-${index}.ts`,
      additions: 100,
      deletions: 0,
    }));
    const result = validateCollaborationPullRequest({
      manifest,
      body: "Closes #20\nCloses #21\nCloses #24\nCloses #31",
      files,
      dependencyStates: {},
      pullRequestNumber: 999,
    });
    expect(result.errors).toEqual([
      "Declare exactly one `Collaboration-Issue: #<number>` in the PR body.",
    ]);
  });

  it("grandfathers only the recorded pre-governance PR", () => {
    expect(
      validateCollaborationPullRequest({
        manifest,
        body: "Closes #20\nCloses #24",
        files: [implementation],
        pullRequestNumber: 33,
      }),
    ).toEqual({
      applies: true,
      exception:
        "The collaboration implementation predates this gate; CodeQL merge protection still applies.",
      errors: [],
    });
  });

  it("does not impose collaboration governance on unrelated changes", () => {
    expect(
      validateCollaborationPullRequest({
        manifest,
        body: "",
        files: [{ filename: "README.md", additions: 1, deletions: 0 }],
      }),
    ).toEqual({ applies: false, errors: [] });
  });

  it("applies collaboration governance when a trigger path is renamed away", () => {
    expect(
      isCollaborationPullRequest(manifest, [
        {
          filename: "archive/reducer.ts",
          previous_filename: "collaboration-worker/src/reducer.ts",
          additions: 0,
          deletions: 0,
        },
      ]),
    ).toBe(true);
  });
});
