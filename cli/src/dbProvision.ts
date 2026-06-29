import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { appsRoot, envOrThrow } from "./mkeConfig.js";
import { run, ok, bad, info, dim } from "./sh.js";

export interface DbProvisionOpts {
  password?: string;
}

// El postgres-mishi vive SIEMPRE en el cluster prod; stage/local apuntan a la
// instancia dev (ns databases-dev), prod a la instancia prod (ns databases).
const EXEC_CONTEXT = "k3d-mke-prod";
const POD = "postgres-0";

function nsForEnv(env: string): string {
  return env === "prod" ? "databases" : "databases-dev";
}

/** snake_case válido para postgres: `omni-whatsapp` -> `omni_whatsapp`. */
function toSnake(app: string): string {
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

  console.log(info(`provisionando BD/rol \`${appSnake}\` en ${ns} (${EXEC_CONTEXT}/${POD})`));

  const r = await run(
    "kubectl",
    [
      "--context", EXEC_CONTEXT, "-n", ns,
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
  console.log(dim("  El password se muestra UNA sola vez. Guardalo ya con `mishi-secret`"));
  console.log(dim("  y/o ponelo en el Secret de la app. No quedará recuperable desde aquí."));
}
