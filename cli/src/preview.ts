// `mke preview up/down/ls` — previews EFÍMEROS POR FEATURE en el clúster
// mke-preview (k3d SEPARADO de prod; jamás se toca mke-prod).
//
// Un feature (rama) = un namespace efímero con:
//   · postgres efímero (postgres:16-alpine, emptyDir — sin PVC)
//   · Secret del app (DATABASE_URL -> pg efímero + llaves fail-closed + PREVIEW=true)
//   · el Deployment del app (su k8s/base, imagen construida desde la rama)
//   · un Ingress Traefik con host <slugApp>-<feature>-pre.mishi.com.co (path / -> backend)
//   · un CNAME <slugApp>-<feature>-pre -> UUID del túnel mke-preview (--overwrite-dns)
//
// El NOMBRE del preview (= namespace = prefijo del host) es `<slugApp>-<feature>`:
// el slug público de la app al inicio para que con muchas apps se sepa qué es qué.
// `down` recibe ese nombre completo (lo que muestra `ls`).
//
// `up` construye desde la RAMA (git worktree efímero + docker build + k3d import),
// aplica los manifests, crea el DNS y verifica alcance (curl con reintentos).
// `down` borra el namespace + el CNAME (vía API de Cloudflare; cloudflared no borra).

import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appsRoot, PREVIEW, previewHost, previewName, slugFeature } from "./mkeConfig.js";
import { previewApp, type PreviewApp, type SecretValue } from "./previewApps.js";
import { deleteRecordsByName } from "./cf.js";
import { run, ok, bad, warn, info, dim } from "./sh.js";

const CTX = PREVIEW.context;

/** UUID del túnel mke-preview (resuelto en runtime; bootstrap lo crea). */
async function tunnelUuid(): Promise<string> {
  const r = await run("cloudflared", ["tunnel", "list"]);
  if (r.code !== 0) throw new Error(`cloudflared tunnel list falló: ${r.stderr}`);
  for (const line of r.stdout.split("\n")) {
    const cols = line.trim().split(/\s+/);
    if (cols[1] === PREVIEW.tunnelName) return cols[0];
  }
  throw new Error(
    `no existe el túnel '${PREVIEW.tunnelName}'. Corré primero: scripts/bootstrap-preview.sh`,
  );
}

async function resolveSecret(v: SecretValue): Promise<string> {
  if (typeof v === "string") {
    return v === "__RANDOM__" ? randomBytes(16).toString("hex") : v;
  }
  const r = await run("mishi-secret", ["get", v.fromSecret]);
  if (r.code !== 0 || !r.stdout) throw new Error(`no pude leer el secreto ${v.fromSecret}`);
  return r.stdout.trim();
}

export interface PreviewUpOpts {
  feature?: string;
  dir?: string;
  dryRun?: boolean;
}

export async function previewUp(app: string, rama: string, opts: PreviewUpOpts): Promise<void> {
  const feature = opts.feature ? slugFeature(opts.feature) : slugFeature(rama);
  const appDir = opts.dir ?? join(appsRoot(), app);
  const cfg = previewApp(app);
  // nombre del preview = <slugApp>-<feature> (sin duplicar si la rama ya lo trae)
  const nombre = previewName(cfg.slug, feature);
  const ns = nombre;
  const host = previewHost(nombre);
  const image = `${app}:pre-${feature}`;
  const baseDir = join(appDir, "k8s", "base");

  if (!existsSync(appDir)) throw new Error(`no existe el repo del app: ${appDir}`);
  if (!existsSync(baseDir)) throw new Error(`el app no tiene k8s/base: ${baseDir}`);

  console.log(info(`preview ${dim(app)} · rama ${dim(rama)} · feature ${dim(feature)} → ${dim(host)}`));

  if (opts.dryRun) {
    console.log(info("DRY RUN — no se toca nada. Plan:"));
    console.log(`  1. git worktree efímero de \`${rama}\` en ${appDir}`);
    console.log(`  2. docker build -t ${image} (Dockerfile: ${cfg.dockerfile ?? "auto-detectado"})`);
    console.log(`  3. k3d image import ${image} → ${PREVIEW.cluster}`);
    console.log(`  4. namespace \`${ns}\` (${CTX}): postgres efímero (${cfg.db.name}/${cfg.db.user}) + Secret \`${cfg.secretName}\` + Deployment/Ingress de la base`);
    console.log(`  5. DNS: ${host} → túnel ${PREVIEW.tunnelName} (--overwrite-dns)`);
    console.log(`  6. esperar rollout + verificar https://${host}/health`);
    console.log(info("nada ejecutado (--dry-run)"));
    return;
  }

  // 0) resolvé el túnel ANTES de trabajar (falla rápido si no hay bootstrap)
  const uuid = await tunnelUuid();

  // 1) worktree efímero de la rama (detached: no choca con ramas ya usadas)
  const wt = mkdtempSync(join(tmpdir(), `mke-pre-${feature}-`));
  let builtOk = false;
  try {
    console.log(info(`git worktree ${dim(rama)} → ${dim(wt)}`));
    const add = await run("git", ["-C", appDir, "worktree", "add", "--detach", "--force", wt, rama]);
    if (add.code !== 0) throw new Error(`git worktree add falló: ${add.stderr || add.stdout}`);

    // 2) build desde la rama (context = raíz del repo, -f el Dockerfile del app)
    const dockerfile = cfg.dockerfile ?? (existsSync(join(wt, "Dockerfile")) ? "Dockerfile" : "apps/backend/Dockerfile");
    console.log(info(`docker build ${dim(image)} (-f ${dockerfile})`));
    const build = await run("docker", ["build", "-t", image, "-f", join(wt, dockerfile), wt]);
    if (build.code !== 0) throw new Error(`docker build falló: ${build.stderr || build.stdout}`);
    console.log(ok("imagen construida"));

    // 3) import directo al clúster de previews
    console.log(info(`k3d image import ${dim(image)} → ${PREVIEW.cluster}`));
    const imp = await run("k3d", ["image", "import", image, "-c", PREVIEW.cluster]);
    if (imp.code !== 0) throw new Error(`k3d image import falló: ${imp.stderr || imp.stdout}`);
    console.log(ok("imagen importada"));

    // 4) overlay de preview DENTRO del worktree (para que ../../base resuelva y
    //    kubectl -k lo acepte sin salir de la raíz de la kustomización)
    const overlayDir = join(wt, "k8s", "overlays", "preview");
    mkdirSync(overlayDir, { recursive: true });
    const dbUrl = `postgres://${cfg.db.user}:${cfg.db.password}@${app}-pg.${ns}.svc.cluster.local:5432/${cfg.db.name}`;
    const literals: Record<string, string> = { [cfg.databaseUrlKey ?? "DATABASE_URL"]: dbUrl };
    for (const [k, v] of Object.entries(cfg.secretLiterals)) literals[k] = await resolveSecret(v);

    writeFileSync(join(overlayDir, "resources.yaml"), resourcesYaml(app, ns, host, cfg, literals));
    writeFileSync(join(overlayDir, "kustomization.yaml"), kustomizationYaml(app, ns, host, image, cfg));

    // 5) apply (kubectl ordena: Namespace primero)
    console.log(info(`kubectl apply -k (${CTX}/${ns})`));
    const apply = await run("kubectl", ["--context", CTX, "apply", "-k", overlayDir]);
    if (apply.code !== 0) throw new Error(`apply falló: ${apply.stderr || apply.stdout}`);
    console.log(ok(apply.stdout.split("\n").join(" · ")));

    // 6) esperá postgres y el backend
    await run("kubectl", ["--context", CTX, "-n", ns, "rollout", "status", `deploy/${app}-pg`, "--timeout=120s"]);
    const deployName = cfg.deployName ?? app;
    const st = await run("kubectl", ["--context", CTX, "-n", ns, "rollout", "status", `deploy/${deployName}`, "--timeout=150s"]);
    if (st.code !== 0) console.log(warn(`el backend no convergió aún: ${st.stderr || st.stdout}`));
    else console.log(ok(st.stdout.split("\n").pop() ?? "backend listo"));

    // 7) DNS: CNAME <slugApp>-<feature>-pre -> túnel (UUID + overwrite, gana sobre el wildcard)
    console.log(info(`DNS: ${host} → túnel ${uuid}`));
    const dns = await run("cloudflared", ["tunnel", "route", "dns", "--overwrite-dns", uuid, host]);
    if (dns.code !== 0) console.log(warn(`cloudflared route dns: ${dns.stderr || dns.stdout}`));
    else console.log(ok(`CNAME listo para ${host}`));

    builtOk = true;

    // 8) verificá alcance (reintentos, sin sleeps ciegos)
    const reachable = await waitReachable(`https://${host}/health`);
    console.log("");
    if (reachable) console.log(ok(`preview VIVO → https://${host}`));
    else {
      console.log(warn(`preview aplicado pero aún NO responde 2xx en https://${host}/health`));
      console.log(info(`  revisá: kubectl --context ${CTX} -n ${ns} get pods`));
    }
  } finally {
    // limpiá el worktree efímero (la imagen queda en el clúster)
    await run("git", ["-C", appDir, "worktree", "remove", "--force", wt]);
    try { rmSync(wt, { recursive: true, force: true }); } catch { /* ya lo quitó git */ }
  }
  if (!builtOk) process.exitCode = 1;
}

/** baja un preview por su NOMBRE completo `<slugApp>-<feature>` (lo que muestra `ls`). */
export async function previewDown(nombre: string, opts: { dryRun?: boolean } = {}): Promise<void> {
  const ns = slugFeature(nombre);
  const host = previewHost(ns);
  console.log(info(`bajando preview ${dim(ns)} (${host})`));

  if (opts.dryRun) {
    console.log(info("DRY RUN — no se toca nada. Plan:"));
    console.log(`  1. kubectl --context ${CTX} delete namespace ${ns}`);
    console.log(`  2. borrar CNAME ${host} (API Cloudflare)`);
    console.log(info("nada ejecutado (--dry-run)"));
    return;
  }

  const del = await run("kubectl", ["--context", CTX, "delete", "namespace", ns, "--ignore-not-found", "--wait=false"]);
  if (del.code === 0) console.log(ok(del.stdout || `namespace ${ns} borrándose`));
  else console.log(warn(`no pude borrar el namespace: ${del.stderr || del.stdout}`));

  try {
    const n = await deleteRecordsByName(host);
    console.log(ok(n ? `CNAME ${host} borrado` : `no había CNAME ${host}`));
  } catch (e) {
    console.log(bad(`DNS: ${e instanceof Error ? e.message : String(e)}`));
  }
}

export async function previewLs(): Promise<void> {
  // Los namespaces de preview son los que NO son de sistema/infra.
  const infra = new Set(["default", "ingress", "cloudflare", "kube-system", "kube-public", "kube-node-lease"]);
  const r = await run("kubectl", ["--context", CTX, "get", "ns", "-o", "jsonpath={range .items[*]}{.metadata.name}{\"\\t\"}{.status.phase}{\"\\n\"}{end}"]);
  if (r.code !== 0) {
    console.log(bad(`no pude listar (¿existe el clúster mke-preview?): ${r.stderr.split("\n")[0]}`));
    return;
  }
  const rows = r.stdout.split("\n").map((l) => l.split("\t")[0]).filter((n) => n && !infra.has(n));
  console.log(`\n  previews vivos ${dim(`(${CTX})`)}`);
  if (!rows.length) { console.log(`    ${dim("(ninguno)")}\n`); return; }
  for (const ns of rows) console.log(`    ${info(ns)} → https://${previewHost(ns)}`);
  console.log("");
}

// ─── generación de manifests ────────────────────────────────────────────────

/** Namespace + postgres efímero + Secret del app. */
function resourcesYaml(app: string, ns: string, host: string, cfg: PreviewApp, literals: Record<string, string>): string {
  const b64 = (s: string): string => Buffer.from(s, "utf8").toString("base64");
  const data = Object.entries(literals).map(([k, v]) => `  ${k}: ${b64(v)}`).join("\n");
  return `apiVersion: v1
kind: Namespace
metadata:
  name: ${ns}
  labels:
    app.kubernetes.io/part-of: mke-preview
    mke.preview/feature: ${ns}
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: ${app}-pg
  labels: { app: ${app}-pg }
spec:
  replicas: 1
  selector: { matchLabels: { app: ${app}-pg } }
  template:
    metadata:
      labels: { app: ${app}-pg }
    spec:
      containers:
        - name: postgres
          image: postgres:16-alpine
          env:
            - { name: POSTGRES_USER, value: "${cfg.db.user}" }
            - { name: POSTGRES_PASSWORD, value: "${cfg.db.password}" }
            - { name: POSTGRES_DB, value: "${cfg.db.name}" }
            - { name: PGDATA, value: /var/lib/postgresql/data/pgdata }
          ports: [{ containerPort: 5432 }]
          readinessProbe:
            exec: { command: ["pg_isready", "-U", "${cfg.db.user}", "-d", "${cfg.db.name}"] }
            periodSeconds: 3
            failureThreshold: 20
          volumeMounts:
            - { name: data, mountPath: /var/lib/postgresql/data }
      volumes:
        - name: data
          emptyDir: {}
---
apiVersion: v1
kind: Service
metadata:
  name: ${app}-pg
spec:
  selector: { app: ${app}-pg }
  ports: [{ port: 5432, targetPort: 5432 }]
---
apiVersion: v1
kind: Secret
metadata:
  name: ${cfg.secretName}
type: Opaque
data:
${data}
`;
}

/** overlay que reusa la base del app + parches de preview. */
function kustomizationYaml(app: string, ns: string, host: string, image: string, cfg: PreviewApp): string {
  const [imgName, imgTag] = image.split(":");
  const deployName = cfg.deployName ?? app;
  return `apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization

namespace: ${ns}

resources:
  - ../../base
  - resources.yaml

images:
  - name: ${imgName}
    newTag: ${imgTag}

patches:
  # host del preview + ruta / -> backend (la base solo enruta /api; en preview no
  # hay static-mishi, así que exponemos todo el backend, incluido /health)
  - target: { kind: Ingress }
    patch: |
      - op: replace
        path: /spec/rules/0/host
        value: ${host}
      - op: replace
        path: /spec/rules/0/http/paths/0/path
        value: /
  # PREVIEW=true: siembra por escenario de Studio si el app lo soporta
  - target: { kind: Deployment, name: ${deployName} }
    patch: |
      - op: add
        path: /spec/template/spec/containers/0/env/-
        value: { name: PREVIEW, value: "true" }
`;
}

// ─── alcance ────────────────────────────────────────────────────────────────

async function waitReachable(url: string, tries = 20, gapMs = 3000): Promise<boolean> {
  for (let i = 0; i < tries; i++) {
    const r = await run("curl", ["-s", "-m", "8", "-o", "/dev/null", "-w", "%{http_code}", url]);
    const code = r.stdout.trim();
    if (/^(200|201|204|301|302|401|403)$/.test(code)) return true;
    process.stdout.write(dim(`  intento ${i + 1}/${tries}: HTTP ${code || "000"}\r`));
    if (i < tries - 1) await new Promise((res) => setTimeout(res, gapMs));
  }
  return false;
}
