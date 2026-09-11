export type Service = "netlify" | "cloudflare";

const documentationPrefixes = ["docs/"];
const documentationFiles = new Set(["CHANGELOG.md", "PR.md", "README.md"]);
const sharedFiles = new Set([
  "bun.lock",
  "package.json",
  "tsconfig.json",
  "vite.config.ts",
  "src/csp.ts",
  "src/domain.ts",
]);

function isDocumentation(path: string) {
  return (
    documentationFiles.has(path) ||
    documentationPrefixes.some((prefix) => path.startsWith(prefix)) ||
    (!path.includes("/") && path.endsWith(".md"))
  );
}

export function affectedServices(paths: readonly string[]): ReadonlySet<Service> {
  const affected = new Set<Service>();
  for (const path of paths) {
    if (isDocumentation(path)) continue;
    if (path.startsWith("collaboration-worker/")) {
      affected.add("cloudflare");
      continue;
    }
    if (
      path.startsWith("netlify/") ||
      path.startsWith("public/") ||
      path === "index.html" ||
      (path.startsWith("src/") && !path.startsWith("src/collaboration/"))
    ) {
      if (sharedFiles.has(path)) affected.add("cloudflare");
      affected.add("netlify");
      continue;
    }
    if (path.startsWith("src/collaboration/") || sharedFiles.has(path)) {
      affected.add("netlify");
      affected.add("cloudflare");
      continue;
    }

    // Unknown non-documentation paths can affect build, packaging, or both runtimes.
    affected.add("netlify");
    affected.add("cloudflare");
  }
  return affected;
}

export function serviceChanged(service: Service, paths: readonly string[]) {
  return affectedServices(paths).has(service);
}
