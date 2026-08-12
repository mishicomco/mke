#!/usr/bin/env -S node --import tsx
// CLI `mke` — operaciones deterministas de la plataforma MKE.
// deploy · ci · publish · expose · rollout · dns · doctor · ls · db provision

import { expose } from "./expose.js";
import { ciRuns, ciLogs, ciDeploy, ciWait, EXIT_WAIT } from "./ci.js";
import { ensureDns } from "./dns.js";
import { doctor } from "./doctor.js";
import { deploy } from "./deploy.js";
import { publish } from "./publish.js";
import { rollout } from "./rollout.js";
import { dbProvision } from "./dbProvision.js";
import { appBorrar } from "./appBorrar.js";
import { appInit } from "./appInit.js";
import { appNacer } from "./appNacer.js";
import { iamLint } from "./iamLint.js";
import { ensureStaticHostPaso } from "./staticHost.js";
import { ls } from "./ls.js";
import { artifactPublicar, artifactLs, artifactVer, artifactRollback, artifactBorrar, artifactNacer, artifactAcceso, guardiaDeploy } from "./artifact.js";
import { previewUp, previewPull, previewEstado, previewLs, previewMerge, previewDown, previewLimpiar } from "./preview.js";
import { previewUpV2, previewPushV2 } from "./previewV2.js";
import { hostFor } from "./mkeConfig.js";

function parseFlags(args: string[]): { positional: string[]; flags: Record<string, string | boolean> } {
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = args[i + 1];
      if (next && !next.startsWith("--")) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = true;
      }
    } else {
      positional.push(a);
    }
  }
  return { positional, flags };
}

const HELP = `mke — CLI de plataforma MKE

  mke deploy <app> <env>                        EL pipeline completo (lo que antes vivía duplicado en el ci-cd.yml de cada app):
                                                  lint de migraciones → preflight convergente (ns+BD+MATERIALIZAR el Secret desde el vault+DNS+host vivo en static-mishi)
                                                  → build backend(+front) → k3d import → apply -k (+re-pin) → dump → Job de migrar → drift-check
                                                  → set image :sha → rollout → publicar front al PVC → catálogo → doctor (postflight)
        opciones: --tag <t>  --dir <repo>  --deploy <nombre-deployment>  --host <fqdn>  --health <path>  --sin-preflight  --dry-run
  ── CI/CD: el TRIGGER es git, NO un comando mke ──────────────────────────────
     deploy a STAGE = push a \`main\`   ·   deploy a PROD = push de un tag \`v*\`
     (el workflow delgado solo llama a \`mke deploy\`; detalle: mke ci --help)
  mke ci runs <app> [n]                         últimos runs del repo en el forge (id/estado/rama)
  mke ci logs <app> [runId]                     baja el ZIP de logs del run (último FALLIDO por default) y muestra las líneas de error
  mke ci wait <app> --ref <tag|sha|rama>        confirma que TU deploy pasó — espera EL run de ese ref (ver mke ci --help)
  mke ci deploy <app> <env>                     escape hatch: SOLO en repos con workflow_dispatch (las apps estándar NO lo tienen;
                                                  ahí el deploy es el push de arriba). Dispara el workflow y espera el veredicto.
        opciones: --ref <rama|tag>   stage: default main · prod: OBLIGATORIO y tiene que ser un tag v* (ej: --ref v0.1.2)
                  --sin-esperar (solo dispara)  --timeout <seg>
  mke ci wait <app> --ref <tag|sha|rama>        espera EL run de ese ref exacto (NUNCA "el último": tras un push el run nuevo
                                                  tarda en registrarse y "el último" es el ANTERIOR → falso positivo).
                                                  veredicto/exit: success=0 · fallo(failure/cancelled/skipped)=1 · timeout=2 ·
                                                  no-apareció=3 · killed(runner muerto, log cortado sin "Job failed")=4
        opciones: --sha <sha> (OBLIGATORIO en la práctica si el ref es una rama; --sha SOLO, sin --ref, también vale)
                  --min-id <id> (id global previo al push)
                  --timeout <seg> (default 1200)  --aparecer <seg> (default 120)  --estancado <seg> (default 300)
  mke artifact nacer <nombre>                    ARTIFACT: genera el cascarón modular estándar en ~/mishicomco/artifacts-mishi/<nombre>
  mke artifact publicar <nombre> <html|carpeta>  frontend sin build ni ambientes en <nombre>-artifact.mishi.com.co —
                                                  commit a artifacts-mishi (historia+backup) → CNAME → routing+CSP → cp al PVC (+runtime compartido)
                                                  → aviso SSE (pestañas abiertas se recargan solas) → doctor    opciones: --mensaje "..."
  mke artifact ls | ver <n> | rollback <n> | borrar <n>   listar · cadena pública · versión anterior · PVC+CNAME (la historia queda)  ·  diseño: mke/AI_ARTIFACTS.md
  mke artifact acceso <n|--todos> <email|rol:x|publico>  quién puede VER un artifact (tabla accesos de artifact-mishi; la guardia la consulta)
                                                  opciones: --quitar   ·  --todos = todos los artifacts
                                                  publico (por artifact, nunca --todos) = se abre SIN sesión, solo lectura
  mke publish <front> <env>                      front estático: build imagen contenido → Job al PVC de static-mishi → doctor
        opciones: --tag <t>  --dir <repo>  --host <fqdn>   (env = stage | prod)
  mke rollout <app> <env>                        rollout restart + status (sin rebuild; tag mutable / reciclar pods)
        opciones: --deploy <nombre-deployment>
  mke db provision <app> <env>                   crea BD+rol de la app en postgres-mishi (idempotente; imprime DATABASE_URL)
        opciones: --password <pw>   (prod → ns databases · stage/local → databases-dev)
  mke app nacer <nombre>                         NACIMIENTO COMPLETO de una app nueva, EN UN COMANDO (el verbo \`nacer\` vive acá, no en Studio):
                                                  cascarón (create-mishi-app) → repo PRIMARIO en git-mishi (git.mishi.com.co/mishicomco/<app>, +push-mirror a GitHub backup)
                                                  → git init/commit/push a origin=forge (dispara CI) → \`mke app init\` (plataforma) → registro en Studio
        opciones: --subdominio <sub>  --env stage|prod (default stage)  --dir <ruta>  --sin-cascaron  --sin-plataforma  --sin-registro  --dry-run
  mke app init <app>                             nacimiento de PLATAFORMA de una app (paso 4 de \`nacer\`, suelto; idempotente):
                                                  BD+rol → vault-mishi → namespace+Secret k8s (DATABASE_URL+SESSION_SECRET) → DNS → host static-mishi → grant vault
        opciones: --env stage|prod (default stage)  --subdominio <name>  --dry-run
  mke app borrar <app>                           TEARDOWN de una app, inverso de \`nacer\`: k8s + BD/rol + DNS + host static-mishi + catálogo (repo/dir opt-in)
        opciones: --env stage|prod (default stage)  --si (OBLIGATORIO)  --si-prod (2a llave en prod)  --forge (borra el repo)  --dir-local (borra el checkout)
  mke iam lint                                   valida mke.iam.yaml en el dev loop (mismo parser+mensajes que el deploy; sin cluster ni red). Exit 1 si el deploy abortaría.
        opciones: --dir <repo>  (default: cwd)
  mke static agregar <sub>                      agrega el host de <sub> al ingress de static-mishi (stage+prod), idempotente
                                                  (paso suelto de \`mke app init\`; útil si el nacimiento ya pasó sin este paso)
        opciones: --dry-run
  mke expose <app> <env> --host-port <N>        expone un servicio del HOST (systemd) en <app><suffix>.mishi.com.co
  mke expose <app> <env> --svc <name:port>      expone un servicio del CLUSTER ya existente
        opciones: --host <fqdn>  (override del subdominio)   --path </>
  mke preview up <app> <rama>                    VERBO DEFINITIVO de iteración: rama efímera (worktree local + push, pod HMR con SIDECAR postgres, lease de secretos del vault); CNAME <app>-<rama-slug>  ·  detalle: mke preview --help
  mke preview pull|estado|ls|merge|down|limpiar … traer cambios / estado / listar / MERGE (final feliz) / down (ABORTO) / red de seguridad  ·  detalle: mke preview --help
  mke dns <host|app> <env>                       crea/repara/REPUNTA el CNAME al tunnel del entorno vía API Cloudflare (env: local|stage|prod|preview; con preview pasá el host completo)
  mke doctor <host> [path]                       diagnostica la cadena pública y dice qué capa está rota
  mke ls [env]                                    inventario de ingresses (host → servicio) por entorno

  env = local | stage | prod
  ej:  mke deploy polla-futbolera stage
       mke expose agents-mishi stage --host-port 8787
       mke doctor agents-stage.mishi.com.co
       mke ls stage
       mke app init barrio-mishi --env stage --dry-run`;

const PREVIEW_HELP = `mke preview — VERBO DEFINITIVO de iteración: rama efímera con pod HMR (2026-07-11)

  Clúster mke-preview, ns \`preview\` (JAMÁS mke-prod). Pod con init clona+instala,
  vite HMR + tsx watch, caddy un-solo-origen, SIDECAR postgres efímero. Host BARE
  \`<app>-<rama-slug>.mishi.com.co\` (un solo label DNS); DB que MUERE con el pod
  (sin DROP central); secretos/config por LEASE del vault leyendo
  \`mke.preview.yaml\` de la rama — CERO --env humano. DEGRADACIÓN interina: si el
  vault aún no tiene el escenario 4, arranca SIN lease (warning) para probar
  pod+DB+HMR en vivo.

  mke preview up <app> <rama>      crea la rama local si falta (desde main) + git worktree en
                                    \`<app>.wt-<rama-slug>\` + push; pide el lease del vault acotado a
                                    los secretos de mke.preview.yaml; aplica el pod; migra (db:migrate)
                                    y siembra (db:sembrar) o restaura el espejo. IDEMPOTENTE.
        --espejo                   en vez de sembrar, restaura datos de STAGE en el SIDECAR (TRUNCATE +
                                    pg_dump --data-only --disable-triggers excluyendo cada tabla de
                                    apps/backend/db/tablas-sensibles.txt del repo — si falta, ABORTA)
        --live                      modo EMBED: vite bajo /live/<app>/ (Studio embebe same-origen)
        --ttl-segundos <n>          TTL del lease (backstop de vida); default del vault
        --json  --dry-run  --repo-url <url>
        --v2                        preview v2 (opt-in, 2026-08-11): imagen REAL (docker build del
                                    Dockerfile del repo) en vez de clone+install en vivo; sin HMR — el
                                    front se actualiza por el actualizador silencioso del molde
                                    (/version.json). Mismo ns/host/lease/DNS que v1. Detalle: AI_PREVIEW_V2.md
  mke preview push <app> <rama> --v2   SOLO v2: detecta qué cambió (git diff) y corre el carril que
                                    toque — front (~5-10s: vite build local + kubectl cp) y/o back
                                    (~30-60s: docker build + carga de imagen + set image + rollout +
                                    MIGRATE_ONLY). v1 no tiene push: usa \`pull\` (HMR ya recoge solo).
        --json
  mke preview pull <app> <rama>    git pull DENTRO del pod (HMR recoge solo) + renueva el lease
  mke preview estado <app> <rama> rama + estado del pod + lease + host
  mke preview ls [<app>]           lista los previews vivos
  mke preview merge <app> <rama>   FINAL FELIZ (único): verifica worktree limpio → mergea la rama a
                                    main + push → borra worktree + rama local + rama REMOTA (esto
                                    dispara el workflow \`on: delete\` → limpieza del cluster).  --json
  mke preview down <app> <rama>    ABORTO TOTAL (a mano): revoca lease + borra bundle k8s por labels +
                                    CNAME + worktree + rama local + rama REMOTA. GUARDARRAÍL: se niega
                                    si la rama tiene commits no mergeados a main (salvo --forzar).
        --forzar                    baja aunque haya trabajo sin mergear (lo descarta)
        --sin-worktree              MODO RUNNER: solo limpieza de cluster, NO toca ramas (lo usa el
                                    workflow \`on: delete\` — la rama ya no existe cuando corre)
        --json
  mke preview limpiar               red de seguridad (NO el mecanismo primario — ese es el workflow
                                    \`on: delete\` de cada app): barre previews cuya rama ya no existe
                                    en origin y les aplica la limpieza de cluster (modo runner).`;

const CI_HELP = `mke ci — operar el CI del forge (git-mishi). El TRIGGER del deploy es GIT, no mke.

  CONTRATO DE DEPLOY (horneado en el ci-cd.yml delgado de cada app):
    • push a \`main\`            → deploy a STAGE  (<app>-stage.mishi.com.co), runner del gamer
    • push de un tag \`v*\`      → deploy a PROD   (<app>.mishi.com.co),        runner del laptop
    El workflow solo llama a \`mke deploy <app> <env>\`; el pipeline entero vive en el CLI.
    Las apps estándar NO tienen \`workflow_dispatch\` (un input desconocido caía al default y
    deployaba al ambiente equivocado): por eso el escape hatch manual es \`mke deploy\` en la
    terminal, no un dispatch.

  mke ci runs <app> [n]            últimos n runs del repo (id / estado / rama). Solo lectura.
  mke ci logs <app> [runId]        baja el ZIP de logs (último FALLIDO por default) y muestra los errores.
  mke ci wait <app> --ref <r>      CONFIRMA TU DEPLOY: espera EL run del ref exacto (NUNCA "el último":
                                     tras un push el run nuevo tarda en registrarse y "el último" es el
                                     ANTERIOR → falso positivo). LOCK por id una vez visto.
        --ref <tag|sha|rama>       prod: usa el tag (\`--ref v0.1.2\`). stage (push a main): el ref de
                                     RAMA no basta → pasá \`--sha <sha>\` (o \`--min-id <id previo al push>\`).
                                     \`--sha\` SOLO (sin --ref) también vale.
        exit: success=0 · fallo(failure/cancelled/skipped)=1 · timeout=2 · no-apareció=3 ·
              killed(runner muerto: heartbeat estancado / log cortado sin "Job failed")=4
        --timeout <seg> (1200) · --aparecer <seg> (120) · --estancado <seg> (300)
  mke ci deploy <app> <env>        ESCAPE HATCH — solo repos que conservan workflow_dispatch. En una app
                                     estándar NO dispara nada (usa el push de arriba). Dispara+espera.
        --ref <rama|tag> (prod exige tag v*) · --sin-esperar · --timeout <seg>

  Trampas (cicatrices reales): \`[skip ci]\` en el commit tageado silencia también el run del tag;
  un tag no-semver a prod falla-cerrado (no deploya); si el gamer está apagado, stage no deploya
  (prod sí). Guíate por la MÁQUINA para el ambiente, no por el nombre del runner.`;

async function main() {
  const [, , cmd, ...rest] = process.argv;
  const { positional, flags } = parseFlags(rest);

  switch (cmd) {
    case "deploy": {
      const [app, env] = positional;
      if (!app || !env) return fail("uso: mke deploy <app> <env> [--tag t] [--dir repo] [--deploy name] [--host fqdn] [--health path] [--sin-preflight] [--dry-run]");
      await deploy(app, env, {
        tag: typeof flags.tag === "string" ? flags.tag : undefined,
        dir: typeof flags.dir === "string" ? flags.dir : undefined,
        deploy: typeof flags.deploy === "string" ? flags.deploy : undefined,
        host: typeof flags.host === "string" ? flags.host : undefined,
        health: typeof flags.health === "string" ? flags.health : undefined,
        sinPreflight: flags["sin-preflight"] === true,
        dryRun: flags["dry-run"] === true,
      });
      break;
    }
    case "ci": {
      const [action, app, tercero] = positional;
      if (flags.help || action === "help" || (!action && !app)) { console.log(CI_HELP); break; }
      if (!action || !app) return fail("uso: mke ci runs <app> [n] | mke ci logs <app> [runId] | mke ci wait <app> --ref <tag|sha|rama> | mke ci deploy <app> <env>  (git push es el trigger real — mke ci --help)");
      if (action === "runs") {
        await ciRuns(app, tercero ? Number(tercero) : undefined);
      } else if (action === "logs") {
        await ciLogs(app, tercero ? Number(tercero) : undefined);
      } else if (action === "deploy") {
        if (!tercero) return fail("uso: mke ci deploy <app> <stage|prod> [--ref r]  (prod exige --ref <tag v*>)");
        await ciDeploy(app, tercero, typeof flags.ref === "string" ? flags.ref : undefined, {
          sinEsperar: flags["sin-esperar"] === true,
          timeoutSeg: typeof flags.timeout === "string" ? Number(flags.timeout) : undefined,
        });
      } else if (action === "wait") {
        // `--sha` solo (sin --ref) también identifica el run: se usa como ref.
        // Fricción real 2026-08-09: `mke ci wait app --sha X` moría en usage.
        const ref = typeof flags.ref === "string"
          ? flags.ref
          : typeof flags.sha === "string" ? flags.sha : undefined;
        if (!ref) return fail("uso: mke ci wait <app> --ref <tag|sha|rama> [--sha s] [--min-id n] [--timeout seg] [--aparecer seg] [--estancado seg]\n(--sha solo, sin --ref, también vale: espera el run de ese commit)");
        const veredicto = await ciWait(app, ref, {
          sha: typeof flags.sha === "string" ? flags.sha : undefined,
          minId: typeof flags["min-id"] === "string" ? Number(flags["min-id"]) : undefined,
          timeoutSeg: typeof flags.timeout === "string" ? Number(flags.timeout) : undefined,
          aparecerSeg: typeof flags.aparecer === "string" ? Number(flags.aparecer) : undefined,
          estancadoSeg: typeof flags.estancado === "string" ? Number(flags.estancado) : undefined,
        });
        process.exitCode = EXIT_WAIT[veredicto];
      } else {
        return fail("uso: mke ci runs|logs|deploy|wait <app> …");
      }
      break;
    }
    case "publish": {
      const [front, env] = positional;
      if (!front || !env) return fail("uso: mke publish <front> <env> [--tag t] [--dir repo] [--host fqdn]");
      await publish(front, env, {
        tag: typeof flags.tag === "string" ? flags.tag : undefined,
        dir: typeof flags.dir === "string" ? flags.dir : undefined,
        host: typeof flags.host === "string" ? flags.host : undefined,
      });
      break;
    }
    case "rollout": {
      const [app, env] = positional;
      if (!app || !env) return fail("uso: mke rollout <app> <env> [--deploy name]");
      await rollout(app, env, typeof flags.deploy === "string" ? flags.deploy : undefined);
      break;
    }
    case "db": {
      const [action, app, env] = positional;
      if (action !== "provision" || !app || !env) return fail("uso: mke db provision <app> <env> [--password pw]");
      await dbProvision(app, env, {
        password: typeof flags.password === "string" ? flags.password : undefined,
      });
      break;
    }
    case "app": {
      const [action, app] = positional;
      if (action === "nacer") {
        if (!app) return fail("uso: mke app nacer <nombre> [--subdominio sub] [--env stage|prod] [--dir ruta] [--sin-cascaron] [--sin-plataforma] [--sin-registro] [--dry-run]");
        await appNacer(app, {
          subdominio: typeof flags.subdominio === "string" ? flags.subdominio : undefined,
          env: typeof flags.env === "string" ? flags.env : undefined,
          dir: typeof flags.dir === "string" ? flags.dir : undefined,
          sinCascaron: flags["sin-cascaron"] === true,
          sinPlataforma: flags["sin-plataforma"] === true,
          sinRegistro: flags["sin-registro"] === true,
          dryRun: flags["dry-run"] === true,
        });
        break;
      }
      if (action === "borrar") {
        if (!app) return fail("uso: mke app borrar <app> [--env stage|prod] [--subdominio sub] --si [--si-prod] [--forge] [--dir-local]");
        await appBorrar(app, {
          env: typeof flags.env === "string" ? flags.env : undefined,
          subdominio: typeof flags.subdominio === "string" ? flags.subdominio : undefined,
          si: flags.si === true,
          siProd: flags["si-prod"] === true,
          forge: flags.forge === true,
          dirLocal: flags["dir-local"] === true,
        });
        break;
      }
      if (action !== "init" || !app) return fail("uso: mke app init <app> [--env stage|prod] [--subdominio nombre] [--dry-run]  |  mke app nacer <nombre>  |  mke app borrar <app> --si");
      const env = typeof flags.env === "string" ? flags.env : "stage";
      await appInit(app, env, {
        subdominio: typeof flags.subdominio === "string" ? flags.subdominio : undefined,
        dryRun: flags["dry-run"] === true,
      });
      break;
    }
    case "iam": {
      const [action] = positional;
      if (action !== "lint") return fail("uso: mke iam lint [--dir <repo>]");
      await iamLint({ dir: typeof flags.dir === "string" ? flags.dir : undefined });
      break;
    }
    case "artifact": {
      const [action, nombre, origen] = positional;
      if (action === "publicar") {
        if (!nombre || !origen) return fail("uso: mke artifact publicar <nombre> <archivo.html|carpeta> [--mensaje \"...\"]");
        await artifactPublicar(nombre, origen, {
          mensaje: typeof flags.mensaje === "string" ? flags.mensaje : undefined,
        });
      } else if (action === "nacer") {
        if (!nombre) return fail("uso: mke artifact nacer <nombre>");
        await artifactNacer(nombre);
      } else if (action === "ls") {
        await artifactLs();
      } else if (action === "ver") {
        if (!nombre) return fail("uso: mke artifact ver <nombre>");
        await artifactVer(nombre);
      } else if (action === "rollback") {
        if (!nombre) return fail("uso: mke artifact rollback <nombre>");
        await artifactRollback(nombre);
      } else if (action === "borrar") {
        if (!nombre) return fail("uso: mke artifact borrar <nombre>");
        await artifactBorrar(nombre);
      } else if (action === "acceso") {
        // `mke artifact acceso <artifact> <sujeto>` o `... --todos <sujeto>`.
        // OJO parseFlags: un flag seguido de un valor se lo traga como string
        // (`--todos email` → flags.todos = email), así que se aceptan ambas
        // formas.
        const todos = flags.todos === true || typeof flags.todos === "string";
        const objetivo = todos ? "*" : nombre;
        const sujeto = typeof flags.todos === "string" ? flags.todos : todos ? nombre : origen;
        if (!objetivo || !sujeto) {
          return fail("uso: mke artifact acceso <artifact|--todos> <email|rol:x|publico> [--quitar]");
        }
        await artifactAcceso(objetivo, sujeto, { quitar: flags.quitar === true });
      } else if (action === "guardia") {
        await guardiaDeploy(true); // rebuild+redeploy de la puerta
      } else {
        return fail("uso: mke artifact nacer|publicar|ls|ver|rollback|borrar|acceso|guardia …  (diseño: mke/AI_ARTIFACTS.md)");
      }
      break;
    }
    case "static": {
      const [action, sub] = positional;
      if (action !== "agregar" || !sub) return fail("uso: mke static agregar <sub> [--dry-run]");
      await ensureStaticHostPaso(sub, sub, { dryRun: flags["dry-run"] === true });
      break;
    }
    case "ls": {
      const [env] = positional;
      await ls(env);
      break;
    }
    case "preview": {
      const [action, ...pargs] = positional;
      if (flags.help || action === "help") { console.log(PREVIEW_HELP); break; }
      if (action === "up") {
        const [app, rama] = pargs;
        if (!app || !rama) return fail("uso: mke preview up <app> <rama> [--v2] [--espejo] [--live] [--ttl-segundos n] [--json] [--dry-run] [--repo-url url]");
        if (flags.v2 === true) {
          await previewUpV2(app, rama, {
            json: flags.json === true,
            dryRun: flags["dry-run"] === true,
            repoUrl: typeof flags["repo-url"] === "string" ? flags["repo-url"] : undefined,
            ttlSegundos: typeof flags["ttl-segundos"] === "string" ? Number(flags["ttl-segundos"]) : undefined,
          });
        } else {
          await previewUp(app, rama, {
            espejo: flags.espejo === true,
            live: flags.live === true,
            json: flags.json === true,
            dryRun: flags["dry-run"] === true,
            repoUrl: typeof flags["repo-url"] === "string" ? flags["repo-url"] : undefined,
            ttlSegundos: typeof flags["ttl-segundos"] === "string" ? Number(flags["ttl-segundos"]) : undefined,
          });
        }
      } else if (action === "push") {
        const [app, rama] = pargs;
        if (!app || !rama) return fail("uso: mke preview push <app> <rama> --v2 [--json]  (--v2 obligatorio: v1 usa `pull` para HMR)");
        if (flags.v2 !== true) return fail("`mke preview push` es SOLO para --v2 (v1 itera con HMR en vivo, sin push — usá `mke preview pull` para refrescar el git del pod)");
        await previewPushV2(app, rama, { json: flags.json === true });
      } else if (action === "pull") {
        const [app, rama] = pargs;
        if (!app || !rama) return fail("uso: mke preview pull <app> <rama> [--json]");
        await previewPull(app, rama, { json: flags.json === true });
      } else if (action === "estado") {
        const [app, rama] = pargs;
        if (!app || !rama) return fail("uso: mke preview estado <app> <rama> [--json]");
        await previewEstado(app, rama, { json: flags.json === true });
      } else if (action === "ls" || action === undefined) {
        await previewLs(pargs[0], { json: flags.json === true });
      } else if (action === "merge") {
        const [app, rama] = pargs;
        if (!app || !rama) return fail("uso: mke preview merge <app> <rama> [--json]");
        await previewMerge(app, rama, { json: flags.json === true });
      } else if (action === "down") {
        const [app, rama] = pargs;
        if (!app || !rama) return fail("uso: mke preview down <app> <rama> [--forzar] [--sin-worktree] [--json]");
        await previewDown(app, rama, {
          json: flags.json === true,
          sinWorktree: flags["sin-worktree"] === true,
          forzar: flags.forzar === true,
        });
      } else if (action === "limpiar") {
        await previewLimpiar({ json: flags.json === true });
      } else {
        return fail("uso: mke preview up|push|pull|estado|ls|merge|down|limpiar");
      }
      break;
    }
    case "expose": {
      const [app, env] = positional;
      if (!app || !env) return fail("uso: mke expose <app> <env> --host-port N | --svc name:port");
      await expose(app, env, {
        hostPort: flags["host-port"] ? Number(flags["host-port"]) : undefined,
        svc: typeof flags.svc === "string" ? flags.svc : undefined,
        host: typeof flags.host === "string" ? flags.host : undefined,
        path: typeof flags.path === "string" ? flags.path : undefined,
      });
      break;
    }
    case "dns": {
      const [hostOrApp, env] = positional;
      if (!hostOrApp || !env) return fail("uso: mke dns <host|app> <env>");
      const host = hostOrApp.includes(".") ? hostOrApp : hostFor(hostOrApp, env);
      await ensureDns(host, env);
      break;
    }
    case "doctor": {
      const [host, path] = positional;
      if (!host) return fail("uso: mke doctor <host> [path]");
      await doctor(host, path);
      break;
    }
    case "help":
    case "--help":
    case undefined:
      console.log(HELP);
      break;
    default:
      fail(`comando desconocido: ${cmd}\n\n${HELP}`);
  }
}

function fail(msg: string) {
  console.error(msg);
  process.exitCode = 1;
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
