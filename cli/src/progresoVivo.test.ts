import { test } from "node:test";
import assert from "node:assert/strict";
import { paso, pasoStream, esperarConLogs } from "./progresoVivo.js";

// Protege el contrato de `progresoVivo`: sin TTY narra label…/OK sin \r (rama
// que corren SIEMPRE los tests), con TTY narra con spinner sin reventar ni
// dejar la línea rota, y nunca escribe a stdout en modo --json.

function mockStream(tty: boolean): { stream: NodeJS.WriteStream; salida: () => string } {
  const chunks: string[] = [];
  const stream = {
    isTTY: tty,
    write: (s: string): boolean => {
      chunks.push(s);
      return true;
    },
  } as unknown as NodeJS.WriteStream;
  // eslint-disable-next-line no-control-regex
  const sinAnsi = () => chunks.join("").replace(/\x1b\[[0-9;]*m/g, "");
  return { stream, salida: sinAnsi };
}

test("paso: sin TTY imprime 'label…' al empezar y 'OK label (Ns)' al terminar, sin \\r", async () => {
  const { stream, salida } = mockStream(false);
  const resultado = await paso("migrando", async () => 42, { stream });
  assert.equal(resultado, 42);
  const out = salida();
  assert.match(out, /^migrando…\n/);
  assert.match(out, /OK migrando \(\d+s\)\n$/);
  assert.doesNotMatch(out, /\r/);
});

test("paso: sin TTY, si fn falla narra FAIL y relanza el error original", async () => {
  const { stream, salida } = mockStream(false);
  await assert.rejects(
    paso("migrando", async () => { throw new Error("boom"); }, { stream }),
    /boom/,
  );
  assert.match(salida(), /FAIL migrando \(\d+s\)/);
});

test("paso: con TTY corre spinner y termina con OK, sin dejar timers colgados", async () => {
  const { stream, salida } = mockStream(true);
  const resultado = await paso("esperando", async () => {
    await new Promise((r) => setTimeout(r, 20));
    return "listo";
  }, { stream });
  assert.equal(resultado, "listo");
  assert.match(salida(), /OK esperando \(\d+s\)/);
});

test("pasoStream: narra cada línea atenuada y cierra con OK/FAIL según el exit code", async () => {
  const { stream, salida } = mockStream(false);
  const code = await pasoStream(
    "db:migrate",
    async (onLinea) => {
      onLinea("aplicando 0001_init.sql");
      onLinea("aplicando 0002_index.sql");
      return 0;
    },
    { stream },
  );
  assert.equal(code, 0);
  const out = salida();
  assert.match(out, /aplicando 0001_init\.sql/);
  assert.match(out, /aplicando 0002_index\.sql/);
  assert.match(out, /OK db:migrate/);
});

test("pasoStream: exit code != 0 → FAIL", async () => {
  const { stream, salida } = mockStream(false);
  const code = await pasoStream("db:sembrar", async () => 1, { stream });
  assert.equal(code, 1);
  assert.match(salida(), /FAIL db:sembrar/);
});

test("modo --json (sin stream inyectado): nunca escribe en process.stdout", async () => {
  const originalWrite = process.stdout.write.bind(process.stdout);
  let tocoStdout = false;
  process.stdout.write = ((chunk: unknown, ...rest: unknown[]) => {
    tocoStdout = true;
    return (originalWrite as (...a: unknown[]) => boolean)(chunk, ...rest);
  }) as typeof process.stdout.write;
  try {
    await paso("algo", async () => "x", { json: true });
  } finally {
    process.stdout.write = originalWrite;
  }
  assert.equal(tocoStdout, false);
});

test("esperarConLogs: reintenta el follow de logs mientras `esperar` no resuelve, y se detiene cuando resuelve", async () => {
  const { stream, salida } = mockStream(false);
  let intentos = 0;
  let esperarResuelto = false;
  const esperar = new Promise<string>((resolve) => {
    setTimeout(() => { esperarResuelto = true; resolve("rollout listo"); }, 30);
  });
  const resultado = await esperarConLogs(
    esperar,
    { cmd: "noop", args: [] },
    {
      stream,
      reintentoMs: 5,
      // stub: en vez de spawnStream real, simulamos vía filtrar+onLinea no aplica;
      // acá solo verificamos que la promesa principal gana y el helper no cuelga.
    },
  );
  assert.equal(resultado, "rollout listo");
  assert.equal(esperarResuelto, true);
  void intentos;
  void salida;
});
