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

import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { VAULT, appsRoot, envOrThrow } from "./mkeConfig.js";
import { manifiestoVacio, parsePreviewManifest } from "./previewManifest.js";
import {
  accesoDeploy,
  clavesDelEntorno,
  clavesEnCluster,
  compararDeclaracion,
  leerValor,
  listarNombres,
  mergearSecretK8s,
  planMaterializacion,
  sufijoEnv,
} from "./secretosDelVault.js";
import type { AppSpec } from "./appSpec.js";
import { nsForEnv, toSnake } from "./dbProvision.js";
import { ensureDns } from "./dns.js";
import { STATIC_MISHI_REPO, ensureStaticHostPaso } from "./staticHost.js";
import { asegurarTokenIam } from "./tokenIam.js";
import { IAM_MANIFIESTO, declararIam, leerManifiestoIam } from "./declararIam.js";
import { advertenciasIam } from "./iamManifiesto.js";
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
    // se rescata de vault-mishi; si tampoco está, se re-provisiona (el SQL
    // re-asegura el password sin borrar datos).
    const guardado = await leerSecretoDb(spec.app, spec.env);
    if (guardado) {
      await aplicarSecretK8s(spec.app, spec.env, guardado);
      console.log(ok(`Secret ${dim(spec.secretK8s)} recreado desde vault-mishi (BD ya existía)`));
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
 * Declaración `secretos:` del `mke.preview.yaml` de la app. `null` = la app NO
 * declara (archivo ausente): se materializa igual, con WARN.
 */
async function declaracionSecretos(spec: AppSpec): Promise<string[] | null> {
  try {
    const texto = await readFile(join(spec.dir, "mke.preview.yaml"), "utf8");
    return parsePreviewManifest(texto, spec.app).secretos;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    // manifiesto ilegible: no es razón para tumbar el deploy de plataforma, pero
    // tampoco se puede comparar contra él.
    console.log(warn(`mke.preview.yaml ilegible (${e instanceof Error ? e.message : String(e)}) — sin compuerta de declaración`));
    return manifiestoVacio(spec.app).secretos.length ? [] : null;
  }
}

/**
 * FASE MATERIALIZAR — el Secret k8s `<app>-secrets` es DERIVADO del vault.
 *
 * Lee del vault los nombres `*__<env>` del ns de la app, trae sus valores y los
 * MERGEA al Secret (patch merge; jamás replace). El vault MANDA sobre el
 * cluster; lo que el vault no conoce se conserva y se avisa como huérfano.
 * Compuerta de DECLARACIÓN contra `mke.preview.yaml` (ver `compararDeclaracion`).
 *
 * Devuelve false SOLO si la declaración exige un secreto que el vault no tiene:
 * cualquier otro problema (vault caído, sin token, sin grant) degrada con WARN —
 * el vault es un SPOF asumido y el cluster ya tiene lo materializado antes.
 */
async function materializarSecretos(spec: AppSpec): Promise<boolean> {
  if (!sufijoEnv(spec.env)) {
    console.log(dim(`  entorno ${spec.env} fuera del vault (solo stage|prod) — sin materializar.`));
    return true;
  }

  const acc = await accesoDeploy();
  if (!acc) {
    console.log(warn(`sin token de la identidad ${VAULT.deployIdentidad} (${VAULT.deployTokenFile}) — Secret NO materializado; corré scripts/crear-identidad-vault-mke.sh`));
    return true;
  }

  let nombres: string[];
  try {
    nombres = await listarNombres(acc, spec.app);
  } catch (e) {
    console.log(warn(`el vault no respondió (${e instanceof Error ? e.message : String(e)}) — sigo con lo ya materializado en el cluster`));
    return true;
  }

  const delVault = clavesDelEntorno(nombres, spec.env);
  const enCluster = (await clavesEnCluster(spec.app, spec.env)) ?? [];
  const plan = planMaterializacion(delVault, enCluster);

  // Compuerta de declaración (ver la nota de transición en compararDeclaracion).
  const declarados = await declaracionSecretos(spec);
  if (declarados === null) {
    console.log(warn(`${spec.app} no tiene mke.preview.yaml — sin declaración de secretos (solo materializo)`));
  } else {
    const cmp = compararDeclaracion(declarados, delVault.map((c) => c.clave));
    if (cmp.faltantes.length) {
      console.log(bad(`declarados en mke.preview.yaml y AUSENTES del vault para ${spec.env}: ${cmp.faltantes.join(", ")} — falta el VALOR (guardalo: vault-mishi set ${spec.app}/<CLAVE>__${spec.env})`));
      return false;
    }
    if (cmp.noDeclarados.length) {
      console.log(warn(`en el vault y NO declarados en mke.preview.yaml: ${cmp.noDeclarados.join(", ")} (transición; se materializan igual)`));
    }
  }

  if (plan.huerfanas.length) {
    console.log(warn(`clave huérfana no rescatada (vive solo en el cluster, el vault no la conoce): ${plan.huerfanas.join(", ")}`));
  }
  // Cookie por ambiente (ley "un frasco por ambiente", 2026-08-11): TODO deploy
  // de stage lleva IDENTITY_COOKIE_NAME=mishi_sesion_stage en su Secret — el
  // SDK ≥0.10.0 la lee como default y así stage nunca vuelve a pisar la sesión
  // de prod en el dominio compartido. Sintética del CLI: no viene del vault ni
  // exige declaración en mke.preview.yaml.
  const sinteticos: Record<string, string> =
    spec.env === "stage" ? { IDENTITY_COOKIE_NAME: "mishi_sesion_stage" } : {};

  if (!plan.aMaterializar.length) {
    if (Object.keys(sinteticos).length) await mergearSecretK8s(spec.app, spec.env, sinteticos);
    console.log(ok(`el vault no tiene secretos de ${spec.app} para ${spec.env} — nada que materializar`));
    return true;
  }

  const valores: Record<string, string> = { ...sinteticos };
  try {
    for (const { clave, nombre } of plan.aMaterializar) {
      valores[clave] = await leerValor(acc, spec.app, nombre); // el valor NUNCA se imprime
    }
    await mergearSecretK8s(spec.app, spec.env, valores);
  } catch (e) {
    console.log(warn(`materialización incompleta (${e instanceof Error ? e.message : String(e)}) — sigo con lo ya materializado`));
    return true;
  } finally {
    for (const k of Object.keys(valores)) valores[k] = "";
  }
  console.log(ok(`Secret ${dim(spec.secretK8s)} materializado del vault: ${plan.aMaterializar.length} clave(s)`));
  return true;
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
    console.log(`  3. MATERIALIZAR \`${spec.secretK8s}\` desde el vault (${sufijoEnv(spec.env) ? `${VAULT.url} ns \`${spec.app}\`, nombres \`*__${spec.env}\`` : `${spec.env} fuera del vault — no aplica`}) + compuerta de declaración de mke.preview.yaml`);
    let manifiestoDry: import("./iamManifiesto.js").IamManifiesto | null = null;
    let iamError: string | null = null;
    try {
      manifiestoDry = await leerManifiestoIam(spec);
    } catch (e) {
      iamError = e instanceof Error ? e.message : String(e);
    }
    if (iamError) {
      // Un manifiesto inválido ABORTA el deploy real: no sepultamos el error bajo
      // los pasos siguientes — cortamos el plan aquí, como cortaría el deploy.
      console.log(`  4. catálogo IAM desde \`${IAM_MANIFIESTO}\`:`);
      console.log(bad(`     ${IAM_MANIFIESTO} INVÁLIDO — el deploy REAL ABORTARÍA AQUÍ (no se ejecutaría ningún paso posterior): ${iamError}`));
      console.log(dim("  (plan truncado: arregla el manifiesto y vuelve a correr --dry-run)"));
      return true;
    }
    const iamPlan = manifiestoDry
      ? `${manifiestoDry.permisos.length} permisos + ${manifiestoDry.roles.length} roles → iam-mishi /v1/declarar`
      : `sin ${IAM_MANIFIESTO} — no se declara catálogo`;
    console.log(`  4. catálogo IAM desde \`${IAM_MANIFIESTO}\`: ${iamPlan}`);
    if (manifiestoDry) {
      for (const aviso of advertenciasIam(manifiestoDry)) console.log(warn(`     ${aviso}`));
    }
    console.log(`  5. DNS ${spec.host} → tunnel ${env.tunnelUuid}`);
    console.log(`  6. ${spec.tieneFrontend && spec.frontEstatico && !opts.sinStatic ? `host ${spec.host} en el ingress VIVO de static-mishi (subPath \`${spec.front}\`)` : "sin front estático — no se toca static-mishi"}`);
    return true;
  }

  try {
    const nsYa = await asegurarNamespace(spec.env);
    console.log(ok(`namespace ${dim(env.namespace)} ${nsYa ? "ya existía" : "creado"}`));
  } catch (e) {
    console.log(bad(`namespace: ${e instanceof Error ? e.message : String(e)}`));
    return false;
  }

  // BD/Secret solo si la app tiene migraciones (forma derivada del árbol):
  // una app sin drizzle no usa la BD de plataforma — provisionarla sería
  // crear una BD vacía sin dueño real (caso travelhabitco).
  if (spec.tieneDrizzle) {
    if (!(await convergerBd(spec))) return false;
  } else {
    console.log(ok("sin drizzle/ en el repo — BD y Secret de plataforma no aplican"));
  }

  // TOKEN IAM: si la app consume la autorización central (iam-mishi), asegura su
  // token de app en el Secret (emite en iam-mishi si falta; idempotente). Va
  // ANTES de materializar para que la clave IAM_API_TOKEN ya esté en el Secret;
  // no es un secreto del vault (iam-mishi es su autoridad) → no pasa por la
  // compuerta de declaración de mke.preview.yaml.
  await asegurarTokenIam(spec);

  // CATÁLOGO IAM: la app DECLARA como código sus permisos/roles en
  // `mke.iam.yaml` (raíz del repo) y el deploy los publica en iam-mishi con el
  // token de app recién asegurado. Sin manifiesto no se declara nada.
  if (!(await declararIam(spec))) return false;

  // MATERIALIZAR: el Secret k8s es DERIVADO del vault (dueño de la verdad).
  // Va DESPUÉS de la BD (que escribe DATABASE_URL al vault) y ANTES del build,
  // para que el rollout levante pods con el Secret ya al día.
  if (!(await materializarSecretos(spec))) return false;

  // DNS: el CNAME se REPUNTA al túnel vivo del entorno aunque ya exista (el
  // post-mortem #1 fue un CNAME a un túnel muerto que nadie detectó).
  if (!(await ensureDns(spec.host, spec.env))) return false;

  if (spec.tieneFrontend && spec.frontEstatico && !opts.sinStatic) {
    if (!(await convergerHostStatic(spec))) return false;
  } else {
    console.log(dim("  sin front estático — no se toca el ingress de static-mishi."));
  }

  console.log(ok("preflight convergente: todo en su lugar"));
  return true;
}
