import { spawn } from "node:child_process";

export type CommandResult = {
  exitCode: number | null;
  stdout: string;
};

export type CommandOptions = {
  cwd: string;
  env?: Readonly<Record<string, string>>;
  timeoutMs?: number;
  maxOutputBytes?: number;
};

export class SafeCommandError extends Error {
  readonly kind: "failed" | "spawn" | "timeout" | "output-limit";

  constructor(kind: SafeCommandError["kind"]) {
    super(`Command ${kind}.`);
    this.name = "SafeCommandError";
    this.kind = kind;
  }
}

export async function runCommand(
  executable: string,
  args: readonly string[],
  { cwd, env = {}, timeoutMs = 30_000, maxOutputBytes = 1024 * 1024 }: CommandOptions,
): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const detached = process.platform !== "win32";
    const child = spawn(executable, args, {
      cwd,
      detached,
      env: { ...process.env, ...env },
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const output = { stdout: [] as Buffer[], stderr: [] as Buffer[] };
    let capturedBytes = 0;
    let settled = false;

    const finish = (result: CommandResult | SafeCommandError) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (result instanceof SafeCommandError) reject(result);
      else resolve(result);
    };
    const terminate = () => {
      if (detached && child.pid) {
        try {
          process.kill(-child.pid, "SIGKILL");
          return;
        } catch {
          // Fall back to the direct child if the process group already exited.
        }
      }
      child.kill("SIGKILL");
    };
    const capture = (chunk: Buffer, stream: "stdout" | "stderr") => {
      if (settled) return;
      capturedBytes += chunk.byteLength;
      if (capturedBytes > maxOutputBytes) {
        terminate();
        finish(new SafeCommandError("output-limit"));
      } else {
        output[stream].push(chunk);
      }
    };

    child.stdout.on("data", (chunk: Buffer) => capture(chunk, "stdout"));
    child.stderr.on("data", (chunk: Buffer) => capture(chunk, "stderr"));
    child.once("error", () => finish(new SafeCommandError("spawn")));
    child.once("close", (exitCode) =>
      finish({ exitCode, stdout: Buffer.concat(output.stdout).toString("utf8") }),
    );
    const timer = setTimeout(() => {
      terminate();
      finish(new SafeCommandError("timeout"));
    }, timeoutMs);
  });
}

export function createProviderCommandRunner(options: CommandOptions) {
  return async (executable: string, args: readonly string[], env?: Record<string, string>) => {
    const result = await runCommand(executable, args, { ...options, env });
    if (result.exitCode !== 0) throw new SafeCommandError("failed");
    return result.stdout;
  };
}

export function createDeadlineProviderCommandRunner(options: CommandOptions, budgetMs: number) {
  const deadline = Date.now() + budgetMs;
  return async (executable: string, args: readonly string[], env?: Record<string, string>) => {
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) throw new SafeCommandError("timeout");
    const result = await runCommand(executable, args, {
      ...options,
      env,
      timeoutMs: Math.min(options.timeoutMs ?? remainingMs, remainingMs),
    });
    if (result.exitCode !== 0) throw new SafeCommandError("failed");
    return result.stdout;
  };
}
