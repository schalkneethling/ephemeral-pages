import { resolve } from "node:path";
import { parseArgs } from "node:util";

import { ReleaseUsageError } from "./args.ts";

export type RecoveryArguments = {
  recoverySourceRunId: number;
  resumeRecoveryRunId?: number;
  workspace: string;
};

const positiveRunId = (value: string | undefined): number => {
  if (!value || !/^[1-9][0-9]*$/u.test(value)) throw new ReleaseUsageError();
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new ReleaseUsageError();
  return parsed;
};

export function parseRecoveryArguments(args: readonly string[], cwd: string): RecoveryArguments {
  try {
    const { values, positionals, tokens } = parseArgs({
      args,
      strict: true,
      allowPositionals: false,
      tokens: true,
      options: {
        "recovery-source-run-id": { type: "string" },
        "resume-recovery-run-id": { type: "string" },
        workspace: { type: "string" },
      },
    });
    const names = tokens.filter((token) => token.kind === "option").map((token) => token.name);
    if (positionals.length !== 0 || names.length !== new Set(names).size || !values.workspace) {
      throw new ReleaseUsageError();
    }
    const recoverySourceRunId = positiveRunId(values["recovery-source-run-id"]);
    const resumeRecoveryRunId =
      values["resume-recovery-run-id"] === undefined
        ? undefined
        : positiveRunId(values["resume-recovery-run-id"]);
    if (resumeRecoveryRunId !== undefined && resumeRecoveryRunId <= recoverySourceRunId) {
      throw new ReleaseUsageError();
    }
    return {
      recoverySourceRunId,
      ...(resumeRecoveryRunId === undefined ? {} : { resumeRecoveryRunId }),
      workspace: resolve(cwd, values.workspace),
    };
  } catch {
    throw new ReleaseUsageError();
  }
}
