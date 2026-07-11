// Progreso EN VIVO para los verbos `mke` — feedback de Santi: los comandos son
// demorados (muchos pasos de red/kubectl) y "parece que no estuviera haciendo
// nada". Este helper es el ÚNICO lugar que decide CÓMO se narra un paso largo;
// los verbos (preview up/merge/down primero, deploy/rollout después) solo lo
// invocan. Reglas duras:
//
//   - Con TTY: spinner + segundos transcurridos en la MISMA línea (\r), que se
//     reemplaza al terminar por `OK label (Ns)` / `FAIL label (Ns)`.
//   - SIN TTY (CI, logs a archivo): nada de \r ni spinner — `label…` al
//     empezar, `OK label (Ns)` al terminar. Los tests corren siempre por esta
//     rama (no hay TTY en `node --test`).
//   - Modo `--json`: NUNCA ensucia stdout (el JSON final es el único stdout
//     válido) — todo esto va a stderr.
//   - Ctrl-C a mitad de un spinner no debe dejar la línea rota: se limpia con
//     el mismo SIGINT handler que se desregistra al terminar.

import { spawnStream } from "./sh.js";
import { ok, bad, dim } from "./sh.js";

const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

export interface PasoOpts {
  /** modo --json del verbo que llama: todo esto va a stderr, nunca a stdout. */
  json?: boolean;
  /** costura de test: inyectar el stream en vez de stdout/stderr real. */
  stream?: NodeJS.WriteStream;
}

function streamPara(opts: PasoOpts): NodeJS.WriteStream {
  return opts.stream ?? (opts.json ? process.stderr : process.stdout);
}

function esTTY(stream: NodeJS.WriteStream): boolean {
  return Boolean(stream.isTTY);
}

const segundosDesde = (inicio: number): number => Math.round((Date.now() - inicio) / 1000);

/**
 * Corre `fn` narrando cuánto lleva. Con TTY: spinner en vivo en la misma
 * línea. Sin TTY: solo el arranque y el cierre. Nunca traga el error de
 * `fn` — lo relanza tras narrar el fallo.
 */
export async function paso<T>(label: string, fn: () => Promise<T>, opts: PasoOpts = {}): Promise<T> {
  const out = streamPara(opts);
  const tty = esTTY(out);
  const inicio = Date.now();
  let frame = 0;
  let timer: NodeJS.Timeout | undefined;

  const limpiarLinea = (): void => {
    if (tty) out.write("\r\x1b[K");
  };
  const restaurar = (): void => {
    if (timer) clearInterval(timer);
    limpiarLinea();
  };
  const onSigint = (): void => {
    restaurar();
    process.exit(130);
  };

  if (tty) {
    process.on("SIGINT", onSigint);
    timer = setInterval(() => {
      out.write(`\r\x1b[K${dim(FRAMES[frame % FRAMES.length])} ${label} ${dim(`(${segundosDesde(inicio)}s)`)}`);
      frame++;
    }, 150);
  } else {
    out.write(`${label}…\n`);
  }

  try {
    const resultado = await fn();
    restaurar();
    out.write(`${ok(`${label} (${segundosDesde(inicio)}s)`)}\n`);
    return resultado;
  } catch (e) {
    restaurar();
    out.write(`${bad(`${label} (${segundosDesde(inicio)}s)`)}\n`);
    throw e;
  } finally {
    if (tty) process.off("SIGINT", onSigint);
  }
}

/**
 * Como `paso`, pero para un comando cuya salida en vivo ES la narración (logs
 * de un exec/build). `correr` recibe un callback de línea y devuelve el exit
 * code (mismo shape que `spawnStream`). Cada línea sale atenuada (dim) con un
 * prefijo `  │ `; al final, `OK/FAIL label (Ns)` según el código.
 */
export async function pasoStream(
  label: string,
  correr: (onLinea: (linea: string) => void) => Promise<number>,
  opts: PasoOpts = {},
): Promise<number> {
  const out = streamPara(opts);
  const inicio = Date.now();
  out.write(`${label}\n`);
  const onLinea = (linea: string): void => {
    out.write(`${dim(`  │ ${linea}`)}\n`);
  };
  const code = await correr(onLinea);
  const etiqueta = `${label} (${segundosDesde(inicio)}s)`;
  out.write(`${code === 0 ? ok(etiqueta) : bad(etiqueta)}\n`);
  return code;
}

/** azúcar de `pasoStream` para el caso común: correr un comando vía spawnStream. */
export function pasoStreamCmd(
  label: string,
  cmd: string,
  args: string[],
  opts: PasoOpts = {},
): Promise<number> {
  return pasoStream(label, (onLinea) => spawnStream(cmd, args, onLinea), opts);
}

/**
 * Corre `esperar` (típicamente un `kubectl rollout status` que puede tardar
 * minutos) NARRANDO en vivo qué hace el pod mientras tanto: sigue `logsArgs`
 * (p.ej. `kubectl logs -f deploy/x -c preparar`) atenuado; si el comando de
 * logs falla (el contenedor aún no arrancó) reintenta cada `reintentoMs`. Se
 * detiene limpio en cuanto `esperar` resuelve — no dos streams sueltos.
 */
export async function esperarConLogs<T>(
  esperar: Promise<T>,
  logsArgs: { cmd: string; args: string[] },
  opts: PasoOpts & { filtrar?: (linea: string) => boolean; reintentoMs?: number } = {},
): Promise<T> {
  const out = streamPara(opts);
  let activo = true;
  const narrar = (async (): Promise<void> => {
    if (opts.json) return;
    while (activo) {
      const code = await spawnStream(logsArgs.cmd, logsArgs.args, (linea) => {
        if (!activo) return;
        if (opts.filtrar && !opts.filtrar(linea)) return;
        out.write(`${dim(`  │ ${linea}`)}\n`);
      });
      if (!activo || code === 0) break;
      await new Promise((r) => setTimeout(r, opts.reintentoMs ?? 2000));
    }
  })();

  const resultado = await esperar;
  activo = false;
  await narrar;
  return resultado;
}
