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
import { ls } from "./ls.js";
import { previewUp, previewDown, previewLs } from "./preview.js";
import { ramaUp, ramaDown, ramaLs } from "./rama.js";
import { hostFor } from "./mkeConfig.js";
import { fileURLToPath } from "node:url";

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
  mke app init <app>                             nacimiento de plataforma para una app nueva, EN UN COMANDO (idempotente):
                                                  BD+rol → mishi-secret → namespace+Secret k8s (DATABASE_URL+SESSION_SECRET) → DNS
        opciones: --env stage|prod (default stage)  --subdominio <name>  --dry-run
  mke expose <app> <env> --host-port <N>        expone un servicio del HOST (systemd) en <app><suffix>.mishi.com.co
  mke expose <app> <env> --svc <name:port>      expone un servicio del CLUSTER ya existente
        opciones: --host <fqdn>  (override del subdominio)   --path </>
  mke preview up <app> <rama>                    preview EFÍMERO por feature: build rama → import a mke-preview → manifests (backend + postgres efímero + ingress) → CNAME <slugApp>-<feature>-pre → verifica
        opciones: --feature <nombre>  --dir <repo>
  mke preview down <nombre>                       borra el preview <slugApp>-<feature> (el que muestra ls): namespace + CNAME (vía API Cloudflare)
  mke preview ls                                  lista los previews vivos en mke-preview
  mke rama up <app> <rama>                        enciende un "pod de rama" (harness v2): imagen genérica que clona la rama al arrancar (git), instala, construye el front y corre backend+front mismo origen + postgres efímero; CNAME <app>-<slug>-feat
        opciones: --json  --dry-run (imprime manifiestos)  --sin-dns (no toca Cloudflare)  --repo-url <url>
  mke rama down <app> <rama>                      apaga la rama: borra deployment/service/ingress/configmap/secret + CNAME (idempotente)
        opciones: --json  --sin-dns
  mke rama ls [<app>]                             lista las ramas encendidas (edad/estado)  · opción: --json
  mke dns <host|app> <env>                       crea/repara el CNAME al tunnel correcto del entorno
  mke doctor <host> [path]                       diagnostica la cadena pública y dice qué capa está rota
  mke ls [env]                                    inventario de ingresses (host → servicio) por entorno

  env = local | stage | prod
  ej:  mke deploy polla-futbolera stage
       mke expose agents-mishi stage --host-port 8787
       mke doctor agents-stage.mishi.com.co
       mke ls stage
       mke app init barrio-mishi --env stage --dry-run`;

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
      if (action !== "init" || !app) return fail("uso: mke app init <app> [--env stage|prod] [--subdominio nombre] [--dry-run]");
      const env = typeof flags.env === "string" ? flags.env : "stage";
      await appInit(app, env, {
        subdominio: typeof flags.subdominio === "string" ? flags.subdominio : undefined,
        dryRun: flags["dry-run"] === true,
      });
      break;
    }
    case "ls": {
      const [env] = positional;
      await ls(env);
      break;
    }
    case "preview": {
      const [action, ...pargs] = positional;
      if (action === "up") {
        const [app, rama] = pargs;
        if (!app || !rama) return fail("uso: mke preview up <app> <rama> [--feature nombre] [--dir repo]");
        await previewUp(app, rama, {
          feature: typeof flags.feature === "string" ? flags.feature : undefined,
          dir: typeof flags.dir === "string" ? flags.dir : undefined,
        });
      } else if (action === "down") {
        const [nombre] = pargs;
        if (!nombre) return fail("uso: mke preview down <nombre>  (el <slugApp>-<feature> que muestra `mke preview ls`)");
        await previewDown(nombre);
      } else if (action === "ls" || action === undefined) {
        await previewLs();
      } else {
        return fail("uso: mke preview up|down|ls");
      }
      break;
    }
    case "rama": {
      const [action, ...rargs] = positional;
      const imagesDir = fileURLToPath(new URL("../../images/rama-runner", import.meta.url));
      if (action === "up") {
        const [app, rama] = rargs;
        if (!app || !rama) return fail("uso: mke rama up <app> <rama> [--json] [--dry-run] [--sin-dns] [--repo-url url]");
        await ramaUp(app, rama, imagesDir, {
          json: flags.json === true,
          dryRun: flags["dry-run"] === true,
          sinDns: flags["sin-dns"] === true,
          repoUrl: typeof flags["repo-url"] === "string" ? flags["repo-url"] : undefined,
        });
      } else if (action === "down") {
        const [app, rama] = rargs;
        if (!app || !rama) return fail("uso: mke rama down <app> <rama> [--json] [--sin-dns]");
        await ramaDown(app, rama, {
          json: flags.json === true,
          sinDns: flags["sin-dns"] === true,
        });
      } else if (action === "ls" || action === undefined) {
        await ramaLs(rargs[0], { json: flags.json === true });
      } else {
        return fail("uso: mke rama up|down|ls");
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
