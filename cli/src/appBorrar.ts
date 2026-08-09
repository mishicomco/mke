// `mke app borrar <app>` — TEARDOWN de una app, el inverso de `mke app nacer`.
// Nació de la prueba de fuego de nacimiento (2026-08-08): nacer era un comando
// pero borrar no tenía camino oficial, así que el desmontaje a mano era un
// campo minado (guardarraíles de DNS, clasificador, pasos olvidados). Un verbo
// nombrado y confirmado es el camino limpio.
//
// Deshace, en orden inverso, lo que dejó init/nacer:
//   1. k8s      → borra deploy/svc/ingress/Secret de la app en el ns del env
//   2. BD+rol   → DROP DATABASE + DROP ROLE en postgres-mishi (del env)
//   3. DNS      → borra el CNAME <host> (teardownApp: salta el guardarraíl efímero)
//   4. static   → quita el host de los overlays de static-mishi + commit/push
//   5. forge    → borra el repo mishicomco/<app> del forge
//   6. dir      → borra el checkout local (opt-in con --dir-local)
//   7. catálogo → regenera el ConfigMap mke-catalogo (deriva de los ingress vivos)
//
// GUARDARRAÍLES (destructivo e irreversible):
//   - exige --si (confirmación explícita). Sin ella, solo imprime el plan.
//   - prod exige ADEMÁS --si-prod (doble llave; el default es stage).
//   - cada paso es best-effort e idempotente: re-correr limpia lo que quedó.
//
// El VAULT no expone borrado de valor por API (solo grants), así que los
// secretos `<app>/DATABASE_URL__<env>` quedan huérfanos pero inertes (sin BD ni
// rol no sirven). Se reportan como pendiente; el store es versionado/auditado.

import { execFileSync, execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync } from "node:fs";
import { join } from "node:path";

import { deleteRecordsByName } from "./cf.js";
import { EXEC_CONTEXT, POD, nsForEnv, toSnake } from "./dbProvision.js";
import { FORGE, forgeDeleteRepo, secretGet } from "./forgeRepo.js";
import { appsRoot, envOrThrow, hostFor } from "./mkeConfig.js";
import { regenerarCatalogos } from "./catalogo.js";
import { accesoDeploy, borrarValor, nombreDatabaseUrl } from "./secretosDelVault.js";
import { removeStaticHosts, commitAndPushStaticHostsRemoval } from "./staticHost.js";
import { run, ok, bad, info, warn, dim } from "./sh.js";

const execFileAsync = promisify(execFile);

export interface AppBorrarOpts {
  env?: string;
  /** dominio público si difiere del id interno (default: mismo nombre). */
  subdominio?: string;
  /** confirmación obligatoria: sin esto solo imprime el plan. */
  si?: boolean;
  /** segunda llave para prod. */
  siProd?: boolean;
  /** además del footprint de plataforma, borra el checkout local ~/mishicomco/<app>. */
  dirLocal?: boolean;
  /** además, borra el repo mishicomco/<app> del forge (irreversible). */
  forge?: boolean;
}

interface Paso {
  nombre: string;
  estado: "ok" | "salteado" | "warn";
  detalle: string;
}

export async function appBorrar(app: string, opts: AppBorrarOpts): Promise<void> {
  const env = opts.env ?? "stage";
  const spec = envOrThrow(env);
  const appSnake = toSnake(app);
  const subdominio = opts.subdominio ?? app;
  const host = hostFor(subdominio, env);
  const dbNs = nsForEnv(env);
  const dir = join(appsRoot(), app);

  console.log(`\n  mke app borrar ${dim(app)} (${env}) → ${dim(host)}\n`);

  // ── Plan / guardarraíl de confirmación ─────────────────────────────────────
  const plan = [
    `  1. k8s: borra deploy/svc/ingress/Secret \`${app}\` en ns \`${spec.namespace}\` (${spec.context})`,
    `  2. BD+rol: DROP DATABASE ${appSnake} + DROP ROLE ${appSnake} en ${dbNs} (${EXEC_CONTEXT}/${POD})`,
    `  2b. vault: borra el secreto ${app}/DATABASE_URL__${env}`,
    `  3. DNS: borra el CNAME ${host}`,
    `  4. static-mishi: quita el host de los overlays (stage+prod) + commit/push`,
    opts.forge ? `  5. forge: borra el repo ${FORGE.org}/${app} (IRREVERSIBLE)` : `  5. forge: ${dim("SALTEADO (pasá --forge para borrar el repo)")}`,
    opts.dirLocal ? `  6. dir local: borra ${dir}` : `  6. dir local: ${dim("SALTEADO (pasá --dir-local para borrar el checkout)")}`,
    `  7. catálogo: regenera mke-catalogo`,
  ];

  if (!opts.si) {
    console.log(warn("DESTRUCTIVO e IRREVERSIBLE — nada se tocó (falta --si). Plan:"));
    for (const l of plan) console.log(l);
    console.log(dim(`\n  confirmá con: mke app borrar ${app} --env ${env} --si${env === "prod" ? " --si-prod" : ""}${opts.forge ? " --forge" : ""}${opts.dirLocal ? " --dir-local" : ""}`));
    console.log("");
    return;
  }
  if (env === "prod" && !opts.siProd) {
    console.log(bad(`borrar en PROD exige la doble llave: agregá --si-prod`));
    process.exitCode = 1;
    return;
  }

  const pasos: Paso[] = [];

  // ── 1) k8s ─────────────────────────────────────────────────────────────────
  {
    const r = await run("kubectl", [
      "--context", spec.context, "-n", spec.namespace,
      "delete", "deploy,svc,ingress,secret", app, `${app}-secrets`,
      "--ignore-not-found",
    ]);
    // el arg app aplica a deploy/svc/ingress; ${app}-secrets al secret. kubectl
    // avisa NotFound de los cruces — inofensivo. Éxito = exit 0.
    if (r.code === 0) {
      pasos.push({ nombre: "k8s", estado: "ok", detalle: `deploy/svc/ingress/Secret de ${app} borrados de ${spec.namespace}` });
      console.log(ok(`k8s: recursos de ${app} borrados de ${spec.namespace}`));
    } else {
      pasos.push({ nombre: "k8s", estado: "warn", detalle: `kubectl delete devolvió ${r.code}: ${(r.stderr || r.stdout).split("\n").slice(-2).join(" · ")}` });
      console.log(warn(`k8s: borrado parcial (${r.code}) — revisá; sigo`));
    }
  }

  // ── 2) BD + rol ──────────────────────────────────────────────────────────
  {
    // Cierra conexiones vivas, DROP DATABASE, DROP ROLE. Por stdin (no -c) para
    // no exponer nada por args; ON_ERROR_STOP para fallar ruidoso.
    const sql = [
      "\\set ON_ERROR_STOP on",
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${appSnake}' AND pid <> pg_backend_pid();`,
      `DROP DATABASE IF EXISTS ${appSnake};`,
      `DROP ROLE IF EXISTS ${appSnake};`,
    ].join("\n");
    const r = await run("kubectl", [
      "--context", EXEC_CONTEXT, "-n", dbNs,
      "exec", "-i", POD, "--", "psql", "-U", "postgres",
    ], sql);
    if (r.code === 0) {
      pasos.push({ nombre: "BD+rol", estado: "ok", detalle: `DATABASE+ROLE ${appSnake} borrados de ${dbNs}` });
      console.log(ok(`BD+rol: ${appSnake} borrado de ${dbNs}`));
    } else {
      pasos.push({ nombre: "BD+rol", estado: "warn", detalle: `psql devolvió ${r.code}: ${(r.stderr || r.stdout).split("\n").slice(-2).join(" · ")}` });
      console.log(warn(`BD+rol: no se pudo borrar del todo (${r.code}) — revisá; sigo`));
    }
  }

  // ── 2b) vault: borra el secreto DATABASE_URL__<env> (no dejar huérfanos) ────
  if (env === "stage" || env === "prod") {
    try {
      const acc = await accesoDeploy();
      if (!acc) {
        pasos.push({ nombre: "vault", estado: "warn", detalle: `sin token de mke-runner-deploy: el secreto DATABASE_URL__${env} NO se borró` });
        console.log(warn(`vault: sin token, DATABASE_URL__${env} no borrado`));
      } else {
        const { borrado } = await borrarValor(acc, app, nombreDatabaseUrl(env));
        pasos.push({ nombre: "vault", estado: borrado ? "ok" : "salteado", detalle: borrado ? `secreto ${app}/DATABASE_URL__${env} borrado` : `no había secreto ${app}/DATABASE_URL__${env}` });
        console.log(borrado ? ok(`vault: ${app}/DATABASE_URL__${env} borrado`) : info(`vault: no había ${app}/DATABASE_URL__${env}`));
      }
    } catch (e) {
      pasos.push({ nombre: "vault", estado: "warn", detalle: `no se pudo borrar el secreto: ${e instanceof Error ? e.message : String(e)}` });
      console.log(warn(`vault: ${e instanceof Error ? e.message : String(e)}`));
    }
  }

  // ── 3) DNS ─────────────────────────────────────────────────────────────────
  try {
    const n = await deleteRecordsByName(host, { teardownApp: true });
    pasos.push({ nombre: "DNS", estado: n > 0 ? "ok" : "salteado", detalle: n > 0 ? `${n} record(s) de ${host} borrados` : `no había records de ${host}` });
    console.log(n > 0 ? ok(`DNS: ${n} record(s) de ${host} borrados`) : info(`DNS: no había records de ${host}`));
  } catch (e) {
    pasos.push({ nombre: "DNS", estado: "warn", detalle: `no se pudo borrar el CNAME: ${e instanceof Error ? e.message : String(e)}` });
    console.log(warn(`DNS: ${e instanceof Error ? e.message : String(e)}`));
  }

  // ── 4) static-mishi ──────────────────────────────────────────────────────
  try {
    const res = removeStaticHosts(subdominio);
    if (res.changed) {
      await commitAndPushStaticHostsRemoval(app, res);
      pasos.push({ nombre: "static-mishi", estado: "ok", detalle: `host quitado de los overlays + push` });
      console.log(ok(`static-mishi: host de ${subdominio} quitado (stage+prod) + push`));
    } else {
      pasos.push({ nombre: "static-mishi", estado: "salteado", detalle: `el host ya no estaba en los overlays` });
      console.log(info(`static-mishi: el host de ${subdominio} ya no estaba`));
    }
  } catch (e) {
    pasos.push({ nombre: "static-mishi", estado: "warn", detalle: `no se pudo quitar/pushear: ${e instanceof Error ? e.message : String(e)}` });
    console.log(warn(`static-mishi: ${e instanceof Error ? e.message : String(e)}`));
  }

  // ── 5) forge (opt-in) ──────────────────────────────────────────────────────
  if (opts.forge) {
    const apiToken = await secretGet(FORGE.apiTokenSecret);
    if (!apiToken) {
      pasos.push({ nombre: "forge", estado: "warn", detalle: `sin ${FORGE.apiTokenSecret}: repo NO borrado` });
      console.log(warn(`forge: sin token de API, repo ${FORGE.org}/${app} NO borrado`));
    } else {
      try {
        const { borrado } = await forgeDeleteRepo(app, apiToken);
        pasos.push({ nombre: "forge", estado: borrado ? "ok" : "salteado", detalle: borrado ? `repo ${FORGE.org}/${app} borrado` : `el repo ${FORGE.org}/${app} no existía` });
        console.log(borrado ? ok(`forge: repo ${FORGE.org}/${app} borrado`) : info(`forge: el repo ${FORGE.org}/${app} no existía`));
      } catch (e) {
        pasos.push({ nombre: "forge", estado: "warn", detalle: `no se pudo borrar el repo: ${e instanceof Error ? e.message : String(e)}` });
        console.log(warn(`forge: ${e instanceof Error ? e.message : String(e)}`));
      }
    }
  } else {
    pasos.push({ nombre: "forge", estado: "salteado", detalle: `repo conservado (sin --forge)` });
  }

  // ── 6) dir local (opt-in) ──────────────────────────────────────────────────
  if (opts.dirLocal) {
    if (existsSync(dir)) {
      try {
        await execFileAsync("rm", ["-rf", dir]);
        pasos.push({ nombre: "dir local", estado: "ok", detalle: `${dir} borrado` });
        console.log(ok(`dir local: ${dir} borrado`));
      } catch (e) {
        pasos.push({ nombre: "dir local", estado: "warn", detalle: `no se pudo borrar ${dir}: ${e instanceof Error ? e.message : String(e)}` });
        console.log(warn(`dir local: ${e instanceof Error ? e.message : String(e)}`));
      }
    } else {
      pasos.push({ nombre: "dir local", estado: "salteado", detalle: `${dir} no existía` });
    }
  } else {
    pasos.push({ nombre: "dir local", estado: "salteado", detalle: `checkout conservado (sin --dir-local)` });
  }

  // ── 7) catálogo ────────────────────────────────────────────────────────────
  await regenerarCatalogos();
  pasos.push({ nombre: "catálogo", estado: "ok", detalle: `mke-catalogo regenerado` });

  // ── resumen ────────────────────────────────────────────────────────────────
  console.log(`\n  ${info("resumen del borrado")}`);
  for (const p of pasos) {
    const linea = p.estado === "ok" ? ok(`${p.nombre}: ${p.detalle}`)
      : p.estado === "salteado" ? dim(`${p.nombre}: ${p.detalle}`)
      : warn(`${p.nombre}: ${p.detalle}`);
    console.log(`    ${linea}`);
  }
  console.log(dim(`\n  nota: si la app tenía secretos propios (más allá de DATABASE_URL), bórralos con: vault-mishi borrar ${app}/<CLAVE>`));
  console.log("");
}

// enPath: por si alguna verificación futura lo necesita (paridad con appNacer).
export function _binExiste(bin: string): boolean {
  try {
    execFileSync(process.platform === "win32" ? "where" : "which", [bin], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}
