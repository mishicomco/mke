// Conocimiento HORNEADO de MKE — lo que antes se re-diagnosticaba a mano cada vez.
// Fuente única de verdad para el CLI. Si la realidad cambia, se edita ACÁ.
//
// Hechos no obvios (descubiertos diagnosticando, 2026-06-28):
//  - Un SOLO cluster en el PC gamer: `k3d-mke-prod`, con stage y prod como
//    NAMESPACES del mismo cluster. El cluster/contexto/tunnel `mke-stage` se
//    eliminó (era legacy y confuso). Aplicar al contexto equivocado da
//    "namespaces stage not found".
//  - El cluster lo sirve un solo tunnel cloudflared `mke-prod` (in-cluster, ns
//    cloudflare); `mke-local` sirve el cluster del laptop.
//  - `cloudflared tunnel route dns <NOMBRE> <host>` puede enrutar al tunnel
//    equivocado (mandó a `lmstudio`); SIEMPRE usar el UUID + `--overwrite-dns`.
//  - Para exponer un servicio del HOST a través del cluster NO sirve un Service
//    ExternalName: Traefik los rechaza por defecto (allowExternalNameServices=
//    false) → 404. Se usa Service sin selector + Endpoints a la IP del gateway
//    docker del cluster (el host), que Traefik sí enruta. El host escucha en
//    0.0.0.0 y es alcanzable desde el cluster en esa IP.

import { homedir } from "node:os";
import { join } from "node:path";

export interface EnvSpec {
  /** contexto kubectl */
  context: string;
  /** nombre del cluster k3d (para `k3d image import -c <cluster>`) */
  cluster: string;
  /** namespace dentro del cluster */
  namespace: string;
  /** UUID del tunnel cloudflared del host que sirve este entorno */
  tunnelUuid: string;
  /** sufijo del subdominio público: <app><suffix>.mishi.com.co */
  hostSuffix: string;
  /** IP del gateway docker del cluster = el host, para servicios del host */
  hostGatewayIp: string;
}

export const ENVS: Record<string, EnvSpec> = {
  local: {
    context: "k3d-mke-local",
    cluster: "mke-local",
    namespace: "local",
    tunnelUuid: "f312541c-c13b-4fbc-b342-b679e64e3228", // mke-local
    hostSuffix: "-local",
    hostGatewayIp: "172.18.0.1",
  },
  stage: {
    context: "k3d-mke-prod", // ¡stage vive en el cluster prod!
    cluster: "mke-prod",
    namespace: "stage",
    tunnelUuid: "dde2337f-7e0a-47b7-aec0-dfc9b10539af", // mke-prod (el cluster ÚNICO lo sirve este tunnel; mke-stage 3ade5843 es legacy, NO enruta a Traefik)
    hostSuffix: "-stage",
    hostGatewayIp: "172.20.0.1",
  },
  prod: {
    context: "k3d-mke-prod",
    cluster: "mke-prod",
    namespace: "prod",
    tunnelUuid: "dde2337f-7e0a-47b7-aec0-dfc9b10539af", // mke-prod
    hostSuffix: "",
    hostGatewayIp: "172.20.0.1",
  },
};

export const DOMAIN = "mishi.com.co";

/**
 * Clúster de PREVIEWS por FEATURE (Studio v2). Cluster k3d SEPARADO del de prod
 * (nunca se toca mke-prod). Cada feature = un namespace efímero; cada preview
 * lleva su propio postgres efímero y su CNAME `<slugApp>-<feature>-pre.mishi.com.co`
 * (el slug público de la app al inicio para que con muchas apps se sepa qué es qué).
 *
 * El túnel `mke-preview` se crea en bootstrap-preview.sh; su UUID se resuelve en
 * runtime (`cloudflared tunnel list`) para no hardcodearlo. Zone id de la zona
 * mishi.com.co (para borrar DNS vía API en `preview down`).
 */
export const PREVIEW = {
  context: "k3d-mke-preview",
  cluster: "mke-preview",
  tunnelName: "mke-preview",
  /** sufijo público: `<slugApp>-<feature>-pre.mishi.com.co` (patrón con GUIÓN, sin wildcard). */
  hostSuffix: "-pre",
  /** zona Cloudflare de mishi.com.co (constante; la descubrió el token dns-api). */
  zoneId: "00efc72c39940d1e3c22f2916641efc0",
} as const;

/**
 * host público de un preview: `<nombre>-pre.mishi.com.co`, donde `nombre` es
 * `<slugApp>-<feature>` (ej. bank-studio-escenarios-pre.mishi.com.co).
 */
export function previewHost(nombre: string): string {
  return `${nombre}${PREVIEW.hostSuffix}.${DOMAIN}`;
}

/**
 * nombre completo del preview: `<slugApp>-<feature>`. Si el feature ya empieza
 * con el slug (rama `bank-fix-x` con slug `bank`), no lo duplica.
 */
export function previewName(slug: string, feature: string): string {
  return feature === slug || feature.startsWith(`${slug}-`) ? feature : `${slug}-${feature}`;
}

/**
 * slug de una rama git → nombre de feature apto para DNS/namespace:
 * minúsculas, `/` y no-alfanumérico → `-`, colapsa y recorta guiones, máx 40.
 * ej: `feat/Cobros-Omni` → `feat-cobros-omni`; `studio-escenarios` igual.
 */
export function slugFeature(rama: string): string {
  const s = rama
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/^-+|-+$/g, "");
  if (!s) throw new Error(`no pude derivar un feature válido de la rama '${rama}'`);
  return s;
}

/** host público por convención; el id interno del app puede diferir del subdominio. */
export function hostFor(app: string, env: string): string {
  const spec = ENVS[env];
  if (!spec) throw new Error(`entorno desconocido: ${env} (usa local|stage|prod)`);
  return `${app}${spec.hostSuffix}.${DOMAIN}`;
}

export function envOrThrow(env: string): EnvSpec {
  const spec = ENVS[env];
  if (!spec) throw new Error(`entorno desconocido: ${env} (usa local|stage|prod)`);
  return spec;
}

/**
 * Raíz del workspace donde viven los repos de las apps como hermanos
 * (`<appsRoot>/<app>`). Override con MKE_APPS_ROOT; default ~/mishicomco.
 * El CLI vive en `<appsRoot>/mke/cli`, pero al correr desde un git worktree
 * la ruta relativa no aplica, así que se fija por convención/env.
 */
export function appsRoot(): string {
  return process.env.MKE_APPS_ROOT ?? join(homedir(), "mishicomco");
}
