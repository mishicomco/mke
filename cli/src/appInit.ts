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

import { envOrThrow, hostFor } from "./mkeConfig.js";
import { EXEC_CONTEXT, POD, nsForEnv, toSnake } from "./dbProvision.js";
import { ensureDns } from "./dns.js";
import { run, ok, bad, info, warn, dim } from "./sh.js";
import { ensureStaticHostPaso, planStaticHosts } from "./staticHost.js";
import { regenerarCatalogos } from "./catalogo.js";
import {
  aplicarSecretK8s,
  asegurarNamespace,
  guardarSecretoDb,
  nombreSecretoDb,
  provisionarBd,
  roleExists,
} from "./provisionApp.js";

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
  const secretNameDb = nombreSecretoDb(app, env);
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
  //    La mecánica vive en `provisionApp.ts` — la comparte `mke deploy`, que
  //    converge lo que falte en SU entorno (cicatriz: la BD de prod no existía).
  console.log(info(`BD/rol \`${appSnake}\` en ${dbNs} (${EXEC_CONTEXT}/${POD})`));
  let databaseUrl: string;
  try {
    const r = await provisionarBd(app, appSnake, env);
    databaseUrl = r.databaseUrl;
    steps.push({ name: `BD/rol \`${appSnake}\``, already: r.already });
    console.log(ok(r.already ? `BD/rol \`${appSnake}\` ya existía (password re-asegurado)` : `BD/rol \`${appSnake}\` creado`));
  } catch (e) {
    console.log(bad(e instanceof Error ? e.message : String(e)));
    return;
  }

  // 2) password en mishi-secret (nunca por stdout).
  try {
    const secretAlready = await guardarSecretoDb(app, env, databaseUrl);
    steps.push({ name: `secreto ${secretNameDb}`, already: secretAlready });
    console.log(ok(secretAlready ? `secreto ${secretNameDb} ya existía (actualizado)` : `secreto ${secretNameDb} guardado`));
  } catch (e) {
    console.log(bad(e instanceof Error ? e.message : String(e)));
    return;
  }

  // 3) namespace + Secret k8s.
  try {
    const nsAlready = await asegurarNamespace(env);
    steps.push({ name: `namespace ${spec.namespace}`, already: nsAlready });
    console.log(ok(nsAlready ? `namespace ${spec.namespace} ya existía` : `namespace ${spec.namespace} creado`));

    const k8sSecretAlready = await aplicarSecretK8s(app, env, databaseUrl);
    steps.push({ name: `Secret k8s ${k8sSecretName}`, already: k8sSecretAlready });
    console.log(ok(k8sSecretAlready ? `Secret ${k8sSecretName} ya existía (re-aplicado)` : `Secret ${k8sSecretName} creado`));
  } catch (e) {
    console.log(bad(e instanceof Error ? e.message : String(e)));
    return;
  }

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

  // 6) grant del emisor del vault (decisión Santi 2026-07-19): toda app nace con
  //    grant `emitir` para su ns — sin esto, `mke preview up` recibe 403 del vault
  //    y degrada a sin-lease (causa raíz cazada el 2026-07-19). Idempotente
  //    (emisor:grant usa onConflictDoNothing). Best-effort: si el vault de stage
  //    no está, warning y se sigue (el backfill es re-corrible).
  const grant = await run("kubectl", [
    "--context", EXEC_CONTEXT, "-n", "stage",
    "exec", "deploy/vault-mishi", "--",
    "node", "/app/dist/scripts/grantEmisor.js", "mke-runner", app,
  ]);
  if (grant.code === 0) {
    steps.push({ name: `grant vault (emisor mke-runner → ${app})`, already: false });
    console.log(ok(`grant \`emitir\` del vault asegurado para ${app}`));
  } else {
    console.log(warn(`grant del vault falló (sigo; re-corre con: kubectl -n stage exec deploy/vault-mishi -- node /app/dist/scripts/grantEmisor.js mke-runner ${app}): ${(grant.stderr || grant.stdout).split("\n")[0]}`));
  }

  // 7) catálogo derivado: el ConfigMap `mke-catalogo` (stage+prod) se regenera
  //    de los ingress VIVOS. Best-effort, nunca fatal.
  await regenerarCatalogos();

  // 8) resumen.
  console.log(`\n  ${info("resumen")}`);
  for (const s of steps) {
    console.log(`    ${s.already ? warn(`${s.name}: ya existía`) : ok(`${s.name}: creado`)}`);
  }
  console.log(dim(`\n  el resto del ciclo (deploy de la imagen, ingress del servicio) es \`mke deploy\` / \`mke expose\`.`));
  console.log("");
}

// roleExists / el guardado del secreto / el Secret k8s viven en `provisionApp.ts`
// (los comparte `mke deploy` para converger la plataforma en cada despliegue).
