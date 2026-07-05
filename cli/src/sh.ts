import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * Corre un comando sin shell. Nunca lanza: devuelve code != 0 en error.
 * `input` se escribe al stdin del proceso (p.ej. SQL para `kubectl exec -i ... psql`).
 */
export async function run(cmd: string, args: string[], input?: string): Promise<RunResult> {
  try {
    const child = execFileAsync(cmd, args, { maxBuffer: 32 * 1024 * 1024 });
    if (input !== undefined) {
      child.child.stdin?.end(input);
    }
    const { stdout, stderr } = await child;
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

/**
 * Corre un comando streameando su salida línea a línea (stdout+stderr) al
 * callback. Nunca lanza: resuelve con el exit code. Para narrar procesos
 * largos en vivo (p.ej. los logs del init de un pod de rama).
 */
export function spawnStream(
  cmd: string,
  args: string[],
  onLinea: (linea: string) => void,
): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args);
    let buf = "";
    const comer = (d: Buffer) => {
      buf += d.toString();
      const lineas = buf.split("\n");
      buf = lineas.pop() ?? "";
      for (const l of lineas) if (l.trim()) onLinea(l);
    };
    child.stdout?.on("data", comer);
    child.stderr?.on("data", comer);
    child.on("error", () => resolve(1));
    child.on("close", (code) => {
      if (buf.trim()) onLinea(buf);
      resolve(code ?? 1);
    });
  });
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
