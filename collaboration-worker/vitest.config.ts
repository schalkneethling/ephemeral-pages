import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
  root: import.meta.dirname,
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        // Johannesburg crossed midnight before the Workers runtime's UTC release day.
        // Production remains pinned to 2026-08-23; tests use the newest runtime date available now.
        compatibilityDate: "2026-08-22",
        bindings: {
          TICKET_HMAC_SECRET: "worker-runtime-test-ticket-secret",
          ADMIN_TOKEN: "worker-runtime-test-admin-secret",
        },
      },
    }),
  ],
  test: {
    include: ["test/**/*.test.ts"],
  },
});
