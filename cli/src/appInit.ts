// `mke app init <app>` — nacimiento de plataforma para una app nueva, en UN
// comando idempotente: BD+rol en postgres-mishi, password en mishi-secret,
// namespace + Secret k8s con DATABASE_URL/SESSION_SECRET, DNS del host.
//
// Reusa lo horneado: nsForEnv/toSnake/EXEC_CONTEXT/POD de dbProvision.ts (el
// mismo postgres-mishi, misma convención BD-por-app), ensureDns de dns.ts
// (mismo CNAME al tunnel del entorno que usa `mke expose`), hostFor/envOrThrow
// de mkeConfig.ts. No se reimplementa nada de eso acá.
//
// Cada paso es check-before-create: correr el comando dos veces no duplica
// nada, reporta "ya existía" y sigue. El password NUNCA se imprime — vive
// solo en mishi-secret y en el Secret de k8s.

import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { appsRoot, envOrThrow, hostFor } from "./mkeConfig.js";
import { EXEC_CONTEXT, POD, nsForEnv, toSnake } from "./dbProvision.js";
import { ensureDns } from "./dns.js";
import { run, ok, bad, info, warn, dim } from "./sh.js";
import { ensureStaticHostPaso, planStaticHosts } from "./staticHost.js";

export interface AppInitOpts {
  /** dominio público si difiere del id interno del app (default: mismo nombre). */
  subdominio?: string;
  /** imprime el plan y no toca nada (sin BD, sin kubectl, sin DNS, sin secretos). */
  dryRun?: boolean;
}

interface Step {
  name: string;
  /** true si el paso ya existía (idempotente, no se tocó nada). */
  already: boolean;
}

/**
 * Nacimiento de plataforma: BD+rol → secreto → namespace+Secret k8s → DNS.
 * Idempotente end to end; --dry-run solo imprime el plan.
 */
export async function appInit(app: string, env: string, opts: AppInitOpts): Promise<void> {
  const spec = envOrThrow(env); // valida local|stage|prod
  const dbNs = nsForEnv(env);
  const appSnake = toSnake(app);
  const subdominio = opts.subdominio ?? app;
  const host = hostFor(subdominio, env);
  const secretNameDb = `mke/${app}/${env}/database-url`;
  const k8sSecretName = `${app}-secrets`;
  const dnsSuffix = spec.hostSuffix;

  console.log(`\n  mke app init ${dim(app)} (${env}) → ${dim(host)}\n`);

  if (opts.dryRun) {
    console.log(info("DRY RUN — no se toca nada. Plan:"));
    console.log(`  1. BD+rol \`${appSnake}\` en postgres-mishi (${dbNs}, ${EXEC_CONTEXT}/${POD})`);
    console.log(`     - CREATE ROLE/DATABASE si no existen, password aleatorio (openssl rand -base64 32)`);
    console.log(`     - ALTER SCHEMA public OWNER TO ${appSnake}; ALTER DEFAULT PRIVILEGES → GRANT ALL a ${appSnake}`);
    console.log(`  2. mishi-secret set ${secretNameDb}  (guarda DATABASE_URL cifrado, nunca se imprime)`);
    console.log(`  3. namespace \`${spec.namespace}\` (${spec.context}) — crear si no existe`);
    console.log(`     Secret k8s \`${k8sSecretName}\` con DATABASE_URL + SESSION_SECRET (aleatorio)`);
    console.log(`  4. DNS: ${host} → tunnel ${spec.tunnelUuid} (mismo mecanismo que \`mke expose\`/\`mke dns\`)`);
    const planHosts = planStaticHosts(subdominio);
    console.log(`  5. host del front en static-mishi (ingress stage+prod, SIEMPRE ambos): ${planHosts.stageHost} + ${planHosts.prodHost}`);
    console.log(`\n  ${dim(`sufijo público del entorno: "${dnsSuffix || "(prod, sin sufijo)"}"`)}`);
    console.log(info("nada ejecutado (--dry-run)"));
    return;
  }

  const steps: Step[] = [];

  // 1) BD + rol, con fix de ownership (schema public + default privileges).
  const pw = randomBytes(24).toString("base64url");
  const already = await roleExists(appSnake, dbNs);
  const sqlPath = join(appsRoot(), "postgres-mishi", "bootstrap", "provision-app-db.sql");
  if (!existsSync(sqlPath)) {
    console.log(bad(`no encuentro el SQL de bootstrap: ${sqlPath}`));
    return;
  }
  const baseSql = readFileSync(sqlPath, "utf8");
  const ownerFixSql = `
-- fix de ownership (gotcha: DDL corrida como postgres deja tablas del rol postgres).
\\connect :app
ALTER SCHEMA public OWNER TO :app;
GRANT ALL ON SCHEMA public TO :app;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL PRIVILEGES ON TABLES TO :app;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL PRIVILEGES ON SEQUENCES TO :app;
`;
  const sql = baseSql + ownerFixSql;

  console.log(info(`BD/rol \`${appSnake}\` en ${dbNs} (${EXEC_CONTEXT}/${POD})`));
  const r = await run(
    "kubectl",
    [
      "--context", EXEC_CONTEXT, "-n", dbNs,
      "exec", "-i", POD, "--",
      "psql", "-U", "postgres",
      "-v", `app=${appSnake}`,
      "-v", `pw=${pw}`,
    ],
    sql,
  );
  if (r.code !== 0) {
    console.log(bad(`provision de BD falló: ${r.stderr || r.stdout}`));
    return;
  }
  steps.push({ name: `BD/rol \`${appSnake}\``, already });
  console.log(ok(already ? `BD/rol \`${appSnake}\` ya existía (password re-asegurado)` : `BD/rol \`${appSnake}\` creado`));

  const databaseUrl = `postgres://${appSnake}:${pw}@postgres.${dbNs}.svc.cluster.local:5432/${appSnake}`;

  // 2) password en mishi-secret (nunca por stdout).
  const secretAlready = await mishiSecretExists(secretNameDb);
  const set = await run("mishi-secret", ["set", secretNameDb], databaseUrl);
  if (set.code !== 0) {
    console.log(bad(`mishi-secret set falló: ${set.stderr || set.stdout}`));
    return;
  }
  steps.push({ name: `secreto ${secretNameDb}`, already: secretAlready });
  console.log(ok(secretAlready ? `secreto ${secretNameDb} ya existía (actualizado)` : `secreto ${secretNameDb} guardado`));

  // 3) namespace + Secret k8s.
  const nsGet = await run("kubectl", ["--context", spec.context, "get", "namespace", spec.namespace]);
  const nsAlready = nsGet.code === 0;
  if (!nsAlready) {
    const nsCreate = await run("kubectl", ["--context", spec.context, "create", "namespace", spec.namespace]);
    if (nsCreate.code !== 0) {
      console.log(bad(`crear namespace falló: ${nsCreate.stderr || nsCreate.stdout}`));
      return;
    }
  }
  steps.push({ name: `namespace ${spec.namespace}`, already: nsAlready });
  console.log(ok(nsAlready ? `namespace ${spec.namespace} ya existía` : `namespace ${spec.namespace} creado`));

  const sessionSecret = randomBytes(32).toString("hex");
  const secretGet = await run("kubectl", [
    "--context", spec.context, "-n", spec.namespace, "get", "secret", k8sSecretName,
  ]);
  const k8sSecretAlready = secretGet.code === 0;
  const applySecret = await run("kubectl", [
    "--context", spec.context, "-n", spec.namespace,
    "create", "secret", "generic", k8sSecretName,
    `--from-literal=DATABASE_URL=${databaseUrl}`,
    `--from-literal=SESSION_SECRET=${sessionSecret}`,
    "--dry-run=client", "-o", "yaml",
  ]);
  if (applySecret.code !== 0) {
    console.log(bad(`generar Secret k8s falló: ${applySecret.stderr || applySecret.stdout}`));
    return;
  }
  const secretFile = join(tmpdir(), `mke-app-init-${app}-${env}-secret.yaml`);
  writeFileSync(secretFile, applySecret.stdout);
  const applyR = await run("kubectl", ["--context", spec.context, "apply", "-f", secretFile]);
  if (applyR.code !== 0) {
    console.log(bad(`apply del Secret falló: ${applyR.stderr || applyR.stdout}`));
    return;
  }
  steps.push({ name: `Secret k8s ${k8sSecretName}`, already: k8sSecretAlready });
  console.log(ok(k8sSecretAlready ? `Secret ${k8sSecretName} ya existía (re-aplicado)` : `Secret ${k8sSecretName} creado`));

  // 4) DNS — reusa ensureDns (mismo mecanismo que `mke dns`/`mke expose`).
  const dnsOk = await ensureDns(host, env);
  steps.push({ name: `DNS ${host}`, already: false });
  if (!dnsOk) {
    console.log(warn("DNS no quedó verificado — revisá arriba; los demás pasos sí se completaron"));
  }

  // 5) host del front en static-mishi — SIEMPRE ambos entornos (stage+prod): el
  // ingress no depende de en qué env se provisionó la BD hoy.
  const staticResult = await ensureStaticHostPaso(app, subdominio);
  steps.push({ name: `host static-mishi`, already: staticResult?.already ?? false });

  // 6) resumen.
  console.log(`\n  ${info("resumen")}`);
  for (const s of steps) {
    console.log(`    ${s.already ? warn(`${s.name}: ya existía`) : ok(`${s.name}: creado`)}`);
  }
  console.log(dim(`\n  el resto del ciclo (deploy de la imagen, ingress del servicio) es \`mke deploy\` / \`mke expose\`.`));
  console.log("");
}

/** true si el rol ya existe en el postgres-mishi del namespace dado. */
async function roleExists(appSnake: string, dbNs: string): Promise<boolean> {
  const r = await run("kubectl", [
    "--context", EXEC_CONTEXT, "-n", dbNs,
    "exec", "-i", POD, "--",
    "psql", "-U", "postgres", "-tAc",
    `SELECT 1 FROM pg_roles WHERE rolname = '${appSnake}'`,
  ]);
  return r.code === 0 && r.stdout.trim() === "1";
}

async function mishiSecretExists(name: string): Promise<boolean> {
  const r = await run("mishi-secret", ["get", name]);
  return r.code === 0 && r.stdout.trim().length > 0;
}
