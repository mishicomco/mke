// `mke app nacer <app> --subdominio <sub>` — nacimiento greenfield COMPLETO de una
// app del ecosistema, en un comando idempotente. Corre en el LAPTOP (necesita
// disco ~/mishicomco, git, npm y el CLI create-mishi-app).
//
// Decisión Santi 2026-07-20: el verbo `nacer` es de `mke`, NO de Studio (Studio =
// notas y sueños). Portado desde el viejo `mishi-studio app nacer`, con DOS
// cambios de fondo: (1) el repo primario nace en **git-mishi** (el forge) con
// push-mirror a GitHub, no al revés; (2) la plataforma se provisiona llamando a
// `appInit` EN PROCESO (no spawneando `mke`).
//
// Pasos (cada uno idempotente/salteable; si un paso externo falla, se corta ahí,
// los previos no se deshacen — re-correr es seguro):
//   1. cascarón   → create-mishi-app (checkout hermano ~/mishicomco o PATH)
//   2. repo       → git init + npm install (lockfile) + commit inicial +
//                   ensureForgeRepo (git-mishi) + push a origin=forge +
//                   ensureGithubMirror (backup off-site). El push dispara el
//                   primer deploy a stage vía el forgejo-runner.
//   3. plataforma → appInit(app, env)  (BD+DNS+Secret+host static-mishi+grant vault)
//   4. registro   → API de Studio: POST /v1/app + POST /v1/app/:id/escenario
//                   (la app se registra para colgarle notas/sueños; Studio no la crea)

import { existsSync } from "node:fs";
import { join } from "node:path";

import { appInit } from "./appInit.js";
import { ensureForgeRepo, ensureGithubMirror, forgeCloneUrl } from "./forgeRepo.js";
import { appsRoot } from "./mkeConfig.js";
import { run, spawnStream, ok, bad, info, warn, dim } from "./sh.js";

const ORG = "mishicomco";
const STUDIO_URL = process.env.STUDIO_URL ?? "https://studio-stage.mishi.com.co";

export interface AppNacerOpts {
  subdominio?: string;
  env?: string;
  dir?: string;
  sinCascaron?: boolean;
  sinPlataforma?: boolean;
  sinRegistro?: boolean;
  dryRun?: boolean;
}

/** Corre un comando streameando su salida con prefijo; devuelve el exit code. */
async function stream(prefix: string, cmd: string, args: string[]): Promise<number> {
  return spawnStream(cmd, args, (l) => process.stdout.write(`  ${dim(prefix)} ${l}\n`));
}

/** Resuelve el bin de create-mishi-app: checkout hermano o global en PATH. */
function resolverCascaron(): { cmd: string; args: string[] } | null {
  const hermano = join(appsRoot(), "create-mishi-app", "bin", "create-mishi-app.mjs");
  if (existsSync(hermano)) return { cmd: "node", args: [hermano] };
  return { cmd: "create-mishi-app", args: [] }; // fallback a PATH (spawnStream falla limpio si no está)
}

async function registrarEnStudio(app: string): Promise<string> {
  const tok = await run("mishi-secret", ["get", "mishi-studio-token"]);
  if (tok.code !== 0 || !tok.stdout) {
    return "registro en Studio omitido (falta mishi-studio-token); registra luego con `mishi-studio app crear`";
  }
  const headers = {
    Authorization: `Bearer ${tok.stdout.trim()}`,
    "Content-Type": "application/json",
    "x-quien": "santi",
  };
  const appRes = await fetch(`${STUDIO_URL}/v1/app`, {
    method: "POST",
    headers,
    body: JSON.stringify({ nombre: app, repo: app }),
  });
  if (!appRes.ok) return `registro en Studio no quedó (HTTP ${appRes.status}); re-corre o usa \`mishi-studio app crear\``;
  const appRow = (await appRes.json()) as { id: string };
  await fetch(`${STUDIO_URL}/v1/app/${encodeURIComponent(appRow.id)}/escenario`, {
    method: "POST",
    headers,
    body: JSON.stringify({ nombre: "feliz", fixtures: {}, descripcion: "escenario esqueleto — completar con datos reales" }),
  });
  return `app '${appRow.id}' registrada en Studio + escenario 'feliz'`;
}

export async function appNacer(app: string, opts: AppNacerOpts): Promise<void> {
  const env = opts.env ?? "stage";
  const subdominio = opts.subdominio ?? app;
  const dir = opts.dir ?? join(appsRoot(), app);
  const cloneUrl = forgeCloneUrl(app);

  console.log(`\n  mke app nacer ${dim(app)} → ${dim(`${subdominio}-${env}.mishi.com.co`)}\n`);

  if (opts.dryRun) {
    console.log(info("DRY RUN — no se toca nada. Plan:"));
    console.log(`  1. cascarón: create-mishi-app --nombre ${app} --subdominio ${subdominio} --dir ${dir}`);
    console.log(`  2. repo: git init + npm install + commit → repo \`${ORG}/${app}\` en git-mishi (${cloneUrl}) → push origin (forge) → mirror a GitHub`);
    console.log(`  3. plataforma: appInit(${app}, ${env})  (BD+DNS+Secret+host static-mishi+grant vault; incluye ensureForgeRepo idempotente)`);
    console.log(`  4. registro: POST ${STUDIO_URL}/v1/app + escenario 'feliz'`);
    console.log(info("nada ejecutado (--dry-run)"));
    return;
  }

  // 1) cascarón.
  if (opts.sinCascaron) {
    console.log(warn("cascarón salteado (--sin-cascaron)"));
  } else {
    const c = resolverCascaron();
    if (!c) return console.log(bad("no encuentro create-mishi-app (ni hermano ni en PATH)"));
    const code = await stream("cascaron", c.cmd, [...c.args, "--yes", "--nombre", app, "--subdominio", subdominio, "--dir", dir]);
    if (code !== 0) return console.log(bad(`create-mishi-app falló (code ${code})`));
    console.log(ok(`cascarón creado en ${dir}`));
  }

  // 2) repo en git-mishi (forge primary) + push + mirror a GitHub.
  if (!opts.sinCascaron) {
    const gitC = (args: string[]) => run("git", ["-C", dir, ...args]);
    if ((await gitC(["rev-parse", "--git-dir"])).code !== 0) await gitC(["init", "-b", "main"]);
    if ((await gitC(["rev-parse", "-q", "--verify", "HEAD"])).code !== 0) {
      if (!existsSync(join(dir, "package-lock.json"))) {
        const inst = await stream("npm", "npm", ["install", "--prefix", dir]);
        if (inst !== 0) return console.log(bad(`npm install falló (code ${inst}); no se commitea sin lockfile`));
      }
      await gitC(["add", "-A"]);
      const commit = await gitC(["commit", "-m", `nacimiento: cascarón create-mishi-app (${app})`]);
      if (commit.code !== 0) return console.log(bad(`commit inicial falló: ${commit.stderr || commit.stdout}`));
    }
    try {
      const repo = await ensureForgeRepo(app);
      console.log(ok(repo.already ? `repo \`${ORG}/${app}\` ya existía en el forge` : `repo \`${ORG}/${app}\` creado en git-mishi`));
    } catch (e) {
      return console.log(bad(`crear repo en el forge falló: ${(e as Error).message.split("\n")[0]}`));
    }
    if ((await gitC(["remote", "get-url", "origin"])).code !== 0) await gitC(["remote", "add", "origin", cloneUrl]);
    const push = await stream("git", "git", ["-C", dir, "push", "-u", "origin", "main"]);
    if (push !== 0) return console.log(bad(`push al forge falló (code ${push})`));
    console.log(ok(`push al forge hecho (dispara deploy en el forgejo-runner)`));
    const mirror = await ensureGithubMirror(app);
    console.log(dim(`  ${mirror}`));
  }

  // 3) plataforma — appInit EN PROCESO (idempotente; su paso 0 re-asegura el repo).
  if (opts.sinPlataforma) {
    console.log(warn("plataforma salteada (--sin-plataforma)"));
  } else {
    await appInit(app, env, { subdominio });
  }

  // 4) registro en Studio (para colgarle notas/sueños; Studio no crea la app).
  if (opts.sinRegistro) {
    console.log(warn("registro en Studio salteado (--sin-registro)"));
  } else {
    console.log(dim(`  ${await registrarEnStudio(app)}`));
  }

  console.log(`\n  ${ok(`app '${app}' nacida`)}  ${dim(`(${subdominio}-${env}.mishi.com.co)`)}\n`);
}
