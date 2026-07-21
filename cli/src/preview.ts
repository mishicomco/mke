// `mke preview up|pull|estado|ls|down|merge|limpiar` — el verbo DEFINITIVO de
// iteración: preview-pods EFÍMEROS atados a la vida de la RAMA (fusión 2026-07-11
// de `feat/mke-preview` + el WIP `feature-pods-cli`). Reusa AL MÁXIMO la
// maquinaria de `mke dev` (mismo pod: init clona+instala, vite HMR + tsx watch,
// caddy un-solo-origen, SIDECAR postgres efímero — ver `manifiestosPreview` en
// @mishicomco/dev-receta), con estas diferencias de fondo:
//
//   1. Namespace/host PROPIOS con la rama SIEMPRE en el nombre: `preview` (ns),
//      host BARE `<app>-<slug(rama)>.mishi.com.co` (sin sufijo).
//   2. DB = SIDECAR postgres efímero en el pod: muere con el pod, sin DROP
//      central. `--espejo` restaura datos de STAGE (sanitizados) DENTRO del
//      sidecar (ver `previewEspejo.ts`); si no, se migra + siembra (db:sembrar).
//   3. Secretos/config por LEASE del vault (Contrato 1) leyendo `mke.preview.yaml`
//      de la app (Contrato 2). CERO `--env` humano. DEGRADACIÓN interina: si el
//      vault aún no tiene el escenario 4, `up` arranca SIN lease (warning claro)
//      para poder probar en vivo pod+DB+HMR antes del merge del vault.
//   4. Un git WORKTREE local persistido en `<app>.wt-<rama-slug>` (hermano del
//      repo), para editar la rama localmente Y en el pod a la vez.
//
// `mke preview merge` es el ÚNICO comando del final feliz (mergea a main + borra
// la rama remota → dispara el workflow `on: delete` → limpieza del cluster).
// `mke preview down` a mano = ABORTO TOTAL (revoca lease + borra bundle + rama).
// En modo runner (`--sin-worktree` / sin worktree) `down` solo limpia el cluster.

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { appsRoot, PREVIEW, VAULT } from "./mkeConfig.js";
import {
  manifiestosPreview,
  previewPodName,
  previewPodHost,
  selectorDePreview,
  slugDev,
  PREVIEW_SIN_LEASE,
} from "@mishicomco/dev-receta";
import { deleteRecordsByName, tunnelTarget, upsertCname } from "./cf.js";
import { previewTunnelUuid } from "./dns.js";
import { leerTablasSensibles, truncarSidecar, restaurarEspejo } from "./previewEspejo.js";
import { parsePreviewManifest, manifiestoVacio, type PreviewManifest } from "./previewManifest.js";
import { forgeCloneUrl, forgeRepoExists } from "./forgeRepo.js";
import { crearLease, revocarLease, renovarLease, type VaultClienteOpts } from "./vaultLease.js";
import { run, ok, bad, warn, info, dim } from "./sh.js";
import { paso, pasoStreamCmd, esperarConLogs } from "./progresoVivo.js";

const CTX = PREVIEW.context;
const NS = "preview";

export interface PreviewUpOpts {
  espejo?: boolean;
  live?: boolean;
  json?: boolean;
  dryRun?: boolean;
  repoUrl?: string;
  /** TTL del lease en segundos (backstop de vida; default del vault si se omite). */
  ttlSegundos?: number;
}

export interface PreviewMutOpts {
  json?: boolean;
}

export interface PreviewDownOpts {
  json?: boolean;
  /** salta el borrado del worktree/ramas: modo runner (el `on: delete` del CI). */
  sinWorktree?: boolean;
  /** fuerza el down aunque la rama tenga commits no mergeados a main. */
  forzar?: boolean;
}

export interface PreviewMergeOpts {
  json?: boolean;
}

export interface PreviewLsOpts {
  json?: boolean;
}

// helper de push/borrado remoto (el GITHUB_TOKEN del env pisa el de gh — ver CLAUDE.md).
function gitCredArgs(appDir: string, ...rest: string[]): string[] {
  return ["-u", "GITHUB_TOKEN", "git", "-c", "credential.helper=!gh auth git-credential", "-C", appDir, ...rest];
}

// ─── git local: rama + worktree persistido ───────────────────────────────────

function worktreeDir(appDir: string, ramaSlug: string): string {
  return `${appDir}.wt-${ramaSlug}`;
}

/** asegura que la rama exista LOCALMENTE (creada desde main actualizado si no
 * existe) y que haya un worktree persistido en `<app>.wt-<rama-slug>`. Devuelve
 * el path del worktree. Idempotente. */
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

  const push = await run("env", gitCredArgs(appDir, "push", "-u", "origin", rama));
  if (push.code !== 0) console.log(warn(`push de ${rama} falló (sigo; el pod igual clona lo que ya esté en origin): ${push.stderr || push.stdout}`));
  else console.log(ok(`rama ${dim(rama)} empujada a origin`));

  return wt;
}

/** best-effort: borra el worktree local. Silencioso si no existe en ESTA máquina. */
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

// ─── credenciales de git/npm/vault (mismo patrón que `mke dev`/`mke feature`) ─

async function resolveRepoUrl(app: string, override: string | undefined, dryRun: boolean): Promise<string> {
  if (override) return override;
  // El forge (git-mishi) es la casa PRIMARIA de los repos; GitHub es solo mirror
  // de backup y puede ir atrasado (o ni existir aún para apps recién nacidas).
  // Por eso el pod clona del forge si el repo vive ahí, y GitHub queda de fallback
  // para repos viejos aún no migrados.
  const base = forgeCloneUrl(app);
  if (dryRun) return base;
  try {
    if (await forgeRepoExists(app)) {
      const t = await run("mishi-secret", ["get", "git-mishi-token"]);
      const token = t.stdout.trim();
      // Forgejo/Gitea aceptan el token como username en la URL HTTPS.
      if (t.code === 0 && token) return `https://${token}@${base.replace(/^https:\/\//, "")}`;
      return base;
    }
  } catch {
    // forge caído → seguimos al fallback GitHub
  }
  const gh = `https://github.com/mishicomco/${app}.git`;
  const t = await run("mishi-secret", ["get", "mishi-studio-gh-read-pat"]);
  if (t.code === 0 && t.stdout.trim()) return `https://x-access-token:${t.stdout.trim()}@github.com/mishicomco/${app}.git`;
  return gh;
}

async function resolveNpmToken(dryRun: boolean): Promise<string | undefined> {
  if (dryRun) return undefined;
  // las apps consumen @mishicomco/* del forge (git-mishi): ese token manda.
  // El PAT de GitHub Packages queda de fallback para apps aún no migradas.
  for (const nombre of ["git-mishi-npm-token", "mishi-gh-read-packages-pat"]) {
    const t = await run("mishi-secret", ["get", nombre]);
    const token = t.stdout.trim();
    if (t.code === 0 && token) return token;
  }
  return undefined;
}

/** token de la identidad EMISORA del vault. DEGRADA (null) si no está: en el
 * interino el vault puede no tener el escenario 4 desplegado. */
async function resolveEmisorTokenSuave(): Promise<string | null> {
  const t = await run("mishi-secret", ["get", VAULT.emisorTokenSecret]);
  const token = t.stdout.trim();
  return t.code === 0 && token ? token : null;
}

function vaultCliente(emisorToken: string): VaultClienteOpts {
  return { vaultUrl: VAULT.url, emisorToken };
}

// ─── manifiesto de la app (Contrato 2) ───────────────────────────────────────

/** Lee `mke.preview.yaml` del checkout LOCAL de la app (repo hermano). Archivo
 * ausente ⇒ manifiesto vacío (Contrato 2, no es error). */
export async function leerManifiestoPreview(app: string, dir?: string): Promise<PreviewManifest> {
  const repoDir = dir ?? join(appsRoot(), app);
  try {
    const text = await readFile(join(repoDir, "mke.preview.yaml"), "utf8");
    return parsePreviewManifest(text, app);
  } catch (e: unknown) {
    const err = e as NodeJS.ErrnoException;
    if (err.code === "ENOENT") return manifiestoVacio(app);
    throw e;
  }
}

// ─── lease del vault (Contrato 1) con DEGRADACIÓN interina ────────────────────

interface LeaseResuelto {
  leaseId: string;
  leaseToken?: string;
}

/** Pide un lease al vault; si el vault no está / no responde / 404, DEGRADA con
 * gracia a `sin-lease` (warning claro) para poder probar pod+DB+HMR en vivo
 * antes de que el escenario 4 del vault esté desplegado. */
async function adquirirLease(app: string, rama: string, manifiesto: PreviewManifest, opts: { json?: boolean; ttlSegundos?: number }): Promise<LeaseResuelto> {
  const emisor = await resolveEmisorTokenSuave();
  if (!emisor) {
    if (!opts.json) console.log(warn(`vault sin escenario 4 — pod sin lease, secretos de app no disponibles (no encontré ${VAULT.emisorTokenSecret})`));
    return { leaseId: PREVIEW_SIN_LEASE };
  }
  if (!opts.json) console.log(info(`pidiendo lease al vault, acotado a ${manifiesto.secretos.length} secreto(s) declarado(s) en mke.preview.yaml…`));
  try {
    const lease = await crearLease(vaultCliente(emisor), {
      ns: app,
      rama,
      secretos: manifiesto.secretos,
      ttlSegundos: opts.ttlSegundos,
    });
    if (!opts.json) console.log(ok(`lease ${dim(lease.leaseId)} · expira ${dim(lease.expiraEn)}`));
    // re-up: revoca el lease ANTERIOR del bundle (si había) — sin esto cada
    // re-up fuga un lease activo hasta su TTL. Revocar DESPUÉS de emitir el
    // nuevo: si la emisión falla, el pod viejo conserva su lease.
    const anterior = await leaseIdDe(app, rama);
    if (anterior && anterior !== lease.leaseId) {
      try {
        await revocarLease(vaultCliente(emisor), anterior);
        if (!opts.json) console.log(dim(`  lease anterior ${anterior} revocado`));
      } catch (e) {
        if (!opts.json) console.log(warn(`no pude revocar el lease anterior ${anterior} (el TTL lo limpia): ${e instanceof Error ? e.message : String(e)}`));
      }
    }
    return { leaseId: lease.leaseId, leaseToken: lease.token };
  } catch (e) {
    if (!opts.json) console.log(warn(`vault sin escenario 4 — pod sin lease, secretos de app no disponibles (${e instanceof Error ? e.message : String(e)})`));
    return { leaseId: PREVIEW_SIN_LEASE };
  }
}

/** lee el label `mke.preview/lease` del Deployment del bundle app×rama. `null`
 * si no hay bundle vivo o si se arrancó en modo degradado (sin-lease). */
export async function leaseIdDe(app: string, rama: string): Promise<string | null> {
  const sel = selectorDePreview(app, rama);
  const r = await run("kubectl", ["--context", CTX, "-n", NS, "get", "deploy", "-l", sel, "-o", "jsonpath={.items[0].metadata.labels.mke\\.preview/lease}"]);
  const leaseId = r.stdout.trim();
  if (r.code !== 0 || !leaseId || leaseId === PREVIEW_SIN_LEASE) return null;
  return leaseId;
}

/**
 * Compone el "buscar leaseId → revoke" de forma IDEMPOTENTE y testeable sin red:
 * sin lease (bundle ya bajado / modo degradado) es no-op; con lease, delega en
 * el `revocar` inyectado exactamente una vez. Corazón de `preview down`.
 */
export async function revocarSiHayLease(
  leaseId: string | null,
  revocar: (leaseId: string) => Promise<{ leaseId: string; estado: string }>,
): Promise<{ revocado: boolean; leaseId: string | null }> {
  if (!leaseId || leaseId === PREVIEW_SIN_LEASE) return { revocado: false, leaseId: null };
  await revocar(leaseId);
  return { revocado: true, leaseId };
}

// ─── up ──────────────────────────────────────────────────────────────────────

export async function previewUp(app: string, rama: string, opts: PreviewUpOpts): Promise<void> {
  const ramaSlug = slugDev(rama);
  const name = previewPodName(app, rama);
  const host = previewPodHost(app, rama);
  const url = `https://${host}`;
  const appDir = join(appsRoot(), app);

  if (!opts.json) console.log(info(`preview ${dim(app)} · rama ${dim(rama)} → ${dim(host)}`));

  const wt = worktreeDir(appDir, ramaSlug);
  const repoUrl = await resolveRepoUrl(app, opts.repoUrl, opts.dryRun === true);
  const npmToken = await resolveNpmToken(opts.dryRun === true);

  if (opts.dryRun) {
    // en dry-run el worktree aún no existe: leemos el manifiesto de lo que haya
    // en el repo hermano (best-effort) solo para narrar el plan.
    const preview = await leerManifiestoPreview(app);
    console.log(info("DRY RUN — no se toca nada. Plan:"));
    console.log(`  1. asegurar rama '${rama}' local (crear desde main si falta) + worktree en ${wt} + push`);
    console.log(`  2. lease del vault (Contrato 1) acotado a ${preview.secretos.length} secreto(s) de mke.preview.yaml; DEGRADA a sin-lease si el vault no responde`);
    console.log(`  3. kubectl apply del preview-pod (ns ${NS}, ${CTX}, SIDECAR postgres) → ${host}`);
    console.log(`  4. DNS: ${host} → túnel ${PREVIEW.tunnelName}`);
    console.log(`  5. migrar (db:migrate) y ${opts.espejo ? "restaurar el espejo de stage (sanitizado) en el sidecar" : "sembrar (db:sembrar)"} dentro del pod`);
    console.log(info("nada ejecutado (--dry-run)"));
    return;
  }

  // 0) worktree local + push (falla rápido si el repo hermano no existe)
  await asegurarWorktree(appDir, rama, ramaSlug);

  // 0.5) FORMA de la app: DERIVADA del árbol del worktree de la rama (la verdad
  //      se deriva, no se declara). backend-only → sin vite, readiness /health;
  //      frontend-only → sin sidecar postgres ni migraciones.
  const forma = {
    backend: existsSync(join(wt, "apps", "backend")),
    frontend: existsSync(join(wt, "apps", "frontend")),
  };
  if (!forma.backend && !forma.frontend) {
    throw new Error(`la rama '${rama}' de ${app} no tiene apps/backend ni apps/frontend — nada que encender`);
  }
  if (!opts.json && !(forma.backend && forma.frontend)) {
    console.log(info(`forma derivada del worktree: ${forma.backend ? "backend-only (sin vite; readiness por /health)" : "frontend-only (sin sidecar postgres)"}`));
  }

  // 1) manifiesto de la RAMA (Contrato 2): se lee del WORKTREE recién creado —
  //    lo que declara ESTA rama, no main. Ausente/vacío ⇒ lista vacía + warning.
  const manifiesto = await leerManifiestoPreview(app, wt);
  if (!opts.json && manifiesto.imagen) {
    console.log(info(`runner declarado en mke.preview.yaml: ${dim(manifiesto.imagen)}`));
  }
  if (!opts.json && manifiesto.secretos.length === 0) {
    console.log(warn(`la rama '${rama}' no declara secretos en mke.preview.yaml — el lease se acota a CERO secretos (la app no leerá ninguno del vault)`));
  }

  // 2) lease del vault (o degradación a sin-lease)
  const lease = await adquirirLease(app, rama, manifiesto, { json: opts.json, ttlSegundos: opts.ttlSegundos });

  // 3) túnel + manifiestos + apply (idempotente)
  const uuid = await previewTunnelUuid();
  const items = manifiestosPreview({
    app, rama, repoUrl,
    leaseId: lease.leaseId,
    leaseToken: lease.leaseToken,
    config: manifiesto.config,
    npmToken,
    live: opts.live,
    imagen: manifiesto.imagen,
    rutas: manifiesto.rutas,
    backend: forma.backend,
    frontend: forma.frontend,
  });
  const manifiestos = JSON.stringify({ apiVersion: "v1", kind: "List", items }, null, 2);
  const apply = await run("kubectl", ["--context", CTX, "apply", "-f", "-"], manifiestos);
  if (apply.code !== 0) throw new Error(`apply falló: ${apply.stderr || apply.stdout}`);
  console.log(ok(apply.stdout.split("\n").join(" · ")));

  if (!opts.json) console.log(info("esperando el pod (clone + npm install + postgres)…"));
  // 4) rollout — el hueco mudo real (clone+install puede tardar minutos):
  //    narramos EN VIVO los logs del initContainer `preparar` mientras se
  //    espera; si el contenedor aún no arrancó, reintenta cada pocos segundos.
  const rollout = await esperarConLogs(
    run("kubectl", ["--context", CTX, "-n", NS, "rollout", "status", `deploy/${name}`, "--timeout=600s"]),
    { cmd: "kubectl", args: ["--context", CTX, "-n", NS, "logs", "-f", `deploy/${name}`, "-c", "preparar", "--pod-running-timeout=20s"] },
    { json: opts.json, filtrar: (l) => !/waiting to start: PodInitializing|fsnotify watcher/.test(l) },
  );
  const listo = rollout.code === 0;
  console.log(listo ? ok(rollout.stdout.split("\n").pop() ?? "pod listo") : warn(`el pod no convergió aún: ${rollout.stderr || rollout.stdout}`));
  if (!listo && !opts.json) await diagnosticarPodNoListo(name);

  // 5) DNS
  try {
    const que = await upsertCname(host, tunnelTarget(uuid));
    console.log(ok(que === "ok" ? "CNAME ya apuntaba bien" : `CNAME ${que}`));
  } catch (e) {
    console.log(warn(`Cloudflare API: ${e instanceof Error ? e.message : String(e)}`));
  }

  // 6) migrar + (espejo | sembrar) DENTRO del pod, PREVIEW_MODE=true — se
  //    transmite el stdout del exec DIMMED en vivo (antes se capturaba mudo).
  //    Sin backend no hay DB: se salta entero (frontend-only).
  if (listo && forma.backend) {
    const migrateCode = await pasoStreamCmd(
      "migrando (db:migrate) dentro del pod",
      "kubectl",
      ["--context", CTX, "-n", NS, "exec", `deploy/${name}`, "-c", "dev", "--", "sh", "-c", "cd /workspace/repo && npm run db:migrate -w apps/backend"],
      { json: opts.json },
    );
    if (migrateCode !== 0 && !opts.json) console.log(warn("db:migrate falló (sigo)"));

    if (opts.espejo) {
      await paso("--espejo: truncando + restaurando datos de stage (sanitizado) en el sidecar", async () => {
        const tablasSensibles = await leerTablasSensibles(app, appsRoot());
        await truncarSidecar(name);
        await restaurarEspejo(app, name, tablasSensibles);
        return tablasSensibles.length;
      }, { json: opts.json });
    } else {
      const hayScript = await run("kubectl", ["--context", CTX, "-n", NS, "exec", `deploy/${name}`, "-c", "dev", "--", "sh", "-c", "cd /workspace/repo && npm run -w apps/backend 2>/dev/null | grep -q '^  db:sembrar$'"]);
      if (hayScript.code === 0) {
        const sembrarCode = await pasoStreamCmd(
          "sembrando (db:sembrar) dentro del pod",
          "kubectl",
          ["--context", CTX, "-n", NS, "exec", `deploy/${name}`, "-c", "dev", "--", "sh", "-c", "cd /workspace/repo && npm run db:sembrar -w apps/backend"],
          { json: opts.json },
        );
        if (sembrarCode !== 0 && !opts.json) console.log(warn("db:sembrar falló (sigo)"));
      } else {
        console.log(warn(`${app} no tiene script db:sembrar en apps/backend — sigo sin sembrar`));
      }
    }
  }

  // backend-only: el / puede ser un 404 legítimo (servicio sin ruta raíz) — se
  // sondea /health, la misma cadena túnel→ingress→caddy→backend.
  const reachable = listo ? await waitReachable(forma.frontend ? `${url}/` : `${url}/health`) : false;
  console.log("");
  if (opts.json) {
    console.log(JSON.stringify({ app, rama, name, host, url, leaseId: lease.leaseId, estado: reachable ? "vivo" : listo ? "aplicado" : "pendiente" }));
    return;
  }
  console.log(reachable ? ok(`preview VIVO → ${url}`) : warn(`aplicado pero aún no responde en ${url}`));
}

// ─── pull (git en el pod + renovar el lease) ──────────────────────────────────

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

  // renovar el lease (backstop de vida; best-effort — el vault puede no estar)
  const leaseId = await leaseIdDe(app, rama);
  let renovado: string | null = null;
  if (leaseId) {
    const emisor = await resolveEmisorTokenSuave();
    if (emisor) {
      try {
        const r2 = await renovarLease(vaultCliente(emisor), leaseId);
        renovado = r2.expiraEn;
      } catch (e) {
        if (!opts.json) console.log(warn(`no pude renovar el lease: ${e instanceof Error ? e.message : String(e)}`));
      }
    }
  }

  if (!opts.json) console.log(ok(`al día${renovado ? ` · lease renovado hasta ${renovado}` : ""}`));
  else console.log(JSON.stringify({ app, rama, name, leaseId, expiraEn: renovado, estado: "al-dia" }));
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
  const labels = d.metadata?.labels ?? {};
  const avail = d.status?.availableReplicas ?? 0;
  const total = d.status?.replicas ?? 0;
  const estadoPod = avail > 0 ? "vivo" : total > 0 ? "arrancando" : "detenido";
  const edad = edadDesde(d.metadata?.creationTimestamp);
  const leaseId = labels["mke.preview/lease"] ?? PREVIEW_SIN_LEASE;

  if (opts.json) {
    console.log(JSON.stringify({ app, rama, name, host, leaseId, edad, estado: estadoPod }));
    return;
  }
  console.log(`\n  preview-pod ${info(name)} ${dim(`[${estadoPod} · ${edad}]`)}`);
  console.log(`    rama: ${info(rama)}   lease: ${info(leaseId)}`);
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

// ─── limpieza del cluster (lease + bundle + DNS) — común a down y merge ────────

async function limpiarCluster(app: string, rama: string, opts: { json?: boolean }): Promise<{ leaseId: string | null; revocado: boolean; dnsBorrado: boolean }> {
  const name = previewPodName(app, rama);
  const host = previewPodHost(app, rama);

  // 1) revoca el lease (si hay y el vault responde). Doble vía: aunque el vault
  //    no esté, igual borramos el bundle por labels — idempotente.
  const leaseId = await leaseIdDe(app, rama);
  let revocado = false;
  if (leaseId) {
    const emisor = await resolveEmisorTokenSuave();
    if (emisor) {
      try {
        const r = await paso(`revocando lease ${leaseId}`, () => revocarSiHayLease(leaseId, (id) => revocarLease(vaultCliente(emisor), id)), { json: opts.json });
        revocado = r.revocado;
      } catch (e) {
        if (!opts.json) console.log(warn(`no pude revocar el lease (¿vault caído? el TTL lo limpia): ${e instanceof Error ? e.message : String(e)}`));
      }
    } else if (!opts.json) {
      console.log(dim("  vault sin emisor a mano — salto la revocación (el TTL del lease lo limpia)"));
    }
  } else if (!opts.json) {
    console.log(dim("  sin lease vivo para esta app×rama (no-op)"));
  }

  // 2) borra el bundle k8s DIRECTO por labels (siempre, idempotente)
  const del = await paso(`borrando recursos k8s de ${name}`, () => run("kubectl", [
    "--context", CTX, "-n", NS,
    "delete", "deployment,service,ingress,secret,configmap",
    "-l", selectorDePreview(app, rama),
    "--ignore-not-found", "--wait=false",
  ]), { json: opts.json });
  if (!opts.json && del.code !== 0) console.log(warn(`no pude borrar recursos k8s (sigo): ${del.stderr || del.stdout}`));

  // 3) DNS
  let dnsBorrado = false;
  try {
    const n = await paso(`borrando CNAME ${host}`, () => deleteRecordsByName(host, { previewApp: app, previewRama: rama }), { json: opts.json });
    dnsBorrado = n > 0;
  } catch (e) {
    if (!opts.json) console.log(warn(`DNS (sigo): ${e instanceof Error ? e.message : String(e)}`));
  }

  return { leaseId, revocado, dnsBorrado };
}

/** commits en `rama` que NO están en main (origin/main tras fetch). >0 = trabajo
 * sin mergear. Devuelve -1 si no se pudo determinar (rama local ausente). */
async function commitsSinMergear(appDir: string, rama: string): Promise<number> {
  if ((await run("git", ["-C", appDir, "show-ref", "--verify", "-q", `refs/heads/${rama}`])).code !== 0) return -1;
  await run("git", ["-C", appDir, "fetch", "origin", "main"]);
  const base = (await run("git", ["-C", appDir, "rev-parse", "--verify", "-q", "origin/main"])).code === 0 ? "origin/main" : "main";
  const r = await run("git", ["-C", appDir, "rev-list", "--count", `${base}..${rama}`]);
  const n = Number(r.stdout.trim());
  return Number.isNaN(n) ? -1 : n;
}

// ─── down (ABORTO TOTAL a mano · limpieza de cluster desde el runner) ─────────

/**
 * Baja un preview. Dos modos:
 *  - A MANO (hay worktree y no se pasa --sin-worktree) = ABORTO TOTAL: revoca el
 *    lease + borra el bundle + DNS + worktree + rama LOCAL + rama REMOTA.
 *    GUARDARRAÍL: si la rama tiene commits que no están en main, se niega salvo
 *    `--forzar` (no querés tirar trabajo sin querer).
 *  - MODO RUNNER (`--sin-worktree`, o no hay worktree en esta máquina) = solo
 *    limpieza de cluster (lease + bundle + DNS). NO toca ramas: cuando corre el
 *    workflow `on: delete` la rama ya no existe. IDEMPOTENTE, sin TTY.
 */
export async function previewDown(app: string, rama: string, opts: PreviewDownOpts = {}): Promise<void> {
  const ramaSlug = slugDev(rama);
  const name = previewPodName(app, rama);
  const host = previewPodHost(app, rama);
  const appDir = join(appsRoot(), app);
  const wt = worktreeDir(appDir, ramaSlug);
  const esRunner = opts.sinWorktree === true || !existsSync(wt);

  if (!opts.json) console.log(info(`bajando preview ${dim(name)} (${host})${esRunner ? dim(" · modo runner (solo cluster)") : ""}`));

  // GUARDARRAÍL (solo a mano): no tirar trabajo sin mergear sin --forzar.
  if (!esRunner && !opts.forzar) {
    const sin = await commitsSinMergear(appDir, rama);
    if (sin > 0) {
      throw new Error(
        `la rama '${rama}' tiene ${sin} commit(s) que NO están en main — \`mke preview down\` es un ABORTO que borra la rama. ` +
        `Si querés conservar el trabajo, mergealo con \`mke preview merge ${app} ${rama}\`. Para descartar igual: --forzar.`,
      );
    }
  }

  const { leaseId, revocado, dnsBorrado } = await limpiarCluster(app, rama, { json: opts.json });

  if (esRunner) {
    if (!opts.json) console.log(dim("  modo runner: no se tocan ramas (la rama ya no existe cuando corre el workflow)"));
    if (opts.json) console.log(JSON.stringify({ app, rama, name, host, leaseId, revocado, dnsBorrado, modo: "runner", estado: "apagado" }));
    return;
  }

  // A MANO: borra worktree + rama local + rama remota (dispara el on:delete → cluster).
  await borrarWorktreeSiExiste(appDir, ramaSlug, { json: opts.json });
  const delLocal = await run("git", ["-C", appDir, "branch", "-D", rama]);
  if (!opts.json) console.log(delLocal.code === 0 ? ok(`rama local ${dim(rama)} borrada`) : dim(`  rama local ${rama} ausente (nada que borrar)`));
  const delRemota = await paso(`borrando rama remota ${rama}`, () => run("env", gitCredArgs(appDir, "push", "origin", "--delete", rama)), { json: opts.json });
  if (!opts.json && delRemota.code !== 0) console.log(dim(`  rama remota ${rama} ausente o sin permiso (${delRemota.stderr.split("\n")[0]})`));

  if (opts.json) console.log(JSON.stringify({ app, rama, name, host, leaseId, revocado, dnsBorrado, modo: "abort", estado: "apagado" }));
}

// ─── merge: el ÚNICO comando del final feliz ─────────────────────────────────

/**
 * Cierra un preview con éxito: mergea la rama a main + push de main, luego borra
 * worktree + rama local + rama REMOTA. Borrar la rama remota dispara el workflow
 * `on: delete` de la app → limpieza del cluster (no la esperamos acá). Aborta si
 * el worktree tiene cambios sin commit (no querés mergear a medias).
 */
export async function previewMerge(app: string, rama: string, opts: PreviewMergeOpts = {}): Promise<void> {
  const ramaSlug = slugDev(rama);
  const appDir = join(appsRoot(), app);
  const wt = worktreeDir(appDir, ramaSlug);
  if (!existsSync(appDir)) throw new Error(`no existe el repo del app: ${appDir}`);
  if (!opts.json) console.log(info(`merge ${dim(app)} · rama ${dim(rama)} → main`));

  // 1) worktree limpio (o inexistente): sin cambios sin commit.
  if (existsSync(wt)) {
    const st = await run("git", ["-C", wt, "status", "--porcelain"]);
    if (st.stdout.trim()) {
      throw new Error(`el worktree ${wt} tiene cambios sin commit — commiteá o descartá antes de mergear:\n${st.stdout}`);
    }
  }

  // 2) merge a main en el repo principal + push.
  const fetch = await paso("fetch origin/main", () => run("git", ["-C", appDir, "fetch", "origin", "main"]), { json: opts.json });
  if (fetch.code !== 0 && !opts.json) console.log(warn(`fetch de main falló (sigo con lo local): ${fetch.stderr}`));
  const co = await run("git", ["-C", appDir, "checkout", "main"]);
  if (co.code !== 0) throw new Error(`no pude checkout main en ${appDir} (¿cambios sin commit?): ${co.stderr || co.stdout}`);
  const ff = await run("git", ["-C", appDir, "merge", "--ff-only", "origin/main"]);
  if (ff.code !== 0 && !opts.json) console.log(dim(`  main local no avanzó a origin/main por ff (${ff.stderr.split("\n")[0]})`));
  const merge = await run("git", ["-C", appDir, "merge", "--no-edit", rama]);
  if (merge.code !== 0) throw new Error(`merge de ${rama} a main falló (¿conflicto?): ${merge.stderr || merge.stdout}`);
  if (!opts.json) console.log(ok(`rama ${dim(rama)} mergeada a main`));
  const push = await paso("push main → origin", () => run("env", gitCredArgs(appDir, "push", "origin", "main")), { json: opts.json });
  if (push.code !== 0) throw new Error(`push de main falló: ${push.stderr || push.stdout}`);

  // 3) borra worktree + rama local + rama remota (→ dispara on:delete → cluster).
  await borrarWorktreeSiExiste(appDir, ramaSlug, { json: opts.json });
  const delLocal = await run("git", ["-C", appDir, "branch", "-D", rama]);
  if (!opts.json) console.log(delLocal.code === 0 ? ok(`rama local ${dim(rama)} borrada`) : dim(`  rama local ${rama} ausente`));
  const delRemota = await paso(`borrando rama remota ${rama}`, () => run("env", gitCredArgs(appDir, "push", "origin", "--delete", rama)), { json: opts.json });
  const remotaOk = delRemota.code === 0;
  if (!opts.json) {
    if (remotaOk) console.log(dim("  → borrar la rama remota dispara el workflow `on: delete` de la app, que limpia el preview en el cluster (no lo esperamos acá)."));
    else console.log(warn(`el preview del cluster NO se limpiará solo (el on:delete no se disparó) — corré \`mke preview down ${app} ${rama} --sin-worktree\` para limpiarlo a mano.`));
    console.log(ok(`merge de ${dim(rama)} completo.`));
  } else {
    console.log(JSON.stringify({ app, rama, mergeada: true, ramaRemotaBorrada: remotaOk, estado: "mergeado" }));
  }
}

// ─── limpiar: red de seguridad (no el mecanismo primario — ver AI_REPO_STATE) ─

/**
 * Barrido de previews cuya rama YA NO EXISTE en origin. El mecanismo PRIMARIO
 * de limpieza es el workflow `on: delete` de cada app (self-hosted runner →
 * `mke preview down --sin-worktree` inmediato); `limpiar` es la red de seguridad
 * para lo que ese workflow no alcanzó a bajar (runner caído, app sin el workflow).
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
    const remoto = await run("git", ["-C", appDir, "ls-remote", "--heads", "origin"]);
    const ramas = remoto.code === 0 ? remoto.stdout.split("\n").map((l) => l.split("refs/heads/")[1]).filter(Boolean) : [];
    const viva = ramas.some((r2) => slugDev(r2) === ramaSlug);
    if (viva) continue;
    if (!opts.json) console.log(info(`rama de ${app}-${ramaSlug} ya no existe en origin → bajando (solo cluster)`));
    await previewDown(app, ramaSlug, { json: opts.json, sinWorktree: true });
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

/** cuando `rollout status` vence: nombra los contenedores not-ready y muestra sus
 * últimas líneas de log — el diagnóstico que antes había que excavar a mano. */
async function diagnosticarPodNoListo(name: string): Promise<void> {
  const r = await run("kubectl", ["--context", CTX, "-n", NS, "get", "pod", "-l", `app=${name}`, "-o",
    "jsonpath={range .items[0].status.containerStatuses[*]}{.name}={.ready}{\"\\n\"}{end}"]);
  const noListos = r.stdout.split("\n").filter((l) => l.trim().endsWith("=false")).map((l) => l.split("=")[0]);
  if (!noListos.length) return;
  console.log(warn(`contenedor(es) not-ready: ${noListos.join(", ")} — últimas líneas:`));
  for (const c of noListos) {
    const logs = await run("kubectl", ["--context", CTX, "-n", NS, "logs", `deploy/${name}`, "-c", c, "--tail=10"]);
    for (const l of (logs.stdout || logs.stderr).split("\n").slice(-10)) if (l.trim()) console.log(dim(`  [${c}] ${l}`));
  }
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
