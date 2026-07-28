// PREFLIGHT CONVERGENTE — fase (a) de `mke deploy`.
//
// Post-mortem del deploy de status-mishi a prod (2026-07-27): tres de los cinco
// incidentes fueron cosas que "alguien debió haber hecho antes" y nadie
// verificó en el momento del deploy —
//   (1) CNAME apuntando a un túnel muerto, sin detección,
//   (3) la BD de prod no existía (`app init` solo había provisionado stage),
//   (5) el host del front vivía en el overlay git de static-mishi pero NADIE
//       aplicó el ingress VIVO → 404 público.
//
// La cura no es un checklist humano: es que cada deploy CONVERJA lo que falte
// en SU entorno. Todo paso es check-before-create e idempotente — "ya existía"
// es OK, no error. Si algo no se puede converger, el preflight devuelve false y
// el deploy NO construye ni despliega nada.

import { join } from "node:path";

import { appsRoot, envOrThrow } from "./mkeConfig.js";
import type { AppSpec } from "./appSpec.js";
import { nsForEnv, toSnake } from "./dbProvision.js";
import { ensureDns } from "./dns.js";
import { STATIC_MISHI_REPO, ensureStaticHostPaso } from "./staticHost.js";
import {
  aplicarSecretK8s,
  asegurarNamespace,
  dbExists,
  guardarSecretoDb,
  leerSecretoDb,
  provisionarBd,
  roleExists,
  secretK8sExiste,
} from "./provisionApp.js";
import { run, ok, bad, warn, info, dim } from "./sh.js";

export interface PreflightOpts {
  /** no toca nada: solo dice qué convergería. */
  dryRun?: boolean;
  /** no toca el ingress de static-mishi (útil para apps sin front propio). */
  sinStatic?: boolean;
}

/** hosts que declara el ingress VIVO de static-mishi en el namespace del entorno. */
async function hostsVivosStatic(env: string): Promise<string[] | null> {
  const spec = envOrThrow(env);
  const r = await run("kubectl", [
    "--context", spec.context, "-n", spec.namespace,
    "get", "ingress", "static-mishi",
    "-o", 'jsonpath={range .spec.rules[*]}{.host}{"\\n"}{end}',
  ]);
  if (r.code !== 0) return null;
  return r.stdout.split("\n").map((h) => h.trim()).filter(Boolean);
}

/**
 * Asegura que el host del front esté en el ingress VIVO de static-mishi (no
 * solo en el overlay de git): agrega el host al overlay si falta (commit+push,
 * `staticHost.ts`) y APLICA el overlay al cluster. Sin esto, el front nuevo da
 * 404 hasta que alguien se acuerde de aplicar.
 */
async function convergerHostStatic(spec: AppSpec): Promise<boolean> {
  const vivos = await hostsVivosStatic(spec.env);
  if (vivos === null) {
    console.log(warn(`no pude leer el ingress de static-mishi en ${spec.env} — ¿está desplegado static-mishi?`));
    return false;
  }
  if (vivos.includes(spec.host)) {
    console.log(ok(`host ${dim(spec.host)} ya está en el ingress VIVO de static-mishi`));
    return true;
  }

  console.log(info(`host ${spec.host} FALTA en el ingress vivo de static-mishi → convergiendo`));
  await ensureStaticHostPaso(spec.app, spec.front);

  const env = envOrThrow(spec.env);
  const overlay = join(appsRoot(), STATIC_MISHI_REPO, "k8s", "overlays", spec.env);
  const apply = await run("kubectl", ["--context", env.context, "apply", "-k", overlay]);
  if (apply.code !== 0) {
    console.log(bad(`apply del ingress de static-mishi falló: ${(apply.stderr || apply.stdout).split("\n")[0]}`));
    return false;
  }
  const despues = await hostsVivosStatic(spec.env);
  if (despues?.includes(spec.host)) {
    console.log(ok(`host ${dim(spec.host)} aplicado al ingress VIVO de static-mishi`));
    return true;
  }
  console.log(bad(`el ingress vivo de static-mishi sigue sin ${spec.host} tras aplicar el overlay`));
  return false;
}

/** Converge BD + Secret k8s de la app en SU entorno. */
async function convergerBd(spec: AppSpec): Promise<boolean> {
  const dbNs = nsForEnv(spec.env);
  const appSnake = toSnake(spec.app);
  const bdYa = (await roleExists(appSnake, dbNs)) && (await dbExists(appSnake, dbNs));
  const secretYa = await secretK8sExiste(spec.app, spec.env);

  if (bdYa && secretYa) {
    console.log(ok(`BD \`${appSnake}\` en ${dim(dbNs)} y Secret ${dim(spec.secretK8s)} ya existían`));
    return true;
  }

  try {
    if (!bdYa) {
      const { databaseUrl } = await provisionarBd(spec.app, appSnake, spec.env);
      await guardarSecretoDb(spec.app, spec.env, databaseUrl);
      await aplicarSecretK8s(spec.app, spec.env, databaseUrl);
      console.log(ok(`BD \`${appSnake}\` creada en ${dim(dbNs)} + Secret ${dim(spec.secretK8s)} aplicado`));
      return true;
    }
    // BD viva pero sin Secret k8s: el password NO es recuperable de postgres —
    // se rescata de mishi-secret; si tampoco está, se re-provisiona (el SQL
    // re-asegura el password sin borrar datos).
    const guardado = await leerSecretoDb(spec.app, spec.env);
    if (guardado) {
      await aplicarSecretK8s(spec.app, spec.env, guardado);
      console.log(ok(`Secret ${dim(spec.secretK8s)} recreado desde mishi-secret (BD ya existía)`));
      return true;
    }
    const { databaseUrl } = await provisionarBd(spec.app, appSnake, spec.env);
    await guardarSecretoDb(spec.app, spec.env, databaseUrl);
    await aplicarSecretK8s(spec.app, spec.env, databaseUrl);
    console.log(warn(`Secret ${spec.secretK8s} no existía y el password no estaba guardado → password re-asegurado`));
    return true;
  } catch (e) {
    console.log(bad(`BD/Secret: ${e instanceof Error ? e.message : String(e)}`));
    return false;
  }
}

/**
 * Preflight completo. true = se puede seguir a la compuerta de migraciones.
 * Idempotente end-to-end; `--dry-run` solo imprime el plan.
 */
export async function preflightDeploy(spec: AppSpec, opts: PreflightOpts = {}): Promise<boolean> {
  const env = envOrThrow(spec.env);
  console.log(`\n  ${info(`preflight convergente — ${spec.app} (${spec.env}) → ${dim(spec.host)}`)}`);

  if (opts.dryRun) {
    console.log(`  1. namespace \`${env.namespace}\` (${env.context})`);
    console.log(`  2. BD/rol \`${spec.db}\` en ${nsForEnv(spec.env)} + Secret k8s \`${spec.secretK8s}\``);
    console.log(`  3. DNS ${spec.host} → tunnel ${env.tunnelUuid}`);
    console.log(`  4. ${spec.tieneFrontend && !opts.sinStatic ? `host ${spec.host} en el ingress VIVO de static-mishi (subPath \`${spec.front}\`)` : "sin front estático — no se toca static-mishi"}`);
    return true;
  }

  try {
    const nsYa = await asegurarNamespace(spec.env);
    console.log(ok(`namespace ${dim(env.namespace)} ${nsYa ? "ya existía" : "creado"}`));
  } catch (e) {
    console.log(bad(`namespace: ${e instanceof Error ? e.message : String(e)}`));
    return false;
  }

  if (!(await convergerBd(spec))) return false;

  // DNS: el CNAME se REPUNTA al túnel vivo del entorno aunque ya exista (el
  // post-mortem #1 fue un CNAME a un túnel muerto que nadie detectó).
  if (!(await ensureDns(spec.host, spec.env))) return false;

  if (spec.tieneFrontend && !opts.sinStatic) {
    if (!(await convergerHostStatic(spec))) return false;
  } else {
    console.log(dim("  sin front estático — no se toca el ingress de static-mishi."));
  }

  console.log(ok("preflight convergente: todo en su lugar"));
  return true;
}
