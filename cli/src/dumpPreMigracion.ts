// Respaldo pre-migración MUDADO al CLI (antes `scripts/dump-pre-migracion.sh`
// por app). Corre `pg_dump` DENTRO del pod de postgres vía `kubectl exec`
// (mismo patrón que el Job de migrar: el runner no resuelve el host interno del
// cluster) y deja el `.sql.gz` en el filesystem de quien corre el CLI.
//
// Fail-fast real: si el dump falla o queda vacío, devuelve false y `mke deploy`
// ABORTA antes de tocar la BD — no se migra ni se despliega sin respaldo fresco.
// Se hace dump SIEMPRE, aunque no haya migraciones pendientes: a esta escala es
// baratísimo y detectar "no hay pendientes" cuesta más que el dump.
//
// Poda: se conservan los últimos 10 dumps por app×entorno. El respaldo de largo
// plazo es el backup rclone→Drive de postgres-mishi; esto es la red inmediata.

import { spawn } from "node:child_process";
import { createWriteStream, mkdirSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { createGzip } from "node:zlib";
import { homedir } from "node:os";
import { join } from "node:path";

import { EXEC_CONTEXT, POD, nsForEnv } from "./dbProvision.js";
import { ok, bad, dim } from "./sh.js";

const CONSERVAR = 10;

export function dirDumps(): string {
  return process.env.MISHI_BACKUP_DIR ?? join(homedir(), "mishi-backups", "pre-migracion");
}

/** Nombres a BORRAR de una lista ya ordenada de más nuevo a más viejo. */
export function podarLista(nombresNuevoAViejo: string[], conservar = CONSERVAR): string[] {
  return nombresNuevoAViejo.slice(conservar);
}

function podarDumps(dir: string, prefijo: string): string[] {
  let entradas: string[];
  try {
    entradas = readdirSync(dir).filter((f) => f.startsWith(prefijo) && f.endsWith(".sql.gz"));
  } catch {
    return [];
  }
  const ordenados = entradas
    .map((f) => ({ f, t: statSync(join(dir, f)).mtimeMs }))
    .sort((a, b) => b.t - a.t)
    .map((x) => x.f);
  const borrar = podarLista(ordenados);
  for (const f of borrar) {
    try {
      unlinkSync(join(dir, f));
    } catch {
      /* ya no está */
    }
  }
  return borrar;
}

/**
 * Dump comprimido de la BD de la app antes de migrar. Devuelve true si quedó un
 * archivo no vacío. `db` = nombre de la BD en postgres-mishi (una BD por app).
 */
export async function dumpPreMigracion(app: string, db: string, env: string, sha: string): Promise<boolean> {
  const pgNs = nsForEnv(env);
  const dir = dirDumps();
  mkdirSync(dir, { recursive: true });
  const salida = join(dir, `${app}-${env}-${sha}.sql.gz`);

  const codigo = await new Promise<number>((resolve) => {
    const child = spawn("kubectl", [
      "--context", EXEC_CONTEXT, "-n", pgNs,
      "exec", "-i", POD, "--",
      "pg_dump", "-U", "postgres", "-d", db,
    ]);
    const gzip = createGzip();
    const archivo = createWriteStream(salida);
    let stderr = "";
    child.stderr.on("data", (d: Buffer) => {
      stderr += d.toString();
    });
    child.stdout.pipe(gzip).pipe(archivo);
    child.on("error", () => resolve(1));
    archivo.on("error", () => resolve(1));
    child.on("close", (code) => {
      archivo.on("close", () => {
        if (code !== 0 && stderr.trim()) console.log(dim(`  │ ${stderr.trim().split("\n").slice(-3).join(" · ")}`));
        resolve(code ?? 1);
      });
    });
  });

  if (codigo !== 0) {
    console.log(bad(`dump pre-migración falló (${db} @ ${pgNs}) — NO se migra sin respaldo`));
    return false;
  }
  let bytes = 0;
  try {
    bytes = statSync(salida).size;
  } catch {
    bytes = 0;
  }
  if (bytes === 0) {
    console.log(bad("el dump quedó vacío — abortando (no se migra sin respaldo válido)"));
    return false;
  }

  const borrados = podarDumps(dir, `${app}-${env}-`);
  console.log(ok(`dump pre-migración ${dim(`${salida} (${Math.round(bytes / 1024)} KiB)`)}`));
  if (borrados.length) console.log(dim(`  podados ${borrados.length} dump(s) viejo(s) (se conservan ${CONSERVAR})`));
  return true;
}
