// `mke preview up|pull|estado|ls|down|limpiar` — preview-pods EFÍMEROS atados a
// la vida de la RAMA (diseño 2026-07-11). Reusa AL MÁXIMO la maquinaria de
// `mke dev` (mismo pod: init clona+instala, vite HMR + tsx watch, caddy
// un-solo-origen — ver `manifiestosPreview` en @mishicomco/dev-receta, que
// deriva de `manifiestosDev`), con tres diferencias de fondo:
//
//   1. Namespace/host PROPIOS con la rama SIEMPRE en el nombre: `preview` (ns),
//      host BARE `<app>-<slug(rama)>.mishi.com.co` (sin sufijo `-pre`/`-feat`).
//   2. DB efímera en postgres-mishi (`databases-dev`), NO un sidecar por-pod:
//      una BD `<app>_<rama_slug>` que persiste entre reinicios del pod (ver
//      `previewDb.ts`). `--espejo` la puebla con datos de STAGE, sanitizados
//      contra `apps/backend/db/tablas-sensibles.txt` del repo de la app.
//   3. Un git WORKTREE local persistido en `<app>.wt-<rama-slug>` (hermano del
//      repo), para que Santi pueda editar esa rama localmente Y en el pod a la
//      vez; el pod sigue clonando de GitHub (igual que `mke dev`), el worktree
//      es solo para el filo local + el push inicial.
//
// `mke preview down` (y por ende `mke preview limpiar`) son IDEMPOTENTES y
// pensados para correr SIN TTY desde un runner de CI (workflow `on: delete` de
// cada app): recursos/DB/worktree ausentes → warning y sigue, nunca falla.

import { existsSync } from "node:fs";
import { join } from "node:path";
import { appsRoot, PREVIEW } from "./mkeConfig.js";
import {
  manifiestosPreview,
  previewPodName,
  previewPodHost,
  selectorDePreview,
  slugDev,
} from "@mishicomco/dev-receta";
import { deleteRecordsByName, tunnelTarget, upsertCname } from "./cf.js";
import { previewTunnelUuid } from "./dns.js";
import {
  dbNamePreview,
  previewDatabaseUrl,
  provisionarDbPreview,
  resolveAppDbCreds,
  dropDbPreview,
  truncarTodo,
  leerTablasSensibles,
  restaurarEspejo,
} from "./previewDb.js";
import { run, ok, bad, warn, info, dim } from "./sh.js";

const CTX = PREVIEW.context;
const NS = "preview";

export interface PreviewUpOpts {
  espejo?: boolean;
  envExtra?: Record<string, string>;
  live?: boolean;
  json?: boolean;
  dryRun?: boolean;
  repoUrl?: string;
}

export interface PreviewMutOpts {
  json?: boolean;
}

export interface PreviewDownOpts {
  json?: boolean;
  /** salta el borrado del git worktree local (el runner de CI no lo tiene). */
  sinWorktree?: boolean;
}

export interface PreviewLsOpts {
  json?: boolean;
}

// ─── git local: rama + worktree persistido ───────────────────────────────────

function worktreeDir(appDir: string, ramaSlug: string): string {
  return `${appDir}.wt-${ramaSlug}`;
}

/** asegura que la rama exista LOCALMENTE (creada desde main actualizado si no
 * existe) y que haya un worktree persistido en `<app>.wt-<rama-slug>`. Devuelve
 * el path del worktree. Idempotente: re-correr `up` no rompe un worktree ya
 * creado (git worktree add sobre un path existente con la misma rama es no-op
 * salvo que el path no sea ya un worktree válido, en cuyo caso se reintenta). */
async function asegurarWorktree(appDir: string, rama: string, ramaSlug: string): Promise<string> {
  if (!existsSync(appDir)) throw new Error(`no existe el repo del app: ${appDir} (¿falta clonarlo como hermano?)`);
  const wt = worktreeDir(appDir, ramaSlug);

  const existeRamaLocal = (await run("git", ["-C", appDir, "show-ref", "--verify", "-q", `refs/heads/${rama}`])).code === 0;
  if (!existeRamaLocal) {
    console.log(info(`la rama ${dim(rama)} no existe local: creándola desde main`));
    const fetch = await run("git", ["-C", appDir, "fetch", "origin", "main"]);
    if (fetch.code !== 0) console.log(warn(`fetch de main falló (sigo con lo local): ${fetch.stderr}`));
    const base = (await run("git", ["-C", appDir, "rev-parse", "--verify", "-q", "origin/main"])).code === 0 ? "origin/main" : "main";
    const crear = await run("git", ["-C", appDir, "branch", rama, base]);
    if (crear.code !== 0) throw new Error(`no pude crear la rama ${rama} desde ${base}: ${crear.stderr || crear.stdout}`);
  }

  if (!existsSync(wt)) {
    console.log(info(`git worktree ${dim(rama)} → ${dim(wt)}`));
    const add = await run("git", ["-C", appDir, "worktree", "add", wt, rama]);
    if (add.code !== 0) throw new Error(`git worktree add falló: ${add.stderr || add.stdout}`);
  }

  const push = await run("env", [
    "-u", "GITHUB_TOKEN", "git", "-c", "credential.helper=!gh auth git-credential",
    "-C", appDir, "push", "-u", "origin", rama,
  ]);
  if (push.code !== 0) console.log(warn(`push de ${rama} falló (sigo; el pod igual clona lo que ya esté en origin): ${push.stderr || push.stdout}`));
  else console.log(ok(`rama ${dim(rama)} empujada a origin`));

  return wt;
}

/** best-effort: borra el worktree local. Silencioso si no existe en ESTA
 * máquina (el runner de CI del `on: delete` no tiene los worktrees del laptop). */
async function borrarWorktreeSiExiste(appDir: string, ramaSlug: string, opts: { json?: boolean }): Promise<void> {
  const wt = worktreeDir(appDir, ramaSlug);
  if (!existsSync(wt)) {
    if (!opts.json) console.log(dim(`  sin worktree local en esta máquina (${wt}) — nada que borrar`));
    return;
  }
  const del = await run("git", ["-C", appDir, "worktree", "remove", "--force", wt]);
  if (del.code === 0) { if (!opts.json) console.log(ok(`worktree ${dim(wt)} borrado`)); }
  else if (!opts.json) console.log(warn(`no pude borrar el worktree ${wt}: ${del.stderr || del.stdout}`));
}

// ─── credenciales de git/npm (mismo patrón que `mke dev`) ────────────────────

async function resolveRepoUrl(app: string, override: string | undefined, dryRun: boolean): Promise<string> {
  if (override) return override;
  const base = `https://github.com/mishicomco/${app}.git`;
  if (dryRun) return base;
  const t = await run("mishi-secret", ["get", "mishi-studio-gh-read-pat"]);
  if (t.code === 0 && t.stdout.trim()) return `https://x-access-token:${t.stdout.trim()}@github.com/mishicomco/${app}.git`;
  return base;
}

async function resolveNpmToken(dryRun: boolean): Promise<string | undefined> {
  if (dryRun) return undefined;
  const t = await run("mishi-secret", ["get", "mishi-gh-read-packages-pat"]);
  const token = t.stdout.trim();
  return t.code === 0 && token ? token : undefined;
}

// ─── up ──────────────────────────────────────────────────────────────────────

export async function previewUp(app: string, rama: string, opts: PreviewUpOpts): Promise<void> {
  const ramaSlug = slugDev(rama);
  const name = previewPodName(app, rama);
  const host = previewPodHost(app, rama);
  const url = `https://${host}`;
  const appDir = join(appsRoot(), app);

  if (!opts.json) console.log(info(`preview ${dim(app)} · rama ${dim(rama)} → ${dim(host)}`));

  const repoUrl = await resolveRepoUrl(app, opts.repoUrl, opts.dryRun === true);
  const npmToken = await resolveNpmToken(opts.dryRun === true);

  if (opts.dryRun) {
    console.log(info("DRY RUN — no se toca nada. Plan:"));
    console.log(`  1. asegurar rama '${rama}' local (crear desde main si falta) + worktree en ${worktreeDir(appDir, ramaSlug)} + push`);
    console.log(`  2. provisionar DB efímera '${dbNamePreview(app, ramaSlug)}' en databases-dev${opts.espejo ? " + restaurar espejo de stage (sanitizado)" : " + sembrar (db:sembrar)"}`);
    console.log(`  3. kubectl apply del preview-pod (ns ${NS}, ${CTX}) → ${host}`);
    console.log(`  4. DNS: ${host} → túnel ${PREVIEW.tunnelName}`);
    console.log(`  5. migrar (db:migrate) y ${opts.espejo ? "restaurar el espejo" : "sembrar (db:sembrar)"} dentro del pod`);
    console.log(info("nada ejecutado (--dry-run)"));
    return;
  }

  // 0) worktree local + push (falla rápido si el repo hermano no existe)
  await asegurarWorktree(appDir, rama, ramaSlug);

  // 1) DB efímera: reusa el ROL ya provisionado de la app, DB nueva por rama.
  const { user, password } = await resolveAppDbCreds(app);
  await provisionarDbPreview(app, ramaSlug, user);
  const databaseUrl = previewDatabaseUrl(app, ramaSlug, user, password);
  console.log(ok(`DB efímera lista: ${dim(dbNamePreview(app, ramaSlug))} (databases-dev)`));

  // 2) túnel + manifiestos + apply (idempotente: re-aplicar actualiza sin perder envExtra)
  const uuid = await previewTunnelUuid();
  const items = manifiestosPreview({
    app, rama, repoUrl, databaseUrl,
    envExtra: opts.envExtra,
    npmToken,
    live: opts.live,
  });
  const manifiestos = JSON.stringify({ apiVersion: "v1", kind: "List", items }, null, 2);
  const apply = await run("kubectl", ["--context", CTX, "apply", "-f", "-"], manifiestos);
  if (apply.code !== 0) throw new Error(`apply falló: ${apply.stderr || apply.stdout}`);
  console.log(ok(apply.stdout.split("\n").join(" · ")));

  // 3) rollout
  console.log(info("esperando el pod (clone + npm install)…"));
  const rollout = await run("kubectl", ["--context", CTX, "-n", NS, "rollout", "status", `deploy/${name}`, "--timeout=600s"]);
  const listo = rollout.code === 0;
  console.log(listo ? ok(rollout.stdout.split("\n").pop() ?? "pod listo") : warn(`el pod no convergió aún: ${rollout.stderr || rollout.stdout}`));

  // 4) DNS
  try {
    const que = await upsertCname(host, tunnelTarget(uuid));
    console.log(ok(que === "ok" ? "CNAME ya apuntaba bien" : `CNAME ${que}`));
  } catch (e) {
    console.log(warn(`Cloudflare API: ${e instanceof Error ? e.message : String(e)}`));
  }

  // 5) migrar + (espejo | sembrar) DENTRO del pod, PREVIEW_MODE=true
  if (listo) {
    console.log(info("migrando (db:migrate) dentro del pod…"));
    const migrate = await run("kubectl", ["--context", CTX, "-n", NS, "exec", `deploy/${name}`, "-c", "dev", "--", "sh", "-c", "cd /workspace/repo && npm run db:migrate -w apps/backend"]);
    if (migrate.code !== 0) console.log(warn(`db:migrate falló (sigo): ${migrate.stderr || migrate.stdout}`));
    else console.log(ok("migraciones al día"));

    if (opts.espejo) {
      console.log(info("--espejo: truncando + restaurando datos de stage (sanitizado)…"));
      const tablasSensibles = await leerTablasSensibles(app, appsRoot());
      await truncarTodo(app, ramaSlug);
      await restaurarEspejo(app, ramaSlug, tablasSensibles);
      console.log(ok(`espejo de stage restaurado (excluidas ${tablasSensibles.length} tabla(s) sensible(s))`));
    } else {
      const hayScript = await run("kubectl", ["--context", CTX, "-n", NS, "exec", `deploy/${name}`, "-c", "dev", "--", "sh", "-c", "cd /workspace/repo && npm run -w apps/backend 2>/dev/null | grep -q '^  db:sembrar$'"]);
      if (hayScript.code === 0) {
        const sembrar = await run("kubectl", ["--context", CTX, "-n", NS, "exec", `deploy/${name}`, "-c", "dev", "--", "sh", "-c", "cd /workspace/repo && npm run db:sembrar -w apps/backend"]);
        if (sembrar.code !== 0) console.log(warn(`db:sembrar falló (sigo): ${sembrar.stderr || sembrar.stdout}`));
        else console.log(ok("sembrado (db:sembrar)"));
      } else {
        console.log(warn(`${app} no tiene script db:sembrar en apps/backend — sigo sin sembrar`));
      }
    }
  }

  const reachable = listo ? await waitReachable(`${url}/`) : false;
  console.log("");
  if (opts.json) {
    console.log(JSON.stringify({ app, rama, name, host, url, estado: reachable ? "vivo" : listo ? "aplicado" : "pendiente" }));
    return;
  }
  console.log(reachable ? ok(`preview VIVO → ${url}`) : warn(`aplicado pero aún no responde en ${url}`));
}

// ─── pull ────────────────────────────────────────────────────────────────────

export async function previewPull(app: string, rama: string, opts: PreviewMutOpts): Promise<void> {
  const name = previewPodName(app, rama);
  if (!opts.json) console.log(info(`preview ${dim(name)}: pull de la rama activa`));
  const r = await run("kubectl", ["--context", CTX, "-n", NS, "exec", `deploy/${name}`, "-c", "dev", "--", "sh", "/mke/pull.sh"]);
  if (!opts.json) for (const l of (r.stdout || r.stderr).split("\n")) if (l.trim()) console.log(dim(`  │ ${l}`));
  if (r.code !== 0) {
    if (!opts.json) console.log(bad(`pull falló: ${r.stderr || r.stdout}`));
    else console.log(JSON.stringify({ app, rama, name, estado: "error" }));
    return;
  }
  if (!opts.json) console.log(ok("al día"));
  else console.log(JSON.stringify({ app, rama, name, estado: "al-dia" }));
}

// ─── estado / ls ──────────────────────────────────────────────────────────────

export async function previewEstado(app: string, rama: string, opts: PreviewMutOpts): Promise<void> {
  const name = previewPodName(app, rama);
  const host = previewPodHost(app, rama);
  const r = await run("kubectl", ["--context", CTX, "-n", NS, "get", "deploy", name, "-o", "json"]);
  if (r.code !== 0) {
    if (opts.json) console.log(JSON.stringify({ app, rama, name, host, estado: "apagado" }));
    else console.log(warn(`no hay preview-pod ${dim(name)} encendido`));
    return;
  }
  let d: any = {};
  try { d = JSON.parse(r.stdout); } catch { /* vacío */ }
  const avail = d.status?.availableReplicas ?? 0;
  const total = d.status?.replicas ?? 0;
  const estadoPod = avail > 0 ? "vivo" : total > 0 ? "arrancando" : "detenido";
  const edad = edadDesde(d.metadata?.creationTimestamp);
  const db = dbNamePreview(app, slugDev(rama));

  if (opts.json) {
    console.log(JSON.stringify({ app, rama, name, host, db, edad, estado: estadoPod }));
    return;
  }
  console.log(`\n  preview-pod ${info(name)} ${dim(`[${estadoPod} · ${edad}]`)}`);
  console.log(`    rama: ${info(rama)}   DB: ${info(db)}`);
  console.log(`    → https://${host}\n`);
}

interface PreviewRow {
  app: string;
  rama: string;
  name: string;
  host: string;
  edad: string;
  estado: string;
}

export async function previewLs(app: string | undefined, opts: PreviewLsOpts): Promise<void> {
  const sel = app ? `mke.preview/app=${app}` : "mke.preview/app";
  const r = await run("kubectl", ["--context", CTX, "-n", NS, "get", "deploy", "-l", sel, "-o", "json"]);
  if (r.code !== 0) {
    if (opts.json) console.log("[]");
    else console.log(bad(`no pude listar (¿existe el clúster/namespace ${NS}?): ${r.stderr.split("\n")[0]}`));
    return;
  }
  let items: unknown[] = [];
  try { items = (JSON.parse(r.stdout) as { items?: unknown[] }).items ?? []; } catch { /* namespace vacío */ }

  const rows: PreviewRow[] = items.map((it) => {
    const d = it as {
      metadata?: { labels?: Record<string, string>; creationTimestamp?: string };
      status?: { availableReplicas?: number; replicas?: number };
    };
    const labels = d.metadata?.labels ?? {};
    const appL = labels["mke.preview/app"] ?? "?";
    const ramaSlug = labels["mke.preview/rama"] ?? "?";
    const avail = d.status?.availableReplicas ?? 0;
    const total = d.status?.replicas ?? 0;
    return {
      app: appL,
      rama: ramaSlug,
      name: `${appL}-${ramaSlug}`,
      host: previewPodHost(appL, ramaSlug),
      edad: edadDesde(d.metadata?.creationTimestamp),
      estado: avail > 0 ? "vivo" : total > 0 ? "arrancando" : "detenido",
    };
  });

  if (opts.json) { console.log(JSON.stringify(rows)); return; }
  console.log(`\n  previews vivos ${dim(`(${CTX} · ns ${NS})`)}`);
  if (!rows.length) { console.log(`    ${dim("(ninguno)")}\n`); return; }
  for (const row of rows) console.log(`    ${info(row.name)} ${dim(`[${row.estado} · ${row.edad}]`)} → https://${row.host}`);
  console.log("");
}

// ─── down (IDEMPOTENTE — pensado para correr sin TTY desde un runner de CI) ──

/**
 * Baja un preview: recursos k8s + CNAME + DB efímera + worktree local (best-
 * effort). IDEMPOTENTE y tolerante a punta a punta — pensado para el workflow
 * `on: delete` de cada app (self-hosted runner, `mke preview down <app> <rama>`
 * con la rama CRUDA tal como llega del evento; el slug se deriva acá adentro).
 * Nunca lanza por "ya no existía": eso es éxito, no falla.
 */
export async function previewDown(app: string, rama: string, opts: PreviewDownOpts = {}): Promise<void> {
  const ramaSlug = slugDev(rama);
  const name = previewPodName(app, rama);
  const host = previewPodHost(app, rama);
  const appDir = join(appsRoot(), app);
  if (!opts.json) console.log(info(`bajando preview ${dim(name)} (${host})`));

  const del = await run("kubectl", [
    "--context", CTX, "-n", NS,
    "delete", "deployment,service,ingress,secret,configmap",
    "-l", selectorDePreview(app, rama),
    "--ignore-not-found", "--wait=false",
  ]);
  if (!opts.json) {
    if (del.code === 0) console.log(ok(del.stdout || `recursos de ${name} borrándose (o ya no existían)`));
    else console.log(warn(`no pude borrar recursos k8s (sigo): ${del.stderr || del.stdout}`));
  }

  let dnsBorrado = false;
  try {
    const n = await deleteRecordsByName(host, { previewApp: app, previewRama: rama });
    dnsBorrado = n > 0;
    if (!opts.json) console.log(ok(n ? `CNAME ${host} borrado` : `no había CNAME ${host}`));
  } catch (e) {
    if (!opts.json) console.log(warn(`DNS (sigo): ${e instanceof Error ? e.message : String(e)}`));
  }

  let dbBorrada = false;
  try {
    await dropDbPreview(app, ramaSlug);
    dbBorrada = true;
    if (!opts.json) console.log(ok(`DB efímera ${dim(dbNamePreview(app, ramaSlug))} borrada (o ya no existía)`));
  } catch (e) {
    if (!opts.json) console.log(warn(`DB (sigo): ${e instanceof Error ? e.message : String(e)}`));
  }

  if (!opts.sinWorktree) {
    await borrarWorktreeSiExiste(appDir, ramaSlug, { json: opts.json });
  } else if (!opts.json) {
    console.log(dim("  --sin-worktree: no se toca el filo local (runner de CI)"));
  }

  if (!opts.json) console.log(dim(`  la rama '${rama}' sigue existiendo en git — down no la borra.`));
  if (opts.json) console.log(JSON.stringify({ app, rama, name, host, dnsBorrado, dbBorrada, estado: "apagado" }));
}

// ─── limpiar: red de seguridad (no el mecanismo primario — ver AI_REPO_STATE) ─

/**
 * Barrido de previews cuya rama YA NO EXISTE en origin (mergeada/borrada por el
 * autodelete de GitHub). El mecanismo PRIMARIO de limpieza es el workflow
 * `on: delete` de cada app (self-hosted runner → `mke preview down` inmediato,
 * ver mensaje del 2026-07-11); `limpiar` es la red de seguridad para lo que ese
 * workflow no alcanzó a bajar (runner caído, app sin el workflow aún, etc).
 */
export async function previewLimpiar(opts: { json?: boolean } = {}): Promise<void> {
  const r = await run("kubectl", ["--context", CTX, "-n", NS, "get", "deploy", "-l", "mke.preview/app", "-o", "json"]);
  if (r.code !== 0) {
    if (!opts.json) console.log(bad(`no pude listar previews: ${r.stderr.split("\n")[0]}`));
    return;
  }
  let items: unknown[] = [];
  try { items = (JSON.parse(r.stdout) as { items?: unknown[] }).items ?? []; } catch { /* vacío */ }

  let bajados = 0;
  for (const it of items) {
    const d = it as { metadata?: { labels?: Record<string, string> } };
    const labels = d.metadata?.labels ?? {};
    const app = labels["mke.preview/app"];
    const ramaSlug = labels["mke.preview/rama"];
    if (!app || !ramaSlug) continue;
    const appDir = join(appsRoot(), app);
    // buscamos la rama ORIGINAL por el nombre completo del worktree (mismo slug);
    // sin el nombre exacto no podemos derivar la rama cruda del slug, así que
    // usamos `ls-remote` sobre TODAS las ramas y comparamos el slug.
    const remoto = await run("git", ["-C", appDir, "ls-remote", "--heads", "origin"]);
    const ramas = remoto.code === 0 ? remoto.stdout.split("\n").map((l) => l.split("refs/heads/")[1]).filter(Boolean) : [];
    const viva = ramas.some((r2) => slugDev(r2) === ramaSlug);
    if (viva) continue;
    if (!opts.json) console.log(info(`rama de ${app}-${ramaSlug} ya no existe en origin → bajando`));
    await previewDown(app, ramaSlug, { json: opts.json, sinWorktree: false });
    bajados++;
  }
  if (!opts.json) console.log(bajados ? ok(`${bajados} preview(s) bajado(s)`) : dim("nada que limpiar"));
  else console.log(JSON.stringify({ bajados }));
}

// ─── helpers ─────────────────────────────────────────────────────────────────

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
