import { z } from "zod/v4";

export const environmentSchema = z.enum(["staging", "production"]);
export const fullCommitSchema = z.string().regex(/^[0-9a-f]{40}$/u);

const identifierSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/u);
const variableNameSchema = z.string().regex(/^[A-Z][A-Z0-9_]*$/u);
const expectedVariablesSchema = z.record(variableNameSchema, z.string().max(2_048));
const requiredSecretNamesSchema = z
  .array(variableNameSchema)
  .max(128)
  .refine((names) => new Set(names).size === names.length);
const netlifyVariableScopeSchema = z.enum(["builds", "functions", "runtime", "post-processing"]);

export const netlifyTargetSchema = z
  .strictObject({
    siteId: identifierSchema,
    accountId: identifierSchema,
    expectedNonSecretVariables: expectedVariablesSchema,
    requiredSecretNames: requiredSecretNamesSchema,
    requiredVariableScopes: z.record(
      variableNameSchema,
      z.array(netlifyVariableScopeSchema).min(1).max(4),
    ),
  })
  .superRefine((target, context) => {
    if (target.requiredSecretNames.some((name) => name in target.expectedNonSecretVariables)) {
      context.addIssue({
        code: "custom",
        message: "Netlify variables cannot be both secret and non-secret.",
      });
    }
    const variables = new Set([
      ...Object.keys(target.expectedNonSecretVariables),
      ...target.requiredSecretNames,
    ]);
    const scopedVariables = Object.keys(target.requiredVariableScopes);
    if (
      scopedVariables.length !== variables.size ||
      scopedVariables.some((name) => !variables.has(name)) ||
      Object.values(target.requiredVariableScopes).some(
        (scopes) => new Set(scopes).size !== scopes.length,
      )
    ) {
      context.addIssue({
        code: "custom",
        message: "Netlify variable scopes must uniquely cover every configured variable.",
      });
    }
  });

export const cloudflareTargetSchema = z
  .strictObject({
    accountId: identifierSchema,
    workerName: identifierSchema,
    wranglerEnvironment: identifierSchema,
    wranglerConfigPath: z
      .string()
      .min(1)
      .max(1_024)
      .regex(/^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*$/u)
      .refine((path) => path.split("/").every((part) => part !== "." && part !== "..")),
    expectedNonSecretVariables: expectedVariablesSchema,
    requiredSecretNames: requiredSecretNamesSchema,
  })
  .superRefine((target, context) => {
    if (target.requiredSecretNames.some((name) => name in target.expectedNonSecretVariables)) {
      context.addIssue({
        code: "custom",
        message: "Cloudflare variables cannot be both secret and non-secret.",
      });
    }
  });

const environmentTargetSchema = z.strictObject({
  netlify: netlifyTargetSchema.nullable(),
  cloudflare: cloudflareTargetSchema.nullable(),
});

export const releaseConfigSchema = z.strictObject({
  version: z.literal(1),
  integrationBranch: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._/-]*$/u),
  environments: z.strictObject({
    staging: environmentTargetSchema,
    production: environmentTargetSchema,
  }),
});

export const netlifyBaselineSchema = z.strictObject({
  siteId: identifierSchema,
  sourceCommit: fullCommitSchema.nullable(),
  publishedDeployId: identifierSchema,
  publishLocked: z.boolean(),
});

export const cloudflareTrafficSchema = z.strictObject({
  versionId: identifierSchema,
  percentage: z.number().finite().min(0).max(100),
});

export const cloudflareBaselineSchema = z
  .strictObject({
    accountId: identifierSchema,
    workerName: identifierSchema,
    sourceCommit: fullCommitSchema.nullable(),
    deploymentId: identifierSchema,
    traffic: z.array(cloudflareTrafficSchema).min(1).max(10),
  })
  .superRefine((baseline, context) => {
    const versionIds = baseline.traffic.map(({ versionId }) => versionId);
    const total = baseline.traffic.reduce((sum, { percentage }) => sum + percentage, 0);
    if (
      baseline.traffic.some(({ percentage }) => percentage <= 0) ||
      new Set(versionIds).size !== versionIds.length ||
      Math.abs(total - 100) > 0.000_001
    ) {
      context.addIssue({
        code: "custom",
        message: "Cloudflare traffic must contain unique positive versions totaling 100 percent.",
      });
    }
  });

export const releaseBaselineSchema = z.strictObject({
  version: z.literal(1),
  environment: environmentSchema,
  providers: z.strictObject({
    netlify: netlifyBaselineSchema.nullable(),
    cloudflare: cloudflareBaselineSchema.nullable(),
  }),
});

export type ReleaseEnvironment = z.infer<typeof environmentSchema>;
export type ReleaseConfig = z.infer<typeof releaseConfigSchema>;
export type ReleaseBaseline = z.infer<typeof releaseBaselineSchema>;
export type NetlifyTarget = z.infer<typeof netlifyTargetSchema>;
export type CloudflareTarget = z.infer<typeof cloudflareTargetSchema>;
