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
import { devUp, devRama, devPull, devEstado, devLs, devDown, parseEnvExtra } from "./dev.js";
import { featureUp, featurePull, featureDown, featureEstado, featureLs } from "./feature.js";
import { hostFor } from "./mkeConfig.js";
import { fileURLToPath } from "node:url";
import { warn } from "./sh.js";

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
        opciones: --feature <nombre>  --dir <repo>  --dry-run
  mke preview down <nombre>                       borra el preview <slugApp>-<feature> (el que muestra ls): namespace + CNAME (vía API Cloudflare)
        opciones: --dry-run
  mke preview ls                                  lista los previews vivos en mke-preview
  mke dev up <app> [<rama>]                        DEPRECADO — usá \`mke feature\`. enciende el SERVIDOR DE ITERACIÓN (pod DURADERO por app); rama default main; CNAME <app>-dev-feat  ·  detalle: mke dev --help
  mke dev rama|pull|estado|ls|down …               cambiar de rama / pull / estado / listar / apagar  ·  detalle: mke dev --help
  mke rama up|down|ls …                            DEPRECADO — fachada de \`mke dev\` (up ⇒ dev up --live)  ·  detalle: mke rama --help
  mke feature up <app> <rama>                      feature-pod EFÍMERO (SUCESOR de \`mke dev\`): lee mke.feature.yaml de la app, pide un LEASE de secretos al vault y enciende el pod (vite HMR + tsx watch); CERO --env. CNAME <app>-<rama>-feat  ·  detalle: mke feature --help
  mke feature pull|estado|ls|down …                traer cambios + renovar lease / estado / listar / bajar (revoca el lease)  ·  detalle: mke feature --help
  mke dns <host|app> <env>                       crea/repara/REPUNTA el CNAME al tunnel del entorno vía API Cloudflare (env: local|stage|prod|preview; con preview pasá el host completo)
  mke doctor <host> [path]                       diagnostica la cadena pública y dice qué capa está rota
  mke ls [env]                                    inventario de ingresses (host → servicio) por entorno

  env = local | stage | prod
  ej:  mke deploy polla-futbolera stage
       mke expose agents-mishi stage --host-port 8787
       mke doctor agents-stage.mishi.com.co
       mke ls stage
       mke app init barrio-mishi --env stage --dry-run`;

const DEV_HELP = `mke dev — SERVIDOR DE ITERACIÓN (pod DURADERO por app; ÚNICO mecanismo de rama)

  Clúster mke-preview, ns \`dev\` (JAMÁS mke-prod). El pod clona el repo y corre la
  app en MODO DEV REAL (vite dev HMR + tsx watch) sobre postgres efímero. Cambiar
  de rama / traer cambios = git DENTRO del pod, sin recrear el pod.

  mke dev up <app> [<rama>]        enciende (rama default main). CNAME <app>-dev-feat.mishi.com.co
        --nombre <n>               varios servidores de la misma app a la vez
        --poll <s>                 auto-refresca al detectar push en la rama activa
        --seed "<cmd>"             comando de siembra de la app
        --env K1=V1,K2=V2          override PUNTUAL de config (Secret k8s + envFrom al pod ENTERO, init incluido).
                                   GANA sobre k8s/dev.env. NO dupliques claves de la receta (PORT, PREVIEW, DATABASE_URL, RAMA, NODE_ENV).
        --live                     modo EMBED: vite bajo /live/<app>/ + annotation mke.dev/live=true (Studio embebe same-origen)
        --json  --dry-run  --sin-dns  --repo-url <url>
  mke dev rama <app> <rama>        git checkout <rama> DENTRO del pod + reset DB + recarga k8s/dev.env de esa rama  · --nombre --json
  mke dev pull <app>               trae la rama activa YA (git reset --hard; tsx/vite recogen solos)  · --nombre --json
  mke dev estado <app>             rama activa + sha VIVO del workspace + edad + host  · --nombre --json
  mke dev ls [<app>]               lista los servidores de iteración (rama/edad/estado)  · --json
  mke dev down <app>               apaga: borra deployment/service/ingress/configmap/secret + CNAME  · --nombre --json --sin-dns

  CONFIG PÚBLICA por-rama (k8s/dev.env): la app declara sus envs NO secretos
  (ej. VITE_CONNECT_URL, VITE_GOOGLE_CLIENT_ID) en \`k8s/dev.env\` (líneas K=V) de
  su repo. El pod la sourcea al boot y al cambiar de rama, así cada rama trae SU
  config y re-aplicar \`up\` sin --env no pierde nada. PRECEDENCIA (mayor gana):
    --env del CLI  >  k8s/dev.env  >  defaults de la receta
  PROHIBIDO secretos en dev.env (para secretos: contrato RAMA_ENCENDIDA / a futuro leases de vault-mishi).

  Estado para Studio: labels/annotations \`mke.dev/*\` (app, rama, sha VIVO, live).`;

const FEATURE_HELP = `mke feature — FEATURE-POD efímero (2026-07-10, SUCESOR de \`mke dev\`)

  Clúster mke-preview, ns \`feature\` (JAMÁS mke-prod). Misma anatomía de pod que
  \`mke dev\` (init clona+instala, vite HMR + tsx watch, caddy un-solo-origen,
  postgres efímero), pero secretos/config se resuelven por un LEASE del vault
  (Contrato 1) leyendo \`mke.feature.yaml\` de la app (Contrato 2). CERO --env
  humano: si necesitás un override puntual, se discute aparte.

  mke feature up <app> <rama>       lee mke.feature.yaml del checkout local de la app → POST /v1/lease
                                     al vault → enciende el pod con el token del lease + config como env.
                                     CNAME <app>-<rama>-feat.mishi.com.co
        --poll <s>  --seed "<cmd>"  --live  --ttl-segundos <n>  --json  --dry-run  --sin-dns  --repo-url <url>
  mke feature pull <app> <rama>     git pull DENTRO del pod + renovar el lease (mantiene vivo el pod)
  mke feature estado <app> <rama>   lease + estado del pod + host
  mke feature ls [<app>]            lista los feature-pods vivos
  mke feature down <app> <rama>     busca el lease de esa app×rama → revoke (idempotente) + borra el bundle k8s + CNAME
        --json  --sin-dns

  El token de la identidad EMISORA del vault: \`mishi-secret get vault-mishi-emisor-token\`.`;

const RAMA_HELP = `mke rama — DEPRECADO: fachada de \`mke dev\`

  Ya NO hay dos mecanismos de pods de rama. El ÚNICO es el pod de iteración
  DURADERO de \`mke dev\`. \`mke rama\` se conserva como atajo y delega:

  mke rama up   <app> <rama>   ⇒  mke dev up <app> <rama> --live
  mke rama down <app> [<rama>] ⇒  mke dev down <app>
  mke rama ls   [<app>]        ⇒  mke dev ls [<app>]

  Migrá tu dedo/scripts a \`mke dev\`. Ver \`mke dev --help\`.`;

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
          dryRun: flags["dry-run"] === true,
        });
      } else if (action === "down") {
        const [nombre] = pargs;
        if (!nombre) return fail("uso: mke preview down <nombre>  (el <slugApp>-<feature> que muestra `mke preview ls`)");
        await previewDown(nombre, { dryRun: flags["dry-run"] === true });
      } else if (action === "ls" || action === undefined) {
        await previewLs();
      } else {
        return fail("uso: mke preview up|down|ls");
      }
      break;
    }
    case "rama": {
      const [action, ...rargs] = positional;
      if (flags.help || action === "help") { console.log(RAMA_HELP); break; }
      // FACHADA DEPRECADA de `mke dev`: usa la imagen del pod de iteración.
      const imagesDir = fileURLToPath(new URL("../../images/dev-runner", import.meta.url));
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
    case "dev": {
      const [action, ...dargs] = positional;
      if (flags.help || action === "help") { console.log(DEV_HELP); break; }
      if (flags.json !== true) {
        console.error(warn(`\`mke dev\` está DEPRECADO — usá \`mke feature\` (secretos/config por lease del vault, CERO --env). Ver \`mke feature --help\`.`));
      }
      const imagesDir = fileURLToPath(new URL("../../images/dev-runner", import.meta.url));
      const nombre = typeof flags.nombre === "string" ? flags.nombre : undefined;
      if (action === "up") {
        const [app, rama] = dargs;
        if (!app) return fail("uso: mke dev up <app> [<rama>] [--nombre n] [--poll s] [--seed cmd] [--env K=V,...] [--live] [--json] [--dry-run] [--sin-dns] [--repo-url url]");
        await devUp(app, rama ?? "main", imagesDir, {
          json: flags.json === true,
          dryRun: flags["dry-run"] === true,
          sinDns: flags["sin-dns"] === true,
          repoUrl: typeof flags["repo-url"] === "string" ? flags["repo-url"] : undefined,
          nombre,
          poll: typeof flags.poll === "string" ? Number(flags.poll) : undefined,
          seed: typeof flags.seed === "string" ? flags.seed : undefined,
          envExtra: parseEnvExtra(typeof flags.env === "string" ? flags.env : undefined),
          live: flags.live === true,
        });
      } else if (action === "rama") {
        const [app, rama] = dargs;
        if (!app || !rama) return fail("uso: mke dev rama <app> <rama> [--nombre n] [--json]");
        await devRama(app, rama, { json: flags.json === true, nombre });
      } else if (action === "pull") {
        const [app] = dargs;
        if (!app) return fail("uso: mke dev pull <app> [--nombre n] [--json]");
        await devPull(app, { json: flags.json === true, nombre });
      } else if (action === "estado") {
        const [app] = dargs;
        if (!app) return fail("uso: mke dev estado <app> [--nombre n] [--json]");
        await devEstado(app, { json: flags.json === true, nombre });
      } else if (action === "ls" || action === undefined) {
        await devLs(dargs[0], { json: flags.json === true });
      } else if (action === "down") {
        const [app] = dargs;
        if (!app) return fail("uso: mke dev down <app> [--nombre n] [--json] [--sin-dns]");
        await devDown(app, { json: flags.json === true, sinDns: flags["sin-dns"] === true, nombre });
      } else {
        return fail("uso: mke dev up|rama|pull|estado|ls|down");
      }
      break;
    }
    case "feature": {
      const [action, ...fargs] = positional;
      if (flags.help || action === "help") { console.log(FEATURE_HELP); break; }
      const imagesDir = fileURLToPath(new URL("../../images/dev-runner", import.meta.url));
      if (action === "up") {
        const [app, rama] = fargs;
        if (!app || !rama) return fail("uso: mke feature up <app> <rama> [--poll s] [--seed cmd] [--live] [--ttl-segundos n] [--json] [--dry-run] [--sin-dns] [--repo-url url]");
        await featureUp(app, rama, imagesDir, {
          json: flags.json === true,
          dryRun: flags["dry-run"] === true,
          sinDns: flags["sin-dns"] === true,
          repoUrl: typeof flags["repo-url"] === "string" ? flags["repo-url"] : undefined,
          poll: typeof flags.poll === "string" ? Number(flags.poll) : undefined,
          seed: typeof flags.seed === "string" ? flags.seed : undefined,
          live: flags.live === true,
          ttlSegundos: typeof flags["ttl-segundos"] === "string" ? Number(flags["ttl-segundos"]) : undefined,
        });
      } else if (action === "pull") {
        const [app, rama] = fargs;
        if (!app || !rama) return fail("uso: mke feature pull <app> <rama> [--json]");
        await featurePull(app, rama, { json: flags.json === true });
      } else if (action === "estado") {
        const [app, rama] = fargs;
        if (!app || !rama) return fail("uso: mke feature estado <app> <rama> [--json]");
        await featureEstado(app, rama, { json: flags.json === true });
      } else if (action === "ls" || action === undefined) {
        await featureLs(fargs[0], { json: flags.json === true });
      } else if (action === "down") {
        const [app, rama] = fargs;
        if (!app || !rama) return fail("uso: mke feature down <app> <rama> [--json] [--sin-dns]");
        await featureDown(app, rama, { json: flags.json === true, sinDns: flags["sin-dns"] === true });
      } else {
        return fail("uso: mke feature up|pull|estado|ls|down");
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
