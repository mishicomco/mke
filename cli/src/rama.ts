// `mke rama up/down/ls` — el "pod de rama" del diseño "Ramas en el harness v2"
// de Mishi Studio (diseño FIRMADO por Santi). Distinto de `mke preview`:
//
//   preview → construye una IMAGEN por rama (docker build del Dockerfile del app).
//   rama    → SIN imagen por rama: UNA imagen genérica de runner clona la rama en
//             el ARRANQUE del pod, instala, construye el front y corre el backend;
//             el front estático se sirve en el MISMO ORIGEN que la API (un caddy
//             liviano hace reverse-proxy de /api y /health al backend por loopback).
//
// Anatomía del pod (todo en el clúster `mke-preview`, ns `ramas`; JAMÁS mke-prod):
//   · initContainer `preparar` (imagen runner): git clone --depth 1 --branch <rama>
//     → npm install → npm run build -w apps/frontend, en un emptyDir /workspace.
//   · contenedor `backend` (imagen runner): espera al postgres, corre migraciones
//     (drizzle) + siembra (seed:escenario feliz si existe) y `npm run dev`.
//   · contenedor `web` (caddy): sirve /workspace/repo/apps/frontend/dist y hace
//     reverse-proxy de /api y /health al backend por 127.0.0.1 → un solo origen.
//   · sidecar `postgres` (postgres:16-alpine, emptyDir): DB efímera por loopback;
//     nace y muere con el pod. JAMÁS datos de stage ni secretos reales.
//
// Recursos: Namespace `ramas` + Secret (REPO_URL) + ConfigMap (scripts+Caddyfile)
// + Deployment + Service + Ingress, todos con nombre `<app>-<slug(rama)>` y el
// label `mke.rama/name` para un borrado limpio. Host `<...>-feat.mishi.com.co`.

import { RAMA, ramaHost, ramaName, slugFeature } from "./mkeConfig.js";
import { deleteRecordsByName } from "./cf.js";
import { run, ok, bad, warn, info, dim } from "./sh.js";

const CTX = RAMA.context;
const NS = RAMA.namespace;

export interface RamaUpOpts {
  json?: boolean;
  dryRun?: boolean;
  /** salta TODO lo de Cloudflare (para pruebas locales sin tocar DNS real). */
  sinDns?: boolean;
  /** URL de git a clonar (default https://github.com/mishicomco/<app>.git). */
  repoUrl?: string;
}

export interface RamaDownOpts {
  json?: boolean;
  sinDns?: boolean;
}

export interface RamaLsOpts {
  json?: boolean;
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
echo "[rama] build front"
npm run build -w apps/frontend
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

// ─── generación de manifiestos (PURA y testeable) ────────────────────────────

export interface ManifestInput {
  app: string;
  rama: string;
  name: string;
  host: string;
  repoUrl: string;
}

const b64 = (s: string): string => Buffer.from(s, "utf8").toString("base64");
const yamlBlock = (text: string, indent: string): string =>
  text.split("\n").map((l) => `${indent}${l}`).join("\n");

/** Namespace + Secret + ConfigMap + Deployment + Service + Ingress de la rama. */
export function manifiestosRama(inp: ManifestInput): string {
  const { app, rama, name, host, repoUrl } = inp;
  const ramaSlug = slugFeature(rama);
  const labelEntries = [
    `mke.rama/managed: "true"`,
    `mke.rama/name: ${name}`,
    `mke.rama/app: ${app}`,
    `mke.rama/rama: ${ramaSlug}`,
  ];
  const labelsAt = (indent: string): string => labelEntries.map((l) => `${indent}${l}`).join("\n");
  const labels = labelsAt("    "); // metadata.labels de recursos de nivel raíz
  const podLabels = labelsAt("        "); // spec.template.metadata.labels (más anidado)

  return `apiVersion: v1
kind: Namespace
metadata:
  name: ${NS}
  labels:
    app.kubernetes.io/part-of: mke-rama
---
apiVersion: v1
kind: Secret
metadata:
  name: ${name}-git
  namespace: ${NS}
  labels:
${labels}
type: Opaque
data:
  REPO_URL: ${b64(repoUrl)}
---
apiVersion: v1
kind: ConfigMap
metadata:
  name: ${name}-scripts
  namespace: ${NS}
  labels:
${labels}
data:
  prepare.sh: |
${yamlBlock(PREPARE_SH, "    ")}
  boot-backend.sh: |
${yamlBlock(BOOT_BACKEND_SH, "    ")}
  Caddyfile: |
${yamlBlock(CADDYFILE, "    ")}
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: ${name}
  namespace: ${NS}
  labels:
${labels}
spec:
  replicas: 1
  # la rama es efímera y clona en cada arranque: nunca dos pods a la vez.
  strategy: { type: Recreate }
  selector:
    matchLabels:
      app: ${name}
  template:
    metadata:
      labels:
        app: ${name}
${podLabels}
    spec:
      securityContext:
        fsGroup: 1000
      initContainers:
        - name: preparar
          image: ${RAMA.runnerImage}
          imagePullPolicy: IfNotPresent
          command: ["sh", "/rama/prepare.sh"]
          env:
            - { name: APP, value: "${app}" }
            - { name: RAMA, value: "${rama}" }
            - name: REPO_URL
              valueFrom: { secretKeyRef: { name: ${name}-git, key: REPO_URL } }
          volumeMounts:
            - { name: workspace, mountPath: /workspace }
            - { name: scripts, mountPath: /rama }
      containers:
        - name: postgres
          image: postgres:16-alpine
          env:
            - { name: POSTGRES_USER, value: "rama" }
            - { name: POSTGRES_PASSWORD, value: "rama" }
            - { name: POSTGRES_DB, value: "rama" }
            - { name: PGDATA, value: /var/lib/postgresql/data/pgdata }
          ports: [{ containerPort: 5432 }]
          readinessProbe:
            exec: { command: ["pg_isready", "-U", "rama", "-d", "rama"] }
            periodSeconds: 3
            failureThreshold: 40
          volumeMounts:
            - { name: pgdata, mountPath: /var/lib/postgresql/data }
        - name: backend
          image: ${RAMA.runnerImage}
          imagePullPolicy: IfNotPresent
          command: ["sh", "/rama/boot-backend.sh"]
          env:
            - { name: APP, value: "${app}" }
            - { name: RAMA, value: "${rama}" }
            - { name: RAMA_ENCENDIDA, value: "true" }
            - { name: NODE_ENV, value: "development" }
            - { name: PORT, value: "3000" }
            - { name: DATABASE_URL, value: "postgres://rama:rama@127.0.0.1:5432/rama" }
          volumeMounts:
            - { name: workspace, mountPath: /workspace }
            - { name: scripts, mountPath: /rama }
        - name: web
          image: caddy:2-alpine
          command: ["caddy", "run", "--config", "/rama/Caddyfile", "--adapter", "caddyfile"]
          env:
            - { name: PORT, value: "3000" }
          ports: [{ containerPort: 8080 }]
          readinessProbe:
            httpGet: { path: /, port: 8080 }
            periodSeconds: 5
            failureThreshold: 60
          volumeMounts:
            - { name: workspace, mountPath: /workspace }
            - { name: scripts, mountPath: /rama }
      volumes:
        - name: workspace
          emptyDir: {}
        - name: pgdata
          emptyDir: {}
        - name: scripts
          configMap:
            name: ${name}-scripts
            defaultMode: 0755
---
apiVersion: v1
kind: Service
metadata:
  name: ${name}
  namespace: ${NS}
  labels:
${labels}
spec:
  selector:
    app: ${name}
  ports:
    - { port: 80, targetPort: 8080 }
---
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: ${name}
  namespace: ${NS}
  labels:
${labels}
spec:
  rules:
    - host: ${host}
      http:
        paths:
          - path: /
            pathType: Prefix
            backend:
              service:
                name: ${name}
                port: { number: 80 }
`;
}

// ─── túnel / imagen del runner ───────────────────────────────────────────────

async function tunnelUuid(): Promise<string> {
  const r = await run("cloudflared", ["tunnel", "list"]);
  if (r.code !== 0) throw new Error(`cloudflared tunnel list falló: ${r.stderr}`);
  for (const line of r.stdout.split("\n")) {
    const cols = line.trim().split(/\s+/);
    if (cols[1] === RAMA.tunnelName) return cols[0];
  }
  throw new Error(`no existe el túnel '${RAMA.tunnelName}'. Corré primero: scripts/bootstrap-preview.sh`);
}

/** Asegura que la imagen genérica del runner esté importada en el clúster. */
async function ensureRunnerImage(imagesDir: string): Promise<void> {
  const img = RAMA.runnerImage;
  const has = await run("docker", ["image", "inspect", img]);
  if (has.code !== 0) {
    console.log(info(`construyo la imagen del runner ${dim(img)} (primera vez)`));
    const build = await run("docker", ["build", "-t", img, imagesDir]);
    if (build.code !== 0) throw new Error(`docker build del runner falló: ${build.stderr || build.stdout}`);
  }
  console.log(info(`k3d image import ${dim(img)} → ${RAMA.cluster}`));
  const imp = await run("k3d", ["image", "import", img, "-c", RAMA.cluster]);
  if (imp.code !== 0) throw new Error(`k3d image import del runner falló: ${imp.stderr || imp.stdout}`);
}

/** URL de clone. Con `--repo-url` gana ese; si no, el repo del ecosistema. */
async function resolveRepoUrl(app: string, override: string | undefined, dryRun: boolean): Promise<string> {
  if (override) return override;
  const base = `https://github.com/mishicomco/${app}.git`;
  if (dryRun) return base; // en dry-run nunca metemos el token (no se imprime)
  // token de clone read-only opcional (infra, NO secreto de app). Si existe, se
  // inyecta en la URL para clonar repos privados; si no, clone anónimo (público).
  const t = await run("mishi-secret", ["get", "github-rama-token"]);
  if (t.code === 0 && t.stdout.trim()) {
    return `https://x-access-token:${t.stdout.trim()}@github.com/mishicomco/${app}.git`;
  }
  return base;
}

/** SHA corto de la rama (resuelto en el cliente; informativo para --json). */
async function resolveSha(repoUrl: string, rama: string): Promise<string | null> {
  const r = await run("git", ["ls-remote", repoUrl, rama]);
  if (r.code !== 0 || !r.stdout) return null;
  const sha = r.stdout.split(/\s+/)[0];
  return sha ? sha.slice(0, 7) : null;
}

// ─── up ──────────────────────────────────────────────────────────────────────

export async function ramaUp(app: string, rama: string, imagesDir: string, opts: RamaUpOpts): Promise<void> {
  const name = ramaName(app, rama);
  const host = ramaHost(app, rama);
  const url = `https://${host}`;
  const repoUrl = await resolveRepoUrl(app, opts.repoUrl, opts.dryRun === true);
  const yaml = manifiestosRama({ app, rama, name, host, repoUrl });

  if (opts.dryRun) {
    console.log(yaml);
    return;
  }

  const emit = (estado: string, sha: string | null): void => {
    if (opts.json) console.log(JSON.stringify({ app, rama, sha, host, url, estado }));
  };

  if (!opts.json) console.log(info(`rama ${dim(app)} · ${dim(rama)} → ${dim(host)}`));

  // 0) túnel (si vamos a tocar DNS) — falla rápido antes de trabajar
  const uuid = opts.sinDns ? null : await tunnelUuid();

  // 1) imagen del runner + apply (idempotente; re-sincroniza si ya existe)
  await ensureRunnerImage(imagesDir);
  const apply = await run("kubectl", ["--context", CTX, "apply", "-f", "-"], yaml);
  if (apply.code !== 0) throw new Error(`apply falló: ${apply.stderr || apply.stdout}`);
  if (!opts.json) console.log(ok(apply.stdout.split("\n").join(" · ")));

  // 2) esperá el rollout (clone+install+build tardan; timeout generoso)
  if (!opts.json) console.log(info("esperando el pod (clone + npm install + build)…"));
  const st = await run("kubectl", ["--context", CTX, "-n", NS, "rollout", "status", `deploy/${name}`, "--timeout=600s"]);
  const listo = st.code === 0;
  if (!opts.json) console.log(listo ? ok(st.stdout.split("\n").pop() ?? "pod listo") : warn(`el pod no convergió aún: ${st.stderr || st.stdout}`));

  // 3) DNS (salvo --sin-dns)
  if (!opts.sinDns && uuid) {
    if (!opts.json) console.log(info(`DNS: ${host} → túnel ${uuid}`));
    const dns = await run("cloudflared", ["tunnel", "route", "dns", "--overwrite-dns", uuid, host]);
    if (dns.code !== 0 && !opts.json) console.log(warn(`cloudflared route dns: ${dns.stderr || dns.stdout}`));
  }

  // 4) sha + alcance
  const sha = await resolveSha(repoUrl, rama);
  let estado = listo ? "aplicada" : "pendiente";
  if (!opts.sinDns && listo) {
    const reachable = await waitReachable(`${url}/`);
    estado = reachable ? "lista" : "aplicada";
    if (!opts.json) {
      console.log("");
      console.log(reachable ? ok(`rama VIVA → ${url}`) : warn(`aplicada pero aún no responde en ${url}`));
    }
  } else if (opts.sinDns && !opts.json) {
    console.log(ok(`rama aplicada (--sin-dns) → ${name} en ns ${NS}`));
  }
  emit(estado, sha);
}

// ─── down ─────────────────────────────────────────────────────────────────────

export async function ramaDown(app: string, rama: string, opts: RamaDownOpts): Promise<void> {
  const name = ramaName(app, rama);
  const host = ramaHost(app, rama);
  if (!opts.json) console.log(info(`bajando rama ${dim(name)} (${host})`));

  const del = await run("kubectl", [
    "--context", CTX, "-n", NS,
    "delete", "deployment,service,ingress,configmap,secret",
    "-l", `mke.rama/name=${name}`,
    "--ignore-not-found", "--wait=false",
  ]);
  if (!opts.json) {
    if (del.code === 0) console.log(ok(del.stdout || `recursos de ${name} borrándose`));
    else console.log(warn(`no pude borrar recursos: ${del.stderr || del.stdout}`));
  }

  let dnsBorrado = false;
  if (!opts.sinDns) {
    try {
      const n = await deleteRecordsByName(host);
      dnsBorrado = n > 0;
      if (!opts.json) console.log(ok(n ? `CNAME ${host} borrado` : `no había CNAME ${host}`));
    } catch (e) {
      if (!opts.json) console.log(bad(`DNS: ${e instanceof Error ? e.message : String(e)}`));
    }
  }
  if (opts.json) console.log(JSON.stringify({ app, rama, name, host, estado: "apagada", dnsBorrado }));
}

// ─── ls ────────────────────────────────────────────────────────────────────────

interface RamaRow {
  app: string;
  rama: string;
  name: string;
  host: string;
  edad: string;
  estado: string;
}

export async function ramaLs(app: string | undefined, opts: RamaLsOpts): Promise<void> {
  const sel = app ? `mke.rama/managed=true,mke.rama/app=${app}` : "mke.rama/managed=true";
  const r = await run("kubectl", ["--context", CTX, "-n", NS, "get", "deploy", "-l", sel, "-o", "json"]);
  if (r.code !== 0) {
    if (opts.json) console.log("[]");
    else console.log(bad(`no pude listar (¿existe el clúster/namespace de ramas?): ${r.stderr.split("\n")[0]}`));
    return;
  }
  let items: unknown[] = [];
  try {
    items = (JSON.parse(r.stdout) as { items?: unknown[] }).items ?? [];
  } catch { /* namespace vacío o sin json */ }

  const rows: RamaRow[] = items.map((it) => {
    const d = it as {
      metadata?: { labels?: Record<string, string>; creationTimestamp?: string };
      status?: { availableReplicas?: number; replicas?: number };
    };
    const labels = d.metadata?.labels ?? {};
    const name = labels["mke.rama/name"] ?? "?";
    const avail = d.status?.availableReplicas ?? 0;
    const total = d.status?.replicas ?? 0;
    return {
      app: labels["mke.rama/app"] ?? "?",
      rama: labels["mke.rama/rama"] ?? "?",
      name,
      host: `${name}${RAMA.hostSuffix}.mishi.com.co`,
      edad: edadDesde(d.metadata?.creationTimestamp),
      estado: avail > 0 ? "lista" : total > 0 ? "arrancando" : "detenida",
    };
  });

  if (opts.json) {
    console.log(JSON.stringify(rows));
    return;
  }
  console.log(`\n  ramas encendidas ${dim(`(${CTX} · ns ${NS})`)}`);
  if (!rows.length) { console.log(`    ${dim("(ninguna)")}\n`); return; }
  for (const row of rows) {
    console.log(`    ${info(row.name)} ${dim(`[${row.estado} · ${row.edad}]`)} → https://${row.host}`);
  }
  console.log("");
}

// ─── helpers ────────────────────────────────────────────────────────────────────

export function edadDesde(ts: string | undefined, ahora = Date.now()): string {
  if (!ts) return "?";
  const ms = ahora - new Date(ts).getTime();
  if (Number.isNaN(ms) || ms < 0) return "?";
  const min = Math.floor(ms / 60000);
  if (min < 60) return `${min}m`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

async function waitReachable(url: string, tries = 20, gapMs = 3000): Promise<boolean> {
  for (let i = 0; i < tries; i++) {
    const r = await run("curl", ["-s", "-m", "8", "-o", "/dev/null", "-w", "%{http_code}", url]);
    const code = r.stdout.trim();
    if (/^(200|201|204|301|302|401|403)$/.test(code)) return true;
    if (i < tries - 1) await new Promise((res) => setTimeout(res, gapMs));
  }
  return false;
}
