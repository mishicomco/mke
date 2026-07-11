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
 * Clúster de PREVIEWS (Studio v2 + `mke preview`). Cluster k3d SEPARADO del de
 * prod (nunca se toca mke-prod). Namespace `preview`; nombre/host de cada pod
 * los deriva `@mishicomco/dev-receta` (`previewPodName`/`previewPodHost`).
 *
 * El túnel `mke-preview` se crea en bootstrap-preview.sh; su UUID se resuelve en
 * runtime (`cloudflared tunnel list`) para no hardcodearlo. Zone id de la zona
 * mishi.com.co (para crear/borrar DNS vía API).
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
 * vault-mishi: emisor de LEASES efímeros app×rama para `mke preview` (Contrato 1).
 * URL horneada como los demás EnvSpec; override con `VAULT_URL`. El token de la
 * identidad EMISORA (DEDICADA, no root) se lee de `mishi-secret get
 * vault-mishi-emisor-token` en tiempo de uso — nunca acá. DEGRADACIÓN interina:
 * mientras el escenario 4 del vault no esté desplegado, `mke preview up` arranca
 * SIN lease (warning) y el pod corre igual para probar pod+DB+HMR.
 */
export const VAULT = {
  // el CLI corre en el laptop o en el runner (fuera del cluster del vault):
  // default = el host público de stage; dentro de un cluster, override VAULT_URL.
  url: process.env.VAULT_URL ?? "https://vault-stage.mishi.com.co",
  emisorTokenSecret: "vault-mishi-emisor-token",
} as const;

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
