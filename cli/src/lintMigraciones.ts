// La ley expand-contract EJECUTABLE, MUDADA al CLI (2026-07-27).
//
// Antes vivía copiada en `apps/backend/scripts/lintMigraciones.ts` de cada app
// y solo corría en el job `quality` (que solo dispara en PRs). Como el
// ecosistema no usa PRs, el lint corría POR PRIMERA VEZ durante el deploy a
// prod — la compuerta llegaba tarde. Ahora vive UNA vez acá y la corren
// `mke deploy` (antes del dump/migración) y `mke preview merge` (antes de
// mergear a main).
//
// Contrato que se conserva tal cual (compatibilidad con las migraciones ya
// escritas de todas las apps):
//   - `-- contract: <razón>` en el MISMO statement = escape hatch de SQL
//     destructivo (pasa como aviso, no como error).
//   - `-- espejo: ok` en el MISMO statement, o la tabla listada en
//     `apps/backend/db/tablas-sensibles.txt` = decisión de espejo tomada.
//
// Funciones puras (testeadas con fixtures de string) + un runner delgado.

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { ok, bad, warn, dim } from "./sh.js";

export interface Issue {
  archivo: string;
  mensaje: string;
}

export interface Aviso {
  archivo: string;
  razon: string;
}

export interface ResultadoLint {
  issues: Issue[];
  avisos: Aviso[];
}

// Reglas destructivas: rompen compatibilidad con el código del release
// anterior si corren ANTES de que ese código deje de usar lo que tocan.
const REGLAS_DESTRUCTIVAS: Array<{ nombre: string; patron: RegExp }> = [
  { nombre: "DROP TABLE", patron: /\bDROP\s+TABLE\b/i },
  { nombre: "DROP COLUMN", patron: /\bDROP\s+COLUMN\b/i },
  { nombre: "RENAME (tabla o columna)", patron: /\bRENAME\s+(TO|COLUMN)\b/i },
  { nombre: "TRUNCATE", patron: /\bTRUNCATE\b/i },
  {
    nombre: "ALTER COLUMN ... TYPE (cambio de tipo)",
    patron: /\bALTER\s+COLUMN\b[^;]*?\b(?:SET\s+DATA\s+)?TYPE\b/i,
  },
];

const RE_CONTRACT = /--\s*contract:\s*(.+)/i;
const RE_ESPEJO_OK = /--\s*espejo:\s*ok\b/i;
const RE_CREATE_TABLE =
  /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?"?(?:[\w]+"?\s*\.\s*)?"?(\w+)"?\s*\(/i;

/** Divide un archivo de migración drizzle en sus statements individuales. */
export function dividirStatements(sql: string): string[] {
  return sql
    .split("--> statement-breakpoint")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** SET NOT NULL sin DEFAULT en el mismo statement: rompe filas existentes NULL. */
function tieneSetNotNullSinDefault(stmt: string): boolean {
  const tieneSetNotNull = /\bALTER\s+COLUMN\b[^;]*?\bSET\s+NOT\s+NULL\b/i.test(stmt);
  if (!tieneSetNotNull) return false;
  return !/\bDEFAULT\b/i.test(stmt);
}

function extraerRazonContract(stmt: string): string | null {
  const m = stmt.match(RE_CONTRACT);
  return m ? m[1].trim() : null;
}

/** Lista de tablas sensibles del archivo (una por línea, `#` comenta). */
export function cargarTablasSensibles(contenido: string): Set<string> {
  return new Set(
    contenido
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0 && !l.startsWith("#")),
  );
}

/** Lintea un statement suelto. Issues fallan la compuerta; avisos pasan pero gritan. */
export function revisarStatement(
  archivo: string,
  stmt: string,
  tablasSensibles: Set<string>,
): { issues: Issue[]; avisos: Aviso[] } {
  const issues: Issue[] = [];
  const avisos: Aviso[] = [];
  const razonContract = extraerRazonContract(stmt);

  for (const regla of REGLAS_DESTRUCTIVAS) {
    if (regla.patron.test(stmt)) {
      if (razonContract) {
        avisos.push({ archivo, razon: `${regla.nombre}: ${razonContract}` });
      } else {
        issues.push({
          archivo,
          mensaje:
            `${regla.nombre} sin escape hatch. Rompe compatibilidad con el ` +
            `release anterior (el rollout no es atómico con la migración) — ` +
            `si es intencional y ya nada del release previo lo usa, agregá ` +
            `un comentario "-- contract: <razón>" en el mismo statement.\n` +
            `    statement: ${stmt.split("\n")[0].slice(0, 120)}`,
        });
      }
    }
  }

  // SET NOT NULL sin DEFAULT no está en REGLAS_DESTRUCTIVAS (no es una sola
  // palabra clave) pero sigue el mismo contrato de escape hatch.
  if (tieneSetNotNullSinDefault(stmt)) {
    if (razonContract) {
      avisos.push({ archivo, razon: `SET NOT NULL sin DEFAULT: ${razonContract}` });
    } else {
      issues.push({
        archivo,
        mensaje:
          `ALTER COLUMN ... SET NOT NULL sin DEFAULT en el mismo statement. ` +
          `Filas existentes con NULL harían fallar la migración, y el código ` +
          `del release anterior puede seguir insertando sin ese valor — ` +
          `agregá un DEFAULT en el mismo statement o el comentario ` +
          `"-- contract: <razón>" si es intencional.\n` +
          `    statement: ${stmt.split("\n")[0].slice(0, 120)}`,
      });
    }
  }

  const creaTabla = stmt.match(RE_CREATE_TABLE);
  if (creaTabla) {
    const tabla = creaTabla[1];
    const declarada = tablasSensibles.has(tabla);
    const espejoOk = RE_ESPEJO_OK.test(stmt);
    if (!declarada && !espejoOk) {
      issues.push({
        archivo,
        mensaje:
          `CREATE TABLE "${tabla}" nueva sin decisión de espejo. Agregá "${tabla}" ` +
          `a apps/backend/db/tablas-sensibles.txt (si tiene datos reales que NO ` +
          `deben viajar al espejo stage->preview) O agregá el comentario ` +
          `"-- espejo: ok" en el mismo statement (decisión consciente de que sí puede viajar).`,
      });
    }
  }

  return { issues, avisos };
}

/** Lintea el contenido completo de un archivo de migración. */
export function lintArchivo(
  archivo: string,
  contenido: string,
  tablasSensibles: Set<string>,
): ResultadoLint {
  const issues: Issue[] = [];
  const avisos: Aviso[] = [];
  for (const stmt of dividirStatements(contenido)) {
    const r = revisarStatement(archivo, stmt, tablasSensibles);
    issues.push(...r.issues);
    avisos.push(...r.avisos);
  }
  return { issues, avisos };
}

/** Lintea todos los .sql de un directorio de migraciones drizzle. */
export function lintDirectorio(drizzleDir: string, tablasSensibles: Set<string>): ResultadoLint {
  const archivos = readdirSync(drizzleDir)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  const issues: Issue[] = [];
  const avisos: Aviso[] = [];
  for (const archivo of archivos) {
    const contenido = readFileSync(join(drizzleDir, archivo), "utf8");
    const r = lintArchivo(archivo, contenido, tablasSensibles);
    issues.push(...r.issues);
    avisos.push(...r.avisos);
  }
  return { issues, avisos };
}

/**
 * Corre el lint sobre un checkout de app (o worktree) y NARRA el resultado con
 * el formato OK/FAIL del CLI. Devuelve true si la compuerta pasa. Si la app no
 * tiene migraciones todavía, pasa trivialmente.
 */
export function lintMigracionesRepo(dir: string, opts: { drizzleDir?: string; tablasSensiblesPath?: string } = {}): boolean {
  const drizzleDir = opts.drizzleDir ?? join(dir, "apps", "backend", "drizzle");
  const tablasSensiblesPath =
    opts.tablasSensiblesPath ?? join(dir, "apps", "backend", "db", "tablas-sensibles.txt");

  if (!existsSync(drizzleDir)) {
    console.log(ok(`lint de migraciones: sin drizzle/ ${dim("(nada que revisar)")}`));
    return true;
  }
  const tablasSensibles = existsSync(tablasSensiblesPath)
    ? cargarTablasSensibles(readFileSync(tablasSensiblesPath, "utf8"))
    : new Set<string>();

  const { issues, avisos } = lintDirectorio(drizzleDir, tablasSensibles);
  for (const aviso of avisos) {
    console.log(warn(`migración destructiva APROBADA — ${aviso.archivo}: ${aviso.razon}`));
  }
  if (issues.length > 0) {
    console.log(bad(`lint de migraciones: ${issues.length} problema(s)`));
    for (const issue of issues) console.log(`    [${issue.archivo}] ${issue.mensaje}\n`);
    return false;
  }
  console.log(ok(`lint de migraciones sin problemas ${dim(`(${avisos.length} escape hatch usados)`)}`));
  return true;
}
