import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Corre un comando sin shell. Nunca lanza: devuelve code != 0 en error. */
export async function run(cmd: string, args: string[]): Promise<RunResult> {
  try {
    const { stdout, stderr } = await execFileAsync(cmd, args, {
      maxBuffer: 32 * 1024 * 1024,
    });
    return { code: 0, stdout: stdout.trim(), stderr: stderr.trim() };
  } catch (err) {
    const e = err as { code?: number; stdout?: string; stderr?: string; message?: string };
    return {
      code: typeof e.code === "number" ? e.code : 1,
      stdout: (e.stdout ?? "").trim(),
      stderr: (e.stderr ?? e.message ?? "").trim(),
    };
  }
}

// pintar
const C = {
  reset: "\x1b[0m",
  dim: "\x1b[2m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  cyan: "\x1b[36m",
};
export const ok = (s: string) => `${C.green}OK${C.reset} ${s}`;
export const bad = (s: string) => `${C.red}FAIL${C.reset} ${s}`;
export const warn = (s: string) => `${C.yellow}WARN${C.reset} ${s}`;
export const info = (s: string) => `${C.cyan}•${C.reset} ${s}`;
export const dim = (s: string) => `${C.dim}${s}${C.reset}`;
