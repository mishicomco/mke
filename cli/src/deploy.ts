// `mke deploy <app> <env>` — EL pipeline completo de despliegue.
//
// Antes vivía duplicado (~280 líneas de YAML) en el `ci-cd.yml` de cada app, y
// cada copia envejecía sola. Ahora el workflow de la app es delgado y solo
// invoca este verbo; toda la ley de plataforma vive UNA vez, acá.
//
// Fases, en orden, todas fail-fast:
//   0. LINT de migraciones — lo PRIMERO (antes de gastar un build). El
//      post-mortem del 2026-07-27: el lint solo corría en el job `quality` de
//      los PRs y el ecosistema no usa PRs → corrió por primera vez DENTRO del
//      deploy a prod.
//   a. PREFLIGHT convergente: namespace, BD+Secret, DNS al túnel vivo, host del
//      front en el ingress VIVO de static-mishi (`preflightDeploy.ts`).
//   b. BUILD backend (+frontend) → `k3d image import` → `apply -k` con RE-PIN de
//      la imagen viva (el `:dev` del manifiesto reciclaría pods antes de migrar).
//   c. COMPUERTA de BD: dump → Job de migrar → drift-check (`compuertaMigraciones.ts`).
//   d. ROLLOUT: `set image :sha` + `rollout status` (recién ahora se recicla).
//   e. PUBLICAR el front al PVC de static-mishi (si la app tiene frontend).
//   f. CATÁLOGO derivado (`catalogo.ts`).
//   g. POSTFLIGHT: `mke doctor` del host público. Si la cadena pública no
//      responde, el deploy NO es verde (exit != 0).

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { envOrThrow, identityOrigin, imagenCluster, NPM_TOKEN_SECRET } from "./mkeConfig.js";
import { derivarAppSpec, shaCorto, type AppSpec } from "./appSpec.js";
import { preflightDeploy } from "./preflightDeploy.js";
import { compuertaLint, compuertaMigracionesPostBuild } from "./compuertaMigraciones.js";
import { publicarFrontAlPvc } from "./publish.js";
import { regenerarCatalogos } from "./catalogo.js";
import { run, ok, bad, warn, info, dim } from "./sh.js";
import { cargarImagenes, describeCarga } from "./cargaImagenes.js";
import { paso, pasoStreamCmd } from "./progresoVivo.js";
import { doctor } from "./doctor.js";
import { secretGet } from "./forgeRepo.js";

export interface DeployOpts {
  /** directorio del repo del app (default: <appsRoot>/<app>) */
  dir?: string;
  /** tag de la imagen (default: sha corto del checkout, como el CI) */
  tag?: string;
  /** nombre del Deployment si difiere del id del app */
  deploy?: string;
  /** override del host público */
  host?: string;
  /** path de salud para el postflight (default: derivado del ingress) */
  health?: string;
  /** salta la fase de preflight convergente (para depurar; NO usar en CI) */
  sinPreflight?: boolean;
  /** imprime el plan y no toca nada */
  dryRun?: boolean;
}

/** Token npm del forge: vault-mishi primero, env como fallback. NUNCA se imprime. */
async function nodeAuthToken(): Promise<string | null> {
  const delSecreto = await secretGet(NPM_TOKEN_SECRET);
  if (delSecreto) return delSecreto;
  const delEntorno = process.env.NODE_AUTH_TOKEN?.trim();
  return delEntorno ? delEntorno : null;
}

/**
 * Path de salud del postflight. Convención del template: apps CON frontend
 * sirven la salud en /api/health (el /salud del ingress es de apps
 * solo-backend). Derivar del ingress solo aplica al caso solo-backend.
 */
function healthPath(spec: AppSpec, override?: string): string {
  if (override) return override;
  if (spec.tieneFrontend) return "/api/health";
  const base = join(spec.dir, "k8s", "base", "ingress.yaml");
  try {
    const texto = readFileSync(base, "utf8");
    if (/path:\s*\/salud\b/.test(texto)) return "/salud";
    if (/path:\s*\/health\b/.test(texto)) return "/health";
    // Sin ruta de salud declarada: sondear el PRIMER path que el ingress sí
    // reclama (un 404 texto de Traefik ahí significaría cadena rota de verdad;
    // un 404 JSON de la app cuenta como viva — lo distingue el doctor).
    const primero = texto.match(/path:\s*(\/\S*)/);
    if (primero) return primero[1];
  } catch {
    /* sin ingress base legible: default */
  }
  return "/health";
}

export async function deploy(app: string, env: string, opts: DeployOpts = {}): Promise<void> {
  const envSpec = envOrThrow(env);
  const spec = derivarAppSpec(app, env, { dir: opts.dir, host: opts.host, deploy: opts.deploy });
  const sha = opts.tag ?? (await shaCorto(spec.dir));
  const imagen = `${spec.app}:${sha}`;
  const imagenFront = `${spec.app}-frontend:${sha}`;
  // Nombre por el que el CLUSTER referencia la imagen: con registry local es
  // `<ref>/<tag>`, sin registry el tag local. El `docker build` produce SIEMPRE
  // el tag local; `cargarImagenes` pushea al registry cuando aplica.
  const imagenRef = imagenCluster(envSpec, imagen);
  const imagenFrontRef = imagenCluster(envSpec, imagenFront);

  console.log(`\n  ${info(`mke deploy ${dim(spec.app)} (${env}) → ${dim(spec.host)}`)}`);
  console.log(dim(`  imagen ${imagen}${spec.tieneFrontend ? ` + ${imagenFront}` : ""} · deploy/${spec.deployName} · ns ${envSpec.namespace}`));

  if (opts.dryRun) {
    console.log(info("DRY RUN — no se toca nada. Plan:"));
    console.log(`  0. lint de migraciones (${spec.tieneDrizzle ? "hay drizzle" : "sin drizzle"})`);
    await preflightDeploy(spec, { dryRun: true });
    const cargaTxt = envSpec.registry
      ? `docker push → ${envSpec.registry.push} (registry local, pull ${envSpec.registry.ref})`
      : `k3d image import -c ${envSpec.cluster}`;
    console.log(`  b. docker build --provenance=false --sbom=false ${imagen}${spec.tieneFrontend ? ` + ${imagenFront} (VITE_IDENTITY_URL=${identityOrigin(env)})` : ""} → ${cargaTxt} → apply -k ${spec.overlay} (+re-pin)`);
    console.log(`  c. ${spec.tieneDrizzle ? `dump → Job ${spec.app}-migrate-${sha} → drift-check de \`${spec.db}\`` : "sin migraciones: nada"}`);
    console.log(`  d. set image deploy/${spec.deployName} ${spec.contenedor}=${imagenRef} → rollout status`);
    console.log(`  e. ${spec.tieneFrontend ? `publicar front al PVC static-www (subPath=${spec.front})` : "sin front"}`);
    console.log(`  f. regenerar el ConfigMap mke-catalogo (stage+prod)`);
    console.log(`  g. mke doctor ${spec.host}${healthPath(spec, opts.health)}`);
    console.log(info("nada ejecutado (--dry-run)"));
    return;
  }

  // ── 0) LINT: lo primero de todo, antes de gastar un build ────────────────
  if (!compuertaLint(spec)) {
    console.log(bad("deploy abortado por el lint de migraciones"));
    process.exitCode = 1;
    return;
  }

  // ── a) PREFLIGHT convergente ─────────────────────────────────────────────
  if (!opts.sinPreflight) {
    if (!(await preflightDeploy(spec))) {
      console.log(bad("deploy abortado: el preflight no pudo converger la plataforma"));
      process.exitCode = 1;
      return;
    }
  } else {
    console.log(warn("preflight SALTADO (--sin-preflight) — no lo uses en CI"));
  }

  // ── b) BUILD + IMPORT + APPLY (con re-pin) ───────────────────────────────
  const token = await nodeAuthToken();
  if (!token) {
    console.log(warn(`sin token npm del forge (vault-mishi get ${NPM_TOKEN_SECRET}) — el build fallará si la app usa @mishicomco/*`));
  }
  // El token npm del forge se pasa como BuildKit SECRET (--mount=type=secret en
  // el Dockerfile), NO como --build-arg: un ARG queda en el historial de la capa
  // (`docker history --no-trunc`), cacheado en el nodo, cosechable por otro
  // proceso del runner. El secret nunca toca una capa. (fuego 2026-08-08 V3.)
  // Retrocompat en TRANSICIÓN: seguimos pasando --build-arg para los Dockerfiles
  // aún NO migrados (ARG + npm ci); en un Dockerfile ya migrado (sin ARG) ese
  // --build-arg queda SIN USAR → no se hornea → no filtra. Cuando toda la flota
  // migre, borrar la parte --build-arg de acá.
  if (token) {
    process.env.NODE_AUTH_TOKEN = token; // lo lee `--secret ...,env=NODE_AUTH_TOKEN`
    process.env.DOCKER_BUILDKIT = "1"; // --secret exige BuildKit
  }
  const argsToken = token
    ? [
        "--secret", "id=node_auth_token,env=NODE_AUTH_TOKEN",
        "--build-arg", `NODE_AUTH_TOKEN=${token}`, // TRANSICIÓN: borrar al migrar toda la flota
      ]
    : [];
  // No exportamos attestation/SBOM manifests (buildx los genera por default y no
  // los consumimos — "exporting attestation manifest" en los logs). Apagarlos
  // recorta el export y evita manifests basura en el registry. (Fase 1.)
  const argsBuild = ["--provenance=false", "--sbom=false", ...argsToken];

  const codeBackend = await pasoStreamCmd(
    `docker build ${dim(imagen)}`,
    "docker",
    ["build", "-t", imagen, ...argsBuild, "-f", join(spec.dir, "apps", "backend", "Dockerfile"), spec.dir],
  );
  if (codeBackend !== 0) {
    console.log(bad("docker build del backend falló"));
    process.exitCode = 1;
    return;
  }

  if (spec.tieneFrontend) {
    const codeFront = await pasoStreamCmd(
      `docker build ${dim(imagenFront)}`,
      "docker",
      [
        "build", "-t", imagenFront,
        ...argsBuild,
        "--build-arg", `VITE_IDENTITY_URL=${identityOrigin(env)}`,
        "-f", join(spec.dir, "apps", "frontend", "Dockerfile"), spec.dir,
      ],
    );
    if (codeFront !== 0) {
      console.log(bad("docker build del frontend falló"));
      process.exitCode = 1;
      return;
    }
  }

  // Dos deploys en paralelo (dos runners) comparten el tools-container de k3d
  // y el import puede morir con "No such exec instance" — transitorio, se
  // reintenta (post-mortem 2026-07-28: mishi-bank e identity-mishi a la vez).
  const imagenes = spec.tieneFrontend ? [imagen, imagenFront] : [imagen];
  let imp = { code: 1, stdout: "", stderr: "" };
  for (let intento = 1; intento <= 3 && imp.code !== 0; intento++) {
    if (intento > 1) {
      console.log(warn(`carga de imágenes falló (intento ${intento - 1}/3) — reintentando en 10s`));
      await new Promise((r) => setTimeout(r, 10_000));
    }
    imp = await paso(describeCarga(envSpec, imagenes), () => cargarImagenes(envSpec, imagenes));
  }
  if (imp.code !== 0) {
    console.log(bad(`carga de imágenes falló tras 3 intentos: ${imp.stderr || imp.stdout}`));
    process.exitCode = 1;
    return;
  }

  // El manifiesto pinea un tag MUTABLE (:dev): el apply puede resetear la
  // imagen del Deployment vivo (que corre :sha) y reciclar pods ANTES de que
  // las compuertas de migración decidan nada. Capturamos la imagen viva ANTES
  // del apply y la re-pineamos justo después. Primer deploy → vacío, no-op.
  const viva = await run("kubectl", [
    "--context", envSpec.context, "-n", envSpec.namespace,
    "get", `deploy/${spec.deployName}`,
    "-o", "jsonpath={.spec.template.spec.containers[0].image}",
  ]);
  const imagenViva = viva.code === 0 ? viva.stdout.trim() : "";

  const apply = await paso(
    `kubectl apply -k ${dim(spec.overlay)} (${envSpec.context}/${envSpec.namespace})`,
    () => run("kubectl", ["--context", envSpec.context, "apply", "-k", spec.overlay]),
  );
  if (apply.code !== 0) {
    console.log(bad(`apply falló: ${apply.stderr || apply.stdout}`));
    process.exitCode = 1;
    return;
  }
  console.log(dim(`  ${apply.stdout.split("\n").join(" · ")}`));

  if (imagenViva) {
    await paso(`re-pin de la imagen viva ${dim(imagenViva)} (cero rollout hasta pasar las compuertas)`, () =>
      run("kubectl", [
        "--context", envSpec.context, "-n", envSpec.namespace,
        "set", "image", `deploy/${spec.deployName}`, `${spec.contenedor}=${imagenViva}`,
      ]),
    );
  }

  // ── c) COMPUERTA de BD ───────────────────────────────────────────────────
  // El Job de migrar corre DENTRO del cluster → usa el nombre por el que el
  // cluster jala la imagen (con registry local, `<ref>/<tag>`).
  if (!(await compuertaMigracionesPostBuild(spec, imagenRef, sha))) {
    console.log(bad("deploy abortado por la compuerta de migraciones — NO hubo rollout"));
    process.exitCode = 1;
    return;
  }

  // ── d) ROLLOUT ───────────────────────────────────────────────────────────
  const setImage = await paso(`set image deploy/${spec.deployName} → ${dim(imagenRef)}`, () =>
    run("kubectl", [
      "--context", envSpec.context, "-n", envSpec.namespace,
      "set", "image", `deploy/${spec.deployName}`, `${spec.contenedor}=${imagenRef}`,
    ]),
  );
  if (setImage.code !== 0) {
    console.log(bad(`set image falló: ${setImage.stderr || setImage.stdout}`));
    process.exitCode = 1;
    return;
  }
  const statusCode = await pasoStreamCmd(
    `rollout status deploy/${spec.deployName}`,
    "kubectl",
    ["--context", envSpec.context, "-n", envSpec.namespace, "rollout", "status", `deploy/${spec.deployName}`, "--timeout=180s"],
  );
  if (statusCode !== 0) {
    console.log(bad("rollout no convergió"));
    process.exitCode = 1;
    return;
  }

  // ── e) FRONT al PVC de static-mishi ──────────────────────────────────────
  if (spec.tieneFrontend) {
    if (!(await publicarFrontAlPvc(spec.front, env, imagenFrontRef))) {
      console.log(bad("la publicación del front al PVC falló"));
      process.exitCode = 1;
      return;
    }
  }

  // ── f) CATÁLOGO derivado (best-effort, nunca tumba un deploy sano) ───────
  await regenerarCatalogos();

  // ── g) POSTFLIGHT: sin cadena pública sana, el deploy NO es verde ────────
  // Con replicas:1 hay una ventana de settle (endpoints/tunnel/DNS) justo tras
  // el rollout en la que /salud aún no responde — tumbó runs sanos (links-mishi
  // 2026-08-06 ×3). Reintento ACOTADO: el verde sigue exigiendo el 200 real.
  const salud = healthPath(spec, opts.health);
  let diag = await doctor(spec.host, salud);
  for (let intento = 2; !diag.sano && intento <= 3; intento++) {
    console.log(dim(`  postflight no sano aún — reintento ${intento}/3 en 20 s (ventana de settle post-rollout)`));
    await new Promise((r) => setTimeout(r, 20_000));
    diag = await doctor(spec.host, salud);
  }
  if (!diag.sano) {
    console.log(bad(`postflight FALLÓ: https://${spec.host}${salud} no responde sano — el deploy NO es verde`));
    process.exitCode = 1;
    return;
  }
  console.log(ok(`deploy verde: ${spec.app} ${sha} → ${spec.host} (${envSpec.namespace})`));
}
