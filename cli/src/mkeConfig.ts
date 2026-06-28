// Conocimiento HORNEADO de MKE — lo que antes se re-diagnosticaba a mano cada vez.
// Fuente única de verdad para el CLI. Si la realidad cambia, se edita ACÁ.
//
// Hechos no obvios (descubiertos diagnosticando, 2026-06-28):
//  - stage y prod son NAMESPACES del MISMO cluster `k3d-mke-prod`.
//    `k3d-mke-stage` existe como contexto pero su namespace `stage` está vacío
//    (legacy). Aplicar al contexto equivocado da "namespaces stage not found".
//  - cloudflared corre como tunnels del HOST (systemd), NO in-cluster como dice
//    el viejo AI_CONTEXT.md de mke. Un tunnel por entorno.
//  - `cloudflared tunnel route dns <NOMBRE> <host>` puede enrutar al tunnel
//    equivocado (mandó a `lmstudio`); SIEMPRE usar el UUID + `--overwrite-dns`.

export interface EnvSpec {
  /** contexto kubectl */
  context: string;
  /** namespace dentro del cluster */
  namespace: string;
  /** UUID del tunnel cloudflared del host que sirve este entorno */
  tunnelUuid: string;
  /** sufijo del subdominio público: <app><suffix>.mishi.com.co */
  hostSuffix: string;
}

export const ENVS: Record<string, EnvSpec> = {
  local: {
    context: "k3d-mke-local",
    namespace: "local",
    tunnelUuid: "f312541c-c13b-4fbc-b342-b679e64e3228", // mke-local
    hostSuffix: "-local",
  },
  stage: {
    context: "k3d-mke-prod", // ¡stage vive en el cluster prod!
    namespace: "stage",
    tunnelUuid: "3ade5843-cfcc-4526-bbd0-a8256d1640ad", // mke-stage
    hostSuffix: "-stage",
  },
  prod: {
    context: "k3d-mke-prod",
    namespace: "prod",
    tunnelUuid: "dde2337f-7e0a-47b7-aec0-dfc9b10539af", // mke-prod
    hostSuffix: "",
  },
};

export const DOMAIN = "mishi.com.co";

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
