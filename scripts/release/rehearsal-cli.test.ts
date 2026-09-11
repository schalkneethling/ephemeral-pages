import { afterEach, describe, expect, it } from "vitest";

import { rehearsalInspectionEnvironment } from "./rehearsal-cli.ts";

const originalNetlifyToken = process.env.NETLIFY_AUTH_TOKEN;
const originalCloudflareToken = process.env.CLOUDFLARE_API_TOKEN;

afterEach(() => {
  if (originalNetlifyToken === undefined) delete process.env.NETLIFY_AUTH_TOKEN;
  else process.env.NETLIFY_AUTH_TOKEN = originalNetlifyToken;
  if (originalCloudflareToken === undefined) delete process.env.CLOUDFLARE_API_TOKEN;
  else process.env.CLOUDFLARE_API_TOKEN = originalCloudflareToken;
});

describe("rehearsal provider inspection environment", () => {
  it("forwards only the credential for the exact provider executable", () => {
    process.env.NETLIFY_AUTH_TOKEN = "netlify-token";
    process.env.CLOUDFLARE_API_TOKEN = "cloudflare-token";

    const netlify = rehearsalInspectionEnvironment(
      "./node_modules/.bin/netlify",
      "wss://staging.example.test",
    );
    expect(netlify).toMatchObject({
      CI: "true",
      COLLABORATION_WEBSOCKET_URL: "wss://staging.example.test",
      NETLIFY_AUTH_TOKEN: "netlify-token",
    });
    expect(netlify).not.toHaveProperty("CLOUDFLARE_API_TOKEN");

    const cloudflare = rehearsalInspectionEnvironment(
      "./node_modules/.bin/wrangler",
      "wss://staging.example.test",
      { CLOUDFLARE_ACCOUNT_ID: "staging-account" },
    );
    expect(cloudflare).toMatchObject({
      CI: "true",
      CLOUDFLARE_ACCOUNT_ID: "staging-account",
      CLOUDFLARE_API_TOKEN: "cloudflare-token",
      COLLABORATION_WEBSOCKET_URL: "wss://staging.example.test",
    });
    expect(cloudflare).not.toHaveProperty("NETLIFY_AUTH_TOKEN");
  });

  it("rejects unsupported executables, metadata, and credential overrides", () => {
    process.env.NETLIFY_AUTH_TOKEN = "netlify-token";
    process.env.CLOUDFLARE_API_TOKEN = "cloudflare-token";

    expect(() =>
      rehearsalInspectionEnvironment("./node_modules/.bin/unknown", "wss://staging.example.test"),
    ).toThrow("Provider inspection failed.");
    expect(() =>
      rehearsalInspectionEnvironment("./node_modules/.bin/netlify", "wss://staging.example.test", {
        CLOUDFLARE_ACCOUNT_ID: "unexpected",
      }),
    ).toThrow("Provider inspection failed.");
    expect(() =>
      rehearsalInspectionEnvironment("./node_modules/.bin/wrangler", "wss://staging.example.test", {
        CLOUDFLARE_ACCOUNT_ID: "staging-account",
        CLOUDFLARE_API_TOKEN: "untrusted-override",
      }),
    ).toThrow("Provider inspection failed.");
  });

  it("omits an absent token so an existing local CLI login remains usable", () => {
    delete process.env.NETLIFY_AUTH_TOKEN;
    delete process.env.CLOUDFLARE_API_TOKEN;
    const environment = rehearsalInspectionEnvironment(
      "./node_modules/.bin/wrangler",
      "wss://staging.example.test",
      {
        CLOUDFLARE_ACCOUNT_ID: "staging-account",
      },
    );
    expect(environment).not.toHaveProperty("CLOUDFLARE_API_TOKEN");
    expect(environment).not.toHaveProperty("NETLIFY_AUTH_TOKEN");
  });
});
