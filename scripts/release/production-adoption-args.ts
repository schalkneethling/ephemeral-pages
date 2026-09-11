import { resolve } from "node:path";
import { parseArgs } from "node:util";

import { ReleaseUsageError } from "./args.ts";

export type ProductionAdoptionArguments = {
  promotionPr: number;
  rehearsalRunId: number;
  resumeAdoptionRunId?: number;
  workspace: string;
};

const positiveId = (value: string | undefined): number => {
  if (!value || !/^[1-9][0-9]*$/u.test(value) || !Number.isSafeInteger(Number(value))) {
    throw new ReleaseUsageError();
  }
  return Number(value);
};

export function parseProductionAdoptionArguments(
  args: readonly string[],
  cwd: string,
): ProductionAdoptionArguments {
  try {
    const { values, positionals, tokens } = parseArgs({
      args,
      strict: true,
      allowPositionals: true,
      tokens: true,
      options: {
        "promotion-pr": { type: "string" },
        "rehearsal-run-id": { type: "string" },
        "resume-adoption-run-id": { type: "string" },
        workspace: { type: "string" },
      },
    });
    const names = tokens.filter((token) => token.kind === "option").map((token) => token.name);
    if (
      positionals.length !== 1 ||
      positionals[0] !== "adopt" ||
      names.length !== new Set(names).size ||
      !values.workspace
    ) {
      throw new ReleaseUsageError();
    }
    return {
      promotionPr: positiveId(values["promotion-pr"]),
      rehearsalRunId: positiveId(values["rehearsal-run-id"]),
      ...(values["resume-adoption-run-id"] === undefined
        ? {}
        : { resumeAdoptionRunId: positiveId(values["resume-adoption-run-id"]) }),
      workspace: resolve(cwd, values.workspace),
    };
  } catch {
    throw new ReleaseUsageError();
  }
}
