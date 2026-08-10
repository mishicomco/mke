// ─── Publicación del catálogo IAM declarado como código ───────────────────────
// Hermano de tokenIam.ts: aquel EMITE el token de app; éste USA ese token para
// publicar en iam-mishi el catálogo que la app declara en `mke.iam.yaml`
// (permisos + roles), en el preflight de `mke deploy` — antes del rollout.
//
// Contrato:
//   - sin `mke.iam.yaml` (o con puros comentarios) ⇒ NO se llama a iam-mishi.
//     Las apps que aún declaran desde su código en el boot (camino legacy, a
//     extinguir) siguen funcionando exactamente igual.
//   - manifiesto mal formado ⇒ ERROR duro (el deploy aborta): un catálogo
//     mutilado tombstonea permisos vivos y quita accesos sin querer.
//   - iam-mishi caído / token ausente ⇒ WARN, el deploy sigue: la declaración
//     anterior sigue vigente allá y los checks nunca se abren solos.
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { run, ok, bad, warn, info, dim } from "./sh.js";
import { envOrThrow } from "./mkeConfig.js";
import { iamManifiestoTieneCatalogo, parseIamManifiesto, type IamManifiesto } from "./iamManifiesto.js";
import type { AppSpec } from "./appSpec.js";

export const IAM_MANIFIESTO = "mke.iam.yaml";

// Host público de iam-mishi por entorno (dash-suffix en no-prod).
function iamHost(env: string): string {
  return env === "prod" ? "https://iam-mishi.mishi.com.co" : "https://iam-mishi-stage.mishi.com.co";
}

/** Lee y parsea el manifiesto de la app. `null` = no hay archivo. Parseo malo lanza. */
export async function leerManifiestoIam(spec: AppSpec): Promise<IamManifiesto | null> {
  let texto: string;
  try {
    texto = await readFile(join(spec.dir, IAM_MANIFIESTO), "utf8");
  } catch {
    return null;
  }
  return parseIamManifiesto(texto, spec.app);
}

// El token de app vive en el Secret k8s `<app>-secrets` (lo puso asegurarTokenIam;
// iam-mishi es su autoridad, no el vault).
async function tokenDeApp(spec: AppSpec): Promise<string | null> {
  const env = envOrThrow(spec.env);
  const r = await run("kubectl", [
    "--context", env.context, "-n", env.namespace,
    "get", "secret", spec.secretK8s,
    "-o", "jsonpath={.data.IAM_API_TOKEN}",
  ]);
  if (r.code !== 0 || !r.stdout.trim()) return null;
  try {
    return Buffer.from(r.stdout.trim(), "base64").toString("utf8");
  } catch {
    return null;
  }
}

/**
 * Publica el catálogo declarado en `mke.iam.yaml`. Idempotente (iam-mishi
 * reconcilia: activa lo declarado, tombstonea lo que desapareció).
 * Devuelve false SOLO cuando el deploy debe abortar (manifiesto inválido).
 */
export async function declararIam(spec: AppSpec): Promise<boolean> {
  if (spec.env !== "stage" && spec.env !== "prod") return true; // local/preview no hablan con iam real

  let manifiesto: IamManifiesto | null;
  try {
    manifiesto = await leerManifiestoIam(spec);
  } catch (e) {
    console.log(bad(`${IAM_MANIFIESTO}: ${e instanceof Error ? e.message : String(e)}`));
    return false;
  }
  if (!manifiesto) {
    console.log(dim(`  sin ${IAM_MANIFIESTO} — no se declara catálogo IAM (si la app declara en su boot, ese es el camino legacy).`));
    return true;
  }
  if (!iamManifiestoTieneCatalogo(manifiesto)) {
    console.log(dim(`  ${IAM_MANIFIESTO} sin permisos ni roles — nada que declarar (no se llama a iam-mishi).`));
    return true;
  }

  const token = await tokenDeApp(spec);
  if (!token) {
    console.log(warn(`sin IAM_API_TOKEN en ${spec.secretK8s} — catálogo IAM de ${spec.app} NO declarado (sigue vigente la declaración anterior)`));
    return true;
  }

  const cuerpo = {
    app: manifiesto.app,
    permisos: manifiesto.permisos,
    roles: manifiesto.roles,
  };
  console.log(info(`declarando catálogo IAM de ${dim(spec.app)}: ${manifiesto.permisos.length} permisos · ${manifiesto.roles.length} roles`));
  try {
    const res = await fetch(`${iamHost(spec.env)}/v1/declarar`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "x-iam-actor": "mke-deploy",
      },
      body: JSON.stringify(cuerpo),
    });
    if (!res.ok) {
      const detalle = await res.text().catch(() => "");
      // 400 = el manifiesto no pasa el modelo de iam-mishi (nombre/patrón
      // inválido): eso SÍ es un bug del repo, no del entorno → aborta.
      if (res.status === 400) {
        console.log(bad(`iam-mishi rechazó el catálogo de ${IAM_MANIFIESTO} (HTTP 400): ${detalle}`));
        return false;
      }
      console.log(warn(`iam-mishi /v1/declarar → HTTP ${res.status} (${detalle}) — catálogo NO actualizado; sigue el deploy`));
      return true;
    }
    const data = (await res.json()) as {
      permisos?: { activos: number; desactivados: number };
      roles?: { activos: number; desactivados: number };
    };
    console.log(
      ok(
        `catálogo IAM declarado — permisos ${data.permisos?.activos ?? "?"} activos / ${data.permisos?.desactivados ?? "?"} tombstoneados · ` +
          `roles ${data.roles?.activos ?? "?"} / ${data.roles?.desactivados ?? "?"}`,
      ),
    );
  } catch (e) {
    console.log(warn(`no pude hablar con iam-mishi (${e instanceof Error ? e.message : String(e)}) — catálogo NO actualizado; sigue el deploy`));
  }
  return true;
}
