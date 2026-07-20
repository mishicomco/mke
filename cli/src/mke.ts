#!/usr/bin/env -S node --import tsx
// CLI `mke` — operaciones deterministas de la plataforma MKE.
// deploy · publish · expose · rollout · dns · doctor · ls · db provision

import { expose } from "./expose.js";
import { ensureDns } from "./dns.js";
import { doctor } from "./doctor.js";
import { deploy } from "./deploy.js";
import { publish } from "./publish.js";
import { rollout } from "./rollout.js";
import { dbProvision } from "./dbProvision.js";
import { appInit } from "./appInit.js";
import { appNacer } from "./appNacer.js";
import { ensureStaticHostPaso } from "./staticHost.js";
import { ls } from "./ls.js";
import { previewUp, previewPull, previewEstado, previewLs, previewMerge, previewDown, previewLimpiar } from "./preview.js";
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

  mke deploy <app> <env>                        build → k3d import → apply -k overlays/<env> → rollout → doctor
        opciones: --tag <t>  --dir <repo>  --deploy <nombre-deployment>  --host <fqdn>
  mke publish <front> <env>                      front estático: build imagen contenido → Job al PVC de static-mishi → doctor
        opciones: --tag <t>  --dir <repo>  --host <fqdn>   (env = stage | prod)
  mke rollout <app> <env>                        rollout restart + status (sin rebuild; tag mutable / reciclar pods)
        opciones: --deploy <nombre-deployment>
  mke db provision <app> <env>                   crea BD+rol de la app en postgres-mishi (idempotente; imprime DATABASE_URL)
        opciones: --password <pw>   (prod → ns databases · stage/local → databases-dev)
  mke app nacer <app> --subdominio <sub>         NACIMIENTO GREENFIELD COMPLETO (idempotente, corre en el laptop):
                                                  cascarón (create-mishi-app) → repo en git-mishi + push + mirror a GitHub → app init → registro en Studio
        opciones: --env stage|prod  --dir <ruta>  --sin-cascaron  --sin-plataforma  --sin-registro  --dry-run
  mke app init <app>                             nacimiento de plataforma para una app nueva, EN UN COMANDO (idempotente):
                                                  BD+rol → mishi-secret → namespace+Secret k8s (DATABASE_URL+SESSION_SECRET) → DNS → host static-mishi
        opciones: --env stage|prod (default stage)  --subdominio <name>  --dry-run
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

async function main() {
  const [, , cmd, ...rest] = process.argv;
  const { positional, flags } = parseFlags(rest);

  switch (cmd) {
    case "deploy": {
      const [app, env] = positional;
      if (!app || !env) return fail("uso: mke deploy <app> <env> [--tag t] [--dir repo] [--deploy name]");
      await deploy(app, env, {
        tag: typeof flags.tag === "string" ? flags.tag : undefined,
        dir: typeof flags.dir === "string" ? flags.dir : undefined,
        deploy: typeof flags.deploy === "string" ? flags.deploy : undefined,
        host: typeof flags.host === "string" ? flags.host : undefined,
      });
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
      const env = typeof flags.env === "string" ? flags.env : "stage";
      if (action === "nacer" && app) {
        await appNacer(app, {
          subdominio: typeof flags.subdominio === "string" ? flags.subdominio : undefined,
          env,
          dir: typeof flags.dir === "string" ? flags.dir : undefined,
          sinCascaron: flags["sin-cascaron"] === true,
          sinPlataforma: flags["sin-plataforma"] === true,
          sinRegistro: flags["sin-registro"] === true,
          dryRun: flags["dry-run"] === true,
        });
        break;
      }
      if (action !== "init" || !app) return fail("uso: mke app nacer <app> --subdominio <sub>  |  mke app init <app> [--env stage|prod] [--subdominio nombre] [--dry-run]");
      await appInit(app, env, {
        subdominio: typeof flags.subdominio === "string" ? flags.subdominio : undefined,
        dryRun: flags["dry-run"] === true,
      });
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
        if (!app || !rama) return fail("uso: mke preview up <app> <rama> [--espejo] [--live] [--ttl-segundos n] [--json] [--dry-run] [--repo-url url]");
        await previewUp(app, rama, {
          espejo: flags.espejo === true,
          live: flags.live === true,
          json: flags.json === true,
          dryRun: flags["dry-run"] === true,
          repoUrl: typeof flags["repo-url"] === "string" ? flags["repo-url"] : undefined,
          ttlSegundos: typeof flags["ttl-segundos"] === "string" ? Number(flags["ttl-segundos"]) : undefined,
        });
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
        return fail("uso: mke preview up|pull|estado|ls|merge|down|limpiar");
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
