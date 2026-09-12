import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { ReleaseUsageError } from "./args.ts";
import { digestSchema } from "./production-record.ts";

export type ProductionArguments = {
  operation: "promote" | "resume";
  promotionPr: number;
  rehearsalRunId: number;
  approvalSha256: string;
  resumeRunId?: number;
  workspace: string;
};
const positiveId = (value: string | undefined): number => {
  if (!value || !/^[1-9][0-9]*$/u.test(value) || !Number.isSafeInteger(Number(value)))
    throw new ReleaseUsageError();
  return Number(value);
};
// This parser deliberately offers no target, credential, configuration, source,
// or policy override. GitHub provenance is checked separately before any writes.
export function parseProductionArguments(
  args: readonly string[],
  cwd: string,
): ProductionArguments {
  try {
    const { values, positionals, tokens } = parseArgs({
      args,
      strict: true,
      allowPositionals: true,
      tokens: true,
      options: {
        "promotion-pr": { type: "string" },
        "rehearsal-run-id": { type: "string" },
        "approval-sha256": { type: "string" },
        "resume-run-id": { type: "string" },
        workspace: { type: "string" },
      },
    });
    const names = tokens.filter((token) => token.kind === "option").map((token) => token.name);
    const operation = positionals[0];
    if (
      positionals.length !== 1 ||
      (operation !== "promote" && operation !== "resume") ||
      names.length !== new Set(names).size ||
      !values.workspace ||
      (operation === "resume") !== (values["resume-run-id"] !== undefined)
    )
      throw new ReleaseUsageError();
    return {
      operation,
      promotionPr: positiveId(values["promotion-pr"]),
      rehearsalRunId: positiveId(values["rehearsal-run-id"]),
      approvalSha256: digestSchema.parse(values["approval-sha256"]),
      ...(operation === "resume" ? { resumeRunId: positiveId(values["resume-run-id"]) } : {}),
      workspace: resolve(cwd, values.workspace),
    };
  } catch {
    throw new ReleaseUsageError();
  }
}
