import { createRemoteJWKSet, errors, jwtVerify, type JWTVerifyGetKey, type JWTPayload } from "jose";

import { captureSecurityEvent, getEnv } from "./security.ts";

const GITHUB_OIDC_ISSUER = "https://token.actions.githubusercontent.com";
const githubJwks = createRemoteJWKSet(new URL(`${GITHUB_OIDC_ISSUER}/.well-known/jwks`));

export type GitHubActionsIdentity = {
  type: "github";
  repositoryId: string;
};

export type UploadIdentity = GitHubActionsIdentity | { type: "anonymous"; ip: string };

export async function resolveUploadIdentity(
  req: Request,
  verify: typeof verifyGitHubOidcToken = verifyGitHubOidcToken,
  configuredAudience = getEnv("GITHUB_OIDC_AUDIENCE"),
): Promise<
  { ok: true; identity: UploadIdentity } | { ok: false; status: 401 | 500; error: string }
> {
  const authorization = req.headers.get("authorization");
  if (!authorization) {
    return { ok: true, identity: { type: "anonymous", ip: clientIp(req) } };
  }

  const match = authorization.match(/^Bearer\s+(\S+)$/i);
  if (!match) {
    oidcFailure("authorization_format");
    return { ok: false, status: 401, error: "Invalid GitHub OIDC token" };
  }

  const audience = configuredAudience;
  if (!audience) {
    return { ok: false, status: 500, error: "GitHub OIDC is not configured" };
  }

  try {
    const identity = await verify(match[1], audience);
    return { ok: true, identity };
  } catch (error) {
    oidcFailure(safeFailureCategory(error));
    return { ok: false, status: 401, error: "Invalid GitHub OIDC token" };
  }
}

export async function verifyGitHubOidcToken(
  token: string,
  audience: string,
  getKey: JWTVerifyGetKey = githubJwks,
): Promise<GitHubActionsIdentity> {
  const { payload } = await jwtVerify(token, getKey, {
    issuer: GITHUB_OIDC_ISSUER,
    audience,
    requiredClaims: ["exp", "nbf"],
  });
  requireClaims(payload, ["repository_id", "repository", "run_id", "run_attempt", "workflow_ref"]);
  return { type: "github", repositoryId: payload.repository_id as string };
}

function requireClaims(payload: JWTPayload, names: string[]): void {
  for (const name of names) {
    if (typeof payload[name] !== "string" || payload[name].trim() === "") {
      throw new Error(`Missing required claim: ${name}`);
    }
  }
}

function safeFailureCategory(error: unknown): string {
  if (error instanceof errors.JWTExpired) return "expired";
  if (error instanceof errors.JWTClaimValidationFailed) return `claim_${error.claim ?? "unknown"}`;
  if (error instanceof errors.JWSSignatureVerificationFailed) return "signature";
  if (error instanceof errors.JOSEError) return "jose";
  return "claims";
}

function oidcFailure(reason: string): void {
  captureSecurityEvent("oidc_validation_failure", "warning", { reason });
}

function clientIp(req: Request): string {
  return (
    req.headers.get("x-nf-client-connection-ip") ??
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    "unknown-ip"
  );
}
