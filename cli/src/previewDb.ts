// DB EFÍMERA de `mke preview` — una BD por app×rama en el postgres-mishi de
// `databases-dev` (mismo postgres que usan stage/local; ver `dbProvision.ts`).
// NO usa un rol nuevo por rama: reusa el rol ya provisionado de la app (mismo
// patrón que su DATABASE_URL de stage), apuntado a una DB EFÍMERA nueva. Ver
// el reporte final del PR por qué (ESCALADO: crear un rol nuevo por rama es
// una opción más aislada pero más pesada; no la implementamos sin pedirlo).
//
// El postgres-mishi vive en el cluster `k3d-mke-prod` (ver `dbProvision.ts`,
// EXEC_CONTEXT/POD) — el mismo exec sirve para provisionar/truncar/dropear la
// DB efímera y para leer la DB de STAGE que consume `--espejo`.

import { readFile } from "node:fs/promises";
import { EXEC_CONTEXT, POD, nsForEnv, toSnake } from "./dbProvision.js";
import { run } from "./sh.js";

const NS = nsForEnv("stage"); // = "databases-dev"

/** nombre de la DB efímera de una app×rama: `<app>_<rama_slug>` (guiones→_). */
export function dbNamePreview(app: string, ramaSlug: string): string {
  return `${toSnake(app)}_${toSnake(ramaSlug)}`;
}

/** nombre de la DB de STAGE de la app (convención `postgres-mishi`: una BD por app). */
export function dbNameStage(app: string): string {
  return toSnake(app);
}

async function psql(sql: string, db = "postgres"): Promise<{ code: number; stdout: string; stderr: string }> {
  return run("kubectl", ["--context", EXEC_CONTEXT, "-n", NS, "exec", "-i", POD, "--", "psql", "-U", "postgres", "-d", db, "-v", "ON_ERROR_STOP=1", "-Atq"], sql);
}

/** rol/pass a usar para la DB efímera: el rol YA provisionado de la app (mismo
 * dueño que su BD de stage). Se resuelve leyendo su DATABASE_URL de mishi-secret
 * (`mke/<app>/stage/database-url`); si no existe, ESCALA con un error claro —
 * significa que la app aún no corrió `mke app init` / `mke db provision`. */
export async function resolveAppDbCreds(app: string): Promise<{ user: string; password: string }> {
  const key = `mke/${app}/stage/database-url`;
  const r = await run("mishi-secret", ["get", key]);
  const url = r.stdout.trim();
  if (r.code !== 0 || !url) {
    throw new Error(
      `no encontré ${key} en mishi-secret — corré \`mke db provision ${app} stage\` / \`mke app init ${app}\` primero (mke preview reusa ese rol para su DB efímera).`,
    );
  }
  const m = url.match(/^postgres(?:ql)?:\/\/([^:]+):([^@]+)@/);
  if (!m) throw new Error(`${key} no tiene forma de DATABASE_URL reconocible`);
  return { user: m[1], password: decodeURIComponent(m[2]) };
}

/** URL de la DB efímera, interna al cluster (la que se inyecta al pod). */
export function previewDatabaseUrl(app: string, ramaSlug: string, user: string, password: string): string {
  return `postgres://${user}:${password}@postgres.${NS}.svc.cluster.local:5432/${dbNamePreview(app, ramaSlug)}`;
}

/**
 * Crea la DB efímera si no existe (idempotente: `up` re-corrido no rompe) y le
 * concede el rol de la app como dueño (CREATE DATABASE no soporta IF NOT
 * EXISTS; se chequea antes por catálogo).
 */
export async function provisionarDbPreview(app: string, ramaSlug: string, user: string): Promise<void> {
  const db = dbNamePreview(app, ramaSlug);
  const existe = await psql(`SELECT 1 FROM pg_database WHERE datname='${db}'`);
  if (existe.stdout.trim() === "1") return;
  const crear = await psql(`CREATE DATABASE ${db} OWNER ${user}`);
  if (crear.code !== 0) throw new Error(`CREATE DATABASE ${db} falló: ${crear.stderr || crear.stdout}`);
}

/** DROP DATABASE de la efímera (idempotente: `IF EXISTS`). */
export async function dropDbPreview(app: string, ramaSlug: string): Promise<void> {
  const db = dbNamePreview(app, ramaSlug);
  // no se puede DROP con conexiones activas: cerramos las del preview-pod primero.
  await psql(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname='${db}' AND pid <> pg_backend_pid()`);
  const r = await psql(`DROP DATABASE IF EXISTS ${db}`);
  if (r.code !== 0) throw new Error(`DROP DATABASE ${db} falló: ${r.stderr || r.stdout}`);
}

/** SQL que trunca TODAS las tablas de public (mismo patrón que iterar-rama.sh). */
export function sqlTruncarTodo(): string {
  return "select 'truncate table '||string_agg(quote_ident(table_name), ', ')||' restart identity cascade' from information_schema.tables where table_schema='public'";
}

/** trunca todas las tablas de la DB efímera (paso previo al --espejo). No-op
 * silencioso si la DB aún no tiene tablas (recién migrada). */
export async function truncarTodo(app: string, ramaSlug: string): Promise<void> {
  const db = dbNamePreview(app, ramaSlug);
  const gen = await psql(sqlTruncarTodo(), db);
  const sentencia = gen.stdout.trim();
  if (!sentencia || sentencia === "") return; // sin tablas aún
  const r = await psql(sentencia, db);
  if (r.code !== 0) throw new Error(`TRUNCATE de ${db} falló: ${r.stderr || r.stdout}`);
}

/** parsea `tablas-sensibles.txt` (una tabla por línea; vacías/`#` ignoradas). */
export function parseTablasSensibles(texto: string): string[] {
  return texto
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"));
}

export async function leerTablasSensibles(app: string, appsRoot: string): Promise<string[]> {
  const { join } = await import("node:path");
  const ruta = join(appsRoot, app, "apps", "backend", "db", "tablas-sensibles.txt");
  let texto: string;
  try {
    texto = await readFile(ruta, "utf8");
  } catch {
    throw new Error(
      `--espejo requiere ${ruta} (una tabla sensible por línea) — creala en el repo de ${app} antes de pedir el espejo (evita copiar datos reales sensibles a un preview público).`,
    );
  }
  return parseTablasSensibles(texto);
}

/** `pg_dump --data-only --disable-triggers --exclude-table-data=...` por cada
 * tabla sensible, de la DB de STAGE de la app → import a la DB efímera. */
export async function restaurarEspejo(app: string, ramaSlug: string, tablasSensibles: string[]): Promise<void> {
  const dbStage = dbNameStage(app);
  const dbPreview = dbNamePreview(app, ramaSlug);
  const excludeArgs = tablasSensibles.map((t) => `--exclude-table-data=${t}`);
  const dump = await run("kubectl", [
    "--context", EXEC_CONTEXT, "-n", NS, "exec", POD, "--",
    "pg_dump", "-U", "postgres", "-d", dbStage, "--data-only", "--disable-triggers", ...excludeArgs,
  ]);
  if (dump.code !== 0) throw new Error(`pg_dump de ${dbStage} falló: ${dump.stderr || dump.stdout}`);
  const restore = await run("kubectl", [
    "--context", EXEC_CONTEXT, "-n", NS, "exec", "-i", POD, "--",
    "psql", "-U", "postgres", "-d", dbPreview, "-v", "ON_ERROR_STOP=0",
  ], dump.stdout);
  if (restore.code !== 0) throw new Error(`restaurar espejo en ${dbPreview} falló: ${restore.stderr || restore.stdout}`);
}
