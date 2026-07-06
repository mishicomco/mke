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
//     → npm install → npm run build (turbo respeta el orden contract→front), emptyDir /workspace.
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

import { RAMA, ramaHost, ramaName } from "./mkeConfig.js";
import { manifiestosRama } from "@mishicomco/rama-receta";
import { deleteRecordsByName, tunnelTarget, upsertCname } from "./cf.js";
import { previewTunnelUuid } from "./dns.js";
import { run, spawnStream, ok, bad, warn, info, dim } from "./sh.js";

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

// La receta (manifiestos PUROS + slug/nombres/host) vive en @mishicomco/rama-receta,
// compartida con Mishi Studio. Acá solo la serializamos a un List JSON para kubectl.

/** Serializa los manifiestos de la receta a un stream aplicable por `kubectl -f -`. */
function manifiestosParaKubectl(app: string, rama: string, repoUrl: string): string {
  const items = manifiestosRama({ app, rama, repoUrl, imagen: RAMA.runnerImage });
  return JSON.stringify({ apiVersion: "v1", kind: "List", items }, null, 2);
}

// ─── imagen del runner ───────────────────────────────────────────────────────

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
  const t = await run("mishi-secret", ["get", "mishi-studio-gh-read-pat"]);
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
  const manifiestos = manifiestosParaKubectl(app, rama, repoUrl);

  if (opts.dryRun) {
    console.log(manifiestos);
    return;
  }

  const emit = (estado: string, sha: string | null): void => {
    if (opts.json) console.log(JSON.stringify({ app, rama, sha, host, url, estado }));
  };

  if (!opts.json) console.log(info(`rama ${dim(app)} · ${dim(rama)} → ${dim(host)}`));

  // 0) túnel (si vamos a tocar DNS) — falla rápido antes de trabajar
  const uuid = opts.sinDns ? null : await previewTunnelUuid();

  // 1) imagen del runner + apply (idempotente; re-sincroniza si ya existe)
  await ensureRunnerImage(imagesDir);
  const apply = await run("kubectl", ["--context", CTX, "apply", "-f", "-"], manifiestos);
  if (apply.code !== 0) throw new Error(`apply falló: ${apply.stderr || apply.stdout}`);
  if (!opts.json) console.log(ok(apply.stdout.split("\n").join(" · ")));

  // 2) esperá el rollout (clone+install+build tardan) NARRANDO: mientras el pod
  // converge, streamea los logs del initContainer `preparar` (el clone/install/
  // build en vivo) para que encender no sea un silencio de minutos. El stream es
  // best-effort: si el pod aún no existe se reintenta; termina con el rollout.
  if (!opts.json) console.log(info("esperando el pod (clone + npm install + build)…"));
  const rollout = run("kubectl", ["--context", CTX, "-n", NS, "rollout", "status", `deploy/${name}`, "--timeout=600s"]);
  let stopLogs = false;
  const narrar = (async () => {
    if (opts.json) return;
    while (!stopLogs) {
      const logs = spawnStream(
        "kubectl",
        ["--context", CTX, "-n", NS, "logs", "-f", `deploy/${name}`, "-c", "preparar", "--pod-running-timeout=20s"],
        (linea) => {
          // ruido del arranque/WSL que no es narración: fuera
          if (/waiting to start: PodInitializing|fsnotify watcher/.test(linea)) return;
          console.log(dim(`  │ ${linea}`));
        },
      );
      const code = await logs;
      if (stopLogs || code === 0) break; // stream cerró naturalmente (init terminó)
      await new Promise((r) => setTimeout(r, 2000)); // pod aún no existe: reintenta
    }
  })();
  const st = await rollout;
  stopLogs = true;
  await narrar;
  const listo = st.code === 0;
  if (!opts.json) console.log(listo ? ok(st.stdout.split("\n").pop() ?? "pod listo") : warn(`el pod no convergió aún: ${st.stderr || st.stdout}`));

  // 3) DNS (salvo --sin-dns)
  if (!opts.sinDns && uuid) {
    if (!opts.json) console.log(info(`DNS: ${host} → túnel ${uuid}`));
    try {
      const que = await upsertCname(host, tunnelTarget(uuid));
      if (!opts.json) console.log(ok(que === "ok" ? "CNAME ya apuntaba bien" : `CNAME ${que}`));
    } catch (e) {
      if (!opts.json) console.log(warn(`Cloudflare API: ${e instanceof Error ? e.message : String(e)}`));
    }
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
