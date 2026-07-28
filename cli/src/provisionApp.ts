// Piezas idempotentes del nacimiento de PLATAFORMA de una app, extraídas de
// `appInit.ts` para que `mke deploy` pueda CONVERGER sin duplicarlas.
//
// Cicatriz que las trae acá (deploy de status-mishi a prod, 2026-07-27):
// `mke app init` solo había provisionado STAGE, así que la BD de prod no
// existía y el deploy a prod se enteró tarde y a mano. La regla nueva: cada
// deploy converge lo que falte en SU entorno, sin error si ya estaba.
//
// El password NUNCA se imprime: vive en mishi-secret y en el Secret de k8s.

import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { appsRoot, envOrThrow } from "./mkeConfig.js";
import { EXEC_CONTEXT, POD, nsForEnv } from "./dbProvision.js";
import { run } from "./sh.js";

/** nombre del secreto en mishi-secret con el DATABASE_URL de la app×entorno. */
export function nombreSecretoDb(app: string, env: string): string {
  return `mke/${app}/${env}/database-url`;
}

/** true si el rol ya existe en el postgres-mishi del namespace dado. */
export async function roleExists(appSnake: string, dbNs: string): Promise<boolean> {
  const r = await run("kubectl", [
    "--context", EXEC_CONTEXT, "-n", dbNs,
    "exec", "-i", POD, "--",
    "psql", "-U", "postgres", "-tAc",
    `SELECT 1 FROM pg_roles WHERE rolname = '${appSnake}'`,
  ]);
  return r.code === 0 && r.stdout.trim() === "1";
}

/** true si la BD de la app ya existe (el post-mortem: el rol podía estar y la BD no). */
export async function dbExists(appSnake: string, dbNs: string): Promise<boolean> {
  const r = await run("kubectl", [
    "--context", EXEC_CONTEXT, "-n", dbNs,
    "exec", "-i", POD, "--",
    "psql", "-U", "postgres", "-tAc",
    `SELECT 1 FROM pg_database WHERE datname = '${appSnake}'`,
  ]);
  return r.code === 0 && r.stdout.trim() === "1";
}

/** SQL de bootstrap + fix de ownership (DDL como postgres deja tablas del rol postgres). */
function sqlProvision(): string {
  const sqlPath = join(appsRoot(), "postgres-mishi", "bootstrap", "provision-app-db.sql");
  if (!existsSync(sqlPath)) {
    throw new Error(`no encuentro el SQL de bootstrap: ${sqlPath}`);
  }
  return (
    readFileSync(sqlPath, "utf8") +
    `
-- fix de ownership (gotcha: DDL corrida como postgres deja tablas del rol postgres).
\\connect :app
ALTER SCHEMA public OWNER TO :app;
GRANT ALL ON SCHEMA public TO :app;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL PRIVILEGES ON TABLES TO :app;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL PRIVILEGES ON SEQUENCES TO :app;
`
  );
}

export interface ProvisionResult {
  databaseUrl: string;
  /** true si el rol Y la BD ya existían (no se creó nada nuevo). */
  already: boolean;
}

/**
 * Crea (o re-asegura) BD+rol de la app en la instancia de postgres-mishi que le
 * toca al entorno, y devuelve el DATABASE_URL interno. Idempotente: el SQL hace
 * CREATE si no existe y re-asegura el password.
 */
export async function provisionarBd(app: string, appSnake: string, env: string): Promise<ProvisionResult> {
  const dbNs = nsForEnv(env);
  const already = (await roleExists(appSnake, dbNs)) && (await dbExists(appSnake, dbNs));
  const pw = randomBytes(24).toString("base64url");
  const r = await run(
    "kubectl",
    [
      "--context", EXEC_CONTEXT, "-n", dbNs,
      "exec", "-i", POD, "--",
      "psql", "-U", "postgres",
      "-v", `app=${appSnake}`,
      "-v", `pw=${pw}`,
    ],
    sqlProvision(),
  );
  if (r.code !== 0) throw new Error(`provision de BD falló: ${(r.stderr || r.stdout).split("\n").slice(-3).join(" · ")}`);
  return {
    databaseUrl: `postgres://${appSnake}:${pw}@postgres.${dbNs}.svc.cluster.local:5432/${appSnake}`,
    already,
  };
}

/** Guarda el DATABASE_URL en mishi-secret. Devuelve true si el secreto ya existía. */
export async function guardarSecretoDb(app: string, env: string, databaseUrl: string): Promise<boolean> {
  const nombre = nombreSecretoDb(app, env);
  const previo = await run("mishi-secret", ["get", nombre]);
  const already = previo.code === 0 && previo.stdout.trim().length > 0;
  const set = await run("mishi-secret", ["set", nombre], databaseUrl);
  if (set.code !== 0) throw new Error(`mishi-secret set falló: ${set.stderr || set.stdout}`);
  return already;
}

/** Lee el DATABASE_URL guardado en mishi-secret (null si no hay). Nunca lo imprime. */
export async function leerSecretoDb(app: string, env: string): Promise<string | null> {
  const r = await run("mishi-secret", ["get", nombreSecretoDb(app, env)]);
  if (r.code !== 0) return null;
  const v = r.stdout.trim();
  return v.length > 0 ? v : null;
}

/** Crea el namespace del entorno si falta. Devuelve true si ya existía. */
export async function asegurarNamespace(env: string): Promise<boolean> {
  const spec = envOrThrow(env);
  const get = await run("kubectl", ["--context", spec.context, "get", "namespace", spec.namespace]);
  if (get.code === 0) return true;
  const create = await run("kubectl", ["--context", spec.context, "create", "namespace", spec.namespace]);
  if (create.code !== 0) throw new Error(`crear namespace falló: ${create.stderr || create.stdout}`);
  return false;
}

/** true si el Secret k8s `<app>-secrets` existe en el namespace del entorno. */
export async function secretK8sExiste(app: string, env: string): Promise<boolean> {
  const spec = envOrThrow(env);
  const r = await run("kubectl", ["--context", spec.context, "-n", spec.namespace, "get", "secret", `${app}-secrets`]);
  return r.code === 0;
}

/**
 * Asegura el Secret k8s `<app>-secrets` SIN destruir claves ajenas.
 *
 * LEY (post-mortem 2026-07-28): el Secret de una app acumula claves que mke NO
 * conoce (llaves ES256 del IdP, allowlists, API keys de integraciones). Un
 * `kubectl apply` del Secret entero las BORRA — así se perdieron las
 * SESSION_*_KEY de identity-mishi en stage. Por eso acá:
 *   - Secret inexistente → se crea con DATABASE_URL + SESSION_SECRET.
 *   - Secret existente   → PATCH merge SOLO de DATABASE_URL; SESSION_SECRET
 *     solo se agrega si falta (rotarlo invalidaría sesiones vivas).
 */
export async function aplicarSecretK8s(
  app: string,
  env: string,
  databaseUrl: string,
  sessionSecret?: string,
): Promise<boolean> {
  const spec = envOrThrow(env);
  const nombre = `${app}-secrets`;
  const already = await secretK8sExiste(app, env);

  if (!already) {
    const create = await run("kubectl", [
      "--context", spec.context, "-n", spec.namespace,
      "create", "secret", "generic", nombre,
      `--from-literal=DATABASE_URL=${databaseUrl}`,
      `--from-literal=SESSION_SECRET=${sessionSecret ?? randomBytes(32).toString("hex")}`,
    ]);
    if (create.code !== 0) throw new Error(`crear Secret k8s falló: ${create.stderr || create.stdout}`);
    return false;
  }

  const vivo = await run("kubectl", [
    "--context", spec.context, "-n", spec.namespace,
    "get", "secret", nombre, "-o", "jsonpath={.data.SESSION_SECRET}",
  ]);
  const data: Record<string, string> = {
    DATABASE_URL: Buffer.from(databaseUrl).toString("base64"),
  };
  if (!vivo.stdout.trim()) {
    data.SESSION_SECRET = Buffer.from(sessionSecret ?? randomBytes(32).toString("hex")).toString("base64");
  }
  const archivo = join(tmpdir(), `mke-secret-${app}-${env}.json`);
  writeFileSync(archivo, JSON.stringify({ data }));
  const patch = await run("kubectl", [
    "--context", spec.context, "-n", spec.namespace,
    "patch", "secret", nombre, "--type", "merge", "--patch-file", archivo,
  ]);
  if (patch.code !== 0) throw new Error(`patch del Secret falló: ${patch.stderr || patch.stdout}`);
  return true;
}
