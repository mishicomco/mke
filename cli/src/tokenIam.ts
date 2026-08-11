// ─── Provisioning automático del token IAM de una app ─────────────────────────
// La autorización del ecosistema es iam-mishi. Toda app estándar que consume el
// check central necesita un TOKEN DE APP (credencial con scope: solo /check y
// /declarar de SÍ misma). Antes esto era manual (emitir + guardar). Acá lo hace
// el deploy, idempotente:
//   1. ¿la app consume iam? = su Deployment referencia el Secret key IAM_API_TOKEN.
//   2. ¿el Secret ya lo tiene? → nada que hacer (reusar; sin churn de tokens).
//   3. si falta: leer la credencial de EMISOR del cluster (Secret de plataforma
//      iam-emisor), pedirle a iam-mishi que EMITA un token de app, y materializarlo
//      en el Secret <app>-secrets.
// El token es material DERIVADO (iam-mishi es la autoridad: lo hashea y puede
// revocar). No vive en el vault-ns de la app → no hace falta ampliar grants.
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { run, ok, bad, warn, info, dim } from "./sh.js";
import { envOrThrow } from "./mkeConfig.js";
import { mergearSecretK8s, clavesEnCluster } from "./secretosDelVault.js";
import type { AppSpec } from "./appSpec.js";

const IAM_KEY = "IAM_API_TOKEN";

// Host público de iam-mishi por entorno (dash-suffix en no-prod).
function iamHost(env: string): string {
  return env === "prod" ? "https://iam-mishi.mishi.com.co" : "https://iam-mishi-stage.mishi.com.co";
}

// ¿La app consume iam? El Deployment base referencia el Secret key IAM_API_TOKEN.
async function consumeIam(spec: AppSpec): Promise<boolean> {
  try {
    const yaml = await readFile(join(spec.dir, "k8s/base/deployment.yaml"), "utf8");
    return yaml.includes(`key: ${IAM_KEY}`);
  } catch {
    return false;
  }
}

// Credencial de EMISOR: la credencial de CI (residual #1 del Hallazgo 0,
// 2026-08-10). El runner ya NO porta el operador (super-poder que podía otorgar
// ecosistema/admin); porta el emisor, cuya capacidad ÚNICA es acuñar tokens de
// app — filtrar lo que el runner toca JAMÁS escala a admin. La lee del Secret de
// plataforma DEDICADO, en su propio namespace `iam-emisor` — NO del namespace de
// las apps ni del ns del operador (que salió del cluster por completo: vive solo
// en el vault). El runner la alcanza por un Role dedicado con
// `resourceNames: [iam-emisor]` (ver mke/clusters/rbac/emisor-access.yaml). mke
// corre al lado del cluster; no la guarda en ningún lado.
export const EMISOR_NS = "iam-emisor";
export const EMISOR_SECRET = "iam-emisor";

async function emisorToken(env: string): Promise<string | null> {
  const spec = envOrThrow(env);
  const r = await run("kubectl", [
    "--context", spec.context, "-n", EMISOR_NS,
    "get", "secret", EMISOR_SECRET,
    "-o", "jsonpath={.data.IAM_EMISOR_TOKEN}",
  ]);
  if (r.code !== 0 || !r.stdout.trim()) return null;
  try {
    return Buffer.from(r.stdout.trim(), "base64").toString("utf8");
  } catch {
    return null;
  }
}

// Pide a iam-mishi que emita un token de app. Devuelve el token en claro (una vez).
async function emitirTokenApp(env: string, emisor: string, app: string): Promise<string | null> {
  const res = await fetch(`${iamHost(env)}/v1/credenciales`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${emisor}`,
      "content-type": "application/json",
      "x-iam-actor": "mke-deploy",
    },
    body: JSON.stringify({ tipo: "app", app }),
  });
  if (!res.ok) {
    console.log(bad(`iam-mishi /v1/credenciales → HTTP ${res.status} (${await res.text().catch(() => "")})`));
    return null;
  }
  const data = (await res.json()) as { token?: string };
  return data.token ?? null;
}

/**
 * Asegura el token IAM de la app en su Secret. Idempotente. No aborta el deploy:
 * si algo falla, avisa y sigue (el /auth/me quedará fail-closed hasta arreglarlo,
 * que es el default seguro). Corre ANTES de materializar el resto del vault.
 */
export async function asegurarTokenIam(spec: AppSpec): Promise<void> {
  if (!(env2ok(spec.env))) return;
  if (!(await consumeIam(spec))) return; // la app no usa iam → nada que hacer

  const enCluster = (await clavesEnCluster(spec.app, spec.env)) ?? [];
  if (enCluster.includes(IAM_KEY)) {
    console.log(ok(`token IAM de ${dim(spec.app)} ya en el Secret (reuso; sin re-emitir)`));
    return;
  }

  const emisor = await emisorToken(spec.env);
  if (!emisor) {
    console.log(warn(`no leí la credencial de emisor de iam-mishi (${EMISOR_NS}/${EMISOR_SECRET}) — token IAM de ${spec.app} NO provisionado; el check quedará fail-closed`));
    return;
  }
  console.log(info(`emitiendo token de app para ${spec.app} en iam-mishi (${spec.env})…`));
  const token = await emitirTokenApp(spec.env, emisor, spec.app);
  if (!token) {
    console.log(warn(`no pude emitir el token IAM de ${spec.app} — sigo (check fail-closed hasta reintentar)`));
    return;
  }
  try {
    await mergearSecretK8s(spec.app, spec.env, { [IAM_KEY]: token });
    console.log(ok(`token IAM de ${dim(spec.app)} emitido y materializado en el Secret`));
  } finally {
    // no dejar el valor colgando en memoria más de lo necesario
  }
}

// Solo stage|prod hablan con iam-mishi (local/preview usan el fake de rama).
function env2ok(env: string): boolean {
  return env === "stage" || env === "prod";
}
