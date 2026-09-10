import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { copyFile, lstat, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

export const GITLEAKS_VERSION = "8.30.0";
const MAX_OUTPUT = 16 * 1024 * 1024;
const SAFE_ENV_NAMES = ["HOME", "LANG", "LC_ALL", "PATH", "SystemRoot", "TMPDIR"];

function safeEnvironment(environment = process.env) {
  return Object.fromEntries(
    SAFE_ENV_NAMES.flatMap((name) => (environment[name] ? [[name, environment[name]]] : [])),
  );
}

export function scanArguments(mode, target, config, ignore, logOptions) {
  return [
    mode,
    "--config",
    config,
    "--gitleaks-ignore-path",
    ignore,
    "--redact=100",
    "--report-format=template",
    "--report-template",
    join(dirname(config), ".gitleaks-report.tmpl"),
    "--report-path=-",
    "--log-level=error",
    "--no-banner",
    "--no-color",
    "--ignore-gitleaks-allow",
    "--timeout=120",
    ...(logOptions ? ["--log-opts", logOptions] : []),
    target,
  ];
}

function execute(binary, args, options = {}) {
  const result = spawnSync(binary, args, {
    cwd: options.cwd,
    encoding: "utf8",
    env: safeEnvironment(options.environment),
    input: options.input,
    maxBuffer: MAX_OUTPUT,
    timeout: 150_000,
  });
  return {
    error: result.error,
    status: result.status,
    stdout: result.stdout ?? "",
  };
}

function parseFindings(output) {
  if (output.trim() === "") return [];
  const parsed = JSON.parse(output);
  if (!Array.isArray(parsed)) throw new Error("Gitleaks returned an invalid report");
  return parsed;
}

export function sanitizeFindings(findings, root, limit = 20) {
  return findings.slice(0, limit).map((finding) => {
    const rawFile = typeof finding.File === "string" ? finding.File : "unknown";
    const file = isAbsolute(rawFile) ? relative(root, rawFile) : rawFile;
    const fingerprint =
      typeof finding.Fingerprint === "string"
        ? finding.Fingerprint.replace(rawFile, file)
        : undefined;
    return {
      rule: typeof finding.RuleID === "string" ? finding.RuleID : "unknown",
      file,
      line: Number.isSafeInteger(finding.StartLine) ? finding.StartLine : undefined,
      ...(typeof finding.Commit === "string" && finding.Commit !== ""
        ? { commit: finding.Commit }
        : {}),
      ...(fingerprint ? { fingerprint } : {}),
    };
  });
}

export async function copyGitFiles(root, destination, git = "git") {
  const listed = execute(git, ["ls-files", "-co", "--exclude-standard", "-z"], { cwd: root });
  if (listed.error || listed.status !== 0) throw new Error("Unable to list repository files");
  const paths = listed.stdout.split("\0").filter(Boolean);
  for (const path of paths) {
    const source = resolve(root, path);
    const relativeSource = relative(root, source);
    if (relativeSource.startsWith(`..${sep}`) || relativeSource === "..") {
      throw new Error("Git returned a path outside the repository");
    }
    let metadata;
    try {
      metadata = await lstat(source);
    } catch (error) {
      if (error && typeof error === "object" && error.code === "ENOENT") continue;
      throw error;
    }
    if (!metadata.isFile()) continue;
    const target = join(destination, relativeSource);
    await mkdir(dirname(target), { recursive: true });
    await copyFile(source, target);
  }
  return paths.length;
}

function checkScan(result, label) {
  let findings;
  try {
    findings = parseFindings(result.stdout);
  } catch {
    throw new Error(`${label} scan returned an unreadable report`);
  }
  if (findings.length > 0) return findings;
  if (result.error || result.status !== 0) throw new Error(`${label} scan failed`);
  return findings;
}

function verifyBinary(binary, config, ignore, root) {
  const version = execute(binary, ["version"], { cwd: root });
  if (version.error || version.status !== 0 || version.stdout.trim() !== GITLEAKS_VERSION) {
    throw new Error(`Gitleaks ${GITLEAKS_VERSION} is required`);
  }

  // Generated at runtime so the scanner does not exempt a committed canary.
  const githubCanary = ["gh", "p_", randomBytes(18).toString("hex")].join("");
  const collaborationCanary = randomBytes(32).toString("hex");
  const result = execute(binary, scanArguments("stdin", "", config, ignore).slice(0, -1), {
    cwd: root,
    input: [
      `credential = "${githubCanary}"`,
      `"STAGE_COLLABORATION_TICKET_SECRET": "${collaborationCanary}"`,
      "",
    ].join("\n"),
  });
  let findings = [];
  try {
    findings = parseFindings(result.stdout);
  } catch {
    // Report details are deliberately discarded below.
  }
  const rules = new Set(findings.map((finding) => finding.RuleID));
  if (
    result.status !== 1 ||
    !rules.has("github-pat") ||
    !rules.has("ephemeral-pages-collaboration-secret") ||
    result.stdout.includes(githubCanary) ||
    result.stdout.includes(collaborationCanary)
  ) {
    throw new Error("Gitleaks detection/redaction canary failed");
  }
}

export async function scanRepository({
  root = process.cwd(),
  binary = process.env.GITLEAKS_BIN || "gitleaks",
} = {}) {
  root = resolve(root);
  const config = join(root, ".gitleaks.toml");
  const ignore = join(root, ".gitleaksignore");
  verifyBinary(binary, config, ignore, root);

  const history = checkScan(
    execute(binary, scanArguments("git", root, config, ignore, "--all"), { cwd: root }),
    "History",
  );

  const mirror = await mkdtemp(join(tmpdir(), "ephemeral-pages-gitleaks-"));
  let worktree;
  try {
    await copyGitFiles(root, mirror);
    worktree = checkScan(
      execute(binary, scanArguments("dir", mirror, config, ignore), { cwd: root }),
      "Worktree",
    );
  } finally {
    await rm(mirror, { recursive: true, force: true });
  }

  const findings = [...sanitizeFindings(history, root), ...sanitizeFindings(worktree, mirror)];
  return {
    ok: findings.length === 0,
    version: GITLEAKS_VERSION,
    historyFindings: history.length,
    worktreeFindings: worktree.length,
    findings,
    truncated: history.length + worktree.length > findings.length,
  };
}

async function main() {
  try {
    const result = await scanRepository();
    console.log(JSON.stringify(result));
    process.exitCode = result.ok ? 0 : 1;
  } catch {
    console.log(
      JSON.stringify({
        ok: false,
        stage: "error",
        error: "Secret scan could not complete",
      }),
    );
    process.exitCode = 2;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
