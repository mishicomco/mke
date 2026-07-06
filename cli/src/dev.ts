// `mke dev up|rama|pull|estado|ls|down` — el "pod de ITERACIÓN" del harness v2 de
// Mishi Studio (diseño FIRMADO por Santi, 2026-07-06). HERMANO de `mke rama`,
// pero con otro propósito:
//
//   rama → pod EFÍMERO por rama: construye el front ESTÁTICO y corre el backend
//          con `npm run dev`. Es una FOTO de la rama.
//   dev  → pod DURADERO por app, servidor de ITERACIÓN: corre la app en MODO DEV
//          REAL (vite dev con HMR + tsx watch) sobre un clone del repo. Cambiar de
//          rama = `git checkout` DENTRO del pod + reset de la DB; traer cambios =
//          `git reset --hard`; tsx/vite recogen solos. Santi ve las ediciones en
//          segundos. "Nada de puertos artesanales, nada de fallback: siempre
//          iteramos en mke-preview."
//
// Anatomía y RECETA (manifiestos PUROS + nombres/host + config de vite) viven en
// @mishicomco/dev-receta (dueño ÚNICO, compartido con Studio). Acá solo se
// serializa a un List JSON para kubectl y se orquestan los efectos (imagen, DNS,
// exec, annotations). Cluster mke-preview, ns `dev`; JAMÁS mke-prod.

import { DEV } from "./mkeConfig.js";
import { manifiestosDev, devName, devHost } from "@mishicomco/dev-receta";
import { deleteRecordsByName, tunnelTarget, upsertCname } from "./cf.js";
import { previewTunnelUuid } from "./dns.js";
import { run, spawnStream, ok, bad, warn, info, dim } from "./sh.js";

const CTX = DEV.context;
const NS = DEV.namespace;

export interface DevUpOpts {
  json?: boolean;
  dryRun?: boolean;
  /** salta TODO lo de Cloudflare (para pruebas locales sin tocar DNS real). */
  sinDns?: boolean;
  /** URL de git a clonar (default https://github.com/mishicomco/<app>.git). */
  repoUrl?: string;
  /** nombre opcional para tener varios servidores de la misma app a la vez. */
  nombre?: string;
  /** segundos del poll in-pod (0 = sin poll). */
  poll?: number;
  /** comando de siembra del app (como el sembrarCmd que consume Studio). */
  seed?: string;
  /** pares VAR=valor extra por app. Van en un Secret k8s (`<name>-env`) + envFrom
   * al contenedor dev Y al init (npm install puede necesitarlos, ej.
   * NODE_AUTH_TOKEN de GitHub Packages); nunca en claro en el Deployment. NO
   * dupliques claves que la receta ya posee (PORT, PREVIEW, DATABASE_URL, …). */
  envExtra?: Record<string, string>;
  /** modo EMBED (`--live`): vite sirve bajo `/live/<app>/` y caddy redirige la
   * raíz ahí, para que Mishi Studio embeba la app same-origen. Marca el
   * Deployment con la annotation `mke.dev/live: "true"`. Declarativo: el flag
   * vive solo en `up`; re-aplicar sin él vuelve al modo normal (lo apaga). */
  live?: boolean;
}

export interface DevMutOpts {
  json?: boolean;
  nombre?: string;
}

export interface DevDownOpts {
  json?: boolean;
  sinDns?: boolean;
  nombre?: string;
}

export interface DevLsOpts {
  json?: boolean;
}

// ─── serialización de la receta ──────────────────────────────────────────────

function manifiestosParaKubectl(opts: DevUpOpts, app: string, rama: string, repoUrl: string): string {
  const items = manifiestosDev({
    app,
    rama,
    repoUrl,
    nombre: opts.nombre,
    imagen: DEV.runnerImage,
    pollSeconds: opts.poll,
    seedCmd: opts.seed,
    envExtra: opts.envExtra,
    live: opts.live,
  });
  return JSON.stringify({ apiVersion: "v1", kind: "List", items }, null, 2);
}

// ─── imagen del runner ───────────────────────────────────────────────────────

async function ensureRunnerImage(imagesDir: string): Promise<void> {
  const img = DEV.runnerImage;
  const has = await run("docker", ["image", "inspect", img]);
  if (has.code !== 0) {
    console.log(info(`construyo la imagen del runner ${dim(img)} (primera vez)`));
    const build = await run("docker", ["build", "-t", img, imagesDir]);
    if (build.code !== 0) throw new Error(`docker build del runner falló: ${build.stderr || build.stdout}`);
  }
  console.log(info(`k3d image import ${dim(img)} → ${DEV.cluster}`));
  const imp = await run("k3d", ["image", "import", img, "-c", DEV.cluster]);
  if (imp.code !== 0) throw new Error(`k3d image import del runner falló: ${imp.stderr || imp.stdout}`);
}

/** URL de clone. Con `--repo-url` gana ese; si no, el repo del ecosistema. */
async function resolveRepoUrl(app: string, override: string | undefined, dryRun: boolean): Promise<string> {
  if (override) return override;
  const base = `https://github.com/mishicomco/${app}.git`;
  if (dryRun) return base; // en dry-run nunca metemos el token (no se imprime)
  const t = await run("mishi-secret", ["get", "mishi-studio-gh-read-pat"]);
  if (t.code === 0 && t.stdout.trim()) {
    return `https://x-access-token:${t.stdout.trim()}@github.com/mishicomco/${app}.git`;
  }
  return base;
}

// ─── fail-fast del rollout ───────────────────────────────────────────────────

/**
 * Detecta si el pod cayó en un estado terminal (Init:Error/CrashLoopBackOff) y,
 * si es así, imprime los logs del contenedor culpable y devuelve true para
 * abortar antes del timeout ciego. Best-effort (lectura pura de kubectl).
 */
async function podReventó(name: string): Promise<{ muerto: boolean; motivo?: string }> {
  const r = await run("kubectl", [
    "--context", CTX, "-n", NS, "get", "pods", "-l", `app=${name}`, "-o", "json",
  ]);
  if (r.code !== 0) return { muerto: false };
  let pods: any[] = [];
  try { pods = (JSON.parse(r.stdout).items ?? []) as any[]; } catch { return { muerto: false }; }
  for (const p of pods) {
    const estados = [
      ...(p.status?.initContainerStatuses ?? []),
      ...(p.status?.containerStatuses ?? []),
    ];
    for (const c of estados) {
      const w = c.state?.waiting?.reason as string | undefined;
      const t = c.state?.terminated?.reason as string | undefined;
      if (w === "CrashLoopBackOff" || t === "Error" || w === "ImagePullBackOff" || w === "ErrImagePull") {
        return { muerto: true, motivo: `${c.name}: ${w ?? t}` };
      }
    }
  }
  return { muerto: false };
}

async function logsDe(name: string, contenedor: string): Promise<string> {
  const r = await run("kubectl", [
    "--context", CTX, "-n", NS, "logs", `deploy/${name}`, "-c", contenedor, "--tail=30",
  ]);
  return (r.stdout || r.stderr || "").trim();
}

/** SHA corto vivo del pod (git rev-parse dentro del contenedor dev). */
async function shaVivo(name: string): Promise<string | null> {
  const r = await run("kubectl", [
    "--context", CTX, "-n", NS, "exec", `deploy/${name}`, "-c", "dev", "--",
    "git", "-C", "/workspace/repo", "rev-parse", "--short", "HEAD",
  ]);
  const sha = r.stdout.trim();
  return r.code === 0 && sha ? sha : null;
}

/** Escribe las annotations vivas rama/sha en el Deployment (no toca el template
 * → sin rollout). Las lee `dev estado`. */
async function anotar(name: string, rama: string | undefined, sha: string | null): Promise<void> {
  const pares: string[] = [];
  if (rama) pares.push(`mke.dev/rama=${rama}`);
  if (sha) pares.push(`mke.dev/sha=${sha}`);
  if (!pares.length) return;
  await run("kubectl", ["--context", CTX, "-n", NS, "annotate", "--overwrite", `deploy/${name}`, ...pares]);
}

// ─── up ──────────────────────────────────────────────────────────────────────

export async function devUp(app: string, rama: string, imagesDir: string, opts: DevUpOpts): Promise<void> {
  const name = devName(app, opts.nombre);
  const host = devHost(app, opts.nombre);
  const url = `https://${host}`;
  const repoUrl = await resolveRepoUrl(app, opts.repoUrl, opts.dryRun === true);
  const manifiestos = manifiestosParaKubectl(opts, app, rama, repoUrl);

  if (opts.dryRun) {
    console.log(manifiestos);
    return;
  }

  const emit = (estado: string, sha: string | null): void => {
    if (opts.json) console.log(JSON.stringify({ app, rama, nombre: opts.nombre ?? null, sha, host, url, estado }));
  };

  if (!opts.json) console.log(info(`dev ${dim(app)} · rama ${dim(rama)} → ${dim(host)}`));

  // 0) túnel (si vamos a tocar DNS) — falla rápido antes de trabajar
  const uuid = opts.sinDns ? null : await previewTunnelUuid();

  // 1) imagen del runner + apply (idempotente)
  await ensureRunnerImage(imagesDir);
  const apply = await run("kubectl", ["--context", CTX, "apply", "-f", "-"], manifiestos);
  if (apply.code !== 0) throw new Error(`apply falló: ${apply.stderr || apply.stdout}`);
  if (!opts.json) console.log(ok(apply.stdout.split("\n").join(" · ")));

  // 2) esperá el rollout NARRANDO los logs del init (clone+install en vivo), con
  //    FAIL-FAST: si el pod revienta (Init:Error/CrashLoop/ImagePull) abortamos
  //    mostrando los logs del contenedor culpable, sin esperar 600s ciegos.
  if (!opts.json) console.log(info("esperando el pod (clone + npm install)…"));
  const rollout = run("kubectl", ["--context", CTX, "-n", NS, "rollout", "status", `deploy/${name}`, "--timeout=600s"]);
  let stopLogs = false;
  const narrar = (async () => {
    if (opts.json) return;
    while (!stopLogs) {
      const logs = spawnStream(
        "kubectl",
        ["--context", CTX, "-n", NS, "logs", "-f", `deploy/${name}`, "-c", "preparar", "--pod-running-timeout=20s"],
        (linea) => {
          if (/waiting to start: PodInitializing|fsnotify watcher/.test(linea)) return;
          console.log(dim(`  │ ${linea}`));
        },
      );
      const code = await logs;
      if (stopLogs || code === 0) break;
      await new Promise((r) => setTimeout(r, 2000));
    }
  })();
  // vigilante fail-fast: sondea el pod; si revienta, corta el rollout.
  const vigilante = (async () => {
    while (!stopLogs) {
      await new Promise((r) => setTimeout(r, 4000));
      if (stopLogs) break;
      const { muerto, motivo } = await podReventó(name);
      if (muerto) return motivo ?? "pod en estado terminal";
    }
    return null;
  })();

  const carrera = await Promise.race([
    rollout.then((st) => ({ tipo: "rollout" as const, st })),
    vigilante.then((motivo) => ({ tipo: "reventó" as const, motivo })),
  ]);
  stopLogs = true;
  await narrar;

  if (carrera.tipo === "reventó" && carrera.motivo) {
    const culpable = carrera.motivo.split(":")[0];
    const logs = await logsDe(name, culpable);
    if (!opts.json) {
      console.log(bad(`el pod reventó (${carrera.motivo}) — logs de ${culpable}:`));
      for (const l of logs.split("\n")) console.log(dim(`  │ ${l}`));
    }
    emit("reventó", null);
    throw new Error(`dev ${name} reventó: ${carrera.motivo}`);
  }

  const st = carrera.tipo === "rollout" ? carrera.st : await rollout;
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

  // 4) annotations vivas (rama + sha del pod) + alcance
  const sha = listo ? await shaVivo(name) : null;
  await anotar(name, rama, sha);
  let estado = listo ? "aplicado" : "pendiente";
  if (!opts.sinDns && listo) {
    const reachable = await waitReachable(`${url}/`);
    estado = reachable ? "vivo" : "aplicado";
    if (!opts.json) {
      console.log("");
      console.log(reachable ? ok(`dev VIVO → ${url}`) : warn(`aplicado pero aún no responde en ${url}`));
    }
  } else if (opts.sinDns && !opts.json) {
    console.log(ok(`dev aplicado (--sin-dns) → ${name} en ns ${NS}`));
  }
  emit(estado, sha);
}

// ─── rama (cambio de rama dentro del pod) ────────────────────────────────────

export async function devRama(app: string, rama: string, opts: DevMutOpts): Promise<void> {
  const name = devName(app, opts.nombre);
  if (!opts.json) console.log(info(`dev ${dim(name)}: checkout ${dim(rama)} + reset DB (dentro del pod)`));
  const r = await run("kubectl", [
    "--context", CTX, "-n", NS, "exec", `deploy/${name}`, "-c", "dev", "--",
    "sh", "/mke/rama.sh", rama,
  ]);
  if (!opts.json) {
    for (const l of (r.stdout || r.stderr).split("\n")) if (l.trim()) console.log(dim(`  │ ${l}`));
  }
  if (r.code !== 0) {
    if (!opts.json) console.log(bad(`checkout falló: ${r.stderr || r.stdout}`));
    if (opts.json) console.log(JSON.stringify({ app, rama, name, estado: "error" }));
    return;
  }
  const sha = await shaVivo(name);
  await anotar(name, rama, sha);
  if (!opts.json) console.log(ok(`rama activa: ${rama}${sha ? ` @ ${sha}` : ""}`));
  else console.log(JSON.stringify({ app, rama, name, sha, estado: "cambiada" }));
}

// ─── pull (traer cambios de la rama activa) ──────────────────────────────────

export async function devPull(app: string, opts: DevMutOpts): Promise<void> {
  const name = devName(app, opts.nombre);
  if (!opts.json) console.log(info(`dev ${dim(name)}: pull de la rama activa`));
  const r = await run("kubectl", [
    "--context", CTX, "-n", NS, "exec", `deploy/${name}`, "-c", "dev", "--",
    "sh", "/mke/pull.sh",
  ]);
  if (!opts.json) {
    for (const l of (r.stdout || r.stderr).split("\n")) if (l.trim()) console.log(dim(`  │ ${l}`));
  }
  if (r.code !== 0) {
    if (!opts.json) console.log(bad(`pull falló: ${r.stderr || r.stdout}`));
    if (opts.json) console.log(JSON.stringify({ app, name, estado: "error" }));
    return;
  }
  const sha = await shaVivo(name);
  const rama = await ramaActiva(name);
  await anotar(name, rama ?? undefined, sha);
  if (!opts.json) console.log(ok(`al día${sha ? ` @ ${sha}` : ""}`));
  else console.log(JSON.stringify({ app, name, rama, sha, estado: "al-dia" }));
}

// ─── estado ──────────────────────────────────────────────────────────────────

/** rama activa según el archivo que el pod mantiene (/workspace/.dev/rama). */
async function ramaActiva(name: string): Promise<string | null> {
  const r = await run("kubectl", [
    "--context", CTX, "-n", NS, "exec", `deploy/${name}`, "-c", "dev", "--",
    "cat", "/workspace/.dev/rama",
  ]);
  const rama = r.stdout.trim();
  return r.code === 0 && rama ? rama : null;
}

export async function devEstado(app: string, opts: DevMutOpts): Promise<void> {
  const name = devName(app, opts.nombre);
  const host = devHost(app, opts.nombre);
  const r = await run("kubectl", ["--context", CTX, "-n", NS, "get", "deploy", name, "-o", "json"]);
  if (r.code !== 0) {
    if (opts.json) console.log(JSON.stringify({ app, name, host, estado: "apagado" }));
    else console.log(warn(`no hay servidor de iteración ${dim(name)} encendido`));
    return;
  }
  let d: any = {};
  try { d = JSON.parse(r.stdout); } catch { /* vacío */ }
  const ann = d.metadata?.annotations ?? {};
  const avail = d.status?.availableReplicas ?? 0;
  const total = d.status?.replicas ?? 0;
  const estadoPod = avail > 0 ? "vivo" : total > 0 ? "arrancando" : "detenido";
  const edad = edadDesde(d.metadata?.creationTimestamp);
  // el sha vivo (exec git rev-parse) es la verdad aunque el poll haya refrescado;
  // la rama la damos por el archivo del pod (o la annotation como respaldo).
  const sha = avail > 0 ? await shaVivo(name) : null;
  const rama = (avail > 0 ? await ramaActiva(name) : null) ?? ann["mke.dev/rama"] ?? null;

  if (opts.json) {
    console.log(JSON.stringify({ app, name, host, rama, sha: sha ?? ann["mke.dev/sha"] ?? null, edad, estado: estadoPod }));
    return;
  }
  console.log(`\n  servidor de iteración ${info(name)} ${dim(`[${estadoPod} · ${edad}]`)}`);
  console.log(`    rama activa: ${info(rama ?? "?")}${sha ? dim(` @ ${sha}`) : ""}`);
  console.log(`    → https://${host}\n`);
}

// ─── ls ────────────────────────────────────────────────────────────────────────

interface DevRow {
  app: string;
  name: string;
  host: string;
  rama: string;
  edad: string;
  estado: string;
}

export async function devLs(app: string | undefined, opts: DevLsOpts): Promise<void> {
  const sel = app ? `mke.dev/managed=true,mke.dev/app=${app}` : "mke.dev/managed=true";
  const r = await run("kubectl", ["--context", CTX, "-n", NS, "get", "deploy", "-l", sel, "-o", "json"]);
  if (r.code !== 0) {
    if (opts.json) console.log("[]");
    else console.log(bad(`no pude listar (¿existe el clúster/namespace ${NS}?): ${r.stderr.split("\n")[0]}`));
    return;
  }
  let items: unknown[] = [];
  try {
    items = (JSON.parse(r.stdout) as { items?: unknown[] }).items ?? [];
  } catch { /* namespace vacío */ }

  const rows: DevRow[] = items.map((it) => {
    const d = it as {
      metadata?: { labels?: Record<string, string>; annotations?: Record<string, string>; creationTimestamp?: string };
      status?: { availableReplicas?: number; replicas?: number };
    };
    const labels = d.metadata?.labels ?? {};
    const ann = d.metadata?.annotations ?? {};
    const name = labels["mke.dev/name"] ?? "?";
    const avail = d.status?.availableReplicas ?? 0;
    const total = d.status?.replicas ?? 0;
    return {
      app: labels["mke.dev/app"] ?? "?",
      name,
      host: `${name}${DEV.hostSuffix}.mishi.com.co`,
      rama: ann["mke.dev/rama"] ?? "?",
      edad: edadDesde(d.metadata?.creationTimestamp),
      estado: avail > 0 ? "vivo" : total > 0 ? "arrancando" : "detenido",
    };
  });

  if (opts.json) {
    console.log(JSON.stringify(rows));
    return;
  }
  console.log(`\n  servidores de iteración ${dim(`(${CTX} · ns ${NS})`)}`);
  if (!rows.length) { console.log(`    ${dim("(ninguno)")}\n`); return; }
  for (const row of rows) {
    console.log(`    ${info(row.name)} ${dim(`[${row.estado} · ${row.rama} · ${row.edad}]`)} → https://${row.host}`);
  }
  console.log("");
}

// ─── down ─────────────────────────────────────────────────────────────────────

export async function devDown(app: string, opts: DevDownOpts): Promise<void> {
  const name = devName(app, opts.nombre);
  const host = devHost(app, opts.nombre);
  if (!opts.json) console.log(info(`bajando servidor de iteración ${dim(name)} (${host})`));

  const del = await run("kubectl", [
    "--context", CTX, "-n", NS,
    "delete", "deployment,service,ingress,configmap,secret",
    "-l", `mke.dev/name=${name}`,
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
  if (opts.json) console.log(JSON.stringify({ app, name, host, estado: "apagado", dnsBorrado }));
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

/** parsea `K1=V1,K2=V2` → objeto (para el flag --env de env extra por app). */
export function parseEnvExtra(raw: string | undefined): Record<string, string> | undefined {
  if (!raw) return undefined;
  const out: Record<string, string> = {};
  for (const par of raw.split(",")) {
    const i = par.indexOf("=");
    if (i <= 0) continue;
    out[par.slice(0, i).trim()] = par.slice(i + 1).trim();
  }
  return Object.keys(out).length ? out : undefined;
}

async function waitReachable(url: string, tries = 30, gapMs = 3000): Promise<boolean> {
  for (let i = 0; i < tries; i++) {
    const r = await run("curl", ["-s", "-m", "8", "-o", "/dev/null", "-w", "%{http_code}", url]);
    const code = r.stdout.trim();
    if (/^(200|201|204|301|302|401|403)$/.test(code)) return true;
    if (i < tries - 1) await new Promise((res) => setTimeout(res, gapMs));
  }
  return false;
}
