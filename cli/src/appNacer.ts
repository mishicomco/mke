// `mke app nacer <nombre>` — NACIMIENTO de una app nueva del ecosistema, en un
// comando. El verbo `nacer` es EXCLUSIVO de `mke` (ley ../CLAUDE.md §Standard
// app structure): Studio solo sueña/nota; crear = mke. El repo PRIMARIO nace en
// git-mishi (forge self-hosted) con push-mirror a GitHub como backup, NO al
// revés.
//
// Corre en el LAPTOP (necesita disco ~/mishicomco, create-mishi-app y `git`);
// no en un pod. Pasos idempotentes/salteables que reportan uno a uno; si un paso
// externo falla se corta ahí (los previos NO se deshacen — re-correr es seguro):
//   1. cascarón   → create-mishi-app (checkout hermano ~/mishicomco o PATH)
//   2. repo forge → API Forgejo: crea mishicomco/<app> en git.mishi.com.co
//                   (+ push-mirror a GitHub, best-effort — ver nota)
//   3. git+push   → git init + commit inicial + push a origin=forge (dispara CI)
//   4. plataforma → appInit() en-proceso (BD+DNS+Secret+host static-mishi+grant)
//   5. registro   → `mishi-studio app crear --nombre <app> --repo mishicomco/<app>`
//   6. resumen    → qué quedó pendiente de humano (secretos reales, etc.)
//
// Secretos SIEMPRE por mishi-secret, jamás impresos.

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

import { appInit } from "./appInit.js";
import {
  FORGE,
  forgeAddPushMirror,
  forgeCreateRepo,
  forgeRepoUrl,
  secretGet,
} from "./forgeRepo.js";
import { appsRoot, envOrThrow } from "./mkeConfig.js";
import { run, ok, bad, info, warn, dim } from "./sh.js";

export interface AppNacerOpts {
  subdominio?: string;
  /** entorno de plataforma para `mke app init` (default stage). */
  env?: string;
  /** directorio del cascarón (default <appsRoot>/<app>). */
  dir?: string;
  /** salta create-mishi-app + git + push (usa un repo ya presente). */
  sinCascaron?: boolean;
  /** salta `mke app init`. */
  sinPlataforma?: boolean;
  /** salta el registro en Studio. */
  sinRegistro?: boolean;
  /** imprime el plan y no toca nada. */
  dryRun?: boolean;
}

interface Paso {
  nombre: string;
  estado: "ok" | "salteado" | "fail";
  detalle: string;
}

function enPath(bin: string): boolean {
  try {
    execFileSync(process.platform === "win32" ? "where" : "which", [bin], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/** Resuelve el CLI create-mishi-app: checkout hermano en disco → global en PATH. */
function resolverCascaron(): { cmd: string; prefix: string[] } | null {
  const fallback = join(appsRoot(), "create-mishi-app", "bin", "create-mishi-app.mjs");
  if (existsSync(fallback)) return { cmd: "node", prefix: [fallback] };
  if (enPath("create-mishi-app")) return { cmd: "create-mishi-app", prefix: [] };
  return null;
}

const ultimas = (s: string, n = 20) => s.split("\n").slice(-n).join("\n").trim();

export async function appNacer(app: string, opts: AppNacerOpts): Promise<void> {
  const env = opts.env ?? "stage";
  envOrThrow(env); // valida local|stage|prod
  const subdominio = opts.subdominio ?? app;
  const dir = opts.dir ?? join(appsRoot(), app);
  const remoto = `${FORGE.org}/${app}`;
  const originUrl = forgeRepoUrl(app);

  console.log(`\n  mke app nacer ${dim(app)} → repo ${dim(originUrl)}  ·  plataforma ${dim(env)}\n`);

  if (opts.dryRun) {
    console.log(info("DRY RUN — no se toca nada. Plan:"));
    console.log(`  1. cascarón: create-mishi-app --nombre ${app} --subdominio ${subdominio} --dir ${dir}${opts.sinCascaron ? dim("  (SALTEADO)") : ""}`);
    console.log(`  2. repo forge: crea ${remoto} en ${FORGE.base} (privado) + push-mirror a GitHub (best-effort)`);
    console.log(`  3. git: init + commit inicial + push a origin=${originUrl} (dispara CI del forge → deploy stage)${opts.sinCascaron ? dim("  (SALTEADO)") : ""}`);
    console.log(`  4. plataforma: mke app init ${app} --env ${env} --subdominio ${subdominio}${opts.sinPlataforma ? dim("  (SALTEADO)") : ""}`);
    console.log(`  5. registro: mishi-studio app crear --nombre ${app} --repo ${remoto}${opts.sinRegistro ? dim("  (SALTEADO)") : ""}`);
    console.log(info("\nnada ejecutado (--dry-run)"));
    return;
  }

  const pasos: Paso[] = [];
  const cortar = (nombre: string, detalle: string) => {
    pasos.push({ nombre, estado: "fail", detalle });
    console.log(bad(detalle));
    resumen(pasos);
    process.exitCode = 1;
  };

  // ── 1) cascarón ────────────────────────────────────────────────────────────
  if (opts.sinCascaron) {
    pasos.push({ nombre: "cascarón", estado: "salteado", detalle: "salteado (--sin-cascaron)" });
  } else {
    const c = resolverCascaron();
    if (!c) {
      return cortar("cascarón", `create-mishi-app no está en ${appsRoot()}/create-mishi-app ni en PATH — instálalo o pasá --sin-cascaron`);
    }
    console.log(info(`cascarón: create-mishi-app → ${dir}`));
    const r = await run(c.cmd, [...c.prefix, "--yes", "--nombre", app, "--subdominio", subdominio, "--dir", dir]);
    if (r.code !== 0) return cortar("cascarón", `create-mishi-app falló (code ${r.code}): ${ultimas(r.stderr || r.stdout)}`);
    pasos.push({ nombre: "cascarón", estado: "ok", detalle: `cascarón en ${dir}` });
    console.log(ok(`cascarón creado en ${dir}`));
  }

  // ── 2) repo primario en el forge (git-mishi) ───────────────────────────────
  const apiToken = await secretGet(FORGE.apiTokenSecret);
  if (!apiToken) {
    return cortar("repo forge", `no hay credencial del forge: mishi-secret get ${FORGE.apiTokenSecret} vino vacío. Sin token de API no se puede crear el repo — BLOQUEANTE.`);
  }
  console.log(info(`repo forge: ${remoto} en ${FORGE.base}`));
  let repoCreado = false;
  try {
    const res = await forgeCreateRepo(app, apiToken);
    repoCreado = res.creado;
  } catch (e) {
    return cortar("repo forge", `crear repo en el forge falló: ${e instanceof Error ? e.message : String(e)}`);
  }
  pasos.push({ nombre: "repo forge", estado: "ok", detalle: repoCreado ? `${remoto} creado en el forge` : `${remoto} ya existía en el forge` });
  console.log(ok(repoCreado ? `${remoto} creado en el forge` : `${remoto} ya existía en el forge`));

  // push-mirror a GitHub (backup off-site) — BEST-EFFORT: nunca corta el
  // nacimiento. Requiere que el repo espejo exista en GitHub + PAT con write.
  // El forge NO crea el repo remoto de GitHub por sí solo; si no está, la API
  // del mirror falla y lo dejamos como TODO explícito (no inventamos el flujo
  // de creación en GitHub — ver git-mishi/AI_REPO_STATE.md: el mirror nativo
  // asume el destino ya existente).
  const mirrorPat = await secretGet(FORGE.mirrorPatSecret);
  if (!mirrorPat) {
    pasos.push({ nombre: "push-mirror", estado: "salteado", detalle: `TODO: sin ${FORGE.mirrorPatSecret} no se configura el mirror a GitHub (backup). Configuralo a mano en el forge cuando exista el PAT.` });
    console.log(warn(`push-mirror a GitHub SALTEADO: falta el secreto ${FORGE.mirrorPatSecret} (TODO manual)`));
  } else {
    try {
      const m = await forgeAddPushMirror(app, apiToken, mirrorPat);
      pasos.push({ nombre: "push-mirror", estado: "ok", detalle: m.configurado ? "mirror a GitHub configurado (sync_on_commit)" : "mirror a GitHub ya existía" });
      console.log(ok(m.configurado ? "push-mirror a GitHub configurado (backup, sync_on_commit)" : "push-mirror a GitHub ya existía"));
    } catch (e) {
      // No cortamos: el repo primario (forge) ya existe. El mirror es respaldo.
      pasos.push({ nombre: "push-mirror", estado: "salteado", detalle: `TODO: mirror a GitHub no quedó (probable: falta crear github.com/${remoto} primero). Detalle: ${e instanceof Error ? e.message : String(e)}` });
      console.log(warn(`push-mirror a GitHub no quedó (backup pendiente, no bloquea): ${e instanceof Error ? e.message : String(e)}`));
    }
  }

  // ── 3) git init + commit inicial + push a origin=forge ─────────────────────
  if (opts.sinCascaron) {
    pasos.push({ nombre: "git+push", estado: "salteado", detalle: "salteado (--sin-cascaron)" });
  } else {
    const gitC = (args: string[]) => run("git", ["-C", dir, ...args]);
    if ((await gitC(["rev-parse", "--git-dir"])).code !== 0) await gitC(["init", "-b", "main"]);
    const hayCommits = (await gitC(["rev-parse", "-q", "--verify", "HEAD"])).code === 0;
    if (!hayCommits) {
      // npm install ANTES del commit: genera package-lock.json que el Dockerfile
      // del cascarón copia (sin lockfile el build de CI del nacimiento falla).
      if (!existsSync(join(dir, "package-lock.json"))) {
        const inst = await run("npm", ["install", "--prefix", dir]);
        if (inst.code !== 0) return cortar("git+push", `npm install falló (no se commitea sin lockfile): ${ultimas(inst.stderr || inst.stdout)}`);
      }
      await gitC(["add", "-A"]);
      const commit = await gitC(["commit", "-m", `nacimiento: cascarón create-mishi-app (${app})`]);
      if (commit.code !== 0) return cortar("git+push", `commit inicial falló: ${ultimas(commit.stderr || commit.stdout)}`);
    }
    // origin = FORGE (repo primario). Si ya apunta a otro lado, lo corrige.
    const originActual = await gitC(["remote", "get-url", "origin"]);
    if (originActual.code !== 0) {
      await gitC(["remote", "add", "origin", originUrl]);
    } else if (originActual.stdout.trim() !== originUrl) {
      await gitC(["remote", "set-url", "origin", originUrl]);
    }
    // push por HTTPS: el credential helper global del host git.mishi.com.co lee
    // el token de mishi-secret al vuelo (git-mishi/AI_REPO_STATE.md). GITHUB_TOKEN
    // se limpia por el gotcha de ../CLAUDE.md (no aplica al forge, pero inocuo).
    console.log(info(`git push → ${originUrl} (dispara CI del forge → deploy ${env})`));
    const push = await run("env", ["-u", "GITHUB_TOKEN", "git", "-C", dir, "push", "-u", "origin", "main"]);
    if (push.code !== 0) return cortar("git+push", `push a ${originUrl} falló: ${ultimas(push.stderr || push.stdout)}`);
    pasos.push({ nombre: "git+push", estado: "ok", detalle: `commit inicial pusheado a ${remoto} (main → CI ${env})` });
    console.log(ok(`commit inicial pusheado a ${remoto}`));
  }

  // ── 4) plataforma — appInit() EN PROCESO (mismo CLI) ───────────────────────
  if (opts.sinPlataforma) {
    pasos.push({ nombre: "plataforma", estado: "salteado", detalle: "salteado (--sin-plataforma)" });
  } else {
    try {
      await appInit(app, env, { subdominio });
      pasos.push({ nombre: "plataforma", estado: "ok", detalle: `mke app init ${app} (${env}) — BD/DNS/Secret/host/grant` });
    } catch (e) {
      return cortar("plataforma", `mke app init falló: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // ── 5) registro en Studio — vía su CLI (no la API interna) ─────────────────
  if (opts.sinRegistro) {
    pasos.push({ nombre: "registro", estado: "salteado", detalle: "salteado (--sin-registro)" });
  } else if (!enPath("mishi-studio")) {
    pasos.push({ nombre: "registro", estado: "salteado", detalle: "TODO: `mishi-studio` no está en PATH — registrá a mano: mishi-studio app crear --nombre " + app + " --repo " + remoto });
    console.log(warn("registro en Studio SALTEADO: `mishi-studio` no está en PATH (TODO manual)"));
  } else {
    const reg = await run("mishi-studio", ["app", "crear", "--nombre", app, "--repo", remoto]);
    if (reg.code !== 0) {
      // No cortamos: la app ya nació (repo+plataforma). El registro es catálogo.
      pasos.push({ nombre: "registro", estado: "salteado", detalle: `TODO: registro en Studio falló (re-corre: mishi-studio app crear --nombre ${app} --repo ${remoto}): ${ultimas(reg.stderr || reg.stdout, 5)}` });
      console.log(warn(`registro en Studio falló (no bloquea; re-corrible): ${ultimas(reg.stderr || reg.stdout, 5)}`));
    } else {
      pasos.push({ nombre: "registro", estado: "ok", detalle: `app registrada en Studio (repo ${remoto})` });
      console.log(ok(`app registrada en Studio`));
    }
  }

  resumen(pasos);
}

function resumen(pasos: Paso[]): void {
  console.log(`\n  ${info("resumen del nacimiento")}`);
  for (const p of pasos) {
    const linea = p.estado === "ok" ? ok(`${p.nombre}: ${p.detalle}`)
      : p.estado === "salteado" ? warn(`${p.nombre}: ${p.detalle}`)
      : bad(`${p.nombre}: ${p.detalle}`);
    console.log(`    ${linea}`);
  }
  const pendientes = pasos.filter((p) => p.estado === "salteado" && p.detalle.includes("TODO"));
  console.log(`\n  ${info("pendiente de humano")}`);
  console.log(dim("    - secretos REALES propios de la app (mke.preview.yaml + vault-mishi) cuando existan"));
  console.log(dim("    - la identidad NO pide secretos al nacer (SDK @mishicomco/identity-mishi)"));
  for (const p of pendientes) console.log(dim(`    - ${p.detalle}`));
  console.log("");
}
