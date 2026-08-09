// Drift-check MUDADO al CLI (antes `scripts/verificar-drift-db.sh` por app).
//
// Compara el journal de drizzle REGISTRADO en la BD (`drizzle.__drizzle_migrations`)
// contra los archivos del repo (`apps/backend/drizzle/*.sql` + `meta/_journal.json`).
//
// Por qué existe: el migrador de drizzle-orm usa una MARCA DE AGUA de
// `created_at` — un journal parchado a mano (o una migración aplicada fuera de
// banda) puede tapar migraciones sin aplicar EN SILENCIO (cicatriz de
// mishi-bank). Esto hace explícito lo que el migrador no verifica.
//
// El hash se calcula IGNORANDO las líneas de anotación del lint
// (`-- contract:` / `-- espejo:`): pueden agregarse DESPUÉS de que la migración
// ya corrió (documentan un drop histórico ya aplicado). Se aceptan DOS hashes
// por archivo: sin anotaciones y el archivo COMPLETO (la migración nació con la
// anotación y se aplicó así). Cualquier otra edición al SQL histórico SÍ es drift.
//
// Solo LEE la BD (SELECT).

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { EXEC_CONTEXT, POD, nsForEnv } from "./dbProvision.js";
import { run, ok, bad, dim } from "./sh.js";

const RE_ANOTACION = /^[ \t]*--[ \t]*(contract|espejo):/i;

/** Quita las líneas de anotación del lint, con la misma semántica que `sed d`. */
export function quitarAnotaciones(sql: string): string {
  const terminaEnSalto = sql.endsWith("\n");
  const lineas = sql.split("\n");
  if (terminaEnSalto) lineas.pop();
  const restantes = lineas.filter((l) => !RE_ANOTACION.test(l));
  const cuerpo = restantes.join("\n");
  return terminaEnSalto && cuerpo.length > 0 ? `${cuerpo}\n` : cuerpo;
}

export function sha256(texto: string): string {
  return createHash("sha256").update(texto).digest("hex");
}

export interface EntradaRepo {
  /** `when` del _journal.json (epoch ms). */
  when: string;
  tag: string;
  /** hash del archivo SIN las líneas de anotación. */
  hash: string;
  /** hash del archivo COMPLETO. */
  hashFull: string;
}

export interface EntradaDb {
  createdAt: string;
  hash: string;
}

/**
 * Compara conjunto-repo vs conjunto-BD ordenados por created_at. Devuelve la
 * lista de problemas (vacía = sin drift). Función PURA: es lo único que hay que
 * testear del drift-check; el resto es I/O.
 */
export function compararDrift(repo: EntradaRepo[], db: EntradaDb[]): string[] {
  const problemas: string[] = [];
  if (repo.length !== db.length) {
    problemas.push(`conteo distinto: repo=${repo.length} vs BD=${db.length}`);
  }
  const n = Math.min(repo.length, db.length);
  for (let i = 0; i < n; i++) {
    const r = repo[i];
    const d = db[i];
    const hashOk = r.hash === d.hash || r.hashFull === d.hash;
    if (r.when !== d.createdAt || !hashOk) {
      problemas.push(
        `mismatch en posición ${i + 1}: repo tag=${r.tag} when=${r.when} hash=${r.hash.slice(0, 12)}… ` +
          `vs BD when=${d.createdAt} hash=${d.hash.slice(0, 12)}…`,
      );
    }
  }
  return problemas;
}

/** Lee el journal del repo y hashea cada .sql. Lanza si falta un archivo referenciado. */
export function entradasDelRepo(drizzleDir: string): EntradaRepo[] {
  const journalPath = join(drizzleDir, "meta", "_journal.json");
  const journal = JSON.parse(readFileSync(journalPath, "utf8")) as {
    entries?: Array<{ when: number; tag: string }>;
  };
  const entradas: EntradaRepo[] = [];
  for (const e of journal.entries ?? []) {
    const sqlPath = join(drizzleDir, `${e.tag}.sql`);
    if (!existsSync(sqlPath)) {
      throw new Error(`falta el archivo ${sqlPath} (referenciado por _journal.json)`);
    }
    const contenido = readFileSync(sqlPath, "utf8");
    entradas.push({
      when: String(e.when),
      tag: e.tag,
      hash: sha256(quitarAnotaciones(contenido)),
      hashFull: sha256(contenido),
    });
  }
  return entradas.sort((a, b) => Number(a.when) - Number(b.when));
}

/** Parsea la salida `created_at|hash` de psql (una fila por línea). */
export function parsearFilasDb(salida: string): EntradaDb[] {
  return salida
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .map((l) => {
      const i = l.indexOf("|");
      return { createdAt: l.slice(0, i), hash: l.slice(i + 1) };
    });
}

/**
 * Lee el journal de migraciones REGISTRADO en la BD. Devuelve la lista (posible
 * vacía) o `null` si no se pudo leer (BD nueva sin schema drizzle, error de
 * conexión, etc.) — en ese caso quien llama NO puede concluir "al día" y debe
 * correr la compuerta completa. Solo SELECT.
 */
export async function leerJournalDb(db: string, env: string): Promise<EntradaDb[] | null> {
  const pgNs = nsForEnv(env);
  const r = await run("kubectl", [
    "--context", EXEC_CONTEXT, "-n", pgNs,
    "exec", "-i", POD, "--",
    "psql", "-U", "postgres", "-d", db, "-Atc",
    "select created_at || '|' || hash from drizzle.__drizzle_migrations order by created_at asc",
  ]);
  if (r.code !== 0) return null;
  return parsearFilasDb(r.stdout);
}

/**
 * ¿Está la BD EXACTAMENTE al día con las migraciones del repo? true SOLO si el
 * journal de la BD == el del repo (mismo conteo, mismos hashes en orden): no hay
 * nada pendiente Y no hay drift. En ese caso `mke deploy` puede saltar
 * dump+migrate (no se toca la BD). Cualquier otra cosa —migraciones pendientes,
 * drift real, o journal ilegible— devuelve false y la compuerta corre completa
 * (que migra lo pendiente o aborta ante drift real). Fail-safe: ante la duda, NO
 * salta. Sin migraciones en el repo → true (nada que hacer).
 */
export async function bdAlDia(db: string, env: string, drizzleDir: string): Promise<boolean> {
  if (!existsSync(join(drizzleDir, "meta", "_journal.json"))) return true;
  let repo: EntradaRepo[];
  try {
    repo = entradasDelRepo(drizzleDir);
  } catch {
    return false; // repo inconsistente → que la compuerta completa lo reporte
  }
  const dbJournal = await leerJournalDb(db, env);
  if (dbJournal === null) return false; // no se pudo leer → no concluir "al día"
  return compararDrift(repo, dbJournal).length === 0;
}

/**
 * Drift-check completo contra la BD de la app en el entorno. Devuelve true si
 * no hay drift. Sin migraciones en el repo → pasa trivialmente.
 */
export async function verificarDrift(db: string, env: string, drizzleDir: string): Promise<boolean> {
  if (!existsSync(join(drizzleDir, "meta", "_journal.json"))) {
    console.log(ok(`drift-check: sin migraciones todavía ${dim("(nada que comparar)")}`));
    return true;
  }
  const pgNs = nsForEnv(env);
  let repo: EntradaRepo[];
  try {
    repo = entradasDelRepo(drizzleDir);
  } catch (e) {
    console.log(bad(`drift-check: ${e instanceof Error ? e.message : String(e)}`));
    return false;
  }

  const r = await run("kubectl", [
    "--context", EXEC_CONTEXT, "-n", pgNs,
    "exec", "-i", POD, "--",
    "psql", "-U", "postgres", "-d", db, "-Atc",
    "select created_at || '|' || hash from drizzle.__drizzle_migrations order by created_at asc",
  ]);
  if (r.code !== 0) {
    console.log(bad(`drift-check: no pude leer el journal de la BD: ${(r.stderr || r.stdout).split("\n")[0]}`));
    return false;
  }

  const filas = parsearFilasDb(r.stdout);
  const problemas = compararDrift(repo, filas);
  if (problemas.length) {
    console.log(bad(`drift detectado: la BD fue tocada por fuera de las migraciones (${db} @ ${pgNs})`));
    for (const p of problemas) console.log(`    ${p}`);
    console.log(dim("    reconciliá antes de seguir — el rollout NO avanza con drift."));
    return false;
  }
  console.log(ok(`sin drift: journal de la BD == migraciones del repo ${dim(`(${filas.length})`)}`));
  return true;
}
