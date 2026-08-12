// `mke preview up|push <app> <rama> --v2` — preview con IMAGEN REAL + canal de
// updates (opt-in; NO reemplaza v1, ver `preview.ts`). Diseño completo y
// justificación de cada decisión: `../../AI_PREVIEW_V2.md`.
//
// Reusa AL MÁXIMO lo que v1 y `mke deploy` ya construyeron: worktree/lease/DNS
// de `preview.ts` (exportados para esto), `cargarImagenes`/`describeCarga` de
// `mke deploy`, y el motor nuevo COMPARTIDO `volumenEstatico.ts` para el carril
// front (pensado también para `mke artifact publicar`, ver el diseño).

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { appsRoot, ENVS, identityOrigin, NPM_TOKEN_SECRET, PREVIEW } from "./mkeConfig.js";
import {
  previewPodName,
  previewPodHost,
  selectorDePreview,
  slugDev,
  DEV_BACKEND_PORT,
  DEV_CADDY_PORT,
  PREVIEW_SIN_LEASE,
} from "@mishicomco/dev-receta";
import {
  asegurarWorktree,
  worktreeDir,
  resolveRepoUrl,
  adquirirLease,
  leaseIdDe,
  leerManifiestoPreview,
  waitReachable,
  diagnosticarPodNoListo,
} from "./preview.js";
import { previewTunnelUuid } from "./dns.js";
import { upsertCname, tunnelTarget } from "./cf.js";
import { cargarImagenes, describeCarga } from "./cargaImagenes.js";
import { copiarArbolAPod, escribirVersionJson, type DestinoPod } from "./volumenEstatico.js";
import { run, ok, warn, info, dim } from "./sh.js";
import { paso, pasoStreamCmd } from "./progresoVivo.js";

const CTX = PREVIEW.context;
const NS = "preview";
// el cluster de PREVIEW es el MISMO que stage (mke-gamer, fusión 2026-08-10):
// reusamos su EnvSpec para `cargarImagenes` (registry local si el nodo lo
// declaró, si no `k3d image import` — retrocompat idéntica a `mke deploy`).
const CARGA_ENV = ENVS.stage;

export interface PreviewV2UpOpts {
  json?: boolean;
  dryRun?: boolean;
  repoUrl?: string;
  ttlSegundos?: number;
}

export interface PreviewV2PushOpts {
  json?: boolean;
}

function frontContainerName(): string { return "front"; }
function backendContainerName(): string { return "backend"; }

/** ruta interna que SIEMPRE responde 200 desde caddy mismo (no depende del
 * contenido del volumen `/srv/front`, que está VACÍO hasta el primer carril
 * front) — el readinessProbe del contenedor `front` pega acá, nunca a `/`:
 * si probara `/` con el volumen vacío, `try_files` cae a `/index.html`
 * (ausente) y el pod nunca converge, dejando el `rollout status` colgado
 * ANTES de que exista la oportunidad de copiar el primer `dist/`. */
const RUTA_LISTO = "/_mke/listo";

/** Caddyfile del pod v2: sirve `/srv/front` como SPA + proxea /api|/salud|/health al backend real. */
function caddyfileV2(forma: { frontend: boolean; backend: boolean }): string {
  if (!forma.frontend) {
    return `:${DEV_CADDY_PORT} {\n\thandle {\n\t\treverse_proxy 127.0.0.1:${DEV_BACKEND_PORT}\n\t}\n}\n`;
  }
  if (!forma.backend) {
    return `:${DEV_CADDY_PORT} {
\thandle ${RUTA_LISTO} {
\t\trespond "ok" 200
\t}
\thandle {
\t\troot * /srv/front
\t\tfile_server
\t\ttry_files {path} /index.html
\t}
}
`;
  }
  return `:${DEV_CADDY_PORT} {
\thandle ${RUTA_LISTO} {
\t\trespond "ok" 200
\t}
\thandle /api/* {
\t\treverse_proxy 127.0.0.1:${DEV_BACKEND_PORT}
\t}
\thandle /salud {
\t\treverse_proxy 127.0.0.1:${DEV_BACKEND_PORT}
\t}
\thandle /health* {
\t\treverse_proxy 127.0.0.1:${DEV_BACKEND_PORT}
\t}
\thandle {
\t\troot * /srv/front
\t\tfile_server
\t\ttry_files {path} /index.html
\t}
}
`;
}

// ─── Plano de datos PostgREST en preview (estándar nuevo, AI_GRADUACION.md) ───
// Una app convergida sirve sus datos por /datos → puerta → PostgREST → RLS.
// En preview eso se replica EN MINIATURA dentro del pod: sidecar PostgREST
// apuntando al sidecar Postgres efímero. Detección: sus migraciones traen RLS.

/** rol/db base de la app (misma derivación que appSpec): block-mishi → block_mishi */
export function dbDeApp(app: string): string {
  return app.replaceAll("-", "_");
}

/** ¿la app está convergida al estándar PostgREST? (migraciones con RLS) */
export function detectarDatosPostgrest(wt: string): boolean {
  const dir = join(wt, "apps", "backend", "drizzle");
  if (!existsSync(dir)) return false;
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".sql")) continue;
    if (/ROW LEVEL SECURITY/i.test(readFileSync(join(dir, f), "utf8"))) return true;
  }
  return false;
}

/** JWKS de AMBOS emisores vivos (la cookie es de dominio compartido). */
export async function jwksAmbosEmisores(): Promise<string> {
  const urls = ["https://identity.mishi.com.co/v1/llaves", "https://identity-stage.mishi.com.co/v1/llaves"];
  const keys: unknown[] = [];
  for (const u of urls) {
    try {
      const r = await fetch(u, { signal: AbortSignal.timeout(5000) });
      if (r.ok) keys.push(...((await r.json()) as { keys?: unknown[] }).keys ?? []);
    } catch {
      // un emisor caído no tumba el preview: con un JWKS alcanza
    }
  }
  if (!keys.length) throw new Error("no pude leer el JWKS de ningún emisor del IdP");
  return JSON.stringify({ keys });
}

/** initdb del sidecar: los roles del mundo PostgREST que las migraciones
 * esperan (guards `IF EXISTS rol`). Corre en cada pod nuevo (emptyDir fresco),
 * como superusuario `dev`, ANTES de que nada se conecte. Password fija:
 * loopback del pod efímero, no cruza el pod. */
function sqlRolesPreview(db: string): string {
  return [
    `CREATE ROLE ${db}_web NOLOGIN;`,
    `CREATE ROLE ${db}_pgrst LOGIN NOINHERIT PASSWORD 'preview';`,
    `GRANT ${db}_web TO ${db}_pgrst;`,
    `GRANT CONNECT ON DATABASE dev TO ${db}_pgrst;`,
  ].join("\n") + "\n";
}

const PGRST_PORT = 3010;
const PGRST_ADMIN_PORT = 3011;

interface ManifiestosV2Input {
  app: string;
  rama: string;
  imagenRef: string;
  sha: string;
  leaseId: string;
  leaseToken?: string;
  config: Record<string, string>;
  forma: { frontend: boolean; backend: boolean };
  /** app convergida al estándar PostgREST: db base + JWKS para el sidecar */
  datos?: { db: string; jwks: string } | null;
}

/** Namespace + Secret(lease) + ConfigMap(Caddyfile) + Deployment + Service + Ingress. */
export function manifiestosPreviewV2(inp: ManifiestosV2Input): Record<string, unknown>[] {
  const name = previewPodName(inp.app, inp.rama);
  const namespace = NS;
  const host = previewPodHost(inp.app, inp.rama);
  const labels: Record<string, string> = {
    "mke.preview/app": inp.app,
    "mke.preview/rama": slugDev(inp.rama),
    "mke.preview/lease": inp.leaseId,
    "mke.preview/v2": "true",
  };
  const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64");

  const namespaceObj = {
    apiVersion: "v1", kind: "Namespace",
    metadata: { name: namespace, labels: { "app.kubernetes.io/part-of": "mke-preview" } },
  };

  const leaseSecretObj = inp.leaseToken ? {
    apiVersion: "v1", kind: "Secret",
    metadata: { name: `${name}-lease`, namespace, labels },
    type: "Opaque",
    data: { LEASE_TOKEN: b64(inp.leaseToken) },
  } : null;
  const leaseTokenEnv = inp.leaseToken
    ? [{ name: "LEASE_TOKEN", valueFrom: { secretKeyRef: { name: `${name}-lease`, key: "LEASE_TOKEN" } } }]
    : [];

  const configMapObj = {
    apiVersion: "v1", kind: "ConfigMap",
    metadata: { name: `${name}-scripts`, namespace, labels },
    data: {
      Caddyfile: caddyfileV2(inp.forma),
      // initdb del sidecar postgres (solo apps convergidas): crea los roles
      // que las migraciones esperan por guard. Se monta el ConfigMap entero en
      // /docker-entrypoint-initdb.d — postgres solo ejecuta *.sql, el
      // Caddyfile lo ignora.
      ...(inp.datos ? { "01-roles-pgrst.sql": sqlRolesPreview(inp.datos.db) } : {}),
    },
  };

  const configEnv = Object.entries(inp.config).map(([k, value]) => ({ name: k, value }));
  const backendEnv = [
    { name: "APP", value: inp.app },
    { name: "RAMA", value: inp.rama },
    { name: "PREVIEW", value: "true" },
    { name: "PREVIEW_MODE", value: "true" },
    { name: "RAMA_ENCENDIDA", value: "true" },
    { name: "NODE_ENV", value: "production" },
    { name: "PORT", value: String(DEV_BACKEND_PORT) },
    { name: "DATABASE_URL", value: "postgres://dev:dev@127.0.0.1:5432/dev" },
    ...configEnv,
    ...leaseTokenEnv,
  ];

  const podLabels = { app: name, ...labels };

  const containers: Record<string, unknown>[] = [];
  if (inp.forma.backend) {
    containers.push({
      name: backendContainerName(),
      image: inp.imagenRef,
      imagePullPolicy: "IfNotPresent",
      env: backendEnv,
      // /salud = el health estándar del ecosistema (ley 2026-08-09); /health
      // era el del molde viejo y apps como block no lo sirven en raíz.
      readinessProbe: { httpGet: { path: "/salud", port: DEV_BACKEND_PORT }, periodSeconds: 3, failureThreshold: 60 },
    });
  }
  if (inp.forma.frontend) {
    containers.push({
      name: frontContainerName(),
      image: "caddy:2-alpine",
      command: ["caddy", "run", "--config", "/mke/Caddyfile", "--adapter", "caddyfile"],
      ports: [{ containerPort: DEV_CADDY_PORT }],
      readinessProbe: { httpGet: { path: RUTA_LISTO, port: DEV_CADDY_PORT }, periodSeconds: 3, failureThreshold: 60 },
      volumeMounts: [
        { name: "front", mountPath: "/srv/front" },
        { name: "scripts", mountPath: "/mke" },
      ],
    });
  } else {
    // backend-only: caddy igual sirve de único-origen del host público
    // (misma cadena que v1 backend-only) proxeando TODO al backend.
    containers.push({
      name: frontContainerName(),
      image: "caddy:2-alpine",
      command: ["caddy", "run", "--config", "/mke/Caddyfile", "--adapter", "caddyfile"],
      ports: [{ containerPort: DEV_CADDY_PORT }],
      readinessProbe: { httpGet: { path: "/health", port: DEV_CADDY_PORT }, periodSeconds: 3, failureThreshold: 60 },
      volumeMounts: [{ name: "scripts", mountPath: "/mke" }],
    });
  }

  if (inp.forma.backend) {
    containers.unshift({
      name: "postgres",
      image: "postgres:16-alpine",
      env: [
        { name: "POSTGRES_USER", value: "dev" },
        { name: "POSTGRES_PASSWORD", value: "dev" },
        { name: "POSTGRES_DB", value: "dev" },
        { name: "PGDATA", value: "/var/lib/postgresql/data/pgdata" },
      ],
      ports: [{ containerPort: 5432 }],
      readinessProbe: { exec: { command: ["pg_isready", "-U", "dev", "-d", "dev"] }, periodSeconds: 3, failureThreshold: 40 },
      volumeMounts: [
        { name: "pgdata", mountPath: "/var/lib/postgresql/data" },
        ...(inp.datos ? [{ name: "scripts", mountPath: "/docker-entrypoint-initdb.d" }] : []),
      ],
    });
  }

  if (inp.datos) {
    // la miniatura del plano de datos real: mismo binario, misma cadena
    // puerta→PostgREST→RLS, contra el sidecar efímero. k8s lo reinicia hasta
    // que postgres esté listo; la readiness (admin /ready) gatea el rollout.
    containers.push({
      name: "postgrest",
      image: "postgrest/postgrest:v12.2.12",
      env: [
        { name: "PGRST_DB_URI", value: `postgres://${inp.datos.db}_pgrst:preview@127.0.0.1:5432/dev` },
        { name: "PGRST_DB_SCHEMAS", value: "public" },
        { name: "PGRST_DB_ANON_ROLE", value: `${inp.datos.db}_web` },
        { name: "PGRST_JWT_SECRET", value: inp.datos.jwks },
        { name: "PGRST_SERVER_PORT", value: String(PGRST_PORT) },
        { name: "PGRST_ADMIN_SERVER_PORT", value: String(PGRST_ADMIN_PORT) },
        { name: "PGRST_DB_POOL", value: "2" },
      ],
      ports: [{ containerPort: PGRST_PORT }],
      readinessProbe: { httpGet: { path: "/ready", port: PGRST_ADMIN_PORT }, periodSeconds: 3, failureThreshold: 60 },
    });
  }

  const deploymentObj = {
    apiVersion: "apps/v1", kind: "Deployment",
    metadata: { name, namespace, labels, annotations: { "mke.preview/rama": inp.rama, "mke.preview/sha": inp.sha } },
    spec: {
      replicas: 1,
      strategy: { type: "Recreate" },
      selector: { matchLabels: { app: name } },
      template: {
        metadata: { labels: podLabels },
        spec: {
          securityContext: { fsGroup: 1000 },
          containers,
          volumes: [
            ...(inp.forma.frontend ? [{ name: "front", emptyDir: {} }] : []),
            ...(inp.forma.backend ? [{ name: "pgdata", emptyDir: {} }] : []),
            { name: "scripts", configMap: { name: `${name}-scripts`, defaultMode: 0o755 } },
          ],
        },
      },
    },
  };

  const serviceObj = {
    apiVersion: "v1", kind: "Service",
    metadata: { name, namespace, labels },
    spec: {
      selector: { app: name },
      ports: [
        { name: "web", port: 80, targetPort: DEV_CADDY_PORT },
        ...(inp.datos ? [{ name: "datos", port: PGRST_PORT, targetPort: PGRST_PORT }] : []),
      ],
    },
  };

  const ingressObj = {
    apiVersion: "networking.k8s.io/v1", kind: "Ingress",
    metadata: { name, namespace, labels },
    spec: { rules: [{ host, http: { paths: [{ path: "/", pathType: "Prefix", backend: { service: { name, port: { number: 80 } } } }] } }] },
  };

  // /datos del host preview → puerta (ForwardAuth) → sidecar PostgREST del pod.
  // Ingress SEPARADO (no IngressRoute) a propósito: `preview down` borra por
  // labels los kinds estándar (ingress incluido) — un CRD quedaría huérfano.
  // Los Middlewares son FIXTURES compartidos del ns preview (se aplican
  // idempotentes acá, no llevan labels de preview para que down no los toque).
  const middlewarePuerta = {
    apiVersion: "traefik.io/v1alpha1", kind: "Middleware",
    metadata: { name: "pgrst-puerta", namespace, labels: { "app.kubernetes.io/part-of": "mke-postgrest" } },
    spec: { forwardAuth: { address: "http://pgrst-puerta.stage.svc.cluster.local:3000/", authResponseHeaders: ["Authorization"] } },
  };
  const middlewareStrip = {
    apiVersion: "traefik.io/v1alpha1", kind: "Middleware",
    metadata: { name: "pgrst-strip-datos", namespace, labels: { "app.kubernetes.io/part-of": "mke-postgrest" } },
    spec: { stripPrefix: { prefixes: ["/datos"] } },
  };
  const ingressDatosObj = {
    apiVersion: "networking.k8s.io/v1", kind: "Ingress",
    metadata: {
      name: `${name}-datos`, namespace, labels,
      annotations: {
        "traefik.ingress.kubernetes.io/router.middlewares":
          `${namespace}-pgrst-puerta@kubernetescrd,${namespace}-pgrst-strip-datos@kubernetescrd`,
      },
    },
    spec: { rules: [{ host, http: { paths: [{ path: "/datos", pathType: "Prefix", backend: { service: { name, port: { number: PGRST_PORT } } } }] } }] },
  };

  return [
    namespaceObj,
    ...(leaseSecretObj ? [leaseSecretObj] : []),
    configMapObj,
    deploymentObj,
    serviceObj,
    ingressObj,
    ...(inp.datos ? [middlewarePuerta, middlewareStrip, ingressDatosObj] : []),
  ];
}

/** token npm del forge (mismo secreto que `mke deploy`) — BuildKit secret, nunca --build-arg. */
async function nodeAuthToken(): Promise<string | null> {
  const t = await run("vault-mishi", ["get", NPM_TOKEN_SECRET]);
  const token = t.stdout.trim();
  return t.code === 0 && token ? token : process.env.NODE_AUTH_TOKEN?.trim() || null;
}

/** `docker build` del backend con el MISMO Dockerfile/flags que `mke deploy` (carril back). */
async function buildBackend(wt: string, imagen: string, opts: { json?: boolean }): Promise<boolean> {
  const token = await nodeAuthToken();
  if (token) {
    process.env.NODE_AUTH_TOKEN = token;
    process.env.DOCKER_BUILDKIT = "1";
  }
  const argsToken = token ? ["--secret", "id=node_auth_token,env=NODE_AUTH_TOKEN", "--build-arg", `NODE_AUTH_TOKEN=${token}`] : [];
  const code = await pasoStreamCmd(
    `docker build ${dim(imagen)}`,
    "docker",
    ["build", "-t", imagen, "--provenance=false", "--sbom=false", ...argsToken, "-f", join(wt, "apps", "backend", "Dockerfile"), wt],
    { json: opts.json },
  );
  return code === 0;
}

/** `vite build` LOCAL del frontend (carril front, sin Docker) → devuelve el dist/.
 * El worktree lo crea `git worktree add` PELADO (sin node_modules) — a
 * diferencia de v1 (que instala DENTRO del pod), acá el build corre en el
 * HOST, así que la primera vez necesita su propio `npm ci` local (barato: el
 * caché de npm del host ya tiene los tarballs de builds anteriores). */
async function buildFrontend(app: string, wt: string, opts: { json?: boolean }): Promise<string | null> {
  if (!existsSync(join(wt, "node_modules"))) {
    const token = await nodeAuthToken();
    if (token) process.env.NODE_AUTH_TOKEN = token;
    const install = await pasoStreamCmd("npm ci (worktree pelado — primera vez)", "npm", ["ci"], { json: opts.json, cwd: wt });
    if (install !== 0) return null;
  }
  process.env.VITE_IDENTITY_URL = identityOrigin("stage");
  // `npm run build -w apps/frontend` a secas NO alcanza: el frontend importa
  // `@<app>/contract` (packages/contract) y ese workspace necesita SU build
  // (tsc) primero — encontrado en el E2E real ("Cannot find module
  // '@dropshipping-mishi/contract'"). El Dockerfile real lo resuelve con
  // `turbo run build --filter=@<app>/frontend` (grafo `dependsOn: ["^build"]`);
  // acá usamos el filtro POR PATH (`./apps/frontend`) para no tener que saber
  // el scope npm de cada app — turbo igual arma el mismo grafo. Caché FUERA del
  // repo (tmpdir): un `--cache-dir` relativo cae DENTRO del worktree y termina
  // como archivos sin trackear que `mke preview merge` no debe arrastrar a main
  // (bache real, encontrado en el E2E).
  const cacheDir = join(tmpdir(), "mke-preview-v2-turbo", app);
  const code = await pasoStreamCmd(
    "turbo build ./apps/frontend (local, carril front — arma primero packages/contract)",
    "npx",
    ["turbo", "run", "build", "--filter=./apps/frontend", `--cache-dir=${cacheDir}`],
    { json: opts.json, cwd: wt },
  );
  const dist = join(wt, "apps", "frontend", "dist");
  return code === 0 && existsSync(dist) ? dist : null;
}

/** `kubectl cp` NO acepta `deploy/<nombre>` como target (a diferencia de
 * `kubectl exec`) — solo un pod real. Resuelve el pod vivo del Deployment. */
async function destinoPod(name: string, contenedor: string): Promise<DestinoPod | null> {
  const r = await run("kubectl", ["--context", CTX, "-n", NS, "get", "pod", "-l", `app=${name}`, "-o", "jsonpath={.items[0].metadata.name}"]);
  const pod = r.stdout.trim();
  if (r.code !== 0 || !pod) return null;
  return { context: CTX, namespace: NS, recurso: pod, contenedor };
}

/** El sidecar PostgREST carga su schema cache al conectar — si la migración
 * corrió después, las funciones/tablas nuevas dan PGRST202. NOTIFY lo recarga
 * en caliente (canal de fábrica de PostgREST). */
async function recargarSchemaPostgrest(name: string, opts: { json?: boolean }): Promise<void> {
  const r = await paso("NOTIFY pgrst 'reload schema' (recarga el cache del sidecar)", () =>
    run("kubectl", ["--context", CTX, "-n", NS, "exec", `deploy/${name}`, "-c", "postgres", "--",
      "psql", "-U", "dev", "-d", "dev", "-c", "NOTIFY pgrst, 'reload schema'"]), { json: opts.json });
  if (r.code !== 0 && !opts.json) console.log(warn(`no pude recargar el schema de PostgREST (sigo): ${r.stderr || r.stdout}`));
}

async function migrarV2(name: string, opts: { json?: boolean }): Promise<boolean> {
  const code = await pasoStreamCmd(
    "migrando (MIGRATE_ONLY=true, imagen real) dentro del pod",
    "kubectl",
    ["--context", CTX, "-n", NS, "exec", `deploy/${name}`, "-c", backendContainerName(), "--",
      "sh", "-c", "cd /app && MIGRATE_ONLY=true node dist/index.js"],
    { json: opts.json },
  );
  return code === 0;
}

// ─── up --v2 ──────────────────────────────────────────────────────────────────

export async function previewUpV2(app: string, rama: string, opts: PreviewV2UpOpts): Promise<void> {
  const t0 = Date.now();
  const ramaSlug = slugDev(rama);
  const name = previewPodName(app, rama);
  const host = previewPodHost(app, rama);
  const url = `https://${host}`;
  const appDir = join(appsRoot(), app);

  if (!opts.json) console.log(info(`preview --v2 ${dim(app)} · rama ${dim(rama)} → ${dim(host)}`));

  const wt = worktreeDir(appDir, ramaSlug);
  const repoUrl = await resolveRepoUrl(app, opts.repoUrl, opts.dryRun === true);
  void repoUrl; // v2 no clona en el pod; el push de la rama a origin sí importa (abajo).

  if (opts.dryRun) {
    console.log(info("DRY RUN — no se toca nada. Plan (--v2):"));
    console.log(`  1. worktree local ${wt} + push de la rama a origin`);
    console.log("  2. lease del vault (Contrato 1) igual que v1");
    console.log("  3. carril back: docker build backend (Dockerfile real) → cargarImagenes → apply del pod v2");
    console.log("  4. MIGRATE_ONLY=true dentro del contenedor backend (mismo Job que usa `mke deploy`, vía exec)");
    console.log("  5. carril front: vite build local → kubectl cp al volumen del contenedor front → version.json");
    console.log(`  6. DNS: ${host} → túnel ${PREVIEW.tunnelName}`);
    console.log(info("nada ejecutado (--dry-run)"));
    return;
  }

  await asegurarWorktree(appDir, rama, ramaSlug);

  const forma = {
    backend: existsSync(join(wt, "apps", "backend")),
    frontend: existsSync(join(wt, "apps", "frontend")),
  };
  if (!forma.backend && !forma.frontend) {
    throw new Error(`la rama '${rama}' de ${app} no tiene apps/backend ni apps/frontend — nada que encender`);
  }

  const manifiesto = await leerManifiestoPreview(app, wt);
  const lease = await adquirirLease(app, rama, manifiesto, { json: opts.json, ttlSegundos: opts.ttlSegundos });

  // app convergida al estándar PostgREST → sidecar de datos en miniatura
  let datos: { db: string; jwks: string } | null = null;
  if (forma.backend && detectarDatosPostgrest(wt)) {
    datos = { db: dbDeApp(app), jwks: await jwksAmbosEmisores() };
    if (!opts.json) console.log(info(`app convergida al estándar PostgREST — sidecar de datos + ruta /datos ${dim(`(rol ${datos.db}_web)`)}`));
  }

  const sha = (await run("git", ["-C", wt, "rev-parse", "--short", "HEAD"])).stdout.trim() || Date.now().toString(36);
  const imagen = `${app}-preview-v2:${sha}`;
  const imagenRef = CARGA_ENV.registry ? `${CARGA_ENV.registry.ref}/${imagen}` : imagen;

  let tBack = 0;
  if (forma.backend) {
    const tb0 = Date.now();
    if (!(await buildBackend(wt, imagen, { json: opts.json }))) throw new Error("docker build del backend falló");
    const carga = await paso(describeCarga(CARGA_ENV, [imagen]), () => cargarImagenes(CARGA_ENV, [imagen]), { json: opts.json });
    if (carga.code !== 0) throw new Error(`carga de imagen falló: ${carga.stderr || carga.stdout}`);
    tBack = Date.now() - tb0;
  }

  // apply del pod v2 (namespace+lease+configmap+deployment+service+ingress)
  const items = manifiestosPreviewV2({
    app, rama, imagenRef, sha,
    leaseId: lease.leaseId, leaseToken: lease.leaseToken,
    config: manifiesto.config, forma, datos,
  });
  const manifiestos = JSON.stringify({ apiVersion: "v1", kind: "List", items }, null, 2);
  const apply = await run("kubectl", ["--context", CTX, "apply", "-f", "-"], manifiestos);
  if (apply.code !== 0) throw new Error(`apply falló: ${apply.stderr || apply.stdout}`);
  console.log(ok(apply.stdout.split("\n").join(" · ")));

  if (!opts.json) console.log(info("esperando el pod (imagen real, sin clone/install)…"));
  // OJO: NO usar `esperarConLogs` siguiendo el contenedor `backend` — a
  // diferencia del `initContainer preparar` de v1 (que TERMINA solo, cerrando
  // el stream de `kubectl logs -f`), `backend` es un proceso de vida larga:
  // `-f` nunca cierra y el narrador colgaría la función para siempre incluso
  // después de que el rollout ya resolvió (bache real, encontrado en el E2E).
  // `pasoStreamCmd` sobre el propio `rollout status` es auto-terminante.
  const rolloutCode = await pasoStreamCmd(
    `rollout status deploy/${name}`,
    "kubectl",
    ["--context", CTX, "-n", NS, "rollout", "status", `deploy/${name}`, "--timeout=300s"],
    { json: opts.json },
  );
  const listo = rolloutCode === 0;
  if (!listo && !opts.json) await diagnosticarPodNoListo(name);

  try {
    const uuid = await previewTunnelUuid();
    const que = await upsertCname(host, tunnelTarget(uuid));
    console.log(ok(que === "ok" ? "CNAME ya apuntaba bien" : `CNAME ${que}`));
  } catch (e) {
    console.log(warn(`Cloudflare API: ${e instanceof Error ? e.message : String(e)}`));
  }

  if (listo && forma.backend) {
    if (!(await migrarV2(name, { json: opts.json })) && !opts.json) console.log(warn("MIGRATE_ONLY falló (sigo)"));
    if (datos) await recargarSchemaPostgrest(name, { json: opts.json });
  }

  let tFront = 0;
  if (listo && forma.frontend) {
    const tf0 = Date.now();
    const dist = await buildFrontend(app, wt, { json: opts.json });
    if (dist) {
      const dp = await destinoPod(name, frontContainerName());
      if (!dp) {
        if (!opts.json) console.log(warn("no encontré el pod vivo del contenedor front — el cp queda para el próximo `preview push --v2`"));
      } else {
        const cp = await paso("kubectl cp dist/ → volumen del contenedor front", () => copiarArbolAPod(dp, dist, "/srv/front"), { json: opts.json });
        if (cp.code === 0) await escribirVersionJson(dp, "/srv/front", sha);
        else if (!opts.json) console.log(warn(`cp del front falló: ${cp.stderr || cp.stdout}`));
      }
    } else if (!opts.json) {
      console.log(warn("vite build falló — el pod queda sin front hasta el próximo `preview push --v2`"));
    }
    tFront = Date.now() - tf0;
  }

  const reachable = listo ? await waitReachable(forma.frontend ? `${url}/` : `${url}/health`) : false;
  const tTotal = Date.now() - t0;
  console.log("");
  if (opts.json) {
    console.log(JSON.stringify({ app, rama, name, host, url, leaseId: lease.leaseId, estado: reachable ? "vivo" : listo ? "aplicado" : "pendiente", msTotal: tTotal, msBack: tBack, msFront: tFront }));
    return;
  }
  console.log(reachable ? ok(`preview v2 VIVO → ${url}`) : warn(`aplicado pero aún no responde en ${url}`));
  console.log(dim(`  tiempos: total ${(tTotal / 1000).toFixed(1)}s · carril back ${(tBack / 1000).toFixed(1)}s · carril front ${(tFront / 1000).toFixed(1)}s`));
}

// ─── push --v2 (detecta carril por diff) ───────────────────────────────────────

/** decide qué carril(es) tocar según los paths cambiados — pura, testeable. */
export function carrilesDeDiff(paths: string[]): { back: boolean; front: boolean } {
  const back = paths.some((p) => /^apps\/backend\//.test(p) || /^(Dockerfile|package\.json|package-lock\.json)$/.test(p) || /^apps\/backend\/Dockerfile$/.test(p));
  const front = paths.some((p) => /^apps\/frontend\//.test(p) || /^packages\/contract\//.test(p));
  return { back, front };
}

export async function previewPushV2(app: string, rama: string, opts: PreviewV2PushOpts): Promise<void> {
  const ramaSlug = slugDev(rama);
  const name = previewPodName(app, rama);
  const appDir = join(appsRoot(), app);
  const wt = worktreeDir(appDir, ramaSlug);
  if (!existsSync(wt)) throw new Error(`no hay worktree local para ${app}/${rama} — corré \`mke preview up ${app} ${rama} --v2\` primero`);

  const shaAntes = (await run("kubectl", ["--context", CTX, "-n", NS, "get", `deploy/${name}`, "-o", "jsonpath={.metadata.annotations.mke\\.preview/sha}"])).stdout.trim();
  const diff = await run("git", ["-C", wt, "diff", "--name-only", shaAntes || "HEAD~1", "HEAD"]);
  const paths = diff.code === 0 ? diff.stdout.split("\n").filter(Boolean) : [];
  const carriles = paths.length ? carrilesDeDiff(paths) : { back: true, front: true }; // sin sha previo: no sabemos, corré ambos

  if (!opts.json) console.log(info(`push --v2 ${dim(app)}/${dim(rama)}: carril back=${carriles.back} carril front=${carriles.front} (${paths.length} archivo(s) cambiado(s))`));

  const forma = { backend: existsSync(join(wt, "apps", "backend")), frontend: existsSync(join(wt, "apps", "frontend")) };
  const sha = (await run("git", ["-C", wt, "rev-parse", "--short", "HEAD"])).stdout.trim();

  let tBack = 0, tFront = 0;
  if (carriles.back && forma.backend) {
    const tb0 = Date.now();
    const imagen = `${app}-preview-v2:${sha}`;
    const imagenRef = CARGA_ENV.registry ? `${CARGA_ENV.registry.ref}/${imagen}` : imagen;
    if (!(await buildBackend(wt, imagen, { json: opts.json }))) throw new Error("docker build del backend falló");
    const carga = await paso(describeCarga(CARGA_ENV, [imagen]), () => cargarImagenes(CARGA_ENV, [imagen]), { json: opts.json });
    if (carga.code !== 0) throw new Error(`carga de imagen falló: ${carga.stderr || carga.stdout}`);
    await paso(`set image deploy/${name} ${backendContainerName()}=${dim(imagenRef)}`, () =>
      run("kubectl", ["--context", CTX, "-n", NS, "set", "image", `deploy/${name}`, `${backendContainerName()}=${imagenRef}`]), { json: opts.json });
    await paso(`annotate deploy/${name} mke.preview/sha=${sha}`, () =>
      run("kubectl", ["--context", CTX, "-n", NS, "annotate", `deploy/${name}`, `mke.preview/sha=${sha}`, "--overwrite"]), { json: opts.json });
    const roll = await pasoStreamCmd(`rollout status deploy/${name}`, "kubectl", ["--context", CTX, "-n", NS, "rollout", "status", `deploy/${name}`, "--timeout=180s"], { json: opts.json });
    if (roll !== 0) throw new Error("rollout del backend no convergió");
    await migrarV2(name, { json: opts.json });
    if (detectarDatosPostgrest(wt)) await recargarSchemaPostgrest(name, { json: opts.json });
    tBack = Date.now() - tb0;
  }
  if (carriles.front && forma.frontend) {
    const tf0 = Date.now();
    const dist = await buildFrontend(app, wt, { json: opts.json });
    if (!dist) throw new Error("vite build falló");
    const dp = await destinoPod(name, frontContainerName());
    if (!dp) throw new Error(`no encontré el pod vivo de ${name} (¿deploy caído?)`);
    const cp = await paso("kubectl cp dist/ → volumen del contenedor front", () => copiarArbolAPod(dp, dist, "/srv/front"), { json: opts.json });
    if (cp.code !== 0) throw new Error(`cp del front falló: ${cp.stderr || cp.stdout}`);
    await escribirVersionJson(dp, "/srv/front", sha);
    if (!carriles.back) {
      await run("kubectl", ["--context", CTX, "-n", NS, "annotate", `deploy/${name}`, `mke.preview/sha=${sha}`, "--overwrite"]);
    }
    tFront = Date.now() - tf0;
  }

  if (opts.json) {
    console.log(JSON.stringify({ app, rama, sha, carriles, msBack: tBack, msFront: tFront }));
    return;
  }
  console.log(ok(`push --v2 listo${carriles.back ? ` · carril back ${(tBack / 1000).toFixed(1)}s` : ""}${carriles.front ? ` · carril front ${(tFront / 1000).toFixed(1)}s` : ""}`));
}

// ─── helpers de limpieza compartidos con v1 (down/merge NO cambian: mismos
// labels `mke.preview/*` bajan el bundle v2 igual que el v1). Documentado en
// AI_PREVIEW_V2.md — este módulo no re-implementa down/merge.

export { selectorDePreview, PREVIEW_SIN_LEASE, leaseIdDe };
