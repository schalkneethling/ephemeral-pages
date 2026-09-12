import { defineConfig } from "vite-plus";

export default defineConfig({
  staged: {
    "*": "vp check --fix",
  },
  fmt: {
    // Release evidence binds exact bytes; formatting would invalidate retained hashes.
    ignorePatterns: ["docs/release-evidence/**/*.json"],
  },
  lint: { options: { typeAware: true, typeCheck: true } },
  test: {
    exclude: [
      "**/node_modules/**",
      "tests/e2e/**",
      // This suite runs with the official Vitest Cloudflare pool via the dedicated script.
      "collaboration-worker/test/room.runtime.test.ts",
    ],
  },
});
