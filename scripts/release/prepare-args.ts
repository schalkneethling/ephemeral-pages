import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { ReleaseUsageError } from "./args.ts";
import { environmentSchema, fullCommitSchema } from "./schema.ts";
import type { PrepareReleaseInput } from "./prepare.ts";

export function parsePrepareArguments(
  args: readonly string[],
  repositoryRoot: string,
  cwd: string,
): PrepareReleaseInput {
  try {
    const { values, positionals } = parseArgs({
      args,
      strict: true,
      allowPositionals: false,
      options: {
        environment: { type: "string" },
        candidate: { type: "string" },
        output: { type: "string" },
        json: { type: "boolean" },
      },
    });
    if (positionals.length || !values.output) throw new ReleaseUsageError();
    return {
      repositoryRoot,
      environment: environmentSchema.parse(values.environment),
      candidate: fullCommitSchema.parse(values.candidate),
      artifactDirectory: resolve(cwd, values.output),
    };
  } catch {
    throw new ReleaseUsageError();
  }
}
