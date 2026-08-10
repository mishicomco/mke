import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { appsRoot, envOrThrow } from "./mkeConfig.js";
import { run, ok, bad, info, dim } from "./sh.js";

export interface DbProvisionOpts {
  password?: string;
}

// El postgres-mishi del ambiente vive en el cluster de SU nodo: stage/local en
// el cluster del gamer (ns databases-dev), prod en el del laptop (ns databases).
// Antes era la constante "k3d-mke-prod", que solo funcionaba porque los DOS
// clusters se llamaban igual — con los clusters nombrados por máquina
// (2026-08-10) el contexto se deriva del entorno.
export function execContext(dbNs: string): string {
  return envOrThrow(dbNs === "databases" ? "prod" : "stage").context;
}
export const POD = "postgres-0";

/** namespace del postgres-mishi que sirve cada entorno (compartido con appInit.ts). */
export function nsForEnv(env: string): string {
  return env === "prod" ? "databases" : "databases-dev";
}

/** snake_case válido para postgres: `omni-whatsapp` -> `omni_whatsapp`. */
export function toSnake(app: string): string {
  return app.replace(/-/g, "_").toLowerCase();
}

/**
 * Provisiona una BD + rol dedicados para una app en postgres-mishi (estándar
 * MKE: una BD por app). Idempotente — el SQL hace CREATE ROLE/DATABASE solo si
 * no existen y re-asegura el password. El SQL usa variables psql `:'app'`/`:'pw'`
 * y `\gexec`, por eso entra por stdin (no por `-c`).
 */
export async function dbProvision(app: string, env: string, opts: DbProvisionOpts): Promise<void> {
  envOrThrow(env); // valida local|stage|prod

  const ns = nsForEnv(env);
  const appSnake = toSnake(app);
  const pw = opts.password ?? randomBytes(24).toString("base64url");

  const sqlPath = join(appsRoot(), "postgres-mishi", "bootstrap", "provision-app-db.sql");
  if (!existsSync(sqlPath)) {
    console.log(bad(`no encuentro el SQL de bootstrap: ${sqlPath}`));
    return;
  }
  const sql = readFileSync(sqlPath, "utf8");

  console.log(info(`provisionando BD/rol \`${appSnake}\` en ${ns} (${execContext(ns)}/${POD})`));

  const r = await run(
    "kubectl",
    [
      "--context", execContext(ns), "-n", ns,
      "exec", "-i", POD, "--",
      "psql", "-U", "postgres",
      "-v", `app=${appSnake}`,
      "-v", `pw=${pw}`,
    ],
    sql,
  );
  if (r.code !== 0) {
    console.log(bad(`provision falló: ${r.stderr || r.stdout}`));
    return;
  }

  const url = `postgres://${appSnake}:${pw}@postgres.${ns}.svc.cluster.local:5432/${appSnake}`;
  console.log(ok(`BD \`${appSnake}\` y rol listos en ${ns}`));
  console.log(info("DATABASE_URL (interno al cluster):"));
  console.log("  " + url);
  console.log(dim("  El password se muestra UNA sola vez. Guardalo ya con `vault-mishi`"));
  console.log(dim("  y/o ponelo en el Secret de la app. No quedará recuperable desde aquí."));
}
