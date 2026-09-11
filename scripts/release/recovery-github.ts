import {
  GitHubReleaseError,
  inspectPreviousProductionRun,
  type GitHubReleaseApi,
  type VerifiedProductionArtifact,
  type VerifiedProductionInvocation,
  type VerifiedProductionRun,
} from "./github-release.ts";

export type RecoveryHistoryInput = {
  current: VerifiedProductionInvocation;
  recoverySourceRunId: number;
  resumeRecoveryRunId?: number;
  now?: Date;
};

export type VerifiedRecoveryHistory = {
  mode: "fresh" | "resume";
  currentRunId: number;
  sourceProductionRunId: number;
  resumeRecoveryRunId?: number;
  evidenceRun: VerifiedProductionRun;
  artifact: VerifiedProductionArtifact;
  skippedPreflightRunIds: readonly number[];
};

export async function verifyRecoveryHistory(
  api: GitHubReleaseApi,
  input: RecoveryHistoryInput,
): Promise<VerifiedRecoveryHistory> {
  const result = await inspectPreviousProductionRun(api, {
    current: input.current,
    recovery: {
      sourceProductionRunId: input.recoverySourceRunId,
      ...(input.resumeRecoveryRunId === undefined
        ? {}
        : { resumeRecoveryRunId: input.resumeRecoveryRunId }),
    },
    now: input.now,
  });
  if (
    result.previous === null ||
    result.artifact === undefined ||
    (result.requiredOperation !== "recover-production" &&
      result.requiredOperation !== "resume-recovery")
  ) {
    throw new GitHubReleaseError("resume");
  }
  const resume = result.requiredOperation === "resume-recovery";
  if (resume !== (input.resumeRecoveryRunId !== undefined)) {
    throw new GitHubReleaseError("resume");
  }
  return {
    mode: resume ? "resume" : "fresh",
    currentRunId: input.current.runId,
    sourceProductionRunId: input.recoverySourceRunId,
    ...(input.resumeRecoveryRunId === undefined
      ? {}
      : { resumeRecoveryRunId: input.resumeRecoveryRunId }),
    evidenceRun: result.previous,
    artifact: result.artifact,
    skippedPreflightRunIds: result.skippedActivations.map(({ runId }) => runId),
  };
}
