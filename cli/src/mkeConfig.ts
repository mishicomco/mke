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
import { existsSync, readFileSync } from "node:fs";

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
  /**
   * Entorno que vive en OTRA máquina (migración prod→laptop 2026-08-06).
   * El contexto kubectl llega por un túnel SSH persistente (unit de usuario
   * `mke-prod-tunnel.service` en el pc gamer → API k3s del laptop), así que
   * kubectl/apply/rollout funcionan igual; SOLO la carga de imágenes cambia:
   * `docker save | ssh docker exec ctr images import` en vez de `k3d image
   * import` (k3d solo ve clusters locales).
   */
  remote?: { ssh: string; sshKey: string; nodo: string };
}

/**
 * Config POR NODO — el MISMO mkeConfig sirve en todas las máquinas de la flota
 * (pc gamer, laptop, futuras). Un nodo declara en `~/.config/mishi/mke-nodo.json`
 * qué entornos viven LOCALMENTE en él:
 *
 *   { "envsLocales": ["prod"] }        // el laptop, dueño de prod
 *
 * Para esos entornos se quita el `remote` (carga de imágenes vía k3d local) y
 * el contexto kubectl pasa a ser el del cluster local (`k3d-<cluster>`), sin
 * túnel SSH. Sin archivo, todo queda como está declarado en ENVS (el pc gamer
 * no necesita ninguno). Override de ruta con MKE_NODO_FILE (tests).
 * NUNCA duplicar este archivo de config por máquina — esa fue la alternativa
 * descartada (dos verdades que driftean).
 */
export function aplicarNodo(envs: Record<string, EnvSpec>): Record<string, EnvSpec> {
  const file = process.env.MKE_NODO_FILE ?? join(homedir(), ".config", "mishi", "mke-nodo.json");
  if (!existsSync(file)) return envs;
  let nodo: { envsLocales?: string[] };
  try {
    nodo = JSON.parse(readFileSync(file, "utf8"));
  } catch (e) {
    throw new Error(`mke-nodo.json ilegible (${file}): ${(e as Error).message}`);
  }
  for (const nombre of nodo.envsLocales ?? []) {
    const spec = envs[nombre];
    if (!spec) throw new Error(`mke-nodo.json declara env desconocido: ${nombre}`);
    if (!spec.remote) continue; // ya es local acá; nada que hacer
    envs[nombre] = { ...spec, context: `k3d-${spec.cluster}`, remote: undefined };
  }
  return envs;
}

export const ENVS: Record<string, EnvSpec> = aplicarNodo({
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
    // PROD VIVE EN EL LAPTOP desde 2026-08-06 (migración; ver memoria
    // handoff-migracion-prod-laptop). El contexto atraviesa el túnel SSH
    // persistente; el ns prod del cluster del pc gamer quedó congelado a 0
    // como rollback temporal — NO es prod.
    context: "mke-prod-laptop",
    cluster: "mke-prod", // nombre del cluster k3d EN el laptop (solo informativo aquí)
    namespace: "prod",
    tunnelUuid: "421fe55c-649e-4df2-baec-7273bd8b7e17", // mke-prod-laptop
    hostSuffix: "",
    hostGatewayIp: "172.18.0.1",
    remote: {
      ssh: "mishi@10.0.0.4",
      sshKey: "~/.ssh/acceso_laptop_key",
      nodo: "k3d-mke-prod-server-0",
    },
  },
});

export const DOMAIN = "mishi.com.co";

/**
 * Build-args PÚBLICOS que el `docker build` del frontend necesita y que antes
 * cada `ci-cd.yml` repetía a mano. NO son secretos (van horneados en el bundle):
 * el origen del IdP identity-mishi por entorno. Vive acá para que el workflow
 * delgado no tenga que saberlo.
 */
export function identityOrigin(env: string): string {
  return env === "prod" ? "https://identity.mishi.com.co" : "https://identity-stage.mishi.com.co";
}

/**
 * Secreto (vault-mishi) con el token del registry npm del forge, que autentica
 * el `npm ci` de los Dockerfiles contra `@mishicomco/*`. El CLI lo obtiene ÉL
 * MISMO en el pc gamer; el workflow ya no lo pasa. NUNCA se imprime.
 * Fallback: la env `NODE_AUTH_TOKEN` si ya viene puesta.
 */
export const NPM_TOKEN_SECRET = "git-mishi-npm-token";

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
 * vault-mishi — DUEÑO ÚNICO de la verdad de secretos del ecosistema. `mke` lo usa
 * en dos papeles:
 *
 *  1. **Emisor de LEASES** efímeros app×rama para `mke preview` (Contrato 1). El
 *     token de la identidad EMISORA (DEDICADA, no root) se lee de `vault-mishi
 *     get vault-mishi-emisor-token` en tiempo de uso — nunca acá. DEGRADACIÓN
 *     interina: si el vault no responde, `mke preview up` arranca SIN lease.
 *  2. **Fuente del Secret k8s `<app>-secrets`** (fase MATERIALIZAR de `mke
 *     deploy`, `secretosDelVault.ts`). Identidad propia `mke-runner-deploy`
 *     (tipo `ci`), token en un archivo 0600 fuera del repo — crearla con
 *     `scripts/crear-identidad-vault-mke.sh`.
 *
 * URL horneada como los demás EnvSpec; override con `VAULT_URL`.
 */
export const VAULT = {
  // el CLI corre en el laptop o en el runner (fuera del cluster del vault):
  // default = el host público de stage; dentro de un cluster, override VAULT_URL.
  url: process.env.VAULT_URL ?? "https://vault.mishi.com.co",
  emisorTokenSecret: "vault-mishi-emisor-token",
  /** identidad del runner que MATERIALIZA los Secrets k8s (lee ns de apps; escribe solo DATABASE_URL__*). */
  deployIdentidad: "mke-runner-deploy",
  /** archivo 0600 con el token de esa identidad. NUNCA en el repo ni en logs. */
  deployTokenFile:
    process.env.VAULT_DEPLOY_TOKEN_FILE ?? join(homedir(), ".config", "mishi", "vault-mke.token"),
  /** dónde vive el POD del vault que sirve `url` (para admin por kubectl exec,
   * p.ej. grants al nacer una app). Fuego R2 2026-08-08: los grants iban al
   * vault CONGELADO de stage (gamer) mientras las escrituras van al vivo de
   * prod (laptop desde 2026-08-07) → 403 en todo primer nacimiento. */
  podContext: process.env.VAULT_POD_CONTEXT ?? "mke-prod-laptop",
  podNamespace: process.env.VAULT_POD_NAMESPACE ?? "prod",
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
