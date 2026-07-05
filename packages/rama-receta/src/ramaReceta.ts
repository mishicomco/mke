// La RECETA de un "pod de rama" del harness v2 de Mishi Studio (diseño FIRMADO por
// Santi). Generación PURA de manifiestos de k8s: entradas {app, rama, repoUrl,
// imagen?} → array de OBJETOS manifest (JSON), sin efectos ni serialización. El
// consumidor decide serializar (kubectl apply -f = List JSON; la API de k8s =
// objeto por objeto).
//
// Anatomía del pod (ns compartido `ramas`; JAMÁS mke-prod):
//   · initContainer `preparar` (imagen runner): git clone --depth 1 --branch <rama>
//     → npm install → npm run build (turbo respeta el orden contract→front).
//   · contenedor `backend` (imagen runner): espera al postgres, migra + siembra y
//     `npm run dev`.
//   · contenedor `web` (caddy): sirve el front estático y hace reverse-proxy de
//     /api y /health al backend por 127.0.0.1 → un solo origen.
//   · sidecar `postgres` (postgres:16-alpine, emptyDir): DB efímera por loopback.
//
// Recursos: Namespace + Secret (REPO_URL) + ConfigMap (scripts+Caddyfile) +
// Deployment + Service + Ingress, todos con nombre `<app>-<slug(rama)>` y el label
// `mke.rama/name` para un borrado limpio. Host `<...>-feat.mishi.com.co`.

// ─── constantes de la receta (dueño ÚNICO; no las dupliques) ─────────────────

export const RAMA_NAMESPACE = "ramas";
export const RAMA_HOST_SUFFIX = "-feat";
export const RAMA_RUNNER_IMAGE = "mke-rama-runner:node22";
export const RAMA_DOMAIN = "mishi.com.co";

// ─── slug / nombres / hosts (PUROS) ──────────────────────────────────────────

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

/**
 * nombre de una rama encendida: `<app>-<slug(rama)>`, saneado y recortado a un
 * límite seguro para nombres de k8s y labels DNS (un segmento del host va hasta
 * 63; dejamos margen para el sufijo `-feat`). Sirve de nombre de los recursos y
 * de prefijo del host.
 */
export function ramaName(app: string, rama: string): string {
  const s = `${app}-${slugFeature(rama)}`
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 50)
    .replace(/^-+|-+$/g, "");
  if (!s) throw new Error(`no pude derivar un nombre de rama válido de '${app}'/'${rama}'`);
  return s;
}

/** host público de una rama encendida: `<app>-<slug(rama)>-feat.mishi.com.co`. */
export function ramaHost(
  app: string,
  rama: string,
  opts: { hostSuffix?: string; domain?: string } = {},
): string {
  const suffix = opts.hostSuffix ?? RAMA_HOST_SUFFIX;
  const domain = opts.domain ?? RAMA_DOMAIN;
  return `${ramaName(app, rama)}${suffix}.${domain}`;
}

/**
 * URL INTERNA del service de la rama dentro del clúster (por donde el proxy /live
 * la alcanza sin salir a internet): `http://<name>.<ns>.svc:80`.
 */
export function ramaServicioInterno(name: string, namespace: string = RAMA_NAMESPACE): string {
  return `http://${name}.${namespace}.svc:80`;
}

// ─── scripts embebidos (van a un ConfigMap; el pod los ejecuta) ──────────────

/** initContainer: clona la rama, instala y construye el front. */
const PREPARE_SH = `#!/bin/sh
set -eu
echo "[rama] preparando $APP@$RAMA"
cd /workspace
if [ ! -d repo/.git ]; then
  git clone --depth 1 --branch "$RAMA" "$REPO_URL" repo
fi
cd repo
echo "[rama] npm install"
npm install --no-audit --no-fund
echo "[rama] build (turbo: contract → front, orden de dependencias)"
npm run build
echo "[rama] preparado: $(git rev-parse --short HEAD)"
`;

/** backend: espera postgres, migra, siembra y corre dev. */
const BOOT_BACKEND_SH = `#!/bin/sh
set -eu
cd /workspace/repo
echo "[rama] esperando postgres…"
until pg_isready -h 127.0.0.1 -p 5432 -U rama >/dev/null 2>&1; do sleep 2; done
echo "[rama] migraciones"
npm run db:migrate -w apps/backend || echo "[rama] db:migrate falló (sigo)"
if npm run -w apps/backend 2>/dev/null | grep -q 'seed:escenario'; then
  echo "[rama] seed escenario feliz"
  npm run seed:escenario -w apps/backend -- feliz || echo "[rama] seed falló (sigo)"
fi
echo "[rama] backend dev en :$PORT"
npm run dev -w apps/backend
`;

/** caddy: front estático + reverse-proxy /api y /health al backend (mismo origen). */
const CADDYFILE = `:8080 {
	handle /api/* {
		reverse_proxy 127.0.0.1:{$PORT}
	}
	handle /health* {
		reverse_proxy 127.0.0.1:{$PORT}
	}
	handle {
		root * /workspace/repo/apps/frontend/dist
		try_files {path} /index.html
		file_server
	}
}
`;

// ─── generación de manifiestos (PURA) ────────────────────────────────────────

export interface RecetaInput {
  /** nombre público/corto de la app (prefijo de nombres y host; ej `mishi-bank`). */
  app: string;
  /** rama git a encender (ej `feat/login`). */
  rama: string;
  /** URL de clone (puede llevar el token embebido: https://x-access-token:…@…). */
  repoUrl: string;
  /** imagen genérica del runner (default `mke-rama-runner:node22`). */
  imagen?: string;
  /** namespace destino (default `ramas`). */
  namespace?: string;
  /** sufijo del host público (default `-feat`). */
  hostSuffix?: string;
  /** dominio (default `mishi.com.co`). */
  domain?: string;
}

export type K8sManifest = Record<string, unknown>;

const b64 = (s: string): string => Buffer.from(s, "utf8").toString("base64");

/**
 * Namespace + Secret + ConfigMap + Deployment + Service + Ingress de la rama, como
 * OBJETOS (no YAML). El REPO_URL viaja base64 en el Secret, nunca en claro.
 */
export function manifiestosRama(inp: RecetaInput): K8sManifest[] {
  const app = inp.app;
  const rama = inp.rama;
  const namespace = inp.namespace ?? RAMA_NAMESPACE;
  const imagen = inp.imagen ?? RAMA_RUNNER_IMAGE;
  const name = ramaName(app, rama);
  const host = ramaHost(app, rama, { hostSuffix: inp.hostSuffix, domain: inp.domain });
  const ramaSlug = slugFeature(rama);

  const labels: Record<string, string> = {
    "mke.rama/managed": "true",
    "mke.rama/name": name,
    "mke.rama/app": app,
    "mke.rama/rama": ramaSlug,
  };

  const namespaceObj: K8sManifest = {
    apiVersion: "v1",
    kind: "Namespace",
    metadata: {
      name: namespace,
      labels: { "app.kubernetes.io/part-of": "mke-rama" },
    },
  };

  const secretObj: K8sManifest = {
    apiVersion: "v1",
    kind: "Secret",
    metadata: { name: `${name}-git`, namespace, labels },
    type: "Opaque",
    data: { REPO_URL: b64(inp.repoUrl) },
  };

  const configMapObj: K8sManifest = {
    apiVersion: "v1",
    kind: "ConfigMap",
    metadata: { name: `${name}-scripts`, namespace, labels },
    data: {
      "prepare.sh": PREPARE_SH,
      "boot-backend.sh": BOOT_BACKEND_SH,
      Caddyfile: CADDYFILE,
    },
  };

  const podLabels = { app: name, ...labels };

  const deploymentObj: K8sManifest = {
    apiVersion: "apps/v1",
    kind: "Deployment",
    metadata: { name, namespace, labels },
    spec: {
      replicas: 1,
      // la rama es efímera y clona en cada arranque: nunca dos pods a la vez.
      strategy: { type: "Recreate" },
      selector: { matchLabels: { app: name } },
      template: {
        metadata: { labels: podLabels },
        spec: {
          securityContext: { fsGroup: 1000 },
          initContainers: [
            {
              name: "preparar",
              image: imagen,
              imagePullPolicy: "IfNotPresent",
              command: ["sh", "/rama/prepare.sh"],
              env: [
                { name: "APP", value: app },
                { name: "RAMA", value: rama },
                {
                  name: "REPO_URL",
                  valueFrom: { secretKeyRef: { name: `${name}-git`, key: "REPO_URL" } },
                },
              ],
              volumeMounts: [
                { name: "workspace", mountPath: "/workspace" },
                { name: "scripts", mountPath: "/rama" },
              ],
            },
          ],
          containers: [
            {
              name: "postgres",
              image: "postgres:16-alpine",
              env: [
                { name: "POSTGRES_USER", value: "rama" },
                { name: "POSTGRES_PASSWORD", value: "rama" },
                { name: "POSTGRES_DB", value: "rama" },
                { name: "PGDATA", value: "/var/lib/postgresql/data/pgdata" },
              ],
              ports: [{ containerPort: 5432 }],
              readinessProbe: {
                exec: { command: ["pg_isready", "-U", "rama", "-d", "rama"] },
                periodSeconds: 3,
                failureThreshold: 40,
              },
              volumeMounts: [{ name: "pgdata", mountPath: "/var/lib/postgresql/data" }],
            },
            {
              name: "backend",
              image: imagen,
              imagePullPolicy: "IfNotPresent",
              command: ["sh", "/rama/boot-backend.sh"],
              env: [
                { name: "APP", value: app },
                { name: "RAMA", value: rama },
                { name: "RAMA_ENCENDIDA", value: "true" },
                { name: "NODE_ENV", value: "development" },
                { name: "PORT", value: "3000" },
                { name: "DATABASE_URL", value: "postgres://rama:rama@127.0.0.1:5432/rama" },
              ],
              volumeMounts: [
                { name: "workspace", mountPath: "/workspace" },
                { name: "scripts", mountPath: "/rama" },
              ],
            },
            {
              name: "web",
              image: "caddy:2-alpine",
              command: ["caddy", "run", "--config", "/rama/Caddyfile", "--adapter", "caddyfile"],
              env: [{ name: "PORT", value: "3000" }],
              ports: [{ containerPort: 8080 }],
              readinessProbe: {
                httpGet: { path: "/", port: 8080 },
                periodSeconds: 5,
                failureThreshold: 60,
              },
              volumeMounts: [
                { name: "workspace", mountPath: "/workspace" },
                { name: "scripts", mountPath: "/rama" },
              ],
            },
          ],
          volumes: [
            { name: "workspace", emptyDir: {} },
            { name: "pgdata", emptyDir: {} },
            { name: "scripts", configMap: { name: `${name}-scripts`, defaultMode: 0o755 } },
          ],
        },
      },
    },
  };

  const serviceObj: K8sManifest = {
    apiVersion: "v1",
    kind: "Service",
    metadata: { name, namespace, labels },
    spec: {
      selector: { app: name },
      ports: [{ port: 80, targetPort: 8080 }],
    },
  };

  const ingressObj: K8sManifest = {
    apiVersion: "networking.k8s.io/v1",
    kind: "Ingress",
    metadata: { name, namespace, labels },
    spec: {
      rules: [
        {
          host,
          http: {
            paths: [
              {
                path: "/",
                pathType: "Prefix",
                backend: { service: { name, port: { number: 80 } } },
              },
            ],
          },
        },
      ],
    },
  };

  return [namespaceObj, secretObj, configMapObj, deploymentObj, serviceObj, ingressObj];
}

/** labelSelector canónico para borrar/listar los recursos de una rama por nombre. */
export function selectorDeRama(name: string): string {
  return `mke.rama/name=${name}`;
}
