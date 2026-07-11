// `--espejo` de `mke preview`: puebla el SIDECAR postgres del preview-pod con
// los datos de la DB de STAGE de la app, SANITIZADOS contra las tablas listadas
// en `apps/backend/db/tablas-sensibles.txt` del repo de la app (evita copiar
// datos reales sensibles a un preview público).
//
// A diferencia del diseño anterior (DB efímera central en postgres-mishi), acá
// NO hay DB que provisionar ni dropear: la DB vive y muere con el pod. El espejo
// es un flujo cross-cluster orquestado por el CLI tras el rollout:
//   1. pg_dump --data-only de la DB de STAGE en postgres-mishi (cluster mke-prod,
//      ns databases-dev; ver `dbProvision.ts` EXEC_CONTEXT/POD), excluyendo cada
//      tabla sensible con --exclude-table-data.
//   2. TRUNCATE de todas las tablas del sidecar (cluster mke-preview, ns preview).
//   3. restaura el dump dentro del sidecar por `kubectl exec … psql`.

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { EXEC_CONTEXT, POD, nsForEnv, toSnake } from "./dbProvision.js";
import { PREVIEW } from "./mkeConfig.js";
import { run } from "./sh.js";

/** ns de postgres-mishi de STAGE (fuente del espejo): `databases-dev`. */
const STAGE_NS = nsForEnv("stage");
/** ns k8s del preview-pod (destino: su sidecar postgres). */
const PREVIEW_NS = "preview";

/** nombre de la DB de STAGE de la app (convención `postgres-mishi`: una BD por app). */
export function dbNameStage(app: string): string {
  return toSnake(app);
}

/** SQL que trunca TODAS las tablas de public (mismo patrón que iterar-rama.sh). */
export function sqlTruncarTodo(): string {
  return "select 'truncate table '||string_agg(quote_ident(table_name), ', ')||' restart identity cascade' from information_schema.tables where table_schema='public'";
}

/** parsea `tablas-sensibles.txt` (una tabla por línea; vacías/`#` ignoradas). */
export function parseTablasSensibles(texto: string): string[] {
  return texto
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"));
}

export async function leerTablasSensibles(app: string, appsRoot: string): Promise<string[]> {
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

/** psql contra el SIDECAR postgres del preview-pod (loopback, superusuario dev). */
async function psqlSidecar(podName: string, sql: string, stdin?: string): Promise<{ code: number; stdout: string; stderr: string }> {
  const args = [
    "--context", PREVIEW.context, "-n", PREVIEW_NS,
    "exec", ...(stdin !== undefined ? ["-i"] : []), `deploy/${podName}`, "-c", "postgres", "--",
    "psql", "-U", "dev", "-d", "dev", "-v", stdin !== undefined ? "ON_ERROR_STOP=0" : "ON_ERROR_STOP=1", "-Atq",
  ];
  return run("kubectl", args, stdin);
}

/** trunca todas las tablas del sidecar (paso previo al espejo). No-op silencioso
 * si aún no hay tablas (recién migrado). */
export async function truncarSidecar(podName: string): Promise<void> {
  const gen = await psqlSidecar(podName, sqlTruncarTodo());
  const sentencia = gen.stdout.trim();
  if (!sentencia) return;
  const r = await psqlSidecar(podName, sentencia);
  if (r.code !== 0) throw new Error(`TRUNCATE del sidecar falló: ${r.stderr || r.stdout}`);
}

/** `pg_dump --data-only --disable-triggers` de la DB de STAGE (excluyendo las
 * tablas sensibles) → restore dentro del SIDECAR del preview-pod. */
export async function restaurarEspejo(app: string, podName: string, tablasSensibles: string[]): Promise<void> {
  const dbStage = dbNameStage(app);
  const excludeArgs = tablasSensibles.map((t) => `--exclude-table-data=${t}`);
  const dump = await run("kubectl", [
    "--context", EXEC_CONTEXT, "-n", STAGE_NS, "exec", POD, "--",
    "pg_dump", "-U", "postgres", "-d", dbStage, "--data-only", "--disable-triggers", ...excludeArgs,
  ]);
  if (dump.code !== 0) throw new Error(`pg_dump de ${dbStage} (stage) falló: ${dump.stderr || dump.stdout}`);
  const restore = await psqlSidecar(podName, "", dump.stdout);
  if (restore.code !== 0) throw new Error(`restaurar espejo en el sidecar falló: ${restore.stderr || restore.stdout}`);
}
